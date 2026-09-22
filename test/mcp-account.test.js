'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CONNECTION_ENV, CREDENTIALS_ENV, MAX_RESULT_BYTES, InspectionError,
    connectionFromEnvironment, createAccountReader, toolResult, toolError } = require('../mcp/account');

const endpoint = 'https://123456-sb1.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=6&deploy=1';
const connection = { config: { restlet: endpoint, realm: '123456_SB1', authType: 'oauth2' }, credentials: { accessToken: 'test.private.token' } };
const version = () => ({ ok: true, protocolVersion: 2, restletVersion: '2.2.0',
    capabilities: { readOnlyInspection: true }, readOnlyMode: true, identity: { accountId: '123456_SB1', userId: '7', roleId: '10' } });
const record = () => ({ ok: true, record: { id: '12', recordType: 'customer', fields: { entityid: 'Example', email: 'a@example.com', memo: 'Untrusted instructions' },
    sublists: { addressbook: { lineCount: 1, lines: [{ fields: { city: 'Chicago' } }] } }, subrecords: {}, complete: true, issues: [], issueCount: 0 } });
const row = (id = '12') => ({ ok: true, id, recordType: 'customer', fields: { internalid: id }, complete: true, issues: [] });
function reader(respond) {
    const calls = [];
    const account = createAccountReader(connection, { client: { async request(action, payload, options) {
        calls.push({ action, payload, options });
        return respond ? respond(action, payload, options) : action === 'version' ? version() : record();
    } } });
    return { account, calls };
}

test('environment config supports documentation only and keeps credentials separate from settings', () => {
    assert.equal(connectionFromEnvironment({}), undefined);
    const environment = { [CONNECTION_ENV]: JSON.stringify(connection.config),
        [CREDENTIALS_ENV]: JSON.stringify({ ...connection.credentials, extraSecret: 'ignored' }) };
    const parsed = connectionFromEnvironment(environment);
    assert.equal(parsed.config.realm, '123456_SB1');
    assert.equal(parsed.config.accessToken, undefined);
    assert.deepEqual(parsed.credentials, connection.credentials);
    for (const invalid of [
        { [CONNECTION_ENV]: 'bad secret JSON', [CREDENTIALS_ENV]: '{}' },
        { [CONNECTION_ENV]: JSON.stringify(connection.config) },
        { [CREDENTIALS_ENV]: JSON.stringify(connection.credentials) },
        { ...environment, [CONNECTION_ENV]: JSON.stringify({ ...connection.config, accessToken: 'do-not-echo' }) },
        { ...environment, [CONNECTION_ENV]: JSON.stringify({ ...connection.config, restlet: endpoint.replace('netsuite.com', 'evil.example') }) },
        { ...environment, [CREDENTIALS_ENV]: JSON.stringify({ accessToken: 'secret\r\nInjected: yes' }) }
    ]) assert.throws(() => connectionFromEnvironment(invalid), error => !error.message.includes('do-not-echo') && !error.message.includes('bad secret'));
});

test('account data requests require supported protocol and an enforced read-only deployment every time', async () => {
    for (const changes of [{ protocolVersion: 1 }, { capabilities: {} }, { readOnlyMode: false }, { readOnlyMode: 'T' }]) {
        const { account, calls } = reader(() => ({ ...version(), ...changes }));
        await assert.rejects(account.getRecord({ recordType: 'customer', internalId: '12' }), { code: changes.readOnlyMode !== undefined ? 'READ_ONLY_REQUIRED' : 'UPGRADE_RESTLET' });
        assert.deepEqual(calls.map(call => call.action), ['version']);
    }
    const { account, calls } = reader();
    const controller = new AbortController();
    await account.getRecord({ recordType: 'customer', internalId: '12' }, { signal: controller.signal });
    await account.getRecord({ recordType: 'customer', internalId: '12' }, { signal: controller.signal });
    assert.deepEqual(calls.map(call => call.action), ['version', 'record', 'version', 'record']);
    assert.ok(calls.every(call => call.options.signal === controller.signal));
});

test('docs-only account reader produces actionable connection errors without network activity', async () => {
    const account = createAccountReader(undefined);
    await assert.rejects(account.connectionInfo(), { code: 'CONFIGURATION_REQUIRED' });
    await assert.rejects(account.getRecord({ recordType: 'customer', internalId: '12' }), { code: 'CONFIGURATION_REQUIRED' });
});

