'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { DEFAULTS, readConfig, connectionKey } = require('../helpers/config');

const endpoint = 'https://123456-sb1.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=1&deploy=1';
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
function uri(filename) { const fsPath = path.resolve(filename); return { scheme: 'file', fsPath, toString: () => pathToFileURL(fsPath).href }; }

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'supersuite-init-'));
    t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
    const folder = { name: 'Fresh workspace', uri: uri(root) };
    const state = new Map();
    const globals = new Map();
    const secrets = new Map();
    const calls = [];
    const messages = [];
    const documents = [];
    const f = {
        root, folder, state, globals, secrets, calls, messages, documents,
        picks: [], inputs: [], infos: [], warnings: [], errors: [], opens: [],
        recordTypes: ['customer'],
        credentialsResult: true,
        fileResult: { succeeded: 2, failed: 0, cancelled: false },
        metadataResult: { succeeded: 1, failed: 0, cancelled: false },
        exportResult: { complete: true, failed: 0, cancelled: false, exportDirectory: path.join(root, '.supersuite-data', 'snapshot') },
        version: async () => ({ protocolVersion: 2, capabilities: { recordExport: true } }),
        planCalls: 0
    };
    const answer = async (queue, fallback, ...args) => { const value = queue.length ? queue.shift() : fallback; return typeof value === 'function' ? value(...args) : value; };
    const message = kind => async (text, ...args) => {
        messages.push({ kind, text, args });
        const action = typeof args[0] === 'object' ? args[1] : args[0];
        return answer(f[kind], action === 'Show Output' || kind === 'errors' ? undefined : action, text, ...args);
    };
    const memory = values => ({ get(key, fallback) { return values.has(key) ? clone(values.get(key)) : fallback; }, async update(key, value) { if (value === undefined) values.delete(key); else values.set(key, clone(value)); } });
    const context = {
        extensionPath: path.resolve(__dirname, '..'), workspaceState: memory(state), globalState: memory(globals),
        secrets: { async get(key) { return secrets.get(key); }, async store(key, value) { secrets.set(key, value); } }
    };
    const vscode = {
        Uri: { file: uri, parse: value => ({ toString: () => value }) },
        ProgressLocation: { Notification: 15 },
        workspace: { isTrusted: true, workspaceFolders: [folder], textDocuments: documents, async openTextDocument(filename) { return { filename }; } },
        commands: { async executeCommand(command, ...args) { calls.push({ action: 'command', command, args }); } },
        env: { async openExternal(value) { calls.push({ action: 'external', uri: value.toString() }); return true; } },
        window: {
            showInformationMessage: message('infos'), showWarningMessage: message('warnings'), showErrorMessage: message('errors'),
            async showQuickPick(items, options) {
                messages.push({ kind: 'pick', options });
                const fallback = items.find(item => ['resume', 'saved'].includes(item.value));
                const selected = await answer(f.picks, fallback, items, options);
                return typeof selected === 'object' || selected === undefined ? selected : items.find(item => item.value === selected);
            },
            async showInputBox(options) { messages.push({ kind: 'input', options }); return answer(f.inputs, undefined, options); },
            async showOpenDialog() { return answer(f.opens, undefined); },
            async showTextDocument(document) { calls.push({ action: 'document', document }); },
            async withProgress(_options, work) { return work({ report() {} }, { isCancellationRequested: false, onCancellationRequested() { return { dispose() {} }; } }); }
        }
    };
    const configuration = {
        async folder() { return folder; },
        async config(selected) { return readConfig(selected.uri.fsPath); },
        async configureCredentials(selected) {
            calls.push({ action: 'credentials', uri: selected.toString() });
            if (!f.credentialsResult) return false;
            const config = await this.config(folder);
            secrets.set(connectionKey(folder.uri.toString(), config), JSON.stringify({ consumerToken: 'SYNTHETIC_PRIVATE_KEY' }));
            return true;
        },
        async connection(selected) {
            const config = await this.config(selected);
            if (!secrets.has(connectionKey(selected.uri.toString(), config))) throw new Error('No saved credentials');
            return { config, client: { async request(action, _payload, options) { calls.push({ action, config: clone(config), options }); return f.version(config, options); } } };
        },
        async refreshMetadata(selected, automatic) { calls.push({ action: 'metadata', uri: selected.toString(), automatic }); return clone(f.metadataResult); }
    };
    const commands = {
        requireProtocol(version) { if (version.protocolVersion !== 2) throw new Error('Deploy protocol 2 RESTlet'); },
        async execute(action, selected) { calls.push({ action, uri: selected.toString() }); return typeof f.fileResult === 'function' ? f.fileResult() : clone(f.fileResult); }
    };
    const exporter = { async exportRecords(selected, types, options) { calls.push({ action: 'records', uri: selected.uri.toString(), types: [...types], options }); return clone(f.exportResult); } };
    const taskRunner = { async run(selected, projectRoot, args) { calls.push({ action: 'task', uri: selected.uri.toString(), projectRoot, args: [...args] }); return f.taskResult ? f.taskResult(args) : { cancelled: false, exitCode: 0 }; } };
    const bootstrap = {
        ensureConfigIgnored: require('../setup/bootstrap').ensureConfigIgnored,
        async createBootstrapProject(workspaceRoot, options) { calls.push({ action: 'bootstrap', workspaceRoot, options }); f.bootstrapProject = { projectRoot: path.join(root, '.config', 'supersuite-sdf'), restletUrl: endpoint, ...clone(options) }; return clone(f.bootstrapProject); },
        async readBootstrapProject() { return clone(f.bootstrapProject); },
        suiteCloudCommands(alias) { return { authenticate: alias ? ['account:setup:ci', '--select', alias] : ['account:setup', '--interactive'], preview: ['project:deploy', '--dryrun'], deploy: ['project:deploy'] }; }
    };
    const sourceFile = path.resolve(__dirname, '../helpers/initialize.js');
    const localRequire = createRequire(sourceFile);
    const module = { exports: {} };
    vm.runInNewContext(await fs.readFile(sourceFile, 'utf8'), {
        module, Buffer, AbortController, process,
        require(name) { return name === 'vscode' ? vscode : localRequire(name); }
    }, { filename: sourceFile });
    const { InitializationWizard, PENDING_INIT, stateKey, fingerprint } = module.exports;
    Object.assign(f, { context, vscode, configuration, PENDING_INIT, stateKey, fingerprint });
    f.wizard = new InitializationWizard(context, configuration, commands, exporter, taskRunner, { appendLine: line => calls.push({ action: 'output', line }), show() { calls.push({ action: 'showOutput' }); } }, { bootstrap, selectRecordTypes: async () => clone(f.recordTypes) });
    f.realPlan = f.wizard.plan;
    f.plan = { schemaVersion: 1, config: { ...DEFAULTS, realm: '123456_SB1', restlet: endpoint }, mode: 'existing', recordTypes: ['customer'], metadata: true, deployed: true, complete: false };
    f.wizard.plan = async () => { f.planCalls++; return clone(f.plan); };
    f.saved = () => clone(state.get(stateKey(folder)));
    f.seed = async overrides => {
        const value = { ...clone(f.plan), connection: fingerprint(f.plan.config), credentialsReady: true, ...overrides };
        await f.wizard.writeConfig(folder, value.config);
        state.set(stateKey(folder), clone(value));
        secrets.set(connectionKey(folder.uri.toString(), value.config), '{"consumerToken":"SYNTHETIC_SAVED_SECRET"}');
        return value;
    };
    t.after(() => f.wizard.dispose());
    return f;
}

