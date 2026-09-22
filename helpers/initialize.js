'use strict';

const vscode = require('vscode');
const path = require('node:path');
const crypto = require('node:crypto');
const { CONFIG_PATH, validateConfig, connectionKey } = require('./config');
const { assertSafeLocalPath, atomicWrite } = require('./localFiles');
const { validateRestletUrl } = require('./netSuiteRestClient');

const PENDING_INIT = 'supersuite.pendingInitialization';
const stateKey = folder => `supersuite.init.${crypto.createHash('sha256').update(folder.uri.toString()).digest('hex')}`;
const fingerprint = config => JSON.stringify([config.restlet, config.realm, config.authType, config.rootDirectory]);

/** Init is a resumable sequence; only nonsecret choices and outcomes are persisted. */
class InitializationWizard {
    constructor(context, configuration, commands, exporter, taskRunner, output, dependencies = {}) {
        Object.assign(this, { context, configuration, commands, exporter, taskRunner, output });
        this.bootstrap = dependencies.bootstrap || require('../setup/bootstrap');
        this.selectRecordTypes = dependencies.selectRecordTypes || require('./recordExport').selectRecordTypes;
        this.active = new Set();
        this.controllers = new Set();
        this.disposed = false;
    }

    dispose() {
        this.disposed = true;
        for (const controller of this.controllers) controller.abort();
        this.controllers.clear();
    }

    assertActive() {
        if (this.disposed) { const error = new Error('Setup cancelled.'); error.name = 'AbortError'; throw error; }
        if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before initializing SuperSuite.');
    }

    async assertConnection(folder, state) {
        this.assertActive();
        const current = await this.configuration.config(folder);
        this.assertActive();
        if (fingerprint(current) !== state.connection) throw new Error('SuperSuite connection settings changed during setup. Run Init again to review the new connection.');
    }

