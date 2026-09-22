'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'supersuite-tasks-'));
    const projectRoot = path.join(root, '.config', 'deployment');
    await fs.mkdir(projectRoot, { recursive: true });
    t.after(async () => {
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        await fs.rm(root, { recursive: true, force: true });
    });
    const events = { process: new Set(), task: new Set() };
    const cancellations = new Set();
    const timers = new Map();
    const lines = [];
    const requests = [];
    const executions = [];
    let timerId = 0;
    let announceStart;
    const f = {
        root, projectRoot, folder: { uri: { scheme: 'file', fsPath: root } }, events, timers, lines, requests, executions, projectChecks: [],
        readBootstrapProject: async () => ({ projectRoot }),
        started: new Promise(resolve => { announceStart = resolve; }),
        emit(type, event) { for (const listener of [...events[type]]) listener(event); },
        fireTimer(delay) { for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.callback(); } },
        cancel() { this.token.isCancellationRequested = true; for (const callback of cancellations) callback(); },
        execution(task) { const execution = { task, terminations: 0, terminate() { this.terminations++; f.onTerminate?.(this); } }; executions.push(execution); return execution; }
    };
    f.token = { isCancellationRequested: false, onCancellationRequested(callback) { cancellations.add(callback); return { dispose() { cancellations.delete(callback); } }; } };
    f.startTask = async task => f.execution(task);
    const vscode = {
        workspace: { isTrusted: true },
        ProgressLocation: { Notification: 15 }, ShellQuoting: { Strong: 2 }, TaskRevealKind: { Always: 1 }, TaskPanelKind: { Dedicated: 2 },
        ShellExecution: class { constructor(command, args, options) { Object.assign(this, { command, args, options }); } },
        Task: class { constructor(definition, scope, name, source, execution, problemMatchers) { Object.assign(this, { definition, scope, name, source, execution, problemMatchers }); } },
        window: { withProgress: async (_options, work) => work({ report() {} }, f.token) },
        tasks: {
            onDidEndTaskProcess(listener) { events.process.add(listener); return { dispose() { events.process.delete(listener); } }; },
            onDidEndTask(listener) { events.task.add(listener); return { dispose() { events.task.delete(listener); } }; },
            executeTask(task) { requests.push(task); const result = f.startTask(task); announceStart(); return result; }
        }
    };
    const filename = path.resolve(__dirname, '../setup/taskRunner.js');
    const localRequire = createRequire(filename);
    const module = { exports: {} };
    vm.runInNewContext(await fs.readFile(filename, 'utf8'), {
        module, process,
        setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
        clearTimeout(id) { timers.delete(id); },
        require(name) {
            if (name === 'vscode') return vscode;
            if (name === './bootstrap') return { async readBootstrapProject(root) { f.projectChecks.push(root); return f.readBootstrapProject(root); } };
            return localRequire(name);
        }
    }, { filename });
    f.vscode = vscode;
    f.runner = new module.exports.SuiteCloudTaskRunner({ appendLine: line => lines.push(line) });
    f.validateArguments = module.exports.validateArguments;
    f.run = args => f.runner.run(f.folder, projectRoot, args || ['project:deploy'], 'SuperSuite deployment');
    t.after(() => f.runner.dispose());
    return f;
}

test('SuiteCloud task arguments are allowlisted and cannot carry secrets or shell syntax', async t => {
    const f = await fixture(t);
    for (const args of [['--version'], ['account:setup', '--interactive'], ['account:setup:ci', '--select', 'superSuite_123-SB1'], ['project:validate'], ['project:deploy', '--dryrun'], ['project:deploy']]) assert.doesNotThrow(() => f.validateArguments(args));
    for (const args of [[], ['project:deploy', '--authid', 'other'], ['account:setup:ci', '--select', 'alias;shutdown'], ['account:setup:ci', '--select', '$(danger)'], ['account:setup:ci', '--select', '%PATH%'], ['account:setup', '--token', 'secret'], ['project:deploy', null]]) assert.throws(() => f.validateArguments(args));
});

test('visible tasks use literal command, strong-quoted arguments, and a separate cwd', async t => {
    const f = await fixture(t);
    const pending = f.run(['account:setup', '--interactive']);
    await f.started;
    const task = f.requests[0];
    assert.equal(task.execution.command, 'suitecloud');
    assert.equal(task.execution.options.cwd, f.projectRoot);
    assert.ok(task.execution.args.every(argument => argument.quoting === f.vscode.ShellQuoting.Strong));
    assert.deepEqual(Array.from(task.execution.args, argument => argument.value), ['account:setup', '--interactive']);
    assert.equal(task.presentationOptions.reveal, f.vscode.TaskRevealKind.Always);
    assert.equal(task.presentationOptions.focus, true);
    f.emit('process', { execution: f.executions[0], exitCode: 0 });
    const result = await pending;
    assert.equal(result.cancelled, false);
    assert.equal(result.exitCode, 0);
    assert.equal(f.events.process.size, 0);
    assert.equal(f.events.task.size, 0);
    assert.equal(f.timers.size, 0);
});

test('process completion before executeTask resolves is not missed', async t => {
    const f = await fixture(t);
    f.startTask = async task => {
        const execution = f.execution(task);
        f.emit('process', { execution, exitCode: 0 });
        return execution;
    };
    assert.equal((await f.run()).exitCode, 0);
    assert.equal(f.runner.owned.size, 0);
    assert.equal(f.runner.activeRoots.size, 0);
});

