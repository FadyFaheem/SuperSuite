'use strict';

const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { connectionKey, validateConfig } = require('../helpers/config');
const { validateRestletUrl } = require('../helpers/auth');
const { assertSafeLocalPath, atomicWrite } = require('../helpers/localFiles');
const { ensureConfigIgnored } = require('../setup/bootstrap');
const { CONNECTION_ENV, CREDENTIALS_ENV, connectionFromEnvironment, createAccountReader } = require('./account');

const CONFIG_PATH = '.config/supersuite-mcp.json';
const PROVIDER_ID = 'supersuite.readonly';
const enabledKey = folder => `supersuite.mcp.${crypto.createHash('sha256').update(folder.uri.toString()).digest('hex')}`;
const fingerprint = config => crypto.createHash('sha256').update(JSON.stringify([config.restlet, config.realm, config.authType])).digest('hex');
const credentialKey = (folder, config) => `mcp.${connectionKey(folder.uri.toString(), config)}`;

function cleanConfig(input) {
    const config = validateConfig(input);
    validateRestletUrl(config.restlet);
    if (!/^[A-Z0-9]+(?:_[A-Z0-9]+)*$/.test(config.realm)) throw new Error('Enter the NetSuite account ID in uppercase, including a sandbox suffix when applicable.');
    return Object.fromEntries(['restlet', 'realm', 'authType', 'timeoutMs', 'maxRetries'].map(key => [key, config[key]]));
}

