'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { DEFAULTS } = require('../helpers/config');
const localFiles = require('../helpers/localFiles');

function fileUri(filename) {
    const fsPath = path.resolve(filename);
    return { scheme: 'file', fsPath, toString: () => pathToFileURL(fsPath).href };
}

async function fixture(t, handlers = {}, overrides = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'supersuite-business-'));
    t.after(async () => {
        assert.ok(root.startsWith(path.join(os.tmpdir(), 'supersuite-business-')));
        await fs.rm(root, { recursive: true, force: true });
    });
    const folder = { uri: fileUri(root), name: 'Workspace' };
    const documents = [];
    const calls = [];
    const lines = [];
    const warnings = [];
    const messages = [];
    const cancellations = new Set();
    const token = {
        isCancellationRequested: false,
        onCancellationRequested(callback) { cancellations.add(callback); return { dispose: () => cancellations.delete(callback) }; }
    };
    const vscode = {
        Uri: { file: fileUri, parse: value => ({ toString: () => value }) },
        ProgressLocation: { Notification: 15 },
        workspace: { textDocuments: documents, registerTextDocumentContentProvider: () => ({ dispose() {} }) },
        commands: { executeCommand: async () => {} },
        window: {
            showWarningMessage: async (message, options, ...choices) => {
                warnings.push(message);
                return options && options.modal ? choices[0] : undefined;
            },
            showInformationMessage: async message => { messages.push(message); },
            withProgress: async (_options, work) => work({ report() {} }, token)
        }
    };
    const client = {
        async request(action, payload = {}) {
            calls.push({ action, payload: JSON.parse(JSON.stringify(payload)) });
            if (handlers[action]) return handlers[action](payload);
            if (action === 'version') return { protocolVersion: 2, restletVersion: '2.0.0', limits: { maxBatchFiles: 20, maxBatchBytes: 4194304, maxFileBytes: 3145728 } };
            if (action === 'push') return { results: payload.files.map(item => ({ ok: true, path: item.path })) };
            throw new Error(`Unexpected request: ${action}`);
        }
    };
    const config = { ...DEFAULTS, restlet: 'https://123456.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=1&deploy=1', realm: '123456' };
    const configuration = { folder: async () => folder, connection: async () => ({ config, client }) };
    const filename = path.resolve(__dirname, '../bl/netSuiteBl.js');
    const realRequire = createRequire(filename);
    const module = { exports: {} };
    const scope = { Buffer, TextDecoder, AbortController, setTimeout, process };
    const compile = vm.runInNewContext(`(function(require, module, exports) { ${await fs.readFile(filename, 'utf8')}\n})`, scope, { filename });
    compile(name => name === 'vscode' ? vscode : name === '../helpers/localFiles' ? { ...localFiles, ...overrides } : realRequire(name), module, module.exports);
    const context = { subscriptions: [] };
    const commands = new module.exports.NetSuiteCommands(context, configuration, { appendLine: line => lines.push(line), show() {} });
    t.after(() => commands.dispose());
    return { root, folder, commands, config, vscode, documents, calls, lines, warnings, messages, token, cancel: () => { token.isCancellationRequested = true; cancellations.forEach(callback => callback()); } };
}

test('dirty editors are skipped before a push and retained for retry', async t => {
    const state = await fixture(t);
    const filename = path.join(state.root, 'script.js');
    await fs.writeFile(filename, 'saved content');
    state.documents.push({ uri: fileUri(filename), isDirty: true });
    await state.commands.execute('uploadFile', fileUri(filename));
    assert.equal(state.calls.filter(call => call.action === 'push').length, 0);
    assert.deepEqual(Array.from(state.commands.lastFailed.paths), ['SuiteScripts/script.js']);
    assert.match(state.lines.join('\n'), /Unsaved editor/);
    assert.equal(await fs.readFile(filename, 'utf8'), 'saved content');
});

