'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { connectionKey, readConfig, validateConfig } = require('../helpers/config');
const transport = require('../helpers/netSuiteRestClient');

const endpoint = 'https://123.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=1&deploy=1';
const credentialNames = ['consumerToken', 'consumerSecret', 'netSuiteKey', 'netSuiteSecret'];
const sourceFile = path.join(__dirname, '../helpers/workspace.js');

async function fixture(t) {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'supersuite-workspace-'));
    t.after(async () => {
        assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
        await fs.rm(temporary, { recursive: true, force: true });
    });
    const folders = [];
    for (const name of ['first', 'second']) {
        const fsPath = path.join(temporary, name);
        await fs.mkdir(fsPath);
        folders.push({ name, uri: { scheme: 'file', fsPath, toString: () => pathToFileURL(fsPath).href } });
    }
    const settings = new Map();
    const messages = [];
    const logs = [];
    const updates = [];
    const secrets = new Map();
    const state = new Map();
    const secretWrites = [];
    const clients = [];
    const inputs = [];
    const requests = [];
    const token = {
        isCancellationRequested: false,
        onCancellationRequested(handler) { this.handler = handler; return { dispose() {} }; },
        cancel() { this.isCancellationRequested = true; this.handler?.(); }
    };
    const fixture = {
        folders, settings, messages, logs, updates, secrets, state, secretWrites, clients, inputs, requests, token,
        pick: folders[0],
        metadata: async () => ({ fields: [{ id: 'entityid', label: 'ID', type: 'text', value: 'MUST_NOT_CACHE' }, null] }),
        set(namespace, folder, values) { settings.set(namespace + ':' + folder.name, values); },
        async writeConfig(folder, value) {
            await fs.mkdir(path.join(folder.uri.fsPath, '.config'), { recursive: true });
            await fs.writeFile(path.join(folder.uri.fsPath, '.config/supersuite.json'), typeof value === 'string' ? value : JSON.stringify(value));
        }
    };
    const context = {
        secrets: {
            async get(key) { return secrets.get(key); },
            async store(key, value) { secretWrites.push([key, value]); secrets.set(key, value); },
            async delete(key) { secrets.delete(key); }
        },
        workspaceState: {
            get(key, fallback) { return state.get(key) ?? fallback; },
            async update(key, value) { if (value === undefined) state.delete(key); else state.set(key, value); }
        }
    };
    const vscode = {
        ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
        ProgressLocation: { Notification: 15 },
        workspace: {
            isTrusted: true, workspaceFolders: folders,
            getWorkspaceFolder(uri) { return folders.find(folder => uri.fsPath === folder.uri.fsPath || uri.fsPath.startsWith(folder.uri.fsPath + path.sep)); },
            getConfiguration(namespace, uri) {
                const folder = folders.find(folder => folder.uri.fsPath === uri.fsPath);
                const values = settings.get(namespace + ':' + folder.name) || {};
                return {
                    inspect(key) { return values[key]; },
                    get(key) { const value = values[key]; return value?.workspaceFolderValue ?? value?.workspaceValue ?? value?.globalValue ?? value?.defaultValue; },
                    async update(key, value, target) {
                        updates.push({ key, value, target, folder: folder.name });
                        const property = { 1: 'globalValue', 2: 'workspaceValue', 3: 'workspaceFolderValue' }[target];
                        if (value === undefined) delete values[key][property];
                    }
                };
            },
            async openTextDocument(filename) { return { filename }; }
        },
        window: {
            async showWorkspaceFolderPick() { return fixture.pick; },
            async showInputBox() { return inputs.shift(); },
            async showTextDocument(document) { messages.push(['document', document.filename]); },
            async showInformationMessage(message) { messages.push(['info', message]); },
            async showWarningMessage(message) { messages.push(['warning', message]); },
            async withProgress(_options, work) { return work({ report() {} }, token); }
        }
    };
    const localRequire = createRequire(sourceFile);
    const exports = { exports: {} };
    vm.runInNewContext(await fs.readFile(sourceFile, 'utf8'), {
        module: exports, AbortController,
        require(name) {
            if (name === 'vscode') return vscode;
            if (name === './netSuiteRestClient') return { ...transport, createClient(config) {
                clients.push(config);
                return { async request(action, payload, options) {
                    requests.push({ action, payload, options });
                    return fixture.metadata(action, payload, options);
                } };
            } };
            return localRequire(name);
        }
    }, { filename: sourceFile });
    fixture.workspace = new exports.exports.WorkspaceConfiguration(context, { appendLine: line => logs.push(line) });
    fixture.vscode = vscode;
    fixture.authorize = async (folder = folders[0], extra = {}) => {
        await fixture.writeConfig(folder, { restlet: endpoint, realm: '123', ...extra });
        const config = await fixture.workspace.config(folder);
        const key = connectionKey(folder.uri.toString(), config);
        secrets.set(key, JSON.stringify(Object.fromEntries(credentialNames.map(name => [name, 'synthetic-' + name]))));
        return key;
    };
    return fixture;
}

