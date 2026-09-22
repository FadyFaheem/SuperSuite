'use strict';

const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const { CONFIG_PATH, DEFAULTS, SECRET_NAMES, readConfig, connectionKey } = require('./config');
const { assertSafeLocalPath } = require('./localFiles');
const { createClient, validateRestletUrl } = require('./netSuiteRestClient');

class WorkspaceConfiguration {
    constructor(context, output) {
        this.context = context;
        this.output = output;
        this.credentialChanges = new Map();
        this.controllers = new Set();
        this.disposed = false;
    }

    dispose() {
        this.disposed = true;
        for (const controller of this.controllers) controller.abort();
        this.controllers.clear();
    }

    async invalidateFields(key) {
        this.credentialChanges.set(key, (this.credentialChanges.get(key) || 0) + 1);
        await this.context.workspaceState.update(`${key}.fields`, undefined);
    }

    async folder(uri) {
        if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before configuring or connecting SuperSuite.');
        const folders = vscode.workspace.workspaceFolders || [];
        if (!folders.length) throw new Error('Open your local SuiteScripts folder first.');
        if (uri) {
            const match = vscode.workspace.getWorkspaceFolder(uri);
            if (!match) throw new Error('Select a file inside an open workspace folder.');
            if (match.uri.scheme !== 'file') throw new Error('SuperSuite needs a filesystem workspace (local or Remote SSH/WSL).');
            return match;
        }
        const selected = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Select the SuiteScripts workspace' });
        if (!selected) return undefined;
        if (selected.uri.scheme !== 'file') throw new Error('SuperSuite needs a filesystem workspace.');
        return selected;
    }

    async config(folder) {
        const modern = vscode.workspace.getConfiguration('supersuite', folder.uri);
        const legacy = vscode.workspace.getConfiguration('netSuiteUpload', folder.uri);
        const settings = {};
        for (const key of Object.keys(DEFAULTS)) {
            const inspected = modern.inspect(key);
            const explicit = inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
            const old = ['restlet', 'realm', 'rootDirectory'].includes(key) ? legacy.get(key) : undefined;
            // VS Code supplies an implicit empty-string default for legacy
            // string settings. That must not replace a modern built-in default.
            if (explicit !== undefined) settings[key] = explicit;
            else if (typeof old === 'string' && old.trim()) settings[key] = old;
        }
        await assertSafeLocalPath(folder.uri.fsPath, path.join(folder.uri.fsPath, CONFIG_PATH));
        return readConfig(folder.uri.fsPath, settings);
    }

