'use strict';

const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const { inside, assertSafeLocalPath } = require('../helpers/localFiles');
const { AUTH_ALIAS, PROJECT_NAME, projectKey, inspectProject, assertCreateTarget, fingerprintProject, testConfigured } = require('./project');
const { ProjectTaskRunner } = require('./taskRunner');

const COMMANDS = Object.freeze(Object.fromEntries([
    ['create', 'SuiteCloud: Create Account Customization Project'], ['selectProject', 'SuiteCloud: Select Project'],
    ['authenticate', 'SuiteCloud: Authenticate Project'], ['validate', 'SuiteCloud: Validate Project'],
    ['preview', 'SuiteCloud: Preview Deployment'], ['deploy', 'SuiteCloud: Deploy Project'],
    ['importObjects', 'SuiteCloud: Import Objects'], ['importFiles', 'SuiteCloud: Import Files'],
    ['test', 'SuiteCloud: Run Unit Tests'], ['guide', 'SuiteCloud: Open Guide']
].map(([action, title]) => [`supersuite.suitecloud.${action}`, { action, title }])));

class SuiteCloudCommands {
    constructor(context, output, dependencies = {}) {
        this.context = context;
        this.output = output;
        this.runner = dependencies.runner || new ProjectTaskRunner(output);
        this.active = new Set();
        this.disposed = false;
    }

    dispose() { this.disposed = true; this.runner.dispose(); }

    assertActive() {
        if (this.disposed) { const error = new Error('SuiteCloud operation cancelled.'); error.code = 'CANCELLED'; throw error; }
        if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before using SuiteCloud.');
    }

