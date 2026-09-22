'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

async function run() {
    const extension = vscode.extensions.getExtension('fadyfaheem.supersuite');
    assert.ok(extension, 'SuperSuite is discoverable by its new Marketplace identity');
    const api = await extension.activate();
    assert.ok(extension.isActive, 'SuperSuite activates');
    const available = await vscode.commands.getCommands(true);
    for (const command of extension.packageJSON.contributes.commands) assert.ok(available.includes(command.command), `Registered command: ${command.command}`);
    await vscode.commands.executeCommand('supersuite.accessSetupGuide');
    const guideOpened = () => vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.input instanceof vscode.TabInputWebview && tab.label.includes('ACCESS_SETUP')));
    for (let attempt = 0; attempt < 100 && !guideOpened(); attempt += 1) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(guideOpened(), 'The bundled key guide opens in a Markdown preview through the registered command');
    const root = process.env.SUPERSUITE_TEST_WORKSPACE;
    assert.ok(root, 'Tests have an isolated workspace');
    const folder = await api.configuration.folder(vscode.Uri.file(root));
    assert.equal(path.relative(folder.uri.fsPath, root), '', 'VS Code may normalize the Windows drive-letter casing.');
    assert.equal((await api.configuration.config(folder)).rootDirectory, 'SuiteScripts');
    await fs.mkdir(path.join(root, '.config'), { recursive: true });
    await fs.writeFile(path.join(root, '.config', 'supersuite.json'), JSON.stringify({ rootDirectory: 'SuiteScripts/Test' }));
    assert.equal((await api.configuration.config(folder)).rootDirectory, 'SuiteScripts/Test');
    await require('./editor').run();
    if (vscode.McpStdioServerDefinition) {
        await api.mcp.context.globalState.update('supersuite.mcp.documentation', true);
        const definitions = await api.mcp.provideMcpServerDefinitions();
        const definition = definitions.find(item => item.label === 'SuperSuite documentation');
        assert.ok(definition, 'Native MCP discovery exposes the enabled documentation server');
        const resolved = await api.mcp.resolveMcpServerDefinition(definition);
        const { Client } = require('@modelcontextprotocol/client');
        const { StdioClientTransport } = require('@modelcontextprotocol/client/stdio');
        const transport = new StdioClientTransport({ command: resolved.command, args: resolved.args,
            env: { ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === 'string')), ...resolved.env }, stderr: 'pipe' });
        const client = new Client({ name: 'supersuite-vscode-integration', version: '1.0.0' });
        try {
            await client.connect(transport);
            const tools = await client.listTools();
            assert.ok(tools.tools.some(tool => tool.name === 'netsuite_get_record'));
            const response = await client.callTool({ name: 'netsuite_search_documentation', arguments: { query: 'record' } });
            assert.notEqual(response.isError, true, 'The resolved MCP process runs with the VS Code Node executable');
            assert.ok(response.structuredContent.results.length);
        } finally { await client.close(); await api.mcp.context.globalState.update('supersuite.mcp.documentation', false); }
    }
    console.log(`SuperSuite integration tests passed in VS Code ${vscode.version}.`);
}
module.exports = { run };