    async target(uri) {
        this.assertActive();
        if (!vscode.workspace.workspaceFolders?.length) {
            const selected = await vscode.window.showOpenDialog({ title: 'Choose an empty folder for SuperSuite', canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Initialize This Folder' });
            if (!selected?.[0]) return;
            this.assertActive();
            if (selected[0].scheme !== 'file') throw new Error('Choose a filesystem folder.');
            await this.context.globalState.update(PENDING_INIT, selected[0].toString());
            await vscode.commands.executeCommand('vscode.openFolder', selected[0]);
            return;
        }
        return this.configuration.folder(uri);
    }

    async resumePending() {
        if (this.disposed) return;
        const pending = this.context.globalState.get(PENDING_INIT);
        if (!pending) return;
        const folder = (vscode.workspace.workspaceFolders || []).find(folder => folder.uri.toString() === pending);
        if (!folder || !vscode.workspace.isTrusted) return;
        await this.context.globalState.update(PENDING_INIT, undefined);
        return this.initialize(folder.uri);
    }

    async initialize(uri) {
        if (this.disposed) return { cancelled: true };
        let folder;
        try { folder = await this.target(uri); } catch (error) {
            if (this.disposed || error.name === 'AbortError') return { cancelled: true };
            throw error;
        }
        if (!folder || this.disposed) return { cancelled: true };
        const key = stateKey(folder);
        if (this.active.has(key)) throw new Error('Setup is already running for this workspace.');
        this.active.add(key);
        let state;
        const save = async () => { this.assertActive(); await this.context.workspaceState.update(key, state); };
        try {
            const config = await this.configuration.config(folder);
            this.assertActive();
            state = this.context.workspaceState.get(key);
            if (state?.schemaVersion !== 1 || (state.connection && state.connection !== fingerprint(config))) state = undefined;
            if (state && !state.complete) {
                const choice = await vscode.window.showQuickPick([
                    { label: 'Resume setup', description: 'Continue unfinished deployment or imports', value: 'resume' },
                    { label: 'Start setup again', description: 'Review account, deployment and import choices', value: 'restart' }
                ], { title: 'SuperSuite Init', ignoreFocusOut: true });
                if (!choice) return { cancelled: true };
                this.assertActive();
                if (choice.value === 'restart') state = undefined;
            } else state = undefined;
            if (!state) {
                state = await this.plan(folder, config);
                if (!state) return { cancelled: true };
                this.assertActive();
                if (state.mode !== 'existing') {
                    this.assertSavedDocument(path.join(folder.uri.fsPath, '.gitignore'));
                    const project = await this.bootstrap.createBootstrapProject(folder.uri.fsPath, {
                        realm: state.config.realm, rootDirectory: state.config.rootDirectory, roleId: state.roleId
                    }, this.context.extensionPath);
                    state.projectRoot = project.projectRoot;
                    state.config.restlet = project.restletUrl || state.config.restlet;
                }
                await this.writeConfig(folder, state.config);
                state.connection = fingerprint(state.config);
                await save();
            }
            const currentConfig = await this.configuration.config(folder);
            await this.assertConnection(folder, state);
            // Finish credential entry before any network import. A cancelled form
            // preserves previous secrets and leaves the current phase resumable.
            if (!await this.context.secrets.get(connectionKey(folder.uri.toString(), currentConfig))) state.credentialsReady = false;
            if (!state.credentialsReady && currentConfig.restlet && state.mode !== 'manual') {
                if (!await this.credentials(folder, currentConfig)) return { cancelled: true };
                state.credentialsReady = true;
                await save();
            }
            if (!state.deployed) {
                this.assertActive();
                if (state.mode === 'automatic') {
                    if (!await this.deploy(folder, state, save)) return { cancelled: true };
                } else if (state.mode === 'manual') {
                    const instructions = path.join(state.projectRoot, 'README.md');
                    try { await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(instructions)); } catch { /* Bundled instructions remain accessible from the command. */ }
                    const action = await vscode.window.showInformationMessage('Deploy the prepared SuperSuite RESTlet in NetSuite, then copy its External URL.', { modal: true, detail: 'The prepared project is in .config/supersuite-sdf. Create a RESTlet script and deployment with your integration role in its audience.' }, 'Deployment Is Ready');
                    if (!action) return { cancelled: true };
                    this.assertActive();
                    const url = await this.urlInput(state.config.restlet);
                    if (!url) return { cancelled: true };
                    state.config.restlet = url;
                    await this.writeConfig(folder, state.config);
                    state.connection = fingerprint(state.config);
                    state.credentialsReady = false;
                }
                state.deployed = true;
                await save();
            }
            if (!state.credentialsReady) {
                if (!await this.credentials(folder, await this.configuration.config(folder))) return { cancelled: true };
                state.credentialsReady = true;
                await save();
            }
            if (!await this.verifyConnection(folder, state, save)) return { cancelled: true };
            if (this.disposed) return { cancelled: true };
            if (!state.filesDone) {
                await this.assertConnection(folder, state);
                const result = await this.commands.execute('downloadFolder', folder.uri);
                state.filesDone = Boolean(result && !result.cancelled && result.failed === 0);
                await save();
                if (result?.cancelled || this.disposed) return { cancelled: true };
            }
            if (state.metadata && !state.metadataDone) {
                await this.assertConnection(folder, state);
                const result = await this.configuration.refreshMetadata(folder.uri, true);
                state.metadataDone = Boolean(result && !result.cancelled && result.failed === 0);
                await save();
                if (result?.cancelled || this.disposed) return { cancelled: true };
            }
            if (state.recordTypes.length && !state.recordsDone && !this.disposed) {
                await this.assertConnection(folder, state);
                const result = await this.exporter.exportRecords(folder, state.recordTypes, { resume: true });
                state.recordsDone = Boolean(result?.complete && !result.cancelled);
                state.exportDirectory = result?.exportDirectory;
                await save();
                if (result?.cancelled || this.disposed) return { cancelled: true };
            }
            state.complete = state.filesDone && (!state.metadata || state.metadataDone) && (!state.recordTypes.length || state.recordsDone);
            await save();
            if (this.disposed) return { cancelled: true };
            if (state.complete) {
                await vscode.window.showInformationMessage(`SuperSuite initialized.${state.recordTypes.length ? ' Business records are saved in the Git-ignored .supersuite-data folder.' : ''}`, 'Show Output').then(choice => { if (choice) this.output.show(); });
            } else await vscode.window.showWarningMessage('SuperSuite setup has unfinished imports. Review Output, fix the reported issues, and run Init again to resume.', 'Show Output').then(choice => { if (choice) this.output.show(); });
            return { complete: state.complete, cancelled: false, exportDirectory: state.exportDirectory };
        } catch (error) {
            if (this.disposed || error.name === 'AbortError') return { cancelled: true };
            throw error;
        } finally { this.active.delete(key); }
    }

    async plan(folder, defaults) {
        const mode = await vscode.window.showQuickPick([
            { label: 'Deploy a new RESTlet with SuiteCloud', description: 'Requires the official SuiteCloud CLI and an authorized deployment role', value: 'automatic' },
            { label: 'Connect to an existing SuperSuite RESTlet', description: 'Use an already deployed RESTlet External URL', value: 'existing' },
            { label: 'Prepare RESTlet for manual deployment', description: 'Generate the script and deployment project, then finish in NetSuite', value: 'manual' }
        ], { title: 'SuperSuite Init · 1/5 · RESTlet', ignoreFocusOut: true });
        if (!mode) return;
        const realm = await vscode.window.showInputBox({ title: 'SuperSuite Init · 2/5 · Account', prompt: 'NetSuite account ID, including sandbox suffix (for example 1234567_SB1)', value: defaults.realm, ignoreFocusOut: true, validateInput: value => /^[a-z0-9]+(?:_[a-z0-9]+)*$/i.test(value.trim()) ? undefined : 'Enter the account ID from Company Information.' });
        if (realm === undefined) return;
        const rootDirectory = await vscode.window.showInputBox({ title: 'SuperSuite Init · 2/5 · Files', prompt: 'Remote SuiteScripts folder to import into this workspace', value: defaults.rootDirectory, ignoreFocusOut: true, validateInput: value => { try { validateConfig({ rootDirectory: value.trim() }); return undefined; } catch (error) { return error.message; } } });
        if (rootDirectory === undefined) return;
        const auth = await vscode.window.showQuickPick([
            { label: 'Token-based authentication (TBA)', description: 'Integration consumer key/secret and token ID/secret', value: 'tba' },
            { label: 'OAuth 2.0 access token', description: 'Use an existing token with RESTlets scope; refresh remains external', value: 'oauth2' }
        ], { title: 'SuperSuite Init · 3/5 · Credentials', ignoreFocusOut: true });
        if (!auth) return;
        let restlet = defaults.restlet;
        let roleId;
        if (mode.value === 'existing') {
            restlet = await this.urlInput(restlet);
            if (!restlet) return;
        } else {
            roleId = await vscode.window.showInputBox({ title: 'SuperSuite Init · 3/5 · RESTlet audience', prompt: 'Existing integration role SCRIPT ID (customrole_...) or DEVELOPER for a developer sandbox role', ignoreFocusOut: true, validateInput: value => /^(?:customrole_[a-z0-9_]{1,29}|DEVELOPER)$/.test(value.trim()) ? undefined : 'Use an existing customrole_... script ID or DEVELOPER.' });
            if (roleId === undefined) return;
        }
        const recordTypes = await this.selectRecordTypes();
        if (recordTypes === undefined) return;
        const metadata = await vscode.window.showQuickPick([
            { label: 'Fetch account field IDs', description: 'Cache field metadata for completion while programming', value: true },
            { label: 'Skip field metadata for now', description: 'Refresh it later from the SuperSuite panel', value: false }
        ], { title: 'SuperSuite Init · 4/5 · Field completions', ignoreFocusOut: true });
        if (!metadata) return;
        const config = validateConfig({ ...defaults, realm: realm.trim().toUpperCase(), rootDirectory: rootDirectory.trim(), authType: auth.value, restlet, metadataRecordTypes: metadata.value ? (recordTypes.length ? recordTypes : ['customer', 'salesorder', 'invoice']) : defaults.metadataRecordTypes });
        const confirmation = await vscode.window.showInformationMessage(`Initialize ${folder.name} from NetSuite ${config.realm}?`, {
            modal: true, detail: `${mode.value === 'automatic' ? 'Create/update the SuperSuite RESTlet using SuiteCloud.\n' : ''}Pull files from ${config.rootDirectory} into this folder. Existing files require confirmation before replacement.\n${recordTypes.length ? `Export ${recordTypes.join(', ')} as read-only JSON snapshots into .supersuite-data (Git ignored). This can take time for a large account.` : 'No business-record export selected.'}\nCredentials are stored in VS Code SecretStorage.`
        }, 'Start Setup');
        if (!confirmation) return;
        return { schemaVersion: 1, config, mode: mode.value, roleId: roleId?.trim(), recordTypes, metadata: metadata.value, deployed: mode.value === 'existing', complete: false };
    }

    async credentials(folder, config) {
        this.assertActive();
        const existing = await this.context.secrets.get(connectionKey(folder.uri.toString(), config));
        if (existing) {
            const choice = await vscode.window.showQuickPick([
                { label: 'Use saved credentials', value: 'saved' }, { label: 'Replace credentials', value: 'replace' }
            ], { title: 'SuperSuite Init · Connection credentials', ignoreFocusOut: true });
            if (!choice) return false;
            this.assertActive();
            if (choice.value === 'saved') return true;
        }
        let action = await vscode.window.showInformationMessage('SuperSuite will ask for your NetSuite access credentials one at a time. Need help creating them?', 'Enter Keys', 'Open Key Setup Guide');
        if (action === 'Open Key Setup Guide') {
            await this.openAccessGuide();
            action = await vscode.window.showInformationMessage('Follow the key setup guide, then continue here. You can also close this message and resume Init later.', 'Enter Keys');
        }
        if (action !== 'Enter Keys') return false;
        this.assertActive();
        return this.configuration.configureCredentials(folder.uri);
    }

    async openAccessGuide() {
        return vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(path.join(this.context.extensionPath, 'docs', 'ACCESS_SETUP.md')));
    }