test('implicit empty legacy defaults do not replace the SuiteScripts root', async t => {
    const f = await fixture(t);
    f.set('netSuiteUpload', f.folders[0], { rootDirectory: { defaultValue: '' }, realm: { defaultValue: '' }, restlet: { defaultValue: '' } });
    assert.equal((await f.workspace.config(f.folders[0])).rootDirectory, 'SuiteScripts');
});

test('workspace setup preserves an existing malformed file and opens it for correction', async t => {
    const f = await fixture(t);
    const contents = '{ "realm": '; // A setup action must not overwrite or refuse to open this.
    await f.writeConfig(f.folders[0], contents);
    await f.workspace.setup(f.folders[0].uri);
    assert.equal(await fs.readFile(path.join(f.folders[0].uri.fsPath, '.config/supersuite.json'), 'utf8'), contents);
    assert.equal(f.messages[0][0], 'document');
    assert.equal(f.secretWrites.length, 0);
});

test('setup creates safe config for only the selected root; cancellation does nothing', async t => {
    const f = await fixture(t);
    f.pick = undefined;
    await f.workspace.setup();
    await assert.rejects(fs.stat(path.join(f.folders[0].uri.fsPath, '.config')), { code: 'ENOENT' });
    f.pick = f.folders[1];
    f.set('supersuite', f.folders[1], { restlet: { workspaceFolderValue: endpoint }, realm: { workspaceFolderValue: '123' } });
    await f.workspace.setup();
    const config = await readConfig(f.folders[1].uri.fsPath);
    assert.equal(config.restlet, endpoint);
    assert.equal(config.realm, '123');
    assert.ok(!credentialNames.some(name => Object.hasOwn(config, name)));
    await assert.rejects(fs.stat(path.join(f.folders[0].uri.fsPath, '.config')), { code: 'ENOENT' });
});

test('file settings override explicit folder/workspace/user settings and legacy only fills gaps', async t => {
    const f = await fixture(t);
    f.set('supersuite', f.folders[0], {
        restlet: { globalValue: endpoint, workspaceValue: 'workspace', workspaceFolderValue: 'folder' },
        batchSize: { defaultValue: 10, globalValue: 4, workspaceValue: 6, workspaceFolderValue: 8 }
    });
    f.set('netSuiteUpload', f.folders[0], { restlet: { globalValue: 'legacy' }, realm: { globalValue: '123' } });
    await f.writeConfig(f.folders[0], { restlet: 'file', metadataRecordTypes: ['SalesOrder', 'salesorder'] });
    const config = await f.workspace.config(f.folders[0]);
    assert.equal(config.restlet, 'file');
    assert.equal(config.batchSize, 8);
    assert.equal(config.realm, '123');
    assert.deepEqual(config.metadataRecordTypes, ['salesorder']);
});

test('invalid config objects and JSON are rejected without leaking source snippets', async t => {
    const f = await fixture(t);
    for (const value of ['null', '[]', '"x"']) {
        await f.writeConfig(f.folders[0], value);
        await assert.rejects(f.workspace.config(f.folders[0]), /JSON object/);
    }
    await f.writeConfig(f.folders[0], '{"consumerSecret":"synthetic-sensitive" BROKEN}');
    await assert.rejects(f.workspace.config(f.folders[0]), error => !error.message.includes('synthetic-sensitive') && /Invalid JSON/.test(error.message));
    for (const rootDirectory of ['SuiteScripts/.supersuite-staging', 'SuiteScripts/a%2fb', 'SuiteScripts/a:b']) {
        assert.throws(() => validateConfig({ rootDirectory }));
    }
});

test('cancelled credential entry preserves existing secrets and complete entry commits once', async t => {
    const f = await fixture(t);
    const key = await f.authorize();
    const previous = f.secrets.get(key);
    f.state.set(key + '.fields', { old: { fields: [{ id: 'private_field' }] } });
    f.inputs.push('new-key', undefined);
    await f.workspace.configureCredentials(f.folders[0].uri);
    assert.equal(f.secretWrites.length, 0);
    assert.equal(f.secrets.get(key), previous);
    assert.ok(f.state.has(key + '.fields'));
    f.inputs.push('new-key', 'new-secret', 'new-token', 'new-token-secret');
    await f.workspace.configureCredentials(f.folders[0].uri);
    assert.equal(f.secretWrites.length, 1);
    assert.equal(JSON.parse(f.secrets.get(key)).netSuiteSecret, 'new-token-secret');
    assert.equal(f.state.has(key + '.fields'), false);
    assert.ok(!JSON.stringify(f.messages).includes('new-token-secret'));
});

test('credential entry stops on disposal and cannot save into a changed connection', async t => {
    const f = await fixture(t);
    const key = await f.authorize();
    const original = f.secrets.get(key);
    let prompts = 0;
    f.vscode.window.showInputBox = async options => {
        assert.equal(options.password, true);
        if (++prompts === 4) await f.writeConfig(f.folders[0], { restlet: endpoint, realm: '456' });
        return 'replacement-value';
    };
    await assert.rejects(f.workspace.configureCredentials(f.folders[0].uri), /settings changed/);
    assert.equal(f.secretWrites.length, 0);
    assert.equal(f.secrets.get(key), original);
    f.vscode.window.showInputBox = async () => { f.workspace.dispose(); return 'replacement-value'; };
    assert.equal(await f.workspace.configureCredentials(f.folders[0].uri), false);
    assert.equal(f.secretWrites.length, 0);
});