test('completed download batches retain outcomes without file contents', async t => {
    const response = { results: [{ ok: true, path: 'SuiteScripts/script.js', encoding: 'utf8', content: 'downloaded content' }] };
    const state = await fixture(t, { pull: () => response });
    const summary = await state.commands.execute('downloadFile', fileUri(path.join(state.root, 'script.js')));
    assert.equal(summary.succeeded, 1);
    assert.equal(summary.failed, 0);
    assert.equal(summary.cancelled, false);
    assert.equal(await fs.readFile(path.join(state.root, 'script.js'), 'utf8'), 'downloaded content');
    assert.equal(Object.hasOwn(response.results[0], 'content'), false, 'Folder results must not retain every downloaded file in memory.');
});

test('partial push failures retry only failed paths with fresh file contents', async t => {
    let failSecond = true;
    const state = await fixture(t, { push: ({ files }) => ({ results: files.map(item => ({
        ok: !(failSecond && item.path.endsWith('/b.js')), path: item.path,
        ...(failSecond && item.path.endsWith('/b.js') ? { error: { code: 'PERMISSION_VIOLATION', message: 'Denied', retryable: false } } : {})
    })) }) });
    await Promise.all(['a.js', 'b.js', 'c.js'].map(name => fs.writeFile(path.join(state.root, name), 'original')));
    await state.commands.execute('uploadFolder', state.folder.uri);
    assert.deepEqual(Array.from(state.commands.lastFailed.paths), ['SuiteScripts/b.js']);
    failSecond = false;
    await fs.writeFile(path.join(state.root, 'b.js'), 'fixed content');
    await state.commands.execute('retryFailed');
    const pushes = state.calls.filter(call => call.action === 'push');
    assert.equal(pushes.length, 2);
    assert.equal(pushes[1].payload.files.length, 1);
    assert.equal(pushes[1].payload.files[0].path, 'SuiteScripts/b.js');
    assert.equal(pushes[1].payload.files[0].content, 'fixed content');
    assert.equal(state.commands.lastFailed, undefined);
});

test('an explicit Explorer folder wins over the active editor and text types remain UTF-8', async t => {
    const state = await fixture(t);
    const selected = path.join(state.root, 'selected');
    const other = path.join(state.root, 'other');
    await Promise.all([fs.mkdir(selected), fs.mkdir(other)]);
    await Promise.all([fs.writeFile(path.join(selected, 'template.ftl'), '<h1>é</h1>'), fs.writeFile(path.join(other, 'script.js'), 'unrelated')]);
    state.vscode.window.activeTextEditor = { document: { uri: fileUri(path.join(other, 'script.js')) } };
    await state.commands.execute('uploadFolder', fileUri(selected));
    const pushed = state.calls.filter(call => call.action === 'push').flatMap(call => call.payload.files);
    assert.deepEqual(pushed.map(item => item.path), ['SuiteScripts/selected/template.ftl']);
    assert.equal(pushed[0].encoding, 'utf8');
    assert.equal(pushed[0].content, '<h1>é</h1>');
});

test('duplicate and unsolicited pull results are rejected before any local file is changed', async t => {
    let mode = 'duplicate';
    const state = await fixture(t, { pull: ({ files }) => ({ results: [
        { ok: true, path: files[0].path, content: 'first replacement', encoding: 'utf8' },
        { ok: true, path: mode === 'duplicate' ? files[0].path : 'SuiteScripts/unrequested.js', content: 'second replacement', encoding: 'utf8' }
    ] }) });
    const filename = path.join(state.root, 'script.js');
    await fs.writeFile(filename, 'original');
    for (mode of ['duplicate', 'unexpected']) {
        await state.commands.execute('downloadFile', fileUri(filename));
        assert.equal(await fs.readFile(filename, 'utf8'), 'original');
        assert.equal(state.commands.lastFailed.paths[0], 'SuiteScripts/script.js');
    }
});