test('initialization collects credentials, verifies RESTlet, pulls files and exports selected records', async t => {
    const f = await fixture(t);
    const result = await f.wizard.initialize(f.folder.uri);
    assert.equal(result.complete, true);
    assert.equal(result.cancelled, false);
    assert.deepEqual(f.calls.map(call => call.action), ['credentials', 'version', 'downloadFolder', 'metadata', 'records']);
    assert.equal(f.saved().filesDone, true);
    assert.equal(f.saved().metadataDone, true);
    assert.equal(f.saved().recordsDone, true);
    assert.equal(f.saved().complete, true);
    assert.equal(f.calls.find(call => call.action === 'records').options.resume, true);
    assert.ok(!JSON.stringify([...f.state]).includes('SYNTHETIC_PRIVATE_KEY'));
    assert.ok(!(await fs.readFile(path.join(f.root, '.config', 'supersuite.json'), 'utf8')).includes('SYNTHETIC_PRIVATE_KEY'));
    assert.match(f.messages.at(-1).text, /SuperSuite initialized/);
});

test('cancelled credential entry leaves a resumable setup with no network import', async t => {
    const f = await fixture(t);
    f.credentialsResult = false;
    assert.equal((await f.wizard.initialize(f.folder.uri)).cancelled, true);
    assert.equal(f.saved().complete, false);
    assert.deepEqual(f.calls.map(call => call.action), ['credentials']);
    assert.equal(f.wizard.active.size, 0);
    f.credentialsResult = true;
    assert.equal((await f.wizard.initialize(f.folder.uri)).complete, true);
    assert.equal(f.planCalls, 1, 'Resume should retain the original plan.');
});

