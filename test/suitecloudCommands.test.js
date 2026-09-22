'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { projectKey } = require('../suitecloud/project');

async function writeProject(root, type = 'ACCOUNTCUSTOMIZATION') {
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'suitecloud.config.js'), 'module.exports = {defaultProjectFolder:"src"};');
    await fs.writeFile(path.join(root, 'src', 'manifest.xml'), `<manifest projecttype="${type}"/>`);
    await fs.writeFile(path.join(root, 'src', 'deploy.xml'), '<deploy/>');
}

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'supersuite-sdf-commands-'));
    const projectRoot = path.join(root, 'Example');
    await writeProject(projectRoot);
    t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
    const uri = filename => ({ scheme: 'file', fsPath: filename, toString: () => `file://${filename}` });
    const folder = { name: 'Workspace', uri: uri(root) };
    const state = new Map([[projectKey(folder), 'Example']]);
    const f = { root, projectRoot, folder, state, tasks: [], infos: [], warnings: [], picks: [], inputs: [], directories: [] };
    const vscode = {
        workspace: { isTrusted: true, workspaceFolders: [folder], textDocuments: [], getWorkspaceFolder: candidate => candidate.scheme === 'file' && candidate.fsPath.startsWith(root) ? folder : undefined },
        Uri: { joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
        commands: { executeCommand: async (...args) => { f.opened = args; } },
        window: {
            showQuickPick: async choices => { const pick = f.picks.shift(); return typeof pick === 'function' ? pick(choices) : pick; },
            showInputBox: async () => f.inputs.shift(),
            showOpenDialog: async () => f.directories.shift(),
            showInformationMessage: async message => { f.infos.push(message); return f.informationResult ?? 'Choose Items'; },
            showWarningMessage: async message => { f.warnings.push(message); return f.warning ? f.warning() : 'Deploy Project'; }
        }
    };
    const runner = { disposed: false, dispose() { this.disposed = true; }, async run(folder, cwd, command, args, title, guard) {
        await guard();
        const task = { folder, cwd, command, args: Array.from(args), title };
        f.tasks.push(task);
        return f.onRun ? await f.onRun(task, guard) : { cancelled: false, exitCode: 0 };
    } };
    const filename = path.resolve(__dirname, '../suitecloud/commands.js');
    const localRequire = createRequire(filename);
    const module = { exports: {} };
    vm.runInNewContext(await fs.readFile(filename, 'utf8'), { module, require: name => name === 'vscode' ? vscode : name === './taskRunner' ? {} : localRequire(name) }, { filename });
    const context = { extensionUri: uri(path.resolve(__dirname, '..')), workspaceState: { get: key => state.get(key), update: async (key, value) => state.set(key, value) } };
    f.commands = new module.exports.SuiteCloudCommands(context, { appendLine() {} }, { runner });
    f.vscode = vscode; f.uri = uri; f.runner = runner;
    t.after(() => f.commands.dispose());
    return f;
}

test('SuiteCloud commands require workspace trust and reject unknown actions', async t => {
    const f = await fixture(t);
    f.vscode.workspace.isTrusted = false;
    await assert.rejects(f.commands.execute('validate'), /Trust this workspace/);
    await assert.rejects(f.commands.execute('arbitrary'), /Unknown SuiteCloud/);
    assert.equal(f.tasks.length, 0);
    await f.commands.execute('guide');
    assert.equal(f.opened[0], 'markdown.showPreview');
});

test('validation uses the persisted project and blocks unsaved project edits', async t => {
    const f = await fixture(t);
    await f.commands.execute('validate');
    assert.deepEqual(f.tasks[0].args, ['project:validate']);
    assert.equal(f.tasks[0].cwd, f.projectRoot);
    f.vscode.workspace.textDocuments.push({ isDirty: true, uri: f.uri(path.join(f.projectRoot, 'src', 'script.js')) });
    await assert.rejects(f.commands.execute('validate'), /Save or discard/);
    assert.equal(f.tasks.length, 1);
});

test('authentication chooses browser or a validated existing auth ID without credential arguments', async t => {
    const f = await fixture(t);
    f.picks.push({ browser: true });
    await f.commands.execute('authenticate');
    assert.deepEqual(f.tasks[0].args, ['account:setup', '--interactive']);
    f.picks.push({ browser: false }); f.inputs.push('sandbox.developer');
    await f.commands.execute('authenticate');
    assert.deepEqual(f.tasks[1].args, ['account:setup:ci', '--select', 'sandbox.developer']);
    f.picks.push({ browser: false }); f.inputs.push('secret;echo');
    await assert.rejects(f.commands.execute('authenticate'), /Invalid SuiteCloud authentication/);
    f.picks.push(undefined);
    assert.equal((await f.commands.execute('authenticate')).cancelled, true);
    assert.equal(f.tasks.length, 2);
});

test('deployment performs dry run then account confirmation then final deployment', async t => {
    const f = await fixture(t);
    await f.commands.execute('deploy');
    assert.deepEqual(f.tasks.map(task => task.args), [['project:deploy', '--dryrun'], ['project:deploy']]);
    assert.equal(f.warnings.length, 1);
    assert.match(f.warnings[0], /account, role/);
});

