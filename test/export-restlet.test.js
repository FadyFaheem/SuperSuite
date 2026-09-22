'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const script = fs.readFileSync(path.join(__dirname, '../netSuiteRestlet/vscodeExtensionRestlet.js'), 'utf8');

function source(options = {}) {
    const fields = options.fields || { entityid: 'Customer 1', balance: 12.34, active: true };
    const sublists = options.sublists || { item: [{ item: '10', amount: 12.34 }] };
    return {
        getFields: () => Object.keys(fields),
        getField: ({ fieldId }) => ({ type: options.types?.[fieldId] || 'text' }),
        getValue({ fieldId }) { if (options.failedField === fieldId) throw new Error('Private record value'); return fields[fieldId]; },
        hasSubrecord: ({ fieldId }) => Boolean(options.subrecords?.[fieldId]),
        getSubrecord: ({ fieldId }) => options.subrecords[fieldId],
        getSublists: () => Object.keys(sublists),
        getSublistFields: ({ sublistId }) => Object.keys(sublists[sublistId][0] || {}),
        getLineCount: ({ sublistId }) => options.lineCount || sublists[sublistId].length,
        getSublistField: ({ fieldId }) => ({ type: options.types?.[fieldId] || 'text' }),
        getSublistValue: ({ sublistId, fieldId, line }) => sublists[sublistId][line % sublists[sublistId].length][fieldId],
        hasSublistSubrecord: ({ fieldId }) => Boolean(options.subrecords?.[fieldId]),
        getSublistSubrecord: ({ fieldId }) => options.subrecords[fieldId],
        save() { assert.fail('Business exports must never save records'); },
        setValue() { assert.fail('Business exports must never set values'); }
    };
}

function fixture(options = {}) {
    let restlet;
    const calls = [];
    const ids = options.ids || ['1', '2', '3'];
    const modules = {
        'N/file': {},
        'N/search': {
            Sort: { ASC: 'ASC' }, Summary: { GROUP: 'GROUP' }, createColumn: value => value,
            create(config) {
                calls.push(['search', config]);
                if (options.searchError) throw Object.assign(new Error('Private search internals'), { name: options.searchError });
                assert.equal(config.columns[0].summary, 'GROUP');
                assert.equal(config.columns[0].sort, 'ASC');
                return { run: () => ({ getRange({ start, end }) {
                    assert.equal(start, 0);
                    assert.ok(end <= 11);
                    const after = config.filters[0][2];
                    return ids.filter(id => Number(id) > after).slice(start, end).map(id => ({ getValue: () => id }));
                } }) };
            }
        },
        'N/record': {
            load(config) {
                calls.push(['load', config]);
                assert.equal(config.isDynamic, false);
                if (options.loadError && String(config.id) === '2') throw Object.assign(new Error('Private record data'), { name: options.loadError });
                return options.source ? options.source(config) : source();
            },
            create() { assert.fail('Export must not create records'); },
            delete() { assert.fail('Export must not delete records'); }
        },
        'N/runtime': { accountId: '123456', getCurrentUser: () => ({ id: 42, role: 1001 }), getCurrentScript: () => ({ getParameter: () => null,
            getRemainingUsage: () => options.usage ? options.usage(calls) : 5000 }) },
        'N/log': { error() { assert.fail('Export must not log business record values'); } }
    };
    vm.runInNewContext(script, { define: (names, factory) => { restlet = factory(...names.map(name => modules[name])); } });
    const api = Object.fromEntries(Object.entries(restlet).map(([name, handler]) => [name, request => JSON.parse(JSON.stringify(handler(request)))]));
    return { api, calls, ids };
}

test('business record export advertises capability, rejects unbounded or write requests', () => {
    const { api, calls } = fixture();
    assert.equal(api.get({ action: 'version' }).capabilities.recordExport, true);
    assert.deepEqual(api.get({ action: 'version' }).identity, { accountId: '123456', userId: '42', roleId: '1001' });
    for (const recordType of ['employee', 'customrecord_anything', '../customer', '__proto__']) {
        assert.equal(api.get({ action: 'records', recordType }).error.code, 'INVALID_RECORD_TYPE');
    }
    for (const pageSize of [0, 11, 1.5]) assert.equal(api.get({ action: 'records', recordType: 'customer', pageSize }).error.code, 'INVALID_PAGE_SIZE');
    assert.equal(api.get({ action: 'records', recordType: 'customer', cursor: '-1' }).error.code, 'INVALID_CURSOR');
    assert.equal(api.post({ action: 'records', recordType: 'customer' }).error.code, 'UNSUPPORTED_ACTION');
    assert.equal(calls.length, 0);
});