test('partial file imports remain unfinished and resume without repeating completed record exports', async t => {
    const f = await fixture(t);
    f.fileResult.failed = 1;
    assert.equal((await f.wizard.initialize(f.folder.uri)).complete, false);
    assert.equal(f.saved().filesDone, false);
    assert.equal(f.saved().recordsDone, true);
    assert.match(f.messages.at(-1).text, /unfinished imports/);
    f.fileResult.failed = 0;
    assert.equal((await f.wizard.initialize(f.folder.uri)).complete, true);
    assert.equal(f.calls.filter(call => call.action === 'downloadFolder').length, 2);
    assert.equal(f.calls.filter(call => call.action === 'records').length, 1);
    assert.equal(f.calls.filter(call => call.action === 'credentials').length, 1);
});

test('an export with incomplete pages is not marked complete even when no records failed', async t => {
    const f = await fixture(t);
    f.exportResult.complete = false;
    assert.equal((await f.wizard.initialize(f.folder.uri)).complete, false);
    assert.equal(f.saved().recordsDone, false);
    f.exportResult.complete = true;
    assert.equal((await f.wizard.initialize(f.folder.uri)).complete, true);
    assert.equal(f.calls.filter(call => call.action === 'downloadFolder').length, 1);
    assert.equal(f.calls.filter(call => call.action === 'records').length, 2);
});

test('metadata errors remain resumable, and transfer cancellation prevents later phases', async t => {
    const f = await fixture(t);
    f.metadataResult.failed = 1;
    assert.equal((await f.wizard.initialize(f.folder.uri)).complete, false);
    assert.equal(f.saved().metadataDone, false);
    f.metadataResult.failed = 0;
    assert.equal((await f.wizard.initialize(f.folder.uri)).complete, true);
    assert.equal(f.calls.filter(call => call.action === 'metadata').length, 2);
    assert.equal(f.calls.filter(call => call.action === 'records').length, 1);
    f.fileResult.cancelled = true;
    const before = f.calls.length;
    assert.equal((await f.wizard.initialize(f.folder.uri)).cancelled, true);
    assert.ok(!f.calls.slice(before).some(call => ['metadata', 'records'].includes(call.action)));
});

test('connection failure stops import and preserves setup for another attempt', async t => {
    const f = await fixture(t);
    f.version = async () => { throw new Error('Role does not have RESTlet access'); };
    assert.equal((await f.wizard.initialize(f.folder.uri)).cancelled, true);
    assert.ok(!f.calls.some(call => call.action === 'downloadFolder'));
    assert.equal(f.saved().credentialsReady, true);
    assert.match(f.messages.at(-1).text, /Role does not have RESTlet access/);
    assert.equal(f.wizard.active.size, 0);
});

test('editing the RESTlet URL clears completed phases and binds new credentials to the new endpoint', async t => {
    const f = await fixture(t);
    await f.seed({ filesDone: true, metadataDone: true, recordsDone: true });
    const updatedEndpoint = endpoint.replace('deploy=1', 'deploy=2');
    f.version = async config => { if (config.restlet === endpoint) throw new Error('Old deployment unavailable'); return { protocolVersion: 2, capabilities: { recordExport: true } }; };
    f.errors.push('Edit RESTlet URL');
    f.inputs.push(updatedEndpoint);
    assert.equal((await f.wizard.initialize(f.folder.uri)).complete, true);
    assert.deepEqual(f.calls.filter(call => ['downloadFolder', 'metadata', 'records'].includes(call.action)).map(call => call.action), ['downloadFolder', 'metadata', 'records']);
    const config = await readConfig(f.root);
    assert.equal(config.restlet, updatedEndpoint);
    assert.equal(f.saved().connection, f.fingerprint(config));
    assert.ok(f.secrets.has(connectionKey(f.folder.uri.toString(), config)));
    assert.equal(f.calls.filter(call => call.action === 'credentials').length, 1);
});