    async folder(uri) {
        this.assertActive();
        const folders = (vscode.workspace.workspaceFolders || []).filter(folder => folder.uri.scheme === 'file');
        if (uri) {
            const matched = vscode.workspace.getWorkspaceFolder(uri);
            if (matched?.uri.scheme !== 'file') throw new Error('Select a file or folder inside an open filesystem workspace.');
            return matched;
        }
        if (folders.length === 0) throw new Error('Open a local repository folder before using SuiteCloud.');
        if (folders.length === 1) return folders[0];
        const selected = await vscode.window.showQuickPick(folders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, folder })), { title: 'SuiteCloud: Choose workspace' });
        this.assertActive();
        return selected?.folder;
    }

    assertClean(root) {
        this.assertActive();
        if ((vscode.workspace.textDocuments || []).some(document => document.isDirty && document.uri.scheme === 'file' && inside(root, document.uri.fsPath))) throw new Error('Save or discard open edits in the selected SuiteCloud project before running this command.');
    }

    async selectProject(folder, force = false) {
        const root = folder.uri.fsPath;
        const saved = this.context.workspaceState.get(projectKey(folder));
        if (saved && !force) {
            if (typeof saved !== 'string' || path.isAbsolute(saved)) throw new Error('Invalid saved SuiteCloud project. Run SuiteCloud: Select Project.');
            try { return await inspectProject(root, path.resolve(root, saved)); }
            catch (error) { throw new Error(`The selected SuiteCloud project is unavailable: ${error.message} Run SuiteCloud: Select Project to choose another.`); }
        }
        const candidates = [root];
        for (const entry of await fs.readdir(root, { withFileTypes: true })) if (entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.') && entry.name !== 'node_modules') candidates.push(path.join(root, entry.name));
        const choices = [];
        for (const candidate of candidates) {
            try { const project = await inspectProject(root, candidate); choices.push({ label: path.relative(root, candidate) || folder.name, description: project.type, project }); }
            catch { /* Only complete, supported projects are discovery candidates. */ }
        }
        choices.push({ label: 'Browse for a project folder…', browse: true });
        this.assertActive();
        const choice = await vscode.window.showQuickPick(choices, { title: 'SuiteCloud: Select project', placeHolder: 'Choose the folder containing suitecloud.config.js' });
        this.assertActive();
        if (!choice) return undefined;
        let project = choice.project;
        if (choice.browse) {
            const uris = await vscode.window.showOpenDialog({ defaultUri: folder.uri, canSelectFiles: false, canSelectFolders: true, canSelectMany: false, title: 'Select a SuiteCloud project inside this workspace' });
            this.assertActive();
            if (!uris?.[0]) return undefined;
            if (uris[0].scheme !== 'file') throw new Error('SuiteCloud needs a filesystem project.');
            project = await inspectProject(root, uris[0].fsPath);
        }
        this.assertActive();
        await this.context.workspaceState.update(projectKey(folder), path.relative(root, project.projectRoot) || '.');
        return project;
    }

    async guardProject(folder, project) {
        this.assertClean(project.projectRoot);
        await inspectProject(folder.uri.fsPath, project.projectRoot);
        // Imports also reject links before allowing the CLI to overwrite local files.
        await fingerprintProject(project);
        this.assertClean(project.projectRoot);
    }

    async run(folder, project, args, title, extraGuard) {
        return this.runner.run(folder, project.projectRoot, 'suitecloud', args, title, async () => {
            await this.guardProject(folder, project);
            if (extraGuard) await extraGuard();
        });
    }

    async create(folder) {
        const name = await vscode.window.showInputBox({ title: 'SuiteCloud: Create Account Customization Project', prompt: 'New folder name inside this workspace', value: 'SuiteCloud', validateInput: value => PROJECT_NAME.test(value) ? undefined : 'Use letters, numbers, underscores or hyphens, starting with a letter or number (64 characters maximum).' });
        this.assertActive();
        if (!name) return { cancelled: true };
        const destination = await assertCreateTarget(folder.uri.fsPath, name);
        const guard = async () => {
            this.assertClean(destination);
            await assertSafeLocalPath(folder.uri.fsPath, folder.uri.fsPath);
            await assertCreateTarget(folder.uri.fsPath, name);
            this.assertActive();
        };
        const result = await this.runner.run(folder, folder.uri.fsPath, 'suitecloud', ['project:create', '--type', 'ACCOUNTCUSTOMIZATION', '--projectname', name], 'Create SuiteCloud project', guard);
        this.assertActive();
        if (result.cancelled) return result;
        const project = await inspectProject(folder.uri.fsPath, destination);
        this.assertActive();
        await this.context.workspaceState.update(projectKey(folder), path.relative(folder.uri.fsPath, destination));
        await vscode.window.showInformationMessage('SuiteCloud project created and selected. Run SuiteCloud: Authenticate Project, then Import Objects or Import Files.');
        return { ...result, projectRoot: project.projectRoot };
    }

    async authenticate(folder, project) {
        const mode = await vscode.window.showQuickPick([{ label: 'Sign in through NetSuite in your browser', browser: true }, { label: 'Use an existing SuiteCloud authentication ID', browser: false }], { title: 'SuiteCloud: Authenticate project' });
        this.assertActive();
        if (!mode) return { cancelled: true };
        let args = ['account:setup', '--interactive'];
        if (!mode.browser) {
            const alias = await vscode.window.showInputBox({ title: 'SuiteCloud authentication ID', prompt: 'An existing Oracle CLI account/role alias; do not paste a token or private key.', validateInput: value => AUTH_ALIAS.test(value) ? undefined : 'Use 1–80 letters, numbers, underscores, hyphens or dots, starting with a letter or number.' });
            this.assertActive();
            if (!alias) return { cancelled: true };
            if (!AUTH_ALIAS.test(alias)) throw new Error('Invalid SuiteCloud authentication ID.');
            args = ['account:setup:ci', '--select', alias];
        }
        return this.run(folder, project, args, 'Authenticate SuiteCloud project');
    }

    async deploy(folder, project) {
        await this.guardProject(folder, project);
        const fingerprint = await fingerprintProject(project);
        const unchanged = async () => {
            if (await fingerprintProject(project) !== fingerprint) throw new Error('SuiteCloud project changed after deployment preview started. Review the changes and run Deploy Project again.');
            this.assertClean(project.projectRoot);
        };
        const preview = await this.run(folder, project, ['project:deploy', '--dryrun'], 'Preview SuiteCloud deployment', unchanged);
        this.assertActive();
        if (preview.cancelled) return preview;
        await unchanged();
        const approval = await vscode.window.showWarningMessage(`Deploy ${path.basename(project.projectRoot)} to NetSuite? Review the dry-run terminal and verify its account, role, and changes before continuing. SuiteCloud will use this project's configured authentication ID and deploy.xml.`, { modal: true }, 'Deploy Project');
        this.assertActive();
        if (approval !== 'Deploy Project') return { cancelled: true };
        return this.run(folder, project, ['project:deploy'], 'Deploy SuiteCloud project', unchanged);
    }

    async execute(action, uri) {
        if (!Object.values(COMMANDS).some(command => command.action === action)) throw new Error('Unknown SuiteCloud command.');
        if (action === 'guide') return vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.joinPath(this.context.extensionUri, 'docs', 'SUITECLOUD.md'));
        let key;
        try {
            const folder = await this.folder(uri);
            if (!folder) return { cancelled: true };
            key = folder.uri.toString();
            if (this.active.has(key)) { key = undefined; throw new Error('Another SuiteCloud operation is active for this workspace. Finish or cancel it before starting another.'); }
            this.active.add(key);
            if (action === 'create') return await this.create(folder);
            const project = await this.selectProject(folder, action === 'selectProject');
            this.assertActive();
            if (!project) return { cancelled: true };
            if (action === 'selectProject') return { cancelled: false, projectRoot: project.projectRoot };
            if (action === 'authenticate') return await this.authenticate(folder, project);
            if (action === 'deploy') return await this.deploy(folder, project);
            if (action === 'test') {
                await testConfigured(project);
                return await this.runner.run(folder, project.projectRoot, 'npm', ['test'], 'Run SuiteCloud unit tests', async () => { await this.guardProject(folder, project); await testConfigured(project); });
            }
            if (action === 'importFiles' || action === 'importObjects') {
                if (action === 'importFiles' && project.type !== 'ACCOUNTCUSTOMIZATION') throw new Error('Oracle file:import supports Account Customization Projects. Choose an ACP to import File Cabinet files.');
                const confirmation = await vscode.window.showInformationMessage('Choose the account files or SDF objects in the SuiteCloud terminal. Its import can replace local project files; review the selected items and overwrite prompt before accepting.', { modal: true }, 'Choose Items');
                this.assertActive();
                if (confirmation !== 'Choose Items') return { cancelled: true };
            }
            const args = { validate: ['project:validate'], preview: ['project:deploy', '--dryrun'], importFiles: ['file:import', '--interactive'], importObjects: ['object:import', '--interactive'] }[action];
            return await this.run(folder, project, args, COMMANDS[`supersuite.suitecloud.${action}`].title);
        } catch (error) {
            if (error.code === 'CANCELLED') return { cancelled: true };
            throw error;
        } finally { if (key) this.active.delete(key); }
    }
}

module.exports = { SuiteCloudCommands, COMMANDS };