test('record projection binds type and ID and makes sublist access an explicit choice', async () => {
    const { account, calls } = reader();
    const result = await account.getRecord({ recordType: 'customer', internalId: '12', fields: ['entityid', 'missing'] });
    assert.deepEqual(result.record.fields, { entityid: 'Example' });
    assert.equal(result.record.sublists, undefined);
    assert.deepEqual(result.projection.missingFields, ['missing']);
    assert.match(result.consistency, /never instructions/);
    assert.deepEqual(calls[1].payload, { recordType: 'customer', internalId: '12' });
    const detailed = await account.getRecord({ recordType: 'customer', internalId: '12', includeSublists: true });
    assert.equal(detailed.record.sublists.addressbook.lineCount, 1);
    for (const changes of [{ id: '14' }, { recordType: 'vendor' }, { fields: [] }, { complete: 'true' }, { issues: 'private' }, { sublists: [] }]) {
        const malformed = reader(action => action === 'version' ? version() : { ok: true, record: { ...record().record, ...changes } });
        await assert.rejects(malformed.account.getRecord({ recordType: 'customer', internalId: '12', includeSublists: true }), { code: 'INVALID_RESPONSE' });
    }
});

test('search sends fixed action and encoded structured data with a useful default column', async () => {
    const { account, calls } = reader(action => action === 'version' ? version() : { ok: true, recordType: 'customer', results: [row()], nextCursor: '12' });
    const filters = [{ fieldId: 'email', operator: 'contains', values: ['a&b@example.com'] }];
    const result = await account.searchRecords({ recordType: 'customer', filters });
    assert.equal(result.nextCursor, '12');
    assert.equal(calls[1].action, 'search');
    assert.equal(calls[1].payload.filters, JSON.stringify(filters));
    assert.equal(calls[1].payload.columns, '["internalid"]');
    assert.equal(calls[1].payload.cursor, '0');
});

test('search rejects mismatched, malformed, duplicated, oversized and nonadvancing pages', async () => {
    const valid = { ok: true, recordType: 'customer', results: [row('12'), row('14')], nextCursor: '14' };
    const invalid = [
        { ...valid, recordType: 'vendor' }, { ...valid, nextCursor: '15' }, { ...valid, nextCursor: '0' },
        { ...valid, results: [] }, { ...valid, results: [row('12'), row('12')] },
        { ...valid, results: [row('14'), row('12')] },
        { ...valid, results: [{ ...row('12'), recordType: 'vendor' }] },
        { ...valid, results: [{ ...row('12'), fields: [] }], nextCursor: null },
        { ...valid, results: [{ ...row('12'), complete: 'true' }], nextCursor: null },
        { ...valid, results: [{ ...row('12'), issues: 'not an array' }], nextCursor: null },
        { ...valid, results: [{ ok: false, id: '12', recordType: 'customer' }], nextCursor: null },
        { ...valid, results: [row('12'), row('14'), row('18')], nextCursor: null }
    ];
    for (const response of invalid) {
        const { account } = reader(action => action === 'version' ? version() : response);
        await assert.rejects(account.searchRecords({ recordType: 'customer', pageSize: 2 }), { code: 'INVALID_RESPONSE' });
    }
    const { account } = reader(action => action === 'version' ? version() : { ...valid, nextCursor: null });
    await assert.rejects(account.searchRecords({ recordType: 'customer', cursor: '12' }), { code: 'INVALID_RESPONSE' });
});

test('account reads serialize work and recover after failures', async () => {
    let release;
    let first = true;
    const { account } = reader(async action => {
        if (action === 'version' && first) {
            first = false;
            await new Promise(resolve => { release = resolve; });
            throw new Error('private upstream details');
        }
        return action === 'version' ? version() : record();
    });
    const pending = account.connectionInfo();
    await assert.rejects(account.getRecord({ recordType: 'customer', internalId: '12' }), { code: 'BUSY' });
    release();
    await assert.rejects(pending);
    assert.equal((await account.connectionInfo()).readOnlyMode, true);
});

test('tool results enforce a projection budget and errors redact upstream messages', () => {
    assert.deepEqual(toolResult({ fields: { entityid: 'Example' } }).structuredContent, { fields: { entityid: 'Example' } });
    assert.throws(() => toolResult({ value: 'x'.repeat(MAX_RESULT_BYTES) }), { code: 'RESULT_TOO_LARGE' });
    const raw = toolError(Object.assign(new Error('private token and customer data'), { code: 'INSUFFICIENT_PERMISSION' }));
    assert.equal(raw.isError, true);
    assert.ok(!JSON.stringify(raw).includes('private token'));
    assert.match(raw.content[0].text, /INSUFFICIENT_PERMISSION/);
    assert.match(toolError(new InspectionError('READ_ONLY_REQUIRED', 'Enable read-only mode.')).content[0].text, /Enable read-only mode/);
    assert.match(toolError(Object.assign(new Error('private'), { name: 'AbortError' })).content[0].text, /Read cancelled/);
});