test('an externally changed connection invalidates an old resume plan', async t => {
    const f = await fixture(t);
    await f.seed({ filesDone: true });
    f.plan.config.rootDirectory = 'SuiteScripts/Other';
    await f.wizard.writeConfig(f.folder, f.plan.config);
    assert.equal((await f.wizard.initialize(f.folder.uri)).complete, true);
    assert.equal(f.planCalls, 1);
    assert.equal(f.calls.filter(call => call.action === 'downloadFolder').length, 1);
    assert.equal(f.saved().config.rootDirectory, 'SuiteScripts/Other');
    assert.notEqual(f.stateKey(f.folder), f.stateKey({ uri: uri(path.join(f.root, 'another')) }));
});

test('empty-window Init hands off to the chosen folder and resumes exactly once', async t => {
    const f = await fixture(t);
    f.vscode.workspace.workspaceFolders = [];
    f.opens.push([f.folder.uri]);
    assert.equal((await f.wizard.initialize()).cancelled, true);
    assert.equal(f.globals.get(f.PENDING_INIT), f.folder.uri.toString());
    assert.deepEqual(f.calls.map(call => call.command), ['vscode.openFolder']);
    assert.equal(f.state.size, 0);
    f.vscode.workspace.workspaceFolders = [f.folder];
    assert.equal((await f.wizard.resumePending()).complete, true);
    assert.equal(f.globals.has(f.PENDING_INIT), false);
    const before = f.calls.length;
    await f.wizard.resumePending();
    assert.equal(f.calls.length, before);
});

test('an unrelated or untrusted folder cannot consume a pending initialization', async t => {
    const f = await fixture(t);
    f.globals.set(f.PENDING_INIT, uri(path.join(f.root, 'other')).toString());
    await f.wizard.resumePending();
    assert.equal(f.calls.length, 0);
    assert.ok(f.globals.has(f.PENDING_INIT));
    f.globals.set(f.PENDING_INIT, f.folder.uri.toString());
    f.vscode.workspace.isTrusted = false;
    await f.wizard.resumePending();
    assert.ok(f.globals.has(f.PENDING_INIT));
    await assert.rejects(f.wizard.initialize(), /Trust this workspace/);
});

test('real plan cancellation creates no configuration and normalizes account and root input', async t => {
    const f = await fixture(t);
    f.wizard.plan = f.realPlan;
    assert.equal((await f.wizard.initialize()).cancelled, true);
    await assert.rejects(fs.stat(path.join(f.root, '.config')), { code: 'ENOENT' });
    f.picks.push('existing', 'tba', true);
    f.inputs.push(' 123456_sb1 ', ' SuiteScripts/Project ', ` ${endpoint} `);
    const plan = await f.wizard.plan(f.folder, DEFAULTS);
    assert.equal(plan.config.realm, '123456_SB1');
    assert.equal(plan.config.rootDirectory, 'SuiteScripts/Project');
    assert.equal(plan.config.restlet, endpoint);
    assert.deepEqual(Array.from(plan.config.metadataRecordTypes), ['customer']);
});

test('key setup help opens the bundled guide and returns to credential entry', async t => {
    const f = await fixture(t);
    f.infos.push('Open Key Setup Guide', 'Enter Keys');
    await f.wizard.writeConfig(f.folder, f.plan.config);
    assert.equal(await f.wizard.credentials(f.folder, f.plan.config), true);
    assert.equal(f.calls[0].command, 'markdown.showPreview');
    assert.equal(f.calls[0].args[0].fsPath, path.join(f.context.extensionPath, 'docs', 'ACCESS_SETUP.md'));
    assert.equal(f.calls[1].action, 'credentials');
});

test('Init never overwrites an unsaved configuration document', async t => {
    const f = await fixture(t);
    const filename = path.join(f.root, '.config', 'supersuite.json');
    await f.wizard.writeConfig(f.folder, f.plan.config);
    const before = await fs.readFile(filename, 'utf8');
    f.documents.push({ uri: uri(filename), isDirty: true });
    await assert.rejects(f.wizard.initialize(), /Save or revert/);
    assert.equal(await fs.readFile(filename, 'utf8'), before);
    assert.equal(f.calls.length, 0);
    assert.equal(f.wizard.active.size, 0);
});

