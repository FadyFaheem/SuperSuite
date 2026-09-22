'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const localFiles = require('../helpers/localFiles');

const record = (id, changes = {}) => ({ ok: true, id: String(id), recordType: 'customer', complete: true,
    fields: { entityid: `Private customer ${id}` }, sublists: { item: { lines: [{ fields: { amount: 12.3 } }] } }, ...changes });
const page = (records, nextCursor = null, recordType = 'customer') => ({ ok: true, recordType, records, nextCursor });

async function fixture(t, options = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'supersuite-export-'));
    t.after(async () => {
        assert.ok(root.startsWith(path.join(os.tmpdir(), 'supersuite-export-')));
        await fs.rm(root, { recursive: true, force: true });
    });
    const folder = { uri: { fsPath: root, scheme: 'file' } };
    const calls = [];
    const output = [];
    const cancellations = new Set();
    const config = { restlet: 'https://123456.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=1&deploy=1', realm: '123456', authType: 'tba' };
    const client = { async request(action, payload, requestOptions) {
        calls.push({ action, payload, signal: requestOptions.signal });
        if (action === 'version') return { protocolVersion: 2, capabilities: { recordExport: options.capability !== false },
            identity: options.identity || { accountId: '123456', userId: '42', roleId: '1001' } };
        if (options.handler) return options.handler(payload);
        return page([record(1)]);
    } };
    const vscode = { workspace: { isTrusted: options.trusted !== false, textDocuments: options.documents || [] }, ProgressLocation: { Notification: 15 },
        window: { withProgress: async (_options, work) => work({ report() {} }, {
            onCancellationRequested(callback) { cancellations.add(callback); return { dispose: () => cancellations.delete(callback) }; }
        }) } };
    const filename = path.resolve(__dirname, '../helpers/recordExport.js');
    const realRequire = createRequire(filename);
    const module = { exports: {} };
    const compile = vm.runInNewContext(`(function(require, module, exports) { ${await fs.readFile(filename, 'utf8')}\n})`, { Buffer, AbortController }, { filename });
    compile(name => name === 'vscode' ? vscode : name === './localFiles' && options.atomicWrite ? { ...localFiles, atomicWrite: options.atomicWrite } : realRequire(name), module, module.exports);
    const exporter = new module.exports.RecordExporter({}, { connection: async () => ({ config, client }) }, { appendLine: line => output.push(line) });
    t.after(() => exporter.dispose());
    return { root, folder, exporter, output, calls, config, cancel: () => cancellations.forEach(callback => callback()), exports: module.exports };
}

test('exports body and sublist snapshots to ignored directories without logging values', async t => {
    const response = page([record(1)]);
    const state = await fixture(t, { handler: () => response });
    await fs.writeFile(path.join(state.root, '.gitignore'), 'node_modules/\n');
    const summary = await state.exporter.exportRecords(state.folder, ['customer']);
    assert.equal(summary.succeeded, 1);
    assert.equal(summary.failed, 0);
    assert.equal(summary.complete, true);
    const saved = JSON.parse(await fs.readFile(path.join(summary.exportDirectory, 'customer', '1.json'), 'utf8'));
    assert.equal(saved.fields.entityid, 'Private customer 1');
    assert.equal(saved.sublists.item.lines[0].fields.amount, 12.3);
    assert.match(await fs.readFile(path.join(state.root, '.gitignore'), 'utf8'), /node_modules\/[\s\S]*\.supersuite-data\/\n$/);
    assert.ok(!state.output.join('\n').includes('Private customer'));
    assert.equal(Object.hasOwn(response.records[0], 'fields'), false, 'Snapshot contents must be released after saving.');
});

test('incompatible RESTlet and untrusted workspaces fail before data is written', async t => {
    for (const options of [{ capability: false }, { trusted: false }]) {
        const state = await fixture(t, options);
        await assert.rejects(state.exporter.exportRecords(state.folder, ['customer']), /Deploy|Trust/);
        assert.deepEqual(await fs.readdir(state.root), []);
    }
});

test('record selections and untrusted response paths are validated before writes', async t => {
    const state = await fixture(t, { handler: () => page([record('../escape')]) });
    await assert.rejects(state.exporter.exportRecords(state.folder, ['employee']), /supported/);
    assert.equal(state.calls.length, 0);
    const summary = await state.exporter.exportRecords(state.folder, ['customer']);
    assert.equal(summary.succeeded, 0);
    assert.equal(summary.failed, 1);
    assert.equal(summary.complete, false);
    assert.equal(await fs.stat(path.join(summary.exportDirectory, 'customer')).catch(() => undefined), undefined);
});

test('duplicate, wrong-type and non-advancing pages are rejected before any snapshot write', async t => {
    for (const response of [page([record(1), record(1)]), page([record(1, { recordType: 'vendor' })]), page([], '1'), page([record(1)], '2')]) {
        const state = await fixture(t, { handler: () => response });
        const summary = await state.exporter.exportRecords(state.folder, ['customer']);
        assert.equal(summary.succeeded, 0);
        assert.equal(summary.blockedTypes, 1);
    }
});