test('cancelled preview and declined approval cannot deploy', async t => {
    const f = await fixture(t);
    f.onRun = async () => ({ cancelled: true });
    assert.equal((await f.commands.execute('deploy')).cancelled, true);
    assert.equal(f.warnings.length, 0);
    f.onRun = undefined; f.warning = () => undefined;
    assert.equal((await f.commands.execute('deploy')).cancelled, true);
    assert.ok(f.tasks.every(task => task.args.includes('--dryrun')));
});

test('changed files during preview or approval invalidate deployment', async t => {
    const f = await fixture(t);
    f.onRun = async () => { await fs.writeFile(path.join(f.projectRoot, 'src', 'changed.js'), 'changed during preview'); return { cancelled: false }; };
    await assert.rejects(f.commands.execute('deploy'), /changed after deployment preview/);
    assert.equal(f.warnings.length, 0);
    f.onRun = undefined;
    f.warning = async () => { await fs.writeFile(path.join(f.projectRoot, 'project.json'), '{"defaultAuthId":"production"}'); return 'Deploy Project'; };
    await assert.rejects(f.commands.execute('deploy'), /changed after deployment preview/);
    assert.ok(f.tasks.every(task => task.args.includes('--dryrun')));
});

test('import commands use interactive Oracle selection and enforce ACP-only file import', async t => {
    const f = await fixture(t);
    await f.commands.execute('importFiles');
    await f.commands.execute('importObjects');
    assert.deepEqual(f.tasks.map(task => task.args), [['file:import', '--interactive'], ['object:import', '--interactive']]);
    await fs.writeFile(path.join(f.projectRoot, 'src', 'manifest.xml'), '<manifest projecttype="SUITEAPP"/>');
    await assert.rejects(f.commands.execute('importFiles'), /Account Customization Projects/);
    f.informationResult = 'Cancel';
    assert.equal((await f.commands.execute('importObjects')).cancelled, true);
    assert.equal(f.tasks.length, 2);
});

test('creation cannot overwrite an existing folder and selects successful new projects', async t => {
    const f = await fixture(t);
    f.inputs.push('Example');
    await assert.rejects(f.commands.execute('create'), /already exists/);
    assert.equal(f.tasks.length, 0);
    f.inputs.push('NewProject');
    f.onRun = async task => { await writeProject(path.join(f.root, task.args[4])); return { cancelled: false }; };
    const result = await f.commands.execute('create');
    assert.equal(result.projectRoot, path.join(f.root, 'NewProject'));
    assert.deepEqual(f.tasks[0].args, ['project:create', '--type', 'ACCOUNTCUSTOMIZATION', '--projectname', 'NewProject']);
    assert.equal(f.state.get(projectKey(f.folder)), 'NewProject');
});

test('project selection persists explicit choices and does not silently replace missing projects', async t => {
    const f = await fixture(t);
    f.state.set(projectKey(f.folder), 'Missing');
    await assert.rejects(f.commands.execute('validate'), /Select Project/);
    f.picks.push(choices => choices.find(choice => choice.project?.projectRoot === f.projectRoot));
    assert.equal((await f.commands.execute('selectProject')).projectRoot, f.projectRoot);
    assert.equal(f.state.get(projectKey(f.folder)), 'Example');
    f.picks.push(choices => choices.find(choice => choice.browse));
    f.directories.push([f.uri(path.dirname(f.root))]);
    await assert.rejects(f.commands.execute('selectProject'), /inside the selected workspace/);
});

test('disposal during an account prompt stops before any task starts', async t => {
    const f = await fixture(t);
    f.picks.push(() => { f.commands.dispose(); return { browser: true }; });
    assert.equal((await f.commands.execute('authenticate')).cancelled, true);
    assert.equal(f.tasks.length, 0);
    assert.equal(f.runner.disposed, true);
});

test('a running operation prevents overlapping commands without clearing its lock', async t => {
    const f = await fixture(t);
    let release; let started;
    const taskStarted = new Promise(resolve => { started = resolve; });
    f.onRun = () => new Promise(resolve => { release = resolve; started(); });
    const pending = f.commands.execute('validate');
    await taskStarted;
    await assert.rejects(f.commands.execute('validate'), /Another SuiteCloud operation/);
    assert.equal(f.commands.active.size, 1);
    release({ cancelled: false });
    await pending;
    assert.equal(f.commands.active.size, 0);
});

test('unit test command runs only an existing configured npm test script', async t => {
    const f = await fixture(t);
    await assert.rejects(f.commands.execute('test'), /no unit-test package/);
    await fs.writeFile(path.join(f.projectRoot, 'package.json'), JSON.stringify({ scripts: { test: 'jest' }, devDependencies: { '@oracle/suitecloud-unit-testing': '3.0.0' } }));
    const installed = path.join(f.projectRoot, 'node_modules', '@oracle', 'suitecloud-unit-testing');
    await fs.mkdir(installed, { recursive: true }); await fs.writeFile(path.join(installed, 'package.json'), '{}');
    await f.commands.execute('test');
    assert.equal(f.tasks[0].command, 'npm');
    assert.deepEqual(f.tasks[0].args, ['test']);
});