test('manual deployment asks for keys only after the final deployment URL is supplied', async t => {
    const f = await fixture(t);
    f.plan.mode = 'manual';
    f.plan.deployed = false;
    f.plan.roleId = 'DEVELOPER';
    f.inputs.push(endpoint.replace('script=1', 'script=77'));
    assert.equal((await f.wizard.initialize()).complete, true);
    assert.equal(f.calls.filter(call => call.action === 'credentials').length, 1);
    assert.equal(f.calls.find(call => call.action === 'version').config.restlet, endpoint.replace('script=1', 'script=77'));
    assert.equal(f.calls.some(call => call.action === 'task'), false);
});

test('automatic setup authenticates, previews, and deploys before importing account files', async t => {
    const f = await fixture(t);
    f.plan.mode = 'automatic';
    f.plan.deployed = false;
    f.plan.roleId = 'DEVELOPER';
    f.picks.push('profile');
    f.inputs.push('sandbox.profile');
    f.warnings.push(() => {
        assert.deepEqual(f.calls.filter(call => call.action === 'task').map(call => call.args), [
            ['account:setup:ci', '--select', 'sandbox.profile'], ['project:deploy', '--dryrun']
        ], 'The user must be able to review the deployment preview before the final confirmation.');
        return 'Deploy to This Account';
    });
    assert.equal((await f.wizard.initialize()).complete, true);
    assert.deepEqual(f.calls.filter(call => call.action === 'task').map(call => call.args), [
        ['account:setup:ci', '--select', 'sandbox.profile'], ['project:deploy', '--dryrun'], ['project:deploy']
    ]);
    assert.ok(f.calls.findIndex(call => call.action === 'downloadFolder') > f.calls.findLastIndex(call => call.action === 'task'));
});

test('disposal during planning prevents configuration and credential writes', async t => {
    const f = await fixture(t);
    f.wizard.plan = async () => { f.wizard.dispose(); return clone(f.plan); };
    assert.equal((await f.wizard.initialize()).cancelled, true);
    await assert.rejects(fs.stat(path.join(f.root, '.config')), { code: 'ENOENT' });
    assert.equal(f.secrets.size, 0);
    assert.equal(f.state.size, 0);
    assert.equal(f.calls.length, 0);
    assert.equal(f.wizard.active.size, 0);
});

test('disposal aborts connection verification and suppresses subsequent prompts and imports', async t => {
    const f = await fixture(t);
    let before;
    f.version = async (_config, options) => {
        before = f.messages.length;
        f.wizard.dispose();
        assert.equal(options.signal.aborted, true);
        const error = new Error('Request cancelled');
        error.name = 'AbortError';
        throw error;
    };
    assert.equal((await f.wizard.initialize()).cancelled, true);
    assert.equal(f.messages.length, before);
    assert.ok(!f.calls.some(call => ['downloadFolder', 'metadata', 'records'].includes(call.action)));
    assert.equal(f.wizard.controllers.size, 0);
    assert.equal(f.wizard.active.size, 0);
});

test('a connection changed during file pull stops later phases and leaves the original plan unfinished', async t => {
    const f = await fixture(t);
    f.fileResult = async () => {
        await f.wizard.writeConfig(f.folder, { ...f.plan.config, realm: '987654_SB1' });
        return { succeeded: 2, failed: 0, cancelled: false };
    };
    await assert.rejects(f.wizard.initialize(), /connection settings changed during setup/);
    assert.ok(!f.calls.some(call => ['metadata', 'records'].includes(call.action)));
    assert.equal(f.saved().complete, false);
    assert.equal(f.wizard.active.size, 0);
});

test('changing account settings after SuiteCloud authentication prevents deployment', async t => {
    const f = await fixture(t);
    f.plan.mode = 'automatic';
    f.plan.deployed = false;
    f.plan.roleId = 'DEVELOPER';
    f.picks.push('browser');
    f.taskResult = async () => {
        await f.wizard.writeConfig(f.folder, { ...f.plan.config, realm: '987654_SB1' });
        return { cancelled: false, exitCode: 0 };
    };
    await assert.rejects(f.wizard.initialize(), /connection settings changed during setup/);
    assert.deepEqual(f.calls.filter(call => call.action === 'task').map(call => call.args), [['account:setup', '--interactive']]);
    assert.equal(f.calls.some(call => call.action === 'downloadFolder'), false);
    assert.equal(f.saved().deployed, false);
});