test('secret binding isolates roots and endpoints, storage cannot override configuration', async t => {
    const f = await fixture(t);
    const key = await f.authorize();
    await f.writeConfig(f.folders[1], { restlet: endpoint, realm: '123' });
    await assert.rejects(f.workspace.connection(f.folders[1]), /No credentials/);
    f.secrets.set(key, JSON.stringify({ consumerToken: 'synthetic', restlet: 'https://malicious.example', realm: 'other' }));
    await f.workspace.connection(f.folders[0]);
    assert.equal(f.clients[0].restlet, endpoint);
    assert.equal(f.clients[0].realm, '123');
    f.secrets.set(key, '{"consumerSecret":"synthetic-sensitive" BAD}');
    await assert.rejects(f.workspace.connection(f.folders[0]), error => !error.message.includes('synthetic-sensitive') && /Saved credentials/.test(error.message));
    await f.writeConfig(f.folders[0], { restlet: endpoint.replace('deploy=1', 'deploy=2'), realm: '123' });
    await assert.rejects(f.workspace.connection(f.folders[0]), /No credentials/);
});

test('legacy migration preserves shared and lower-priority credentials for other roots', async t => {
    const f = await fixture(t);
    const key = await f.authorize();
    const legacy = Object.fromEntries(credentialNames.map(name => [name,
        { globalValue: 'other-account-' + name, workspaceFolderValue: 'selected-account-' + name }]));
    f.set('netSuiteUpload', f.folders[0], legacy);
    await f.workspace.migrateCredentials(f.folders[0].uri);
    const migrated = JSON.parse(f.secrets.get(key));
    assert.equal(migrated.consumerSecret, 'selected-account-consumerSecret');
    assert.equal(legacy.consumerSecret.globalValue, 'other-account-consumerSecret');
    assert.equal(legacy.consumerSecret.workspaceFolderValue, undefined);
    assert.ok(f.updates.every(update => update.target === 3 && update.folder === 'first'));
    assert.match(f.messages.at(-1)[1], /Shared workspace\/user credential settings were retained/);
    assert.ok(!JSON.stringify([...f.messages, ...f.logs]).includes('selected-account-consumerSecret'));
});

test('metadata cache is connection scoped and stores only field descriptors', async t => {
    const f = await fixture(t);
    const key = await f.authorize(f.folders[0], { metadataRecordTypes: ['SalesOrder'] });
    await f.authorize(f.folders[1]);
    await f.workspace.refreshMetadata(f.folders[0].uri);
    assert.equal(f.requests[0].payload.recordType, 'salesorder');
    assert.ok(!JSON.stringify(f.state.get(key + '.fields')).includes('MUST_NOT_CACHE'));
    assert.equal((await f.workspace.cachedFields({ uri: f.folders[0].uri }))[0].id, 'entityid');
    assert.equal((await f.workspace.cachedFields({ uri: f.folders[1].uri })).length, 0);
    await f.workspace.clearCredentials(f.folders[0].uri);
    assert.equal(f.state.has(key + '.fields'), false);
});

test('metadata completion cannot restore cached fields after credentials are cleared', async t => {
    const f = await fixture(t);
    const key = await f.authorize(f.folders[0], { metadataRecordTypes: ['customer'] });
    f.metadata = async () => {
        await f.workspace.clearCredentials(f.folders[0].uri);
        return { fields: [{ id: 'old_role_field' }] };
    };
    await f.workspace.refreshMetadata(f.folders[0].uri);
    assert.equal(f.state.has(key + '.fields'), false);
    assert.match(f.messages.at(-1)[1], /refresh stopped/);
});

test('metadata cancellation and disposal stop requests without claiming success', async t => {
    const f = await fixture(t);
    await f.authorize(f.folders[0], { metadataRecordTypes: ['customer', 'salesorder'] });
    f.token.cancel();
    await f.workspace.refreshMetadata(f.folders[0].uri);
    assert.equal(f.requests.length, 0);
    assert.match(f.messages.at(-1)[1], /refresh stopped/);
    f.token.isCancellationRequested = false;
    f.metadata = async (_action, _payload, { signal }) => {
        f.workspace.dispose();
        assert.equal(signal.aborted, true);
        throw new Error('cancelled');
    };
    const before = f.messages.length;
    await f.workspace.refreshMetadata(f.folders[0].uri);
    assert.equal(f.requests.length, 1);
    assert.equal(f.messages.length, before);
    assert.equal(f.logs.length, 0);
});

test('untrusted workspaces reject setup and hide account metadata', async t => {
    const f = await fixture(t);
    f.vscode.workspace.isTrusted = false;
    await assert.rejects(f.workspace.setup(f.folders[0].uri), /Trust this workspace/);
    assert.equal((await f.workspace.cachedFields({ uri: f.folders[0].uri })).length, 0);
    assert.equal(f.secretWrites.length, 0);
});
