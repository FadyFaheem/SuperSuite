'use strict';

const vscode = require('vscode');
const crypto = require('node:crypto');
const { AUTH_ALIAS, PROJECT_NAME } = require('./project');

function validateCommand(command, args) {
    if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) throw new Error('Invalid SuiteCloud command.');
    const choices = [['account:setup', '--interactive'], ['project:validate'], ['project:deploy', '--dryrun'], ['project:deploy'], ['object:import', '--interactive'], ['file:import', '--interactive']];
    if (command === 'npm' && args.length === 1 && args[0] === 'test') return;
    if (command !== 'suitecloud') throw new Error('Unsupported SuiteCloud executable.');
    if (choices.some(choice => choice.length === args.length && choice.every((value, index) => value === args[index]))) return;
    if (args.length === 3 && args[0] === 'account:setup:ci' && args[1] === '--select' && AUTH_ALIAS.test(args[2])) return;
    if (args.length === 5 && args[0] === 'project:create' && args[1] === '--type' && args[2] === 'ACCOUNTCUSTOMIZATION' && args[3] === '--projectname' && PROJECT_NAME.test(args[4])) return;
    throw new Error('Unsupported SuiteCloud command or arguments.');
}

class ProjectTaskRunner {
    constructor(output) { this.output = output; this.operations = new Set(); this.disposed = false; }

    dispose() {
        this.disposed = true;
        for (const operation of [...this.operations]) operation.cancel();
    }

    async run(folder, root, command, args, title, guard) {
        if (this.disposed) return { cancelled: true };
        if (!vscode.workspace.isTrusted || folder?.uri?.scheme !== 'file') throw new Error('SuiteCloud commands require a trusted filesystem workspace.');
        validateCommand(command, args);
        await guard();
        if (this.disposed || !vscode.workspace.isTrusted) return { cancelled: true };
        const shell = new vscode.ShellExecution(command, args.map(value => ({ value, quoting: vscode.ShellQuoting.Strong })), { cwd: root });
        const task = new vscode.Task({ type: 'supersuite-suitecloud', supersuiteTaskId: crypto.randomUUID() }, folder, title, 'SuperSuite', shell, []);
        task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, focus: args.includes('--interactive'), panel: vscode.TaskPanelKind.Dedicated, showReuseMessage: false };
        task.runOptions = { reevaluateOnRerun: false };
        return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, (_progress, token) => this.execute(task, token, guard));
    }

    execute(task, token, guard) {
        if (this.disposed || token.isCancellationRequested) return Promise.resolve({ cancelled: true });
        return new Promise((resolve, reject) => {
            let finished = false;
            let timeout;
            let endFallback;
            const subscriptions = [];
            const operation = { execution: undefined, cancelled: false, terminated: false };
            const finish = (result, error) => {
                if (finished) return;
                finished = true;
                clearTimeout(timeout);
                clearTimeout(endFallback);
                for (const subscription of subscriptions) subscription.dispose();
                this.operations.delete(operation);
                if (error) reject(error); else resolve(result);
            };
            const terminate = () => {
                if (!operation.execution || operation.terminated) return;
                operation.terminated = true;
                try { operation.execution.terminate(); } catch { this.output.appendLine('Could not stop the SuiteCloud task. Close its terminal if it is still running.'); }
            };
            operation.cancel = error => { operation.cancelled = true; finish({ cancelled: true }, error); terminate(); };
            const matches = event => event.execution?.task?.definition?.supersuiteTaskId === task.definition.supersuiteTaskId;
            this.operations.add(operation);
            subscriptions.push(vscode.tasks.onDidEndTaskProcess(event => {
                if (!matches(event)) return;
                if (event.exitCode === undefined || operation.cancelled) return finish({ cancelled: true });
                if (event.exitCode !== 0) return finish(undefined, new Error(`SuiteCloud task exited with code ${event.exitCode}. Review its terminal for details.`));
                finish({ cancelled: false, exitCode: 0 });
            }));
            subscriptions.push(vscode.tasks.onDidEndTask(event => {
                if (!matches(event) || finished) return;
                clearTimeout(endFallback);
                endFallback = setTimeout(() => finish({ cancelled: true }), 250);
            }));
            subscriptions.push(token.onCancellationRequested(() => operation.cancel()));
            timeout = setTimeout(() => operation.cancel(new Error('SuiteCloud task timed out after 15 minutes and was stopped. Review the terminal before retrying.')), 15 * 60 * 1000);
            Promise.resolve().then(async () => {
                await guard();
                if (operation.cancelled || this.disposed || token.isCancellationRequested || !vscode.workspace.isTrusted) { operation.cancel(); return; }
                this.output.appendLine(`Running ${task.execution.command} ${task.execution.args[0].value} in the SuiteCloud project. Follow its task terminal.`);
                try { operation.execution = await vscode.tasks.executeTask(task); }
                catch { throw new Error('Could not start the SuiteCloud task. Check the installed Oracle SuiteCloud CLI, Node.js and Java prerequisites in the SuiteCloud guide.'); }
                if (operation.cancelled) terminate();
            }).catch(error => finish(undefined, error));
        });
    }
}

module.exports = { ProjectTaskRunner, validateCommand };