class McpIntegration {
    constructor(context, configuration, output) {
        Object.assign(this, { context, configuration, output });
        this.disposed = false;
        this.controllers = new Set();
        this.definitions = new Map();
        this.events = new vscode.EventEmitter();
        this.onDidChangeMcpServerDefinitions = this.events.event;
        this.subscriptions = [];
        if (vscode.lm?.registerMcpServerDefinitionProvider && vscode.McpStdioServerDefinition) {
            this.subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider(PROVIDER_ID, this));
        }
        this.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.events.fire()));
        this.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => this.events.fire()));
        this.subscriptions.push(context.secrets.onDidChange(() => this.events.fire()));
        const watcher = vscode.workspace.createFileSystemWatcher('**/.config/supersuite-mcp.json');
        this.subscriptions.push(watcher, watcher.onDidChange(() => this.events.fire()), watcher.onDidCreate(() => this.events.fire()), watcher.onDidDelete(() => this.events.fire()));
    }

    dispose() {
        this.disposed = true;
        for (const controller of this.controllers) controller.abort();
        this.controllers.clear();
        this.subscriptions.forEach(value => value.dispose());
        this.events.dispose();
        this.definitions.clear();
    }

    assertActive() {
        if (this.disposed) throw new Error('SuperSuite is shutting down.');
        if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before enabling NetSuite MCP access.');
    }

    async readConfig(folder) {
        const filename = path.join(folder.uri.fsPath, CONFIG_PATH);
        await assertSafeLocalPath(folder.uri.fsPath, filename);
        const info = await fs.stat(filename);
        if (!info.isFile() || info.size > 65536) throw new Error('MCP configuration must be a regular file under 64 KiB.');
        let input;
        try { input = JSON.parse(await fs.readFile(filename, 'utf8')); } catch { throw new Error('Correct the JSON syntax in .config/supersuite-mcp.json.'); }
        return cleanConfig(input);
    }

    definition(label) {
        return new vscode.McpStdioServerDefinition(label, process.execPath, [path.join(this.context.extensionPath, 'mcp/server.js')],
            { ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '', NODE_PATH: '', [CONNECTION_ENV]: '', [CREDENTIALS_ENV]: '' }, this.context.extension.packageJSON.version);
    }

    async provideMcpServerDefinitions(token) {
        if (this.disposed || !vscode.workspace.isTrusted || token?.isCancellationRequested) return [];
        const result = [];
        this.definitions.clear();
        if (this.context.globalState.get('supersuite.mcp.documentation', false)) {
            const definition = this.definition('SuperSuite documentation');
            this.definitions.set(definition.label, { docs: true });
            result.push(definition);
        }
        for (const folder of vscode.workspace.workspaceFolders || []) {
            try {
                const config = await this.readConfig(folder);
                if (this.context.workspaceState.get(enabledKey(folder)) !== fingerprint(config)) continue;
                const definition = this.definition(`SuperSuite read-only: ${folder.name} (${fingerprint(config).slice(0, 8)}-${enabledKey(folder).slice(-6)})`);
                this.definitions.set(definition.label, { folder, fingerprint: fingerprint(config) });
                result.push(definition);
            } catch { /* Discovery never prompts or logs account configuration. */ }
        }
        return this.disposed || !vscode.workspace.isTrusted || token?.isCancellationRequested ? [] : result;
    }

    async resolveMcpServerDefinition(definition, token) {
        this.assertActive();
        const selected = this.definitions.get(definition.label);
        if (!selected || token?.isCancellationRequested) return undefined;
        // Rebuild command/args from the installed extension; never trust a caller's executable or env.
        const resolved = this.definition(definition.label);
        if (selected.docs) return this.context.globalState.get('supersuite.mcp.documentation', false) ? resolved : undefined;
        const { folder } = selected;
        if (!(vscode.workspace.workspaceFolders || []).some(current => current.uri.toString() === folder.uri.toString())) return undefined;
        const config = await this.readConfig(folder);
        this.assertActive();
        if (!(vscode.workspace.workspaceFolders || []).some(current => current.uri.toString() === folder.uri.toString()) || token?.isCancellationRequested) return undefined;
        if (fingerprint(config) !== selected.fingerprint || this.context.workspaceState.get(enabledKey(folder)) !== selected.fingerprint) throw new Error('MCP connection settings changed. Run SuperSuite: Configure Read-Only MCP to review them.');
        const credentials = await this.context.secrets.get(credentialKey(folder, config));
        if (!credentials) throw new Error('Configure the read-only MCP credentials before starting this server.');
        const env = { ...resolved.env, [CONNECTION_ENV]: JSON.stringify(config), [CREDENTIALS_ENV]: credentials };
        connectionFromEnvironment(env);
        this.assertActive();
        if (token?.isCancellationRequested || this.context.workspaceState.get(enabledKey(folder)) !== selected.fingerprint || !(vscode.workspace.workspaceFolders || []).some(current => current.uri.toString() === folder.uri.toString())) return undefined;
        resolved.env = env;
        return resolved;
    }

    async configure(uri) {
        this.assertActive();
        const mode = await vscode.window.showQuickPick([
            { label: 'Documentation and read-only NetSuite account', value: 'account' },
            { label: 'Documentation only', value: 'docs' }
        ], { title: 'SuperSuite MCP', ignoreFocusOut: true });
        if (!mode) return;
        this.assertActive();
        if (mode.value === 'docs') {
            await this.context.globalState.update('supersuite.mcp.documentation', true);
            this.events.fire();
            return this.showReady();
        }
        const folder = await this.configuration.folder(uri);
        if (!folder) return;
        this.assertActive();
        let defaults = {};
        try { defaults = await this.readConfig(folder); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        this.assertActive();
        const restlet = await vscode.window.showInputBox({ title: 'Read-only MCP · 1/3 · RESTlet',
            prompt: 'External URL of your SuperSuite 2.2 RESTlet deployment with custscript_supersuite_readonly enabled',
            value: defaults.restlet || '', ignoreFocusOut: true,
            validateInput: value => { try { validateRestletUrl(value.trim()); return undefined; } catch (error) { return error.message; } } });
        if (restlet === undefined) return;
        this.assertActive();
        const realm = await vscode.window.showInputBox({ title: 'Read-only MCP · 2/3 · Account', prompt: 'NetSuite account ID, including sandbox suffix', value: defaults.realm || '', ignoreFocusOut: true,
            validateInput: value => /^[a-z0-9]+(?:_[a-z0-9]+)*$/i.test(value.trim()) ? undefined : 'Enter the account ID.' });
        if (realm === undefined) return;
        this.assertActive();
        const auth = await vscode.window.showQuickPick([{ label: 'Token-based authentication', value: 'tba' }, { label: 'OAuth 2.0 access token', value: 'oauth2' }], { title: 'Read-only MCP · 3/3 · Authentication', ignoreFocusOut: true });
        if (!auth) return;
        this.assertActive();
        const config = cleanConfig({ ...defaults, restlet: restlet.trim(), realm: realm.trim().toUpperCase(), authType: auth.value });
        let credentials = await this.context.secrets.get(credentialKey(folder, config));
        this.assertActive();
        if (credentials) {
            const choice = await vscode.window.showQuickPick([{ label: 'Use saved MCP credentials', value: true }, { label: 'Replace MCP credentials', value: false }], { title: 'Read-only MCP credentials', ignoreFocusOut: true });
            if (!choice) return;
            this.assertActive();
            if (!choice.value) credentials = undefined;
        }
        if (!credentials) {
            const values = {};
            const fields = auth.value === 'oauth2' ? [['accessToken', 'OAuth 2.0 access token with RESTlets scope']] : [
                ['consumerToken', 'Integration consumer key'], ['consumerSecret', 'Integration consumer secret'],
                ['netSuiteKey', 'Token ID for the read-only integration role'], ['netSuiteSecret', 'Token secret']
            ];
            for (const [index, [key, prompt]] of fields.entries()) {
                const value = await vscode.window.showInputBox({ title: `MCP credentials · ${index + 1}/${fields.length}`, prompt, password: true, ignoreFocusOut: true, validateInput: value => value.trim() ? undefined : 'Enter a value.' });
                if (value === undefined) return;
                this.assertActive();
                values[key] = value.trim();
            }
            credentials = JSON.stringify(values);
        }
        const connection = connectionFromEnvironment({ [CONNECTION_ENV]: JSON.stringify(config), [CREDENTIALS_ENV]: credentials });
        const consent = await vscode.window.showInformationMessage(`Enable read-only AI access to NetSuite ${config.realm}?`, { modal: true,
            detail: 'Your MCP host and selected AI model will receive record values when you use the account tools. Use a dedicated role with only the View permissions you need. This connection cannot write records or deploy scripts. Credentials stay in SecretStorage and the server process environment.' }, 'Test and Enable');
        if (!consent) return;
        this.assertActive();
        const controller = new AbortController();
        this.controllers.add(controller);
        try {
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'SuperSuite: Verify read-only MCP deployment', cancellable: true }, async (_progress, token) => {
                const listener = token.onCancellationRequested(() => controller.abort());
                if (token.isCancellationRequested) controller.abort();
                try { await createAccountReader(connection).connectionInfo({ signal: controller.signal }); }
                finally { listener.dispose(); }
            });
            this.assertActive();
            if (controller.signal.aborted) return;
            const filename = path.join(folder.uri.fsPath, CONFIG_PATH);
            const guard = () => {
                this.assertActive();
                if (vscode.workspace.textDocuments.some(document => document.isDirty && [filename, path.join(folder.uri.fsPath, '.gitignore')].some(target => path.relative(document.uri.fsPath, target) === ''))) throw new Error('Save your MCP configuration and .gitignore edits before configuring MCP.');
            };
            guard();
            await ensureConfigIgnored(folder.uri.fsPath);
            await atomicWrite(folder.uri.fsPath, filename, JSON.stringify(config, null, 2) + '\n', guard);
            this.assertActive();
            await this.context.secrets.store(credentialKey(folder, config), credentials);
            await this.context.workspaceState.update(enabledKey(folder), fingerprint(config));
            this.events.fire();
            return this.showReady();
        } catch (error) {
            if (controller.signal.aborted || this.disposed) return;
            throw error;
        } finally { this.controllers.delete(controller); }
    }

    async disable(uri) {
        this.assertActive();
        const folder = vscode.workspace.workspaceFolders?.length ? await this.configuration.folder(uri) : undefined;
        if (vscode.workspace.workspaceFolders?.length && !folder) return;
        if (folder) await this.context.workspaceState.update(enabledKey(folder), undefined);
        await this.context.globalState.update('supersuite.mcp.documentation', false);
        this.events.fire();
        await vscode.window.showInformationMessage('SuperSuite MCP discovery disabled for this workspace. Stop any already-running server in your MCP host; revoke its NetSuite token to end its account access immediately.');
    }

    async showReady() {
        const available = Boolean(vscode.lm?.registerMcpServerDefinitionProvider);
        const action = await vscode.window.showInformationMessage(available ? 'SuperSuite MCP is ready. Open MCP: List Servers, trust/start the SuperSuite server, and enable its tools in your chat.' : 'The standalone MCP server is ready. This VS Code version has no native MCP provider API; see the guide for an external MCP host.', 'Open MCP Guide');
        if (action) return this.guide();
    }

    guide() { return vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(path.join(this.context.extensionPath, 'docs/MCP.md'))); }
}

module.exports = { McpIntegration, CONFIG_PATH, PROVIDER_ID, enabledKey, credentialKey, fingerprint, cleanConfig };
