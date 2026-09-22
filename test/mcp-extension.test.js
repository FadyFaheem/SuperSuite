'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const realAccount = require('../mcp/account');

const endpoint = 'https://123456-sb1.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=1&deploy=1';
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
function uri(filename) { const fsPath = path.resolve(filename); return { scheme: 'file', fsPath, toString: () => pathToFileURL(fsPath).href }; }
const syntheticCredentials = JSON.stringify({ consumerToken: 'SYNTHETIC_CONSUMER', consumerSecret: 'SYNTHETIC_CONSUMER_SECRET', netSuiteKey: 'SYNTHETIC_TOKEN', netSuiteSecret: 'SYNTHETIC_TOKEN_SECRET' });

async function fixture(t, { native = true } = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'supersuite-mcp-ui-'));
    t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
    const folder = { name: 'MCP workspace', uri: uri(root) };
    const state = new Map();
    const globals = new Map();
    const secrets = new Map();
    const calls = [];
    const messages = [];
    const f = { root, folder, state, globals, secrets, calls, messages, picks: [], inputs: [], infos: [], verification: async () => ({ readOnlyMode: true }) };
    const disposable = () => ({ dispose() {} });
    class EventEmitter {
        constructor() { this.listeners = []; this.event = listener => { this.listeners.push(listener); return disposable(); }; }
        fire() { for (const listener of this.listeners) listener(); }
        dispose() { this.listeners = []; }
    }
    const answer = async (queue, ...args) => { const result = queue.shift(); return typeof result === 'function' ? result(...args) : result; };
    const memory = values => ({ get(key, fallback) { return values.has(key) ? clone(values.get(key)) : fallback; }, async update(key, value) { calls.push({ action: 'state', key, value }); if (value === undefined) values.delete(key); else values.set(key, clone(value)); } });
    const context = {
        extensionPath: path.resolve(__dirname, '..'), extension: { packageJSON: { version: '2.2.0' } }, workspaceState: memory(state), globalState: memory(globals),
        secrets: {
            async get(key) { calls.push({ action: 'secretGet', key }); return f.secretGet ? f.secretGet(key) : secrets.get(key); },
            async store(key, value) { calls.push({ action: 'secretStore', key }); secrets.set(key, value); },
            onDidChange: disposable
        }
    };
    const vscode = {
        EventEmitter, Uri: { file: uri }, ProgressLocation: { Notification: 15 },
        workspace: {
            isTrusted: true, workspaceFolders: [folder], textDocuments: [],
            onDidChangeWorkspaceFolders: disposable,
            onDidGrantWorkspaceTrust: disposable,
            createFileSystemWatcher() { return { dispose() {}, onDidChange: disposable, onDidCreate: disposable, onDidDelete: disposable }; }
        },
        commands: { async executeCommand(command, ...args) { calls.push({ action: 'command', command, args }); } },
        window: {
            async showQuickPick(items, options) {
                messages.push({ kind: 'pick', options });
                const selected = await answer(f.picks, items, options);
                return typeof selected === 'object' || selected === undefined ? selected : items.find(item => item.value === selected);
            },
            async showInputBox(options) { messages.push({ kind: 'input', options }); return answer(f.inputs, options); },
            async showInformationMessage(text, ...args) { messages.push({ kind: 'info', text, args }); return answer(f.infos, text, ...args); },
            async withProgress(options, callback) {
                calls.push({ action: 'progress', options });
                return callback({ report() {} }, f.progressToken || { isCancellationRequested: false, onCancellationRequested: disposable });
            }
        }
    };
    if (native) {
        vscode.lm = { registerMcpServerDefinitionProvider(id, provider) { calls.push({ action: 'register', id, provider }); return disposable(); } };
        vscode.McpStdioServerDefinition = class {
            constructor(label, command, args, env, version) { Object.assign(this, { label, command, args, env, version }); }
        };
    }
    const configuration = { async folder() { return folder; } };
    const sourceFile = path.resolve(__dirname, '../mcp/extension.js');
    const localRequire = createRequire(sourceFile);
    const module = { exports: {} };
    vm.runInNewContext(await fs.readFile(sourceFile, 'utf8'), {
        module, Buffer, AbortController, process,
        require(name) {
            if (name === 'vscode') return vscode;
            if (name === './account') return { ...realAccount, createAccountReader(connection) { return { async connectionInfo(options) { calls.push({ action: 'verify', connection, options }); return f.verification(options); } }; } };
            return localRequire(name);
        }
    }, { filename: sourceFile });
    Object.assign(f, module.exports, { context, vscode, configuration });
    f.integration = new f.McpIntegration(context, configuration, { appendLine(text) { calls.push({ action: 'output', text }); } });
    t.after(() => f.integration.dispose());
    f.config = f.cleanConfig({ restlet: endpoint, realm: '123456_SB1', authType: 'tba' });
    f.seed = async ({ approved = true, credentials = syntheticCredentials, config = f.config } = {}) => {
        await fs.mkdir(path.join(root, '.config'), { recursive: true });
        await fs.writeFile(path.join(root, f.CONFIG_PATH), JSON.stringify(config));
        if (approved) state.set(f.enabledKey(folder), f.fingerprint(config));
        if (credentials !== undefined) secrets.set(f.credentialKey(folder, config), credentials);
    };
    f.startAccountForm = () => {
        f.picks.push('account', 'tba');
        f.inputs.push(endpoint, '123456_sb1', 'SYNTHETIC_CONSUMER', 'SYNTHETIC_CONSUMER_SECRET', 'SYNTHETIC_TOKEN', 'SYNTHETIC_TOKEN_SECRET');
        f.infos.push('Test and Enable');
    };
    return f;
}