test('unrelated task events do not finish or terminate owned setup tasks', async t => {
    const f = await fixture(t);
    const pending = f.run();
    await f.started;
    const other = { task: { definition: { supersuiteSetupId: 'someone-else' } } };
    f.emit('process', { execution: other, exitCode: 1 });
    f.emit('task', { execution: other });
    assert.equal(f.runner.owned.size, 1);
    assert.equal([...f.timers.values()].some(timer => timer.delay === 250), false);
    f.emit('process', { execution: f.executions[0], exitCode: 0 });
    assert.equal((await pending).cancelled, false);
});

test('nonzero exits reject with a resumable, actionable error', async t => {
    const f = await fixture(t);
    const pending = f.run();
    await f.started;
    f.emit('process', { execution: f.executions[0], exitCode: 127 });
    await assert.rejects(pending, /code 127.*task terminal.*Init again/);
    assert.equal(f.runner.activeRoots.size, 0);
    assert.equal(f.events.process.size, 0);
});

test('task-only end events fall back to cancellation but nearby process exit wins', async t => {
    const f = await fixture(t);
    let pending = f.run();
    await f.started;
    f.emit('task', { execution: f.executions[0] });
    f.emit('process', { execution: f.executions[0], exitCode: 0 });
    assert.equal((await pending).cancelled, false);
    f.startTask = async task => {
        const execution = f.execution(task);
        f.emit('task', { execution });
        f.fireTimer(250);
        return execution;
    };
    pending = f.run();
    assert.equal((await pending).cancelled, true);
    assert.equal(f.timers.size, 0);
});

test('already-cancelled progress never starts a process', async t => {
    const f = await fixture(t);
    f.cancel();
    assert.equal((await f.run()).cancelled, true);
    assert.equal(f.requests.length, 0);
    assert.equal(f.events.process.size, 0);
});

test('cancellation terminates only the runner execution and clears listeners', async t => {
    const f = await fixture(t);
    const pending = f.run();
    await f.started;
    f.cancel();
    assert.equal((await pending).cancelled, true);
    await Promise.resolve();
    assert.equal(f.executions[0].terminations, 1);
    assert.equal(f.events.process.size, 0);
    assert.equal(f.events.task.size, 0);
    assert.equal(f.runner.owned.size, 0);
});

test('disposal before executeTask resolves still terminates its eventual execution', async t => {
    const f = await fixture(t);
    let resolveExecution;
    f.startTask = task => new Promise(resolve => { const execution = f.execution(task); resolveExecution = () => resolve(execution); });
    const pending = f.run();
    await f.started;
    f.runner.dispose();
    assert.equal((await pending).cancelled, true);
    resolveExecution();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.executions[0].terminations, 1);
    assert.equal((await f.run()).cancelled, true);
    assert.equal(f.requests.length, 1);
});

test('a stalled SuiteCloud task times out, terminates, and releases the project lock', async t => {
    const f = await fixture(t);
    f.onTerminate = execution => f.emit('process', { execution, exitCode: undefined });
    const pending = f.run();
    await f.started;
    f.fireTimer(15 * 60 * 1000);
    await assert.rejects(pending, /timed out after 15 minutes/);
    await Promise.resolve();
    assert.equal(f.executions[0].terminations, 1);
    assert.equal(f.runner.activeRoots.size, 0);
    assert.equal(f.timers.size, 0);
});

test('failure to start reports CLI prerequisites without exposing underlying error text', async t => {
    const f = await fixture(t);
    f.startTask = async () => { throw new Error('private-environment-data'); };
    await assert.rejects(f.run(), error => /Install the Oracle SuiteCloud CLI/.test(error.message) && !error.message.includes('private-environment-data'));
    assert.equal(f.runner.activeRoots.size, 0);
    assert.equal(f.runner.owned.size, 0);
});

test('task execution requires trust, a safe project path, and an exclusive project lock', async t => {
    const f = await fixture(t);
    f.vscode.workspace.isTrusted = false;
    await assert.rejects(f.run(), /Trust this workspace/);
    f.vscode.workspace.isTrusted = true;
    await assert.rejects(f.runner.run(f.folder, path.dirname(f.root), ['--version']), /outside the selected workspace/);
    const pending = f.run();
    await f.started;
    await assert.rejects(f.run(), /already running/);
    f.emit('process', { execution: f.executions[0], exitCode: 0 });
    await pending;
    assert.equal(f.runner.activeRoots.size, 0);
});

test('every task verifies the generated project and rejects altered or mismatched scaffolds', async t => {
    const f = await fixture(t);
    f.startTask = async task => {
        const execution = f.execution(task);
        f.emit('process', { execution, exitCode: 0 });
        return execution;
    };
    await f.run(['project:deploy', '--dryrun']);
    assert.deepEqual(f.projectChecks, [f.root]);
    f.readBootstrapProject = async () => { throw new Error('Generated file changed: suitecloud.config.js'); };
    await assert.rejects(f.run(), /Generated file changed/);
    assert.equal(f.requests.length, 1, 'A changed scaffold must fail before SuiteCloud executes its JavaScript configuration.');
    f.readBootstrapProject = async () => null;
    await assert.rejects(f.run(), /unchanged project generated by SuperSuite Init/);
    f.readBootstrapProject = async () => ({ projectRoot: f.root });
    await assert.rejects(f.run(), /unchanged project generated by SuperSuite Init/);
    assert.equal(f.projectChecks.length, 4);
    assert.equal(f.runner.activeRoots.size, 0);
});