    async urlInput(value) {
        const input = await vscode.window.showInputBox({ title: 'SuperSuite Init · RESTlet External URL', prompt: 'Paste the HTTPS External URL from the RESTlet deployment', value, ignoreFocusOut: true, validateInput: value => { try { validateRestletUrl(value.trim()); return undefined; } catch (error) { return error.message; } } });
        return input?.trim();
    }

    async writeConfig(folder, config) {
        this.assertActive();
        const filename = path.join(folder.uri.fsPath, CONFIG_PATH);
        await assertSafeLocalPath(folder.uri.fsPath, filename);
        this.assertSavedDocument(filename);
        this.assertSavedDocument(path.join(folder.uri.fsPath, '.gitignore'));
        await this.bootstrap.ensureConfigIgnored(folder.uri.fsPath);
        this.assertActive();
        await atomicWrite(folder.uri.fsPath, filename, Buffer.from(`${JSON.stringify(validateConfig(config), null, 2)}\n`), () => {
            this.assertActive();
            this.assertSavedDocument(filename);
        });
    }

    assertSavedDocument(filename) {
        if (vscode.workspace.textDocuments.some(document => document.isDirty && path.relative(document.uri.fsPath, filename) === '')) throw new Error('Save or revert the open SuperSuite configuration or .gitignore before continuing Init.');
    }