test('export loads actual body/sublist values and cursor resumes after the prior ID', () => {
    const { api, calls, ids } = fixture();
    const first = api.get({ action: 'records', recordType: 'customer', pageSize: 2 });
    assert.equal(first.nextCursor, '2');
    assert.equal(first.records[0].fields.balance, 12.34);
    assert.equal(first.records[0].sublists.item.lines[0].fields.item, '10');
    assert.equal(first.records[0].complete, true);
    ids.shift();
    const second = api.get({ action: 'records', recordType: 'customer', pageSize: 2, cursor: first.nextCursor });
    assert.deepEqual(second.records.map(item => item.id), ['3']);
    assert.equal(second.nextCursor, null);
    assert.deepEqual(calls.filter(call => call[0] === 'load').map(call => call[1].id), [1, 2, 3]);
});

test('record and page byte budgets report oversized records and defer without skipping', () => {
    const { api } = fixture({ source: ({ id }) => source({ fields: { memo: 'x'.repeat(id === 3 ? 3 * 1024 * 1024 : 2 * 1024 * 1024) }, sublists: {} }) });
    const first = api.get({ action: 'records', recordType: 'invoice' });
    assert.equal(first.records.length, 1);
    assert.equal(first.nextCursor, '1');
    const second = api.get({ action: 'records', recordType: 'invoice', cursor: '1' });
    assert.deepEqual(second.records.map(item => item.id), ['2', '3']);
    assert.equal(second.records[1].error.code, 'RECORD_TOO_LARGE');
    assert.equal(second.nextCursor, null);
    assert.ok(Buffer.byteLength(JSON.stringify(second)) < 4 * 1024 * 1024);
});

test('governance defers the next unprocessed ID without losing earlier results', () => {
    const { api, calls } = fixture({ usage: values => values.filter(call => call[0] === 'load').length >= 1 ? 100 : 5000 });
    const response = api.get({ action: 'records', recordType: 'customer' });
    assert.deepEqual(response.records.map(item => item.id), ['1']);
    assert.equal(response.nextCursor, '1');
    assert.equal(calls.filter(call => call[0] === 'load').length, 1);
});

test('role permission failures have actionable messages without field values', () => {
    const { api } = fixture({ loadError: 'INSUFFICIENT_PERMISSION' });
    const response = api.get({ action: 'records', recordType: 'customer' });
    assert.equal(response.records[1].error.code, 'RECORD_PERMISSION_DENIED');
    assert.match(response.records[1].error.message, /View permission/);
    assert.ok(!JSON.stringify(response).includes('Private'));
    const denied = fixture({ searchError: 'PERMISSION_VIOLATION' }).api.get({ action: 'records', recordType: 'invoice' });
    assert.equal(denied.error.code, 'RECORD_PERMISSION_DENIED');
});

test('partial field failures and credential omissions are explicit', () => {
    const { api } = fixture({ ids: ['1'], source: () => source({ fields: { entityid: 'Name', password: 'secret', custom: 'secret2', memo: 'inaccessible' },
        types: { custom: 'password' }, failedField: 'memo', sublists: {} }) });
    const response = api.get({ action: 'records', recordType: 'customer' });
    assert.equal(response.records[0].complete, false);
    assert.equal(response.records[0].issueCount, 3);
    assert.deepEqual(response.records[0].fields, { entityid: 'Name' });
    assert.ok(!JSON.stringify(response).includes('secret'));
    assert.ok(!JSON.stringify(response).includes('Private'));
});

test('nested address and inventory subrecords are copied without creating any', () => {
    const address = source({ fields: { city: 'Chicago' }, sublists: {} });
    const { api } = fixture({ ids: ['1'], source: () => source({ fields: { shippingaddress: null }, types: { shippingaddress: 'summary', addressbookaddress: 'summary' },
        sublists: { addressbook: [{ addressbookaddress: null }] }, subrecords: { shippingaddress: address, addressbookaddress: address } }) });
    const response = api.get({ action: 'records', recordType: 'customer' });
    assert.equal(response.records[0].subrecords.shippingaddress.fields.city, 'Chicago');
    assert.equal(response.records[0].sublists.addressbook.lines[0].subrecords.addressbookaddress.fields.city, 'Chicago');
    assert.equal(response.records[0].complete, true);
});

test('10,000-line platform boundary and bounded recursion are marked incomplete', () => {
    const deep = source({ fields: { city: 'Chicago' }, sublists: {} });
    const middle = source({ fields: { nested: null }, types: { nested: 'summary' }, subrecords: { nested: deep }, sublists: {} });
    const outer = source({ fields: { nested: null }, types: { nested: 'summary' }, subrecords: { nested: middle }, sublists: {} });
    const { api } = fixture({ ids: ['1'], source: () => source({ fields: { nested: null }, types: { nested: 'summary' },
        subrecords: { nested: outer }, sublists: { item: [{ item: '1' }] }, lineCount: 10000 }) });
    const result = api.get({ action: 'records', recordType: 'invoice' }).records[0];
    assert.equal(result.complete, false);
    assert.deepEqual(result.issues.map(issue => issue.code), ['SUBRECORD_DEPTH_LIMIT', 'NETSUITE_10000_LINE_LIMIT']);
    assert.equal(result.sublists.item.lines.length, 10000);
});