test('interrupted runs resume their persisted cursor without requesting completed records', async t => {
    let interrupted = true;
    const state = await fixture(t, { handler: payload => {
        if (payload.cursor === '0') return page([record(1), record(2)], '2');
        if (interrupted) throw Object.assign(new Error('Private response body'), { code: 'ECONNRESET' });
        return page([record(3)]);
    } });
    const first = await state.exporter.exportRecords(state.folder, ['customer']);
    assert.equal(first.succeeded, 2);
    assert.equal(first.blockedTypes, 1);
    interrupted = false;
    state.calls.length = 0;
    const second = await state.exporter.exportRecords(state.folder, ['customer']);
    assert.equal(second.exportDirectory, first.exportDirectory);
    assert.equal(second.succeeded, 3);
    assert.equal(second.complete, true);
    assert.deepEqual(state.calls.filter(call => call.action === 'records').map(call => call.payload.cursor), ['2']);
    assert.ok(!state.output.join('\n').includes('Private response body'));
});

test('failed and incomplete records retry individually while successful records stay untouched', async t => {
    let failed = true;
    const state = await fixture(t, { handler: payload => {
        if (failed) return page([record(1), { ok: false, id: '2', recordType: 'customer', error: { code: 'PERMISSION_VIOLATION', message: 'Private value' } },
            record(3, { complete: false, issues: [{ code: 'VALUE_UNAVAILABLE' }] })]);
        return page([record(Number(payload.cursor) + 1)]);
    } });
    const first = await state.exporter.exportRecords(state.folder, ['customer']);
    assert.equal(first.failed, 1);
    assert.equal(first.incomplete, 1);
    failed = false;
    state.calls.length = 0;
    const second = await state.exporter.exportRecords(state.folder, ['customer']);
    assert.equal(second.exportDirectory, first.exportDirectory);
    assert.equal(second.succeeded, 3);
    assert.equal(second.failed, 0);
    assert.equal(second.incomplete, 0);
    assert.equal(second.complete, true);
    assert.deepEqual(state.calls.filter(call => call.action === 'records').map(call => call.payload.cursor).sort(), ['1', '2']);
    assert.deepEqual((await fs.readdir(path.join(second.exportDirectory, 'customer'))).sort(), ['1.json', '2.json', '3.json']);
});

test('cancellation saves a resumable manifest and prevents following pages', async t => {
    let state;
    let writes = 0;
    state = await fixture(t, { handler: () => page([record(1), record(2)], '2'),
        atomicWrite: async (...args) => {
            const result = await localFiles.atomicWrite(...args);
            if (args[1].endsWith(`${path.sep}1.json`) && ++writes === 1) state.cancel();
            return result;
        } });
    const summary = await state.exporter.exportRecords(state.folder, ['customer']);
    assert.equal(summary.cancelled, true);
    assert.equal(summary.succeeded, 1);
    const manifest = JSON.parse(await fs.readFile(summary.manifestPath, 'utf8'));
    assert.equal(manifest.types.customer.cursor, '1');
    assert.equal(manifest.status, 'cancelled');
    assert.equal(state.calls.filter(call => call.action === 'records').length, 1);
});

test('a different account cannot resume another account export', async t => {
    const state = await fixture(t, { handler: () => { throw Object.assign(new Error('Connection failed'), { code: 'ECONNRESET' }); } });
    const first = await state.exporter.exportRecords(state.folder, ['customer']);
    state.config.realm = 'another-account';
    const second = await state.exporter.exportRecords(state.folder, ['customer']);
    assert.notEqual(second.exportDirectory, first.exportDirectory);
});

test('a changed integration role starts a new run and identity is never stored in plaintext', async t => {
    const identity = { accountId: '123456', userId: '42', roleId: '1001' };
    const state = await fixture(t, { identity, handler: () => { throw Object.assign(new Error('Connection failed'), { code: 'ECONNRESET' }); } });
    const first = await state.exporter.exportRecords(state.folder, ['customer']);
    identity.roleId = '1002';
    const second = await state.exporter.exportRecords(state.folder, ['customer']);
    assert.notEqual(second.exportDirectory, first.exportDirectory);
    assert.ok(!(await fs.readFile(second.manifestPath, 'utf8')).includes('123456'));
});

test('dirty gitignore is preserved and prevents business data writes', async t => {
    const documents = [];
    const state = await fixture(t, { documents });
    documents.push({ uri: { fsPath: path.join(state.root, '.gitignore') }, isDirty: true });
    await fs.writeFile(path.join(state.root, '.gitignore'), 'existing\n');
    await assert.rejects(state.exporter.exportRecords(state.folder, ['customer']), /Save your .gitignore/);
    assert.equal(await fs.readFile(path.join(state.root, '.gitignore'), 'utf8'), 'existing\n');
    assert.deepEqual(await fs.readdir(state.root), ['.gitignore']);
});