    async deploy(folder, state, save) {
        await this.assertConnection(folder, state);
        const project = await this.bootstrap.readBootstrapProject(folder.uri.fsPath);
        if (!project || path.resolve(project.projectRoot) !== path.resolve(state.projectRoot) || project.realm !== state.config.realm || project.rootDirectory !== state.config.rootDirectory || project.roleId !== state.roleId) throw new Error('The prepared RESTlet project does not match this setup account, folder, or role. Review the setup project before continuing.');
        const auth = await vscode.window.showQuickPick([
            { label: 'Sign in to SuiteCloud in the browser', description: 'Complete the account and role prompts in the task terminal', value: 'browser' },
            { label: 'Use an existing SuiteCloud authentication ID', description: 'Select a CLI profile that has already been authorized', value: 'profile' },
            { label: 'Open SuiteCloud installation instructions', description: 'Install CLI prerequisites, then resume Init', value: 'install' }
        ], { title: 'SuperSuite Init · Authorize RESTlet deployment', ignoreFocusOut: true });
        if (!auth) return false;
        this.assertActive();
        if (auth.value === 'install') {
            await vscode.env.openExternal(vscode.Uri.parse('https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/chapter_1558708800.html'));
            return false;
        }
        let alias;
        if (auth.value === 'profile') {
            alias = await vscode.window.showInputBox({ title: 'SuiteCloud authentication ID', prompt: 'Existing CLI authentication ID for this account and deployment role', ignoreFocusOut: true, validateInput: value => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(value) ? undefined : 'Start with a letter or number; use up to 80 letters, numbers, dots, underscores and hyphens.' });
            if (!alias) return false;
        }
        const steps = this.bootstrap.suiteCloudCommands(alias);
        this.assertActive();
        if ((await this.taskRunner.run(folder, state.projectRoot, steps.authenticate, 'Authorize SuiteCloud')).cancelled) return false;
        await this.assertConnection(folder, state);
        if ((await this.taskRunner.run(folder, state.projectRoot, steps.preview, 'Preview SuperSuite RESTlet deployment')).cancelled) return false;
        this.assertActive();
        const confirm = await vscode.window.showWarningMessage(`Deploy the SuperSuite RESTlet to ${state.config.realm}?`, {
            modal: true, detail: `Review the deployment preview in the SuiteCloud task terminal and verify its account and role match this account. SuiteCloud uses its selected profile, which is separate from the RESTlet keys. The deployment audience is ${state.roleId}; the RESTlet file root is ${state.config.rootDirectory}.`
        }, 'Deploy to This Account');
        if (!confirm) return false;
        await this.assertConnection(folder, state);
        if ((await this.taskRunner.run(folder, state.projectRoot, steps.deploy, 'Deploy SuperSuite RESTlet')).cancelled) return false;
        state.deployed = true;
        await save();
        if (!state.config.restlet) {
            const url = await this.urlInput('');
            if (!url) return false;
            state.config.restlet = url;
            await this.writeConfig(folder, state.config);
            state.connection = fingerprint(state.config);
            await save();
        }
        return true;
    }