test('native MCP discovery requires prior approval bound to the exact connection and never reads secrets', async t => {
    const f = await fixture(t);
    await f.seed({ approved: false });
    assert.equal((await f.integration.provideMcpServerDefinitions()).length, 0);
    f.state.set(f.enabledKey(f.folder), f.fingerprint(f.config));
    const definitions = await f.integration.provideMcpServerDefinitions();
    assert.equal(definitions.length, 1);
    assert.equal(definitions[0].command, process.execPath);
    assert.equal(definitions[0].env.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(definitions[0].env[realAccount.CREDENTIALS_ENV], '');
    assert.equal(definitions[0].env[realAccount.CONNECTION_ENV], '');
    assert.equal(f.calls.filter(call => call.action === 'secretGet' || call.action === 'verify').length, 0);
    assert.equal(f.messages.length, 0);
    await f.seed({ config: { ...f.config, restlet: endpoint.replace('script=1', 'script=2') }, approved: false });
    assert.equal((await f.integration.provideMcpServerDefinitions()).length, 0);
});

test('resolution reconstructs the executable and env, ignoring caller tampering, and retrieves only dedicated secrets', async t => {
    const f = await fixture(t);
    await f.seed();
    const [definition] = await f.integration.provideMcpServerDefinitions();
    const resolved = await f.integration.resolveMcpServerDefinition({ ...definition, command: 'malicious.exe', args: ['--expose'], env: { MALICIOUS: '1' } });
    assert.equal(resolved.command, process.execPath);
    assert.deepEqual([...resolved.args], [path.join(f.context.extensionPath, 'mcp/server.js')]);
    assert.equal(resolved.env.MALICIOUS, undefined);
    assert.equal(resolved.env[realAccount.CREDENTIALS_ENV], syntheticCredentials);
    assert.deepEqual(JSON.parse(resolved.env[realAccount.CONNECTION_ENV]), clone(f.config));
    assert.equal(f.calls.find(call => call.action === 'secretGet').key, f.credentialKey(f.folder, f.config));
    assert.ok(f.credentialKey(f.folder, f.config).startsWith('mcp.'));
    assert.equal(f.calls.filter(call => call.action === 'verify').length, 0);
    assert.equal(await f.integration.resolveMcpServerDefinition({ label: 'unknown' }), undefined);
});

test('documentation-only provider clears inherited account variables and does not access SecretStorage', async t => {
    const f = await fixture(t);
    f.globals.set('supersuite.mcp.documentation', true);
    const [definition] = await f.integration.provideMcpServerDefinitions();
    const resolved = await f.integration.resolveMcpServerDefinition(definition);
    assert.equal(resolved.env[realAccount.CONNECTION_ENV], '');
    assert.equal(resolved.env[realAccount.CREDENTIALS_ENV], '');
    assert.equal(resolved.env.NODE_OPTIONS, '');
    assert.equal(resolved.env.NODE_PATH, '');
    assert.equal(f.calls.filter(call => call.action === 'secretGet').length, 0);
    f.globals.delete('supersuite.mcp.documentation');
    assert.equal(await f.integration.resolveMcpServerDefinition(definition), undefined);
});

test('changed config, revoked approval and removed folders cannot resolve an approved definition', async t => {
    const f = await fixture(t);
    await f.seed();
    const [definition] = await f.integration.provideMcpServerDefinitions();
    await f.seed({ config: { ...f.config, realm: '999999_SB1' }, approved: false });
    await assert.rejects(f.integration.resolveMcpServerDefinition(definition), /settings changed/u);
    await f.seed();
    f.state.delete(f.enabledKey(f.folder));
    await assert.rejects(f.integration.resolveMcpServerDefinition(definition), /settings changed/u);
    f.vscode.workspace.workspaceFolders = [];
    assert.equal(await f.integration.resolveMcpServerDefinition(definition), undefined);
    assert.equal(f.calls.filter(call => call.action === 'secretGet').length, 0);
});

test('malformed or missing credentials are rejected at resolve time without prompting or exposing their contents', async t => {
    const f = await fixture(t);
    await f.seed({ credentials: '{SYNTHETIC_INVALID_SECRET' });
    const [definition] = await f.integration.provideMcpServerDefinitions();
    await assert.rejects(f.integration.resolveMcpServerDefinition(definition), error => /credentials/u.test(error.message) && !error.message.includes('SYNTHETIC'));
    f.secrets.clear();
    await assert.rejects(f.integration.resolveMcpServerDefinition(definition), /credentials/u);
    assert.equal(f.messages.length, 0);
});

test('successful account configuration verifies read-only capability before storing approval and keeps keys out of files', async t => {
    const f = await fixture(t);
    f.startAccountForm();
    await f.integration.configure(f.folder.uri);
    const stored = JSON.parse(await fs.readFile(path.join(f.root, f.CONFIG_PATH), 'utf8'));
    assert.equal(stored.realm, '123456_SB1');
    assert.equal(JSON.stringify(stored).includes('SYNTHETIC'), false);
    assert.equal(f.state.get(f.enabledKey(f.folder)), f.fingerprint(stored));
    assert.equal(f.secrets.get(f.credentialKey(f.folder, stored)), syntheticCredentials);
    assert.match(await fs.readFile(path.join(f.root, '.gitignore'), 'utf8'), /\/\.config\//u);
    const actions = f.calls.map(call => call.action);
    assert.ok(actions.indexOf('verify') < actions.indexOf('secretStore'));
    const masked = f.messages.filter(message => message.kind === 'input' && message.options.password === true);
    assert.equal(masked.length, 4);
    assert.match(f.messages.find(message => message.kind === 'info').args[0].detail, /model will receive record values/u);
});

test('cancelled account setup forms do not persist config, keys, approval or issue network requests', async t => {
    for (const stage of ['mode', 'url', 'realm', 'auth', 'credentials', 'consent']) {
        await t.test(stage, async t => {
            const f = await fixture(t);
            if (stage !== 'mode') f.picks.push('account');
            if (!['mode', 'url'].includes(stage)) f.inputs.push(endpoint);
            if (!['mode', 'url', 'realm'].includes(stage)) f.inputs.push('123456_SB1');
            if (['credentials', 'consent'].includes(stage)) f.picks.push('tba');
            if (stage === 'consent') f.inputs.push('SYNTHETIC_CONSUMER', 'SYNTHETIC_CONSUMER_SECRET', 'SYNTHETIC_TOKEN', 'SYNTHETIC_TOKEN_SECRET');
            await f.integration.configure(f.folder.uri);
            await assert.rejects(fs.stat(path.join(f.root, f.CONFIG_PATH)), { code: 'ENOENT' });
            assert.equal(f.secrets.size, 0);
            assert.equal(f.state.size, 0);
            assert.equal(f.calls.filter(call => ['verify', 'secretStore'].includes(call.action)).length, 0);
        });
    }
});

test('failed read-only verification leaves account MCP disabled and retains no credentials', async t => {
    const f = await fixture(t);
    f.startAccountForm();
    f.verification = async () => { throw new Error('READ_ONLY_REQUIRED'); };
    await assert.rejects(f.integration.configure(f.folder.uri), /READ_ONLY_REQUIRED/u);
    assert.equal(f.secrets.size, 0);
    assert.equal(f.state.size, 0);
    await assert.rejects(fs.stat(path.join(f.root, f.CONFIG_PATH)), { code: 'ENOENT' });
});

test('OAuth 2.0 setup stores only its dedicated masked access token', async t => {
    const f = await fixture(t);
    f.picks.push('account', 'oauth2');
    f.inputs.push(endpoint, '123456_SB1', 'SYNTHETIC_ACCESS_TOKEN');
    f.infos.push('Test and Enable');
    await f.integration.configure(f.folder.uri);
    const config = JSON.parse(await fs.readFile(path.join(f.root, f.CONFIG_PATH), 'utf8'));
    assert.equal(config.authType, 'oauth2');
    assert.deepEqual(JSON.parse(f.secrets.get(f.credentialKey(f.folder, config))), { accessToken: 'SYNTHETIC_ACCESS_TOKEN' });
    assert.equal(f.messages.filter(message => message.kind === 'input' && message.options.password).length, 1);
    assert.equal(JSON.stringify([...f.state]).includes('SYNTHETIC'), false);
});

test('cancelling saved-credential selection preserves prior files and approval without a request', async t => {
    const f = await fixture(t);
    await f.seed();
    const before = await fs.readFile(path.join(f.root, f.CONFIG_PATH), 'utf8');
    f.picks.push('account', 'tba', undefined);
    f.inputs.push(endpoint, '123456_SB1');
    await f.integration.configure(f.folder.uri);
    assert.equal(await fs.readFile(path.join(f.root, f.CONFIG_PATH), 'utf8'), before);
    assert.equal(f.secrets.get(f.credentialKey(f.folder, f.config)), syntheticCredentials);
    assert.equal(f.state.get(f.enabledKey(f.folder)), f.fingerprint(f.config));
    assert.equal(f.calls.filter(call => call.action === 'verify' || call.action === 'secretStore').length, 0);
});

test('cancelling connection verification prevents configuration from being enabled', async t => {
    const f = await fixture(t);
    f.startAccountForm();
    f.progressToken = { isCancellationRequested: true, onCancellationRequested: () => ({ dispose() {} }) };
    f.verification = async ({ signal }) => { assert.equal(signal.aborted, true); throw new Error('cancelled'); };
    await f.integration.configure(f.folder.uri);
    assert.equal(f.secrets.size, 0);
    assert.equal(f.state.size, 0);
});

test('dirty config and gitignore buffers are protected before any setup writes', async t => {
    const f = await fixture(t);
    f.startAccountForm();
    f.vscode.workspace.textDocuments.push({ isDirty: true, uri: uri(path.join(f.root, '.gitignore')) });
    await assert.rejects(f.integration.configure(f.folder.uri), /Save your MCP configuration/u);
    await assert.rejects(fs.stat(path.join(f.root, f.CONFIG_PATH)), { code: 'ENOENT' });
    assert.equal(f.secrets.size, 0);
});

test('trust and cancellation prevent discovery and resolution', async t => {
    const f = await fixture(t);
    await f.seed();
    const [definition] = await f.integration.provideMcpServerDefinitions();
    assert.equal((await f.integration.provideMcpServerDefinitions({ isCancellationRequested: true })).length, 0);
    assert.equal(await f.integration.resolveMcpServerDefinition(definition, { isCancellationRequested: true }), undefined);
    f.vscode.workspace.isTrusted = false;
    assert.equal((await f.integration.provideMcpServerDefinitions()).length, 0);
    await assert.rejects(f.integration.resolveMcpServerDefinition(definition), /Trust/u);
    await assert.rejects(f.integration.configure(), /Trust/u);
    assert.equal(f.calls.filter(call => call.action === 'secretGet').length, 0);
});

test('disposal cancels verification and prevents persistence or later server resolution', async t => {
    const f = await fixture(t);
    f.startAccountForm();
    f.verification = async ({ signal }) => { f.integration.dispose(); assert.equal(signal.aborted, true); throw new Error('cancelled'); };
    await f.integration.configure(f.folder.uri);
    assert.equal(f.secrets.size, 0);
    assert.equal(f.state.size, 0);
    assert.equal((await f.integration.provideMcpServerDefinitions()).length, 0);
    await assert.rejects(f.integration.resolveMcpServerDefinition({ label: 'anything' }), /shutting down/u);
});

test('older VS Code without native MCP APIs can configure documentation and open the standalone guide', async t => {
    const f = await fixture(t, { native: false });
    f.picks.push('docs');
    f.infos.push('Open MCP Guide');
    await f.integration.configure();
    assert.equal(f.globals.get('supersuite.mcp.documentation'), true);
    assert.ok(f.messages.some(message => /no native MCP provider API/u.test(message.text || '')));
    assert.ok(f.calls.some(call => call.action === 'command' && call.command === 'markdown.showPreview'));
    assert.equal(f.calls.filter(call => call.action === 'register').length, 0);
});

test('discovery discards definitions if workspace trust is revoked while reading configuration', async t => {
    const f = await fixture(t);
    await f.seed();
    const original = f.integration.readConfig.bind(f.integration);
    f.integration.readConfig = async folder => { const config = await original(folder); f.vscode.workspace.isTrusted = false; return config; };
    assert.equal((await f.integration.provideMcpServerDefinitions()).length, 0);
});

test('resolution does not return credentials if its workspace is removed during SecretStorage access', async t => {
    const f = await fixture(t);
    await f.seed();
    const [definition] = await f.integration.provideMcpServerDefinitions();
    f.secretGet = async key => { f.vscode.workspace.workspaceFolders = []; return f.secrets.get(key); };
    assert.equal(await f.integration.resolveMcpServerDefinition(definition), undefined);
});

test('resolution does not read credentials after disposal during configuration lookup', async t => {
    const f = await fixture(t);
    await f.seed();
    const [definition] = await f.integration.provideMcpServerDefinitions();
    const original = f.integration.readConfig.bind(f.integration);
    f.integration.readConfig = async folder => { const config = await original(folder); f.integration.dispose(); return config; };
    await assert.rejects(f.integration.resolveMcpServerDefinition(definition), /shutting down/u);
    assert.equal(f.calls.filter(call => call.action === 'secretGet').length, 0);
});

test('resolution honors approval revocation while credentials are being retrieved', async t => {
    const f = await fixture(t);
    await f.seed();
    const [definition] = await f.integration.provideMcpServerDefinitions();
    f.secretGet = async key => { f.state.delete(f.enabledKey(f.folder)); return f.secrets.get(key); };
    assert.equal(await f.integration.resolveMcpServerDefinition(definition), undefined);
});

test('disposal during account configuration prevents further credential access', async t => {
    const f = await fixture(t);
    f.picks.push('account', () => { f.integration.dispose(); return { value: 'tba' }; });
    f.inputs.push(endpoint, '123456_SB1');
    await assert.rejects(f.integration.configure(f.folder.uri), /shutting down/u);
    assert.equal(f.calls.filter(call => call.action === 'secretGet').length, 0);
});

test('disable revokes discovery even when no workspace is open', async t => {
    const f = await fixture(t);
    f.globals.set('supersuite.mcp.documentation', true);
    f.vscode.workspace.workspaceFolders = [];
    await f.integration.disable();
    assert.equal(f.globals.get('supersuite.mcp.documentation'), false);
    assert.equal((await f.integration.provideMcpServerDefinitions()).length, 0);
    assert.ok(f.messages.some(message => /Stop any already-running server/u.test(message.text || '')));
});