test('resume repairs stale failure counters after a successful retry committed before its manifest', async t => {
    let first = true;
    const state = await fixture(t, { handler: () => first ? page([{ ok: false, id: '1', recordType: 'customer', error: { code: 'DENIED' } }]) :
        assert.fail('A committed successful retry must not be downloaded again.') });
    const initial = await state.exporter.exportRecords(state.folder, ['customer']);
    const directory = path.join(initial.exportDirectory, 'customer');
    // Emulate a process kill after the atomic outcome and marker removal, before
    // the manifest update. The old manifest still says one failed record.
    await fs.writeFile(path.join(directory, '1.json'), JSON.stringify(record(1)));
    await fs.rm(path.join(directory, '1.error.json'));
    first = false;
    state.calls.length = 0;
    const resumed = await state.exporter.exportRecords(state.folder, ['customer']);
    assert.equal(resumed.complete, true);
    assert.equal(resumed.failed, 0);
    assert.equal(resumed.succeeded, 1);
    assert.equal(state.calls.filter(call => call.action === 'records').length, 0);
});

test('resume reconstructs retry marker kind from an atomically committed failed outcome', async t => {
    let first = true;
    const state = await fixture(t, { handler: () => page([record(1, first ? { complete: false } : {})]) });
    const initial = await state.exporter.exportRecords(state.folder, ['customer']);
    const directory = path.join(initial.exportDirectory, 'customer');
    // The retry failed and committed its JSON; its marker/manifest still describe
    // the earlier incomplete snapshot because the process ended between writes.
    await fs.writeFile(path.join(directory, '1.json'), JSON.stringify({ ok: false, id: '1', recordType: 'customer', error: { code: 'DENIED' } }));
    first = false;
    state.calls.length = 0;
    const resumed = await state.exporter.exportRecords(state.folder, ['customer']);
    assert.equal(resumed.complete, true);
    assert.equal(resumed.succeeded, 1);
    assert.equal(resumed.incomplete, 0);
    assert.equal(resumed.failed, 0);
    assert.deepEqual(state.calls.filter(call => call.action === 'records').map(call => call.payload.cursor), ['0']);
});

test('resume recovers a committed record beyond the last persisted cursor', async t => {
    let first = true;
    const state = await fixture(t, { handler: payload => {
        if (first) throw Object.assign(new Error('Connection failed'), { code: 'ECONNRESET' });
        assert.equal(payload.cursor, '1');
        return page([record(2)]);
    } });
    const initial = await state.exporter.exportRecords(state.folder, ['customer']);
    const directory = path.join(initial.exportDirectory, 'customer');
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, '1.json'), JSON.stringify(record(1)));
    first = false;
    const resumed = await state.exporter.exportRecords(state.folder, ['customer']);
    assert.equal(resumed.succeeded, 2);
    assert.equal(resumed.complete, true);
});

test('disposal during connection or version preflight prevents local configuration and data writes', async t => {
    for (const stage of ['connection', 'version']) {
        const state = await fixture(t);
        const connect = state.exporter.configuration.connection;
        state.exporter.configuration.connection = async folder => {
            const connection = await connect(folder);
            if (stage === 'connection') state.exporter.dispose();
            else {
                const request = connection.client.request;
                connection.client.request = async (...args) => {
                    const response = await request(...args);
                    state.exporter.dispose();
                    return response;
                };
            }
            return connection;
        };
        await assert.rejects(state.exporter.exportRecords(state.folder, ['customer']), { name: 'AbortError' });
        assert.deepEqual(await fs.readdir(state.root), []);
    }
});

test('dirty snapshot editors are preserved during resume and block overwriting their saved version', async t => {
    const documents = [];
    const state = await fixture(t, { documents, handler: () => page([record(1, { complete: false })]) });
    const initial = await state.exporter.exportRecords(state.folder, ['customer']);
    const filename = path.join(initial.exportDirectory, 'customer', '1.json');
    const original = await fs.readFile(filename, 'utf8');
    documents.push({ uri: { fsPath: filename, scheme: 'file' }, isDirty: true });
    state.calls.length = 0;
    const resumed = await state.exporter.exportRecords(state.folder, ['customer']);
    assert.equal(resumed.complete, false);
    assert.equal(resumed.blockedTypes, 1);
    assert.equal(await fs.readFile(filename, 'utf8'), original);
    assert.equal(state.calls.filter(call => call.action === 'records').length, 0);
});

test('export rejects a junction redirecting business data outside the workspace', async t => {
    const state = await fixture(t);
    const external = await fs.mkdtemp(path.join(os.tmpdir(), 'supersuite-export-outside-'));
    t.after(async () => {
        assert.ok(external.startsWith(path.join(os.tmpdir(), 'supersuite-export-outside-')));
        await fs.rm(external, { recursive: true, force: true });
    });
    await fs.symlink(external, path.join(state.root, '.supersuite-data'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(state.exporter.exportRecords(state.folder, ['customer']), /Symbolic links|outside/);
    assert.deepEqual(await fs.readdir(external), []);
    assert.equal(state.calls.length, 0);
});