    async connection(folder) {
        const config = await this.config(folder);
        if (!config.restlet) throw new Error('Set restlet and realm in .config/supersuite.json, then run SuperSuite: Configure Credentials.');
        validateRestletUrl(config.restlet);
        const stored = await this.context.secrets.get(connectionKey(folder.uri.toString(), config));
        if (!stored) throw new Error('No credentials for this workspace/account/deployment. Run SuperSuite: Configure Credentials.');
        let parsed;
        try { parsed = JSON.parse(stored); } catch {
            throw new Error('Saved credentials are invalid. Run SuperSuite: Configure Credentials again.');
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Saved credentials are invalid. Configure credentials again.');
        // Only credential properties may come from storage; it must never replace
        // the workspace's validated endpoint, account, or transfer configuration.
        const credentials = Object.fromEntries(SECRET_NAMES.filter(key => typeof parsed[key] === 'string').map(key => [key, parsed[key]]));
        return { config, client: createClient({ ...config, ...credentials }) };
    }

    async setup(uri) {
        const folder = await this.folder(uri);
        if (!folder) return;
        const filename = path.join(folder.uri.fsPath, CONFIG_PATH);
        await assertSafeLocalPath(folder.uri.fsPath, filename);
        await fs.mkdir(path.dirname(filename), { recursive: true });
        let exists;
        try { exists = await fs.lstat(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (exists && !exists.isFile()) throw new Error('SuperSuite configuration must be a regular file.');
        if (!exists) {
            try {
                await fs.writeFile(filename, `${JSON.stringify(await this.config(folder), null, 2)}\n`, { flag: 'wx' });
            } catch (error) { if (error.code !== 'EEXIST') throw error; }
        }
        // The safe file contains no secrets; the cache belongs to workspaceState.
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(filename));
        await vscode.window.showInformationMessage('SuperSuite configuration is ready. Set your RESTlet URL and account realm, then configure credentials.');
    }

    async configureCredentials(uri) {
        const folder = await this.folder(uri);
        if (!folder) return false;
        const config = await this.config(folder);
        validateRestletUrl(config.restlet);
        if (config.authType === 'tba' && !config.realm) throw new Error('Set realm to your NetSuite account ID before configuring TBA.');
        const fields = config.authType === 'oauth2' ? [['accessToken', 'OAuth 2.0 access token (RESTlets scope)']] : [
            ['consumerToken', 'Consumer key from the saved integration record (Setup > Integration > Manage Integrations)'],
            ['consumerSecret', 'Consumer secret shown with that integration consumer key'],
            ['netSuiteKey', 'Token ID from the access token for your application, user and integration role'],
            ['netSuiteSecret', 'Token secret shown when that access token was created']
        ];
        const credentials = {};
        for (const [index, [key, prompt]] of fields.entries()) {
            const value = await vscode.window.showInputBox({ title: `SuperSuite credentials · ${index + 1}/${fields.length}`, prompt, password: true, ignoreFocusOut: true, validateInput: value => value.trim() ? undefined : 'A value is required.' });
            if (value === undefined) return false;
            if (this.disposed) return false;
            credentials[key] = value.trim();
        }
        const key = connectionKey(folder.uri.toString(), config);
        if (this.disposed) return false;
        if (key !== connectionKey(folder.uri.toString(), await this.config(folder))) throw new Error('Connection settings changed while entering credentials. Run Configure Credentials again.');
        if (this.disposed) return false;
        await this.context.secrets.store(key, JSON.stringify(credentials));
        await this.invalidateFields(key);
        await vscode.window.showInformationMessage('SuperSuite credentials saved in VS Code SecretStorage.');
        return true;
    }

    async clearCredentials(uri) {
        const folder = await this.folder(uri);
        if (!folder) return;
        const key = connectionKey(folder.uri.toString(), await this.config(folder));
        await this.context.secrets.delete(key);
        await this.invalidateFields(key);
        await vscode.window.showInformationMessage('SuperSuite credentials cleared for this connection.');
    }

    async migrateCredentials(uri) {
        const folder = await this.folder(uri);
        if (!folder) return;
        const config = await this.config(folder);
        validateRestletUrl(config.restlet);
        if (config.authType !== 'tba') throw new Error('Legacy migration is only for token-based authentication.');
        if (!config.realm) throw new Error('Set realm to your NetSuite account ID before migrating TBA.');
        const old = vscode.workspace.getConfiguration('netSuiteUpload', folder.uri);
        const values = Object.fromEntries(SECRET_NAMES.filter(key => key !== 'accessToken').map(key => [key, old.get(key)]));
        if (Object.values(values).some(value => typeof value !== 'string' || !value.trim() || /^<.*>$/.test(value.trim()))) throw new Error('No complete legacy TBA credentials were found. Use Configure Credentials.');
        const key = connectionKey(folder.uri.toString(), config);
        await this.context.secrets.store(key, JSON.stringify(values));
        await this.invalidateFields(key);
        // Shared settings may serve other workspace folders or unopened projects.
        // Remove only selected-folder values; never erase lower-priority accounts.
        let sharedValuesRemain = false;
        for (const key of Object.keys(values)) {
            const inspected = old.inspect(key);
            if (inspected?.workspaceFolderValue !== undefined) await old.update(key, undefined, vscode.ConfigurationTarget.WorkspaceFolder);
            if (inspected?.workspaceValue !== undefined || inspected?.globalValue !== undefined) sharedValuesRemain = true;
        }
        await vscode.window.showInformationMessage(sharedValuesRemain ?
            'TBA credentials saved in SecretStorage for this folder. Shared workspace/user credential settings were retained for other projects; migrate those projects, then remove the shared plaintext settings and any Git history copies.' :
            'Legacy TBA credentials moved into SecretStorage. Remove any credential copies from Git history separately.');
    }

    async cachedFields(document) {
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (!folder || !vscode.workspace.isTrusted) return [];
        const config = await this.config(folder);
        const cached = this.context.workspaceState.get(`${connectionKey(folder.uri.toString(), config)}.fields`, {});
        return Object.values(cached).flatMap(entry => entry.fields || []);
    }

    async refreshMetadata(uri, automatic = false) {
        const folder = await this.folder(uri);
        if (!folder) return { succeeded: 0, failed: 0, cancelled: true };
        const { client, config } = await this.connection(folder);
        const key = `${connectionKey(folder.uri.toString(), config)}.fields`;
        const credentialKey = connectionKey(folder.uri.toString(), config);
        const credentialVersion = this.credentialChanges.get(credentialKey) || 0;
        let types = config.metadataRecordTypes;
        let recordId;
        if (!types.length && !automatic) {
            const type = await vscode.window.showInputBox({ prompt: 'Record type ID (for example salesorder or customrecord_project)', validateInput: value => /^[a-z][a-z0-9_]{0,127}$/i.test(value.trim()) ? undefined : 'Enter a record type ID.' });
            if (!type) return { succeeded: 0, failed: 0, cancelled: true };
            types = [type.trim().toLowerCase()];
            recordId = await vscode.window.showInputBox({ prompt: 'Optional existing record internal ID for form-specific fields; leave blank to inspect a new record', validateInput: value => !value || /^[1-9][0-9]*$/.test(value) ? undefined : 'Enter a positive internal ID.' });
            if (recordId === undefined) return { succeeded: 0, failed: 0, cancelled: true };
        }
        if (!types.length) return { succeeded: 0, failed: 0, cancelled: false };
        const cache = { ...this.context.workspaceState.get(key, {}) };
        const errors = [];
        let cancelled = false;
        let succeeded = 0;
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'SuperSuite: Refresh field IDs', cancellable: true }, async (progress, token) => {
            const controller = new AbortController();
            this.controllers.add(controller);
            if (this.disposed || token.isCancellationRequested) controller.abort();
            const subscription = token.onCancellationRequested(() => controller.abort());
            try {
                for (const recordType of types) {
                    if (controller.signal.aborted) break;
                    progress.report({ message: recordType });
                    try {
                        const result = await client.request('metadata', { recordType, ...(recordId ? { recordId } : {}) }, { signal: controller.signal });
                        if (!Array.isArray(result.fields)) throw new Error('RESTlet did not return field metadata. Update the deployed RESTlet.');
                        cache[recordType] = { updatedAt: new Date().toISOString(), fields: result.fields.filter(field => field && typeof field.id === 'string').map(field => ({ id: field.id, label: String(field.label || field.id), type: String(field.type || ''), recordType })) };
                        succeeded++;
                    } catch (error) { if (!controller.signal.aborted) errors.push(`${recordType}: ${error.message}`); }
                }
                cancelled = controller.signal.aborted;
                if (!this.disposed && (this.credentialChanges.get(credentialKey) || 0) === credentialVersion) {
                    await this.context.workspaceState.update(key, cache);
                } else cancelled = true;
            } finally { subscription.dispose(); this.controllers.delete(controller); }
        });
        if (this.disposed) return { succeeded, failed: errors.length, cancelled: true };
        if (errors.length) {
            errors.forEach(message => this.output.appendLine(message));
            await vscode.window.showWarningMessage(`SuperSuite: ${errors.length} record types could not be refreshed. See the SuperSuite output channel.`);
        } else if (!automatic) await vscode.window.showInformationMessage(cancelled ?
            'SuperSuite metadata refresh stopped. Refresh again to complete discovery.' :
            'SuperSuite field IDs cached for completions. No record values are stored.');
        return { succeeded, failed: errors.length, cancelled };
    }
}

module.exports = { WorkspaceConfiguration };
