'use strict';
const vscode = require('vscode');
const { WorkspaceConfiguration } = require('./helpers/workspace');
const { NetSuiteCommands } = require('./bl/netSuiteBl');
const { RecordExporter, selectRecordTypes } = require('./helpers/recordExport');
const { SuiteCloudTaskRunner } = require('./setup/taskRunner');
const { InitializationWizard } = require('./helpers/initialize');
const { McpIntegration } = require('./mcp/extension');
const { SuiteCloudCommands, COMMANDS: SUITECLOUD_COMMANDS } = require('./suitecloud/commands');

function activate(context) {
    const output = vscode.window.createOutputChannel('SuperSuite');
    const configuration = new WorkspaceConfiguration(context, output);
    const commands = new NetSuiteCommands(context, configuration, output);
    const exporter = new RecordExporter(context, configuration, output);
    const taskRunner = new SuiteCloudTaskRunner(output);
    const initialization = new InitializationWizard(context, configuration, commands, exporter, taskRunner, output);
    const mcp = new McpIntegration(context, configuration, output);
    const suitecloud = new SuiteCloudCommands(context, output);
    context.subscriptions.push(output, configuration, commands, exporter, taskRunner, initialization, mcp, suitecloud);
    const register = (name, handler) => context.subscriptions.push(vscode.commands.registerCommand(name, async (...args) => {
        try { return await handler(...args); }
        catch (error) {
            output.appendLine(error.message || 'SuperSuite operation failed.');
            const choice = await vscode.window.showErrorMessage(`SuperSuite: ${error.message || 'Operation failed.'}`, 'Show Output');
            if (choice) output.show();
        }
    }));
    for (const action of ['downloadFile', 'uploadFile', 'previewFile', 'deleteFile', 'uploadFolder', 'downloadFolder', 'getRestletVersion', 'retryFailed']) {
        register(`supersuite.${action}`, uri => commands.execute(action, uri));
        if (action !== 'retryFailed') register(`netsuite-upload.${action}`, uri => commands.execute(action, uri));
    }
    register('supersuite.configure', uri => configuration.setup(uri));
    register('supersuite.mcp.configure', uri => mcp.configure(uri));
    register('supersuite.mcp.disable', uri => mcp.disable(uri));
    register('supersuite.mcp.guide', () => mcp.guide());
    for (const [name, definition] of Object.entries(SUITECLOUD_COMMANDS)) register(name, uri => suitecloud.execute(definition.action, uri));
    register('supersuite.initialize', uri => initialization.initialize(uri));
    register('supersuite.accessSetupGuide', () => initialization.openAccessGuide());
    register('supersuite.exportRecords', async uri => {
        const folder = await configuration.folder(uri);
        if (!folder) return;
        const types = await selectRecordTypes();
        if (!types?.length) return;
        const result = await exporter.exportRecords(folder, types, { resume: true });
        if (!result) return;
        const message = `Business record export ${result.cancelled ? 'paused' : result.complete ? 'complete' : 'has unfinished records'}: ${result.succeeded} saved, ${result.failed} failed, ${result.incomplete} incomplete. See .supersuite-data and Output for details.`;
        const choice = result.complete ? await vscode.window.showInformationMessage(message, 'Show Output') : await vscode.window.showWarningMessage(message, 'Show Output');
        if (choice) output.show();
        return result;
    });
    register('supersuite.configureCredentials', uri => configuration.configureCredentials(uri));
    register('supersuite.clearCredentials', uri => configuration.clearCredentials(uri));
    register('supersuite.migrateCredentials', uri => configuration.migrateCredentials(uri));
    register('supersuite.refreshMetadata', uri => configuration.refreshMetadata(uri));
    register('supersuite.showOutput', () => output.show());
    register('netsuite-upload.addCustomDependency', () => vscode.commands.executeCommand('supersuite.addCustomModule'));
    register('netsuite-upload.addNSDependency', () => vscode.commands.executeCommand('supersuite.addModule'));
    require('./editor').register(context, { getFieldMetadata: document => configuration.cachedFields(document) });
    context.subscriptions.push(vscode.window.registerTreeDataProvider('supersuite.workspace', { getTreeItem: item => item, getChildren: () => [] }));
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
    status.name = 'SuperSuite'; status.text = '$(cloud) SuperSuite';
    status.tooltip = 'Initialize or resume SuperSuite setup'; status.command = 'supersuite.initialize';
    if (vscode.workspace.workspaceFolders?.length) status.show();
    context.subscriptions.push(status, vscode.workspace.onDidChangeWorkspaceFolders(() => vscode.workspace.workspaceFolders?.length ? status.show() : status.hide()));
    if (vscode.workspace.isTrusted) for (const folder of vscode.workspace.workspaceFolders || []) {
        if (vscode.workspace.getConfiguration('supersuite', folder.uri).get('autoRefreshMetadata')) configuration.refreshMetadata(folder.uri, true).catch(error => output.appendLine(`Metadata: ${error.message}`));
    }
    initialization.resumePending().catch(error => output.appendLine(`Setup: ${error.message}`));
    context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => initialization.resumePending().catch(error => output.appendLine(`Setup: ${error.message}`))));
    return { configuration, commands, initialization, exporter, mcp, suitecloud };
}
module.exports = { activate, deactivate() {} };