test('malformed base64 cannot silently corrupt a downloaded file', async t => {
    const state = await fixture(t, { pull: ({ files }) => ({ results: [{ ok: true, path: files[0].path, content: '!!!!', encoding: 'base64' }] }) });
    const filename = path.join(state.root, 'file.png');
    await fs.writeFile(filename, 'original');
    await state.commands.execute('downloadFile', fileUri(filename));
    assert.equal(await fs.readFile(filename, 'utf8'), 'original');
    assert.match(state.lines.join('\n'), /invalid base64/);
});

test('an editor that becomes dirty while staging a download is not overwritten', async t => {
    let document;
    const state = await fixture(t, { pull: ({ files }) => ({ results: [{ ok: true, path: files[0].path, content: 'remote', encoding: 'utf8' }] }) }, {
        atomicWrite: async (...args) => { document.isDirty = true; return localFiles.atomicWrite(...args); }
    });
    const filename = path.join(state.root, 'script.js');
    await fs.writeFile(filename, 'original');
    document = { uri: fileUri(filename), isDirty: false };
    state.documents.push(document);
    await state.commands.execute('downloadFile', fileUri(filename));
    assert.equal(await fs.readFile(filename, 'utf8'), 'original');
    assert.match(state.lines.join('\n'), /Editor changed during pull/);
    assert.deepEqual(await fs.readdir(state.root), ['script.js']);
});

test('cancelling during writes preserves completed files and skips the rest of the batch', async t => {
    let state;
    state = await fixture(t, {
        list: () => ({ entries: ['a.js', 'b.js'].map(name => ({ type: 'file', path: `SuiteScripts/${name}` })), nextCursor: null }),
        pull: ({ files }) => ({ results: files.map(item => ({ ok: true, path: item.path, content: 'remote', encoding: 'utf8' })) })
    }, {
        atomicWrite: async (...args) => { await localFiles.atomicWrite(...args); state.cancel(); }
    });
    await Promise.all(['a.js', 'b.js'].map(name => fs.writeFile(path.join(state.root, name), 'original')));
    const summary = await state.commands.execute('downloadFolder', state.folder.uri);
    assert.equal(summary.succeeded, 1);
    assert.equal(summary.failed, 1);
    assert.equal(summary.cancelled, true);
    assert.equal(await fs.readFile(path.join(state.root, 'a.js'), 'utf8'), 'remote');
    assert.equal(await fs.readFile(path.join(state.root, 'b.js'), 'utf8'), 'original');
    assert.deepEqual(Array.from(state.commands.lastFailed.paths), ['SuiteScripts/b.js']);
    assert.match(state.lines.join('\n'), /1 succeeded, 1 failed, cancelled/);
});

test('unsafe directory entries stop that folder without creating or requesting outside paths', async t => {
    const state = await fixture(t, { list: () => ({ entries: [{ type: 'file', path: 'SuiteScripts/../escape.js' }], nextCursor: null }) });
    await state.commands.execute('downloadFolder', state.folder.uri);
    assert.equal(state.calls.filter(call => call.action === 'pull').length, 0);
    assert.deepEqual(await fs.readdir(state.root), []);
    assert.match(state.lines.join('\n'), /LIST_FAILED/);
    assert.equal(state.commands.lastFailed, undefined);
});

test('a failed folder listing preserves partial results and allows sibling folders to finish', async t => {
    const state = await fixture(t, {
        list: ({ path: remote }) => {
            if (remote === 'SuiteScripts') return { entries: ['bad', 'good'].map(name => ({ type: 'folder', path: `SuiteScripts/${name}` })), nextCursor: null };
            if (remote.endsWith('/bad')) throw new Error('Folder access denied');
            return { entries: [{ type: 'file', path: `${remote}/script.js` }], nextCursor: null };
        },
        pull: ({ files }) => ({ results: files.map(item => ({ ok: true, path: item.path, encoding: 'utf8', content: 'downloaded' })) })
    });
    const summary = await state.commands.execute('downloadFolder', state.folder.uri);
    assert.equal(summary.succeeded, 1);
    assert.equal(summary.failed, 1, 'Directory failures must prevent setup from marking the pull complete.');
    assert.equal(summary.cancelled, false);
    assert.equal(await fs.readFile(path.join(state.root, 'good', 'script.js'), 'utf8'), 'downloaded');
    assert.match(state.lines.join('\n'), /SuiteScripts\/bad: LIST_FAILED/);
    assert.match(state.lines.join('\n'), /Run Pull Folder again/);
    assert.equal(state.commands.lastFailed, undefined);
});

