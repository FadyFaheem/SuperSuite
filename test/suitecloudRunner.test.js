'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

async function fixture(t) {
    const events = { process: new Set(), task: new Set(), cancel: new Set() };
    const f = { requests: [], executions: [], guards: 0, events };
    let announce;
    f.started = new Promise(resolve => { announce = resolve; });
    f.emit = (kind, event) => { for (const listener of [...events[kind]]) listener(event); };
    const subscribe = kind => listener => { events[kind].add(listener); return { dispose() { events[kind].delete(listener); } }; };
    const token = { isCancellationRequested: false, onCancellationRequested: subscribe('cancel') };
    f.cancel = () => { token.isCancellationRequested = true; f.emit('cancel'); };
    f.startTask = async task => {
        const execution = { task, terminations: 0, terminate() { this.terminations++; } };
        f.executions.push(execution); return execution;
    };
    const vscode = {
        workspace: { isTrusted: true }, ShellQuoting: { Strong: 2 }, TaskRevealKind: { Always: 1 }, TaskPanelKind: { Dedicated: 2 }, ProgressLocation: { Notification: 15 },
        ShellExecution: class { constructor(command, args, options) { Object.assign(this, { command, args, options }); } },
        Task: class { constructor(definition, folder, name, source, execution) { Object.assign(this, { definition, folder, name, source, execution }); } },
        window: { withProgress: async (_options, work) => work({}, token) },
        tasks: {
            onDidEndTask: subscribe('task'), onDidEndTaskProcess: subscribe('process'),
            executeTask: task => { f.requests.push(task); const value = f.startTask(task); announce(); return value; }
        }
    };
    const filename = path.resolve(__dirname, '../suitecloud/taskRunner.js');
    const localRequire = createRequire(filename);
    const module = { exports: {} };
    vm.runInNewContext(await fs.readFile(filename, 'utf8'), { module, setTimeout, clearTimeout, require: name => name === 'vscode' ? vscode : localRequire(name) }, { filename });
    f.validate = module.exports.validateCommand;
    f.runner = new module.exports.ProjectTaskRunner({ appendLine() {} });
    f.vscode = vscode;
    f.guard = async () => { f.guards++; };
    f.run = (args = ['project:validate']) => f.runner.run({ uri: { scheme: 'file' } }, path.resolve('project'), 'suitecloud', args, 'SuiteCloud test task', () => f.guard());
    t.after(() => f.runner.dispose());
    return f;
}

test('SuiteCloud task allowlist excludes credentials, arbitrary executables and shell syntax', async t => {
    const f = await fixture(t);
    for (const args of [['project:validate'], ['project:deploy'], ['project:deploy', '--dryrun'], ['object:import', '--interactive'], ['file:import', '--interactive'], ['project:create', '--type', 'ACCOUNTCUSTOMIZATION', '--projectname', 'Demo'], ['account:setup:ci', '--select', 'my.alias']]) assert.doesNotThrow(() => f.validate('suitecloud', args));
    assert.doesNotThrow(() => f.validate('npm', ['test']));
    for (const [command, args] of [['sh', ['script']], ['npm', ['install']], ['npx', ['jest']], ['suitecloud', ['project:deploy', '--applyinstallprefs']], ['suitecloud', ['account:setup:ci', '--privatekeypath', '/key.pem']], ['suitecloud', ['account:setup:ci', '--select', 'foo;bar']], ['suitecloud', ['project:create', '--type', 'ACCOUNTCUSTOMIZATION', '--projectname', '../existing']]]) assert.throws(() => f.validate(command, args));
});

test('tasks run strong-quoted arguments in a separate working directory and recheck guards', async t => {
    const f = await fixture(t);
    const pending = f.run(['account:setup', '--interactive']);
    await f.started;
    const task = f.requests[0];
    assert.equal(task.execution.command, 'suitecloud');
    assert.equal(task.execution.options.cwd, path.resolve('project'));
    assert.deepEqual(Array.from(task.execution.args, argument => argument.value), ['account:setup', '--interactive']);
    assert.ok(task.execution.args.every(argument => argument.quoting === 2));
    assert.equal(task.presentationOptions.focus, true);
    assert.equal(task.definition.type, 'supersuite-suitecloud');
    assert.equal(f.guards, 2);
    f.emit('process', { execution: f.executions[0], exitCode: 0 });
    assert.equal((await pending).cancelled, false);
    assert.equal(f.events.process.size, 0);
    assert.equal(f.events.task.size, 0);
});

test('failed final guard cannot start a SuiteCloud process', async t => {
    const f = await fixture(t);
    f.guard = async () => { if (++f.guards === 2) throw new Error('Project changed'); };
    await assert.rejects(f.run(), /Project changed/);
    assert.equal(f.requests.length, 0);
    assert.equal(f.runner.operations.size, 0);
});

test('process completion before executeTask resolves is captured by unique task ID', async t => {
    const f = await fixture(t);
    f.startTask = async task => { const execution = { task }; f.emit('process', { execution, exitCode: 0 }); return execution; };
    assert.equal((await f.run()).exitCode, 0);
    assert.equal(f.runner.operations.size, 0);
});

test('unrelated task completion does not end a SuiteCloud operation', async t => {
    const f = await fixture(t);
    const pending = f.run();
    await f.started;
    f.emit('process', { execution: { task: { definition: { supersuiteTaskId: 'other' } } }, exitCode: 0 });
    assert.equal(f.runner.operations.size, 1);
    f.emit('process', { execution: f.executions[0], exitCode: 1 });
    await assert.rejects(pending, /exited with code 1/);
});

test('cancellation before executeTask resolves terminates the returned owned execution', async t => {
    const f = await fixture(t);
    let release;
    const execution = { terminations: 0, terminate() { this.terminations++; } };
    f.startTask = task => { execution.task = task; return new Promise(resolve => { release = resolve; }); };
    const pending = f.run();
    await f.started;
    f.cancel();
    assert.equal((await pending).cancelled, true);
    release(execution);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(execution.terminations, 1);
    assert.equal(f.runner.operations.size, 0);
});

test('disposal cancels active tasks and prevents future task launches', async t => {
    const f = await fixture(t);
    const pending = f.run();
    await f.started;
    f.runner.dispose();
    assert.equal((await pending).cancelled, true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.executions[0].terminations, 1);
    assert.equal((await f.run()).cancelled, true);
    assert.equal(f.requests.length, 1);
});

test('task-only end event returns cancellation and startup failures have actionable errors', async t => {
    const f = await fixture(t);
    f.startTask = async task => { const execution = { task }; f.emit('task', { execution }); return execution; };
    assert.equal((await f.run()).cancelled, true);
    f.startTask = async () => { throw new Error('unavailable'); };
    await assert.rejects(f.run(), /installed Oracle SuiteCloud CLI/);
    assert.equal(f.events.process.size, 0);
});

test('trust revoked during the last guard prevents process execution', async t => {
    const f = await fixture(t);
    f.guard = async () => { if (++f.guards === 2) f.vscode.workspace.isTrusted = false; };
    assert.equal((await f.run()).cancelled, true);
    assert.equal(f.requests.length, 0);
});
