'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const script = fs.readFileSync(path.join(__dirname, '../netSuiteRestlet/vscodeExtensionRestlet.js'), 'utf8');

function fixture(options = {}) {
    let restlet;
    const calls = [];
    const ids = options.ids || ['12', '14', '18'];
    const mutations = () => assert.fail('Inspection must not mutate NetSuite');
    const modules = {
        'N/file': { create: mutations, delete: mutations, copy: mutations },
        'N/search': {
            Sort: { ASC: 'ASC' }, Summary: { GROUP: 'GROUP' },
            createColumn: input => input, createFilter: input => input,
            create(config) {
                calls.push(['search', config]);
                if (options.searchError) throw Object.assign(new Error('Private filter value'), { name: options.searchError });
                assert.equal(config.columns.length, 1);
                assert.equal(config.columns[0].summary, 'GROUP');
                assert.equal(config.columns[0].sort, 'ASC');
                const after = config.filters.at(-1).values[0];
                return { run: () => ({ getRange({ start, end }) {
                    assert.equal(start, 0);
                    assert.ok(end <= 11);
                    return ids.filter(id => Number(id) > after).slice(start, end).map(id => ({ getValue: () => id }));
                } }), save: mutations };
            }, delete: mutations
        },
        'N/record': {
            create: mutations, delete: mutations, submitFields: mutations,
            load(config) {
                calls.push(['load', config]);
                assert.equal(config.isDynamic, false);
                if (options.loadError) throw Object.assign(new Error('Private record value'), { name: options.loadError });
                const fields = options.fields || { entityid: 'Customer ' + config.id, email: 'a@example.com', custentity_hidden: 'sensitive', password: 'secret' };
                return {
                    getFields: () => Object.keys(fields),
                    getField: ({ fieldId }) => ({ type: fieldId === 'custentity_hidden' ? 'password' : 'text' }),
                    getValue({ fieldId }) {
                        if (options.fieldError === fieldId) throw new Error('Private field value');
                        return fields[fieldId];
                    },
                    getSublists: () => [], save: mutations, setValue: mutations
                };
            }
        },
        'N/runtime': { accountId: '123456', getCurrentUser: () => ({ id: 1, role: 10 }),
            getCurrentScript: () => ({ getParameter: ({ name }) => name === 'custscript_supersuite_readonly' ? options.readOnly : null,
                getRemainingUsage: () => options.lowUsageAfterLoad && calls.some(call => call[0] === 'load') ? 100 : 5000 }) },
        'N/log': { error: mutations }
    };
    vm.runInNewContext(script, { define: (names, factory) => { restlet = factory(...names.map(name => modules[name])); } });
    const api = Object.fromEntries(Object.entries(restlet).map(([method, handler]) =>
        [method, request => JSON.parse(JSON.stringify(handler(request)))]));
    return { api, calls, ids };
}

test('inspection capability and deployment checkbox prohibit writes independently of caller permissions', () => {
    for (const readOnly of [true, 'T']) {
        const { api, calls } = fixture({ readOnly });
        const version = api.get({ action: 'version' });
        assert.equal(version.restletVersion, '2.2.0');
        assert.equal(version.capabilities.readOnlyInspection, true);
        assert.equal(version.readOnlyMode, true);
        assert.equal(api.post({ action: 'push', files: [{ path: 'SuiteScripts/test.js', content: 'bad', encoding: 'utf8' }] }).error.code, 'READ_ONLY_DEPLOYMENT');
        assert.equal(api.delete({ action: 'delete', path: 'SuiteScripts/test.js' }).error.code, 'READ_ONLY_DEPLOYMENT');
        assert.equal(calls.length, 0);
        assert.equal(api.get({ action: 'record', recordType: 'customer', internalId: '12' }).ok, true);
    }
    assert.equal(fixture().api.get({ action: 'version' }).readOnlyMode, false);
});

test('record inspection supports custom types and omits credential values with explicit issues', () => {
    const { api, calls } = fixture();
    const result = api.get({ action: 'record', recordType: 'customrecord_project', internalId: '12' });
    assert.deepEqual(result.record.fields, { entityid: 'Customer 12', email: 'a@example.com' });
    assert.equal(result.record.complete, false);
    assert.equal(result.record.issueCount, 2);
    assert.equal(calls[0][1].type, 'customrecord_project');
    assert.equal(calls[0][1].id, 12);
    assert.ok(!JSON.stringify(result).includes('sensitive'));
    assert.ok(!JSON.stringify(result).includes('secret'));
});

test('record inspection rejects code-like type and ID inputs before any account operation', () => {
    const { api, calls } = fixture();
    for (const recordType of ['customer;evil()', '../customer', '__proto__', 'constructor', 'integration', 'accesstoken']) {
        assert.equal(api.get({ action: 'record', recordType, internalId: 1 }).error.code, 'INVALID_RECORD_TYPE');
    }
    for (const internalId of [0, -1, '01', '1e3', '12;evil()', {}, null, '9999999999999999']) {
        assert.equal(api.get({ action: 'record', recordType: 'customer', internalId }).error.code, 'INVALID_RECORD_ID');
    }
    assert.equal(api.post({ action: 'record', recordType: 'customer', internalId: 1 }).error.code, 'UNSUPPORTED_ACTION');
    assert.equal(api.delete({ action: 'search', recordType: 'customer' }).error.code, 'UNSUPPORTED_ACTION');
    assert.equal(calls.length, 0);
});