test('paths outside the selected workspace fail before transfers', async t => {
    const state = await fixture(t);
    await assert.rejects(state.commands.execute('uploadFile', fileUri(path.join(state.root, '..', 'outside.js'))), /outside the selected workspace/);
    assert.equal(state.calls.length, 0);
});

test('Windows path casing cannot bypass dirty-editor protection', { skip: process.platform !== 'win32' }, async t => {
    const state = await fixture(t);
    const filename = path.join(state.root, 'script.js');
    state.documents.push({ uri: fileUri(filename.toUpperCase()), isDirty: true });
    assert.equal(state.commands.isDirty(filename), true);
});

test('an empty remote folder is a successful completed import', async t => {
    const state = await fixture(t, { list: () => ({ entries: [], nextCursor: null }) });
    const summary = await state.commands.execute('downloadFolder', state.folder.uri);
    assert.equal(summary.succeeded, 0);
    assert.equal(summary.failed, 0);
    assert.equal(summary.cancelled, false);
    assert.equal(state.commands.active.size, 0);
});

test('a declined import confirmation returns cancellation without contacting NetSuite', async t => {
    const state = await fixture(t);
    state.vscode.window.showWarningMessage = async () => undefined;
    const summary = await state.commands.execute('downloadFolder', state.folder.uri);
    assert.equal(summary.succeeded, 0);
    assert.equal(summary.failed, 0);
    assert.equal(summary.cancelled, true);
    assert.equal(state.calls.length, 0);
    assert.equal(state.commands.active.size, 0);
});

test('an already cancelled progress token stops import before the first request', async t => {
    const state = await fixture(t);
    state.cancel();
    const summary = await state.commands.execute('downloadFolder', state.folder.uri);
    assert.equal(summary.cancelled, true);
    assert.equal(state.calls.length, 0);
    assert.equal(state.commands.controllers.size, 0);
    assert.equal(state.commands.active.size, 0);
    assert.match(state.warnings.at(-1), /Cancelled/);
});

test('disposal aborts an import and suppresses follow-up prompts or requests', async t => {
    let state;
    state = await fixture(t, { version: () => {
        state.commands.dispose();
        return { protocolVersion: 2, restletVersion: '2.0.0' };
    } });
    const summary = await state.commands.execute('downloadFolder', state.folder.uri);
    assert.equal(summary.cancelled, true);
    assert.equal(state.calls.length, 1);
    assert.equal(state.warnings.length, 1, 'Only the initial import confirmation should be shown.');
    assert.equal(state.messages.length, 0);
    assert.equal(state.commands.controllers.size, 0);
    assert.equal(state.commands.active.size, 0);
    assert.equal((await state.commands.execute('downloadFolder', state.folder.uri)).cancelled, true);
    assert.equal(state.calls.length, 1);
    assert.equal(state.warnings.length, 1);
});

test('disposal while confirmation is open prevents a new progress task', async t => {
    const state = await fixture(t);
    state.vscode.window.showWarningMessage = async () => { state.commands.dispose(); return 'Pull Files'; };
    const summary = await state.commands.execute('downloadFolder', state.folder.uri);
    assert.equal(summary.cancelled, true);
    assert.equal(state.calls.length, 0);
    assert.equal(state.messages.length, 0);
    assert.equal(state.commands.active.size, 0);
});

test('fatal connection errors still reject and release the workspace transfer lock', async t => {
    const state = await fixture(t, { version: () => ({ protocolVersion: 1 }) });
    await assert.rejects(state.commands.execute('downloadFolder', state.folder.uri), /does not support safe batches/);
    assert.equal(state.commands.active.size, 0);
    assert.equal(state.commands.controllers.size, 0);
});