    async verifyConnection(folder, state, save) {
        while (!this.disposed) {
            await this.assertConnection(folder, state);
            const controller = new AbortController();
            this.controllers.add(controller);
            try {
                const { client } = await this.configuration.connection(folder);
                this.assertActive();
                const version = await client.request('version', {}, { signal: controller.signal });
                this.assertActive();
                this.commands.requireProtocol(version);
                if (state.recordTypes.length && !version.capabilities?.recordExport) throw new Error('This RESTlet does not support business-record exports. Deploy the bundled 2.1 RESTlet first.');
                if (version.identity) {
                    const identity = crypto.createHash('sha256').update(JSON.stringify([version.identity.accountId, version.identity.userId, version.identity.roleId])).digest('hex');
                    if (state.remoteIdentity && state.remoteIdentity !== identity) {
                        state.filesDone = state.metadataDone = state.recordsDone = false;
                        delete state.exportDirectory;
                    }
                    state.remoteIdentity = identity;
                    await save();
                }
                return true;
            } catch (error) {
                if (this.disposed || error.name === 'AbortError') return false;
                const choice = await vscode.window.showErrorMessage(`SuperSuite setup connection: ${error.message}`, 'Retry', 'Edit RESTlet URL', 'Replace Credentials');
                if (!choice) return false;
                this.assertActive();
                if (choice === 'Edit RESTlet URL') {
                    const url = await this.urlInput(state.config.restlet);
                    if (!url) return false;
                    state.config.restlet = url;
                    await this.writeConfig(folder, state.config);
                    state.connection = fingerprint(state.config);
                    state.credentialsReady = false;
                    state.filesDone = state.metadataDone = state.recordsDone = false;
                    delete state.exportDirectory;
                    await save();
                    if (!await this.credentials(folder, state.config)) return false;
                    state.credentialsReady = true;
                    await save();
                } else if (choice === 'Replace Credentials' && !await this.configuration.configureCredentials(folder.uri)) return false;
            } finally { this.controllers.delete(controller); }
        }
        return false;
    }
}

module.exports = { InitializationWizard, PENDING_INIT, stateKey, fingerprint };