test('only one initialization may run in a workspace at a time', async t => {
    const f = await fixture(t);
    let release;
    let planning;
    const enteredPlan = new Promise(resolve => { planning = resolve; });
    f.wizard.plan = () => new Promise(resolve => { release = resolve; planning(); });
    const first = f.wizard.initialize();
    await enteredPlan;
    await assert.rejects(f.wizard.initialize(), /Setup is already running/);
    release(undefined);
    assert.equal((await first).cancelled, true);
    assert.equal(f.wizard.active.size, 0);
});

test('remote account, user, and role identity is hashed and each change restarts all import phases', async t => {
    const f = await fixture(t);
    const identity = { accountId: '123456_SB1', userId: 'PRIVATE_USER_1024', roleId: 'PRIVATE_ROLE_2048' };
    f.version = async () => ({ protocolVersion: 2, capabilities: { recordExport: true }, identity: clone(identity) });
    assert.equal((await f.wizard.initialize()).complete, true);
    let previous = f.saved().remoteIdentity;
    assert.match(previous, /^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify([...f.state]).includes(identity.userId));
    assert.ok(!JSON.stringify([...f.state]).includes(identity.roleId));
    for (const [property, value] of [['roleId', 'PRIVATE_ROLE_NEW'], ['userId', 'PRIVATE_USER_NEW'], ['accountId', '987654_SB1']]) {
        const saved = f.saved();
        saved.complete = false; // Resume after phases finished but final setup state was not committed.
        f.state.set(f.stateKey(f.folder), saved);
        identity[property] = value;
        f.calls.length = 0;
        assert.equal((await f.wizard.initialize()).complete, true);
        assert.deepEqual(f.calls.filter(call => ['downloadFolder', 'metadata', 'records'].includes(call.action)).map(call => call.action), ['downloadFolder', 'metadata', 'records'], `${property} changes must not reuse import completion from a different NetSuite identity.`);
        const current = f.saved().remoteIdentity;
        assert.match(current, /^[a-f0-9]{64}$/);
        assert.notEqual(current, previous);
        previous = current;
    }
    assert.equal(f.planCalls, 1, 'Identity changes retain the approved setup choices while restarting imports.');
});

test('the same remote identity preserves completed import phases during resume', async t => {
    const f = await fixture(t);
    f.version = async () => ({ protocolVersion: 2, capabilities: { recordExport: true }, identity: { accountId: '123456_SB1', userId: '1024', roleId: '2048' } });
    await f.wizard.initialize();
    const saved = f.saved();
    saved.complete = false;
    f.state.set(f.stateKey(f.folder), saved);
    f.calls.length = 0;
    assert.equal((await f.wizard.initialize()).complete, true);
    assert.deepEqual(f.calls.map(call => call.action), ['version']);
    assert.equal(f.saved().remoteIdentity, saved.remoteIdentity);
});

test('Init after disposal returns cancellation without opening UI or writing state', async t => {
    const f = await fixture(t);
    f.vscode.workspace.workspaceFolders = [];
    f.opens.push(() => { throw new Error('Disposed setup must not open a folder picker.'); });
    f.wizard.dispose();
    assert.equal((await f.wizard.initialize()).cancelled, true);
    assert.equal(f.calls.length, 0);
    assert.equal(f.messages.length, 0);
    assert.equal(f.state.size, 0);
    assert.equal(f.globals.size, 0);
    await assert.rejects(fs.stat(path.join(f.root, '.config')), { code: 'ENOENT' });
});

test('declining final deployment confirmation stops after preview and remains resumable', async t => {
    const f = await fixture(t);
    f.plan.mode = 'automatic';
    f.plan.deployed = false;
    f.plan.roleId = 'DEVELOPER';
    f.picks.push('browser');
    f.warnings.push(undefined);
    assert.equal((await f.wizard.initialize()).cancelled, true);
    assert.deepEqual(f.calls.filter(call => call.action === 'task').map(call => call.args), [
        ['account:setup', '--interactive'], ['project:deploy', '--dryrun']
    ]);
    assert.equal(f.calls.some(call => call.action === 'downloadFolder'), false);
    assert.equal(f.saved().deployed, false);
    assert.equal(f.saved().complete, false);
    assert.equal(f.wizard.active.size, 0);
});