test('structured search groups matching IDs, returns selected body fields, and resumes after deletion', () => {
    const { api, calls, ids } = fixture();
    const request = { action: 'search', recordType: 'salesorder', pageSize: 2,
        filters: JSON.stringify([{ fieldId: 'entity', operator: 'anyof', values: ['7', '8'] }]),
        columns: JSON.stringify(['internalid', 'entityid', 'email']) };
    const first = api.get(request);
    assert.equal(first.nextCursor, '14');
    assert.deepEqual(first.results.map(item => item.id), ['12', '14']);
    assert.deepEqual(first.results[0].fields, { internalid: '12', entityid: 'Customer 12', email: 'a@example.com' });
    assert.equal(first.results[0].complete, true);
    assert.equal(calls[0][1].filters[0].name, 'entity');
    assert.deepEqual(Array.from(calls[0][1].filters[0].values), ['7', '8']);
    ids.shift();
    const second = api.get({ ...request, cursor: first.nextCursor });
    assert.deepEqual(second.results.map(item => item.id), ['18']);
    assert.equal(second.nextCursor, null);
});

test('ID-only search avoids unnecessary record loads', () => {
    const { api, calls } = fixture();
    const result = api.get({ action: 'search', recordType: 'customrecord_project' });
    assert.equal(result.results[0].fields.internalid, '12');
    assert.equal(calls.filter(call => call[0] === 'load').length, 0);
});

test('search rejects formulas, joins, object values, unknown operators and oversized requests', () => {
    const { api, calls } = fixture();
    const base = { action: 'search', recordType: 'customer' };
    const filter = (value) => ({ ...base, filters: JSON.stringify([value]) });
    for (const fieldId of ['formulatext', 'entity.email', 'access_token', 'privatekey', '__proto__']) {
        assert.equal(api.get({ ...base, columns: JSON.stringify([fieldId]) }).error.code, 'INVALID_FIELD_ID');
        assert.equal(api.get(filter({ fieldId, operator: 'is', values: ['a'] })).error.code, 'INVALID_FIELD_ID');
    }
    for (const payload of [
        filter({ fieldId: 'email', operator: 'is', values: ['a'], join: 'customer' }),
        { ...base, filters: '{invalid' }, { ...base, filters: '[]'.repeat(5000) },
        { ...base, columns: JSON.stringify(Array(21).fill('email')) },
        { ...base, filters: JSON.stringify(Array(11).fill({ fieldId: 'email', operator: 'is', values: ['a'] })) }
    ]) assert.equal(api.get(payload).error.code, 'INVALID_SEARCH');
    assert.equal(api.get(filter({ fieldId: 'email', operator: 'evil()', values: ['a'] })).error.code, 'INVALID_OPERATOR');
    for (const values of [[{}], ['x'.repeat(501)], ['a\nsecret'], [], Array(21).fill('x')]) {
        assert.equal(api.get(filter({ fieldId: 'email', operator: 'is', values })).error.code, 'INVALID_FILTER_VALUES');
    }
    for (const pageSize of [0, 11, 1.5]) assert.equal(api.get({ ...base, pageSize }).error.code, 'INVALID_PAGE_SIZE');
    assert.equal(api.get({ ...base, cursor: '-1' }).error.code, 'INVALID_CURSOR');
    assert.equal(calls.length, 0);
});

test('search field omissions and role failures expose fixed errors without record values', () => {
    const { api } = fixture({ fieldError: 'email' });
    const result = api.get({ action: 'search', recordType: 'customer', columns: JSON.stringify(['custentity_hidden', 'email', 'missing']) });
    assert.equal(result.results[0].complete, false);
    assert.deepEqual(result.results[0].issues.map(issue => issue.code), ['CREDENTIAL_FIELD_OMITTED', 'FIELD_UNAVAILABLE', 'FIELD_UNAVAILABLE']);
    assert.ok(!JSON.stringify(result).includes('Private'));
    assert.ok(!JSON.stringify(result).includes('sensitive'));
    const denied = fixture({ loadError: 'INSUFFICIENT_PERMISSION' }).api.get({ action: 'record', recordType: 'customer', internalId: '1' });
    assert.equal(denied.error.code, 'RECORD_PERMISSION_DENIED');
    assert.ok(!JSON.stringify(denied).includes('Private'));
    const invalid = fixture({ searchError: 'SSS_INVALID_SRCH_FILTER' }).api.get({ action: 'search', recordType: 'customer' });
    assert.equal(invalid.error.code, 'SSS_INVALID_SRCH_FILTER');
    assert.ok(!JSON.stringify(invalid).includes('Private'));
});

test('governance and byte limits defer selected-field searches without skipping IDs', () => {
    const request = { action: 'search', recordType: 'customer', columns: '["email"]' };
    const limited = fixture({ lowUsageAfterLoad: true }).api.get(request);
    assert.equal(limited.nextCursor, '12');
    assert.equal(limited.results.length, 1);
    const large = fixture({ fields: { email: 'x'.repeat(2 * 1024 * 1024) } }).api.get(request);
    assert.equal(large.nextCursor, '12');
    assert.equal(large.results.length, 1);
    assert.ok(Buffer.byteLength(JSON.stringify(large)) < 4 * 1024 * 1024);
    const oversized = fixture({ fields: { email: 'x'.repeat(3 * 1024 * 1024) } }).api.get(request);
    assert.equal(oversized.results[0].error.code, 'RECORD_TOO_LARGE');
    assert.equal(oversized.nextCursor, null);
});
