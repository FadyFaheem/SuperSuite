'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Client, InMemoryTransport } = require('@modelcontextprotocol/client');
const { StdioClientTransport } = require('@modelcontextprotocol/client/stdio');
const { createSuperSuiteServer } = require('../mcp/server');
const { CONNECTION_ENV, CREDENTIALS_ENV } = require('../mcp/account');

async function connected(t, dependencies = {}) {
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const server = createSuperSuiteServer(dependencies);
    const client = new Client({ name: 'supersuite-protocol-tests', version: '1.0.0' });
    t.after(async () => { await client.close(); await server.close(); });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return { server, client };
}

async function rejectedTool(client, name, args) {
    try {
        const result = await client.callTool({ name, arguments: args });
        assert.equal(result.isError, true, name + ' should reject invalid arguments');
    } catch (error) {
        // SDK versions may return protocol InvalidParams or an isError result.
        if (error.code === 'ERR_ASSERTION') throw error;
        assert.ok(error.code !== undefined || /invalid|unknown|not found/i.test(error.message));
    }
}

test('official MCP client initializes the server and sees only annotated read-only tools', async t => {
    const { client } = await connected(t);
    assert.equal(client.getServerVersion().name, 'supersuite-readonly');
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map(tool => tool.name).sort(), [
        'netsuite_connection_info', 'netsuite_get_record', 'netsuite_read_documentation',
        'netsuite_search_documentation', 'netsuite_search_records'
    ]);
    for (const tool of tools) {
        assert.equal(tool.annotations.readOnlyHint, true);
        assert.equal(tool.annotations.destructiveHint, false);
        assert.equal(tool.annotations.idempotentHint, true);
        assert.equal(tool.inputSchema.additionalProperties, false);
        assert.ok(!/write|save|execute|deploy|delete/.test(tool.name));
    }
    const prompts = await client.listPrompts();
    assert.equal(prompts.prompts.length, 1);
    const result = await client.getPrompt({ name: 'inspect_record_and_update_script',
        arguments: { recordType: 'customer', internalId: '12', change: 'Handle a missing email address.' } });
    assert.match(result.messages[0].content.text, /customer internal ID 12/);
    assert.match(result.messages[0].content.text, /Handle a missing email address/);
    assert.match(result.messages[0].content.text, /Do not deploy or mutate/);
});

test('documentation tools work without credentials while account tools explain missing setup', async t => {
    const { client } = await connected(t);
    const search = await client.callTool({ name: 'netsuite_search_documentation', arguments: { query: 'record load' } });
    assert.notEqual(search.isError, true);
    assert.equal(search.structuredContent.coverage, 'curated-catalog');
    assert.ok(search.structuredContent.results.length > 0);
    assert.ok(search.structuredContent.results.every(result => result.url.startsWith('https://')));
    const account = await client.callTool({ name: 'netsuite_connection_info', arguments: {} });
    assert.equal(account.isError, true);
    assert.match(account.content[0].text, /CONFIGURATION_REQUIRED/);
});

test('tool handlers receive parsed defaults and SDK cancellation signal without arbitrary actions', async t => {
    const calls = [];
    const account = {
        connectionInfo: async options => { calls.push({ name: 'info', options }); return { readOnlyMode: true }; },
        getRecord: async (args, options) => { calls.push({ name: 'record', args, options }); return { record: { fields: { entityid: 'Example' } } }; },
        searchRecords: async (args, options) => { calls.push({ name: 'search', args, options }); return { results: [] }; }
    };
    const { client } = await connected(t, { account });
    const record = await client.callTool({ name: 'netsuite_get_record', arguments: { recordType: 'customer', internalId: '12', fields: ['entityid'] } });
    assert.equal(record.structuredContent.record.fields.entityid, 'Example');
    assert.equal(calls[0].args.includeSublists, false);
    assert.equal(typeof calls[0].options.signal.addEventListener, 'function');
    await client.callTool({ name: 'netsuite_search_records', arguments: { recordType: 'customer' } });
    assert.deepEqual(calls[1].args.columns, ['internalid']);
    assert.equal(calls[1].args.pageSize, 5);
    assert.equal(calls[1].args.cursor, '0');
    const before = calls.length;
    for (const [name, args] of [
        ['netsuite_get_record', { recordType: 'customer', internalId: '12', action: 'push' }],
        ['netsuite_get_record', { recordType: '../customer', internalId: '12' }],
        ['netsuite_get_record', { recordType: 'customer', internalId: '12;execute()' }],
        ['netsuite_search_records', { recordType: 'customer', columns: [] }],
        ['netsuite_search_records', { recordType: 'customer', columns: Array(21).fill('email') }],
        ['netsuite_search_records', { recordType: 'customer', filters: [{ fieldId: 'email', operator: 'is', values: ['a'], join: 'entity' }] }],
        ['netsuite_search_records', { recordType: 'customer', query: 'SELECT * FROM customer' }],
        ['netsuite_connection_info', { restlet: 'https://evil.example' }],
        ['netsuite_execute_script', { code: 'deleteAllRecords()' }]
    ]) await rejectedTool(client, name, args);
    assert.equal(calls.length, before);
});

test('SDK calls expose fixed errors and bound data projections', async t => {
    const account = {
        connectionInfo: async () => { throw new Error('private.token customer name and email'); },
        getRecord: async () => ({ fields: { memo: 'x'.repeat(300000) } })
    };
    const { client } = await connected(t, { account });
    const failed = await client.callTool({ name: 'netsuite_connection_info', arguments: {} });
    assert.equal(failed.isError, true);
    assert.ok(!JSON.stringify(failed).includes('private.token'));
    assert.match(failed.content[0].text, /Read failed/);
    const large = await client.callTool({ name: 'netsuite_get_record', arguments: { recordType: 'customer', internalId: '12' } });
    assert.equal(large.isError, true);
    assert.match(large.content[0].text, /RESULT_TOO_LARGE/);
    assert.ok(JSON.stringify(large).length < 1000);
});

test('MCP cancellation reaches documentation fetch and closing disposes its service', { timeout: 5000 }, async t => {
    let started;
    let cancelled;
    let disposed = 0;
    const startedPromise = new Promise(resolve => { started = resolve; });
    const cancelledPromise = new Promise(resolve => { cancelled = resolve; });
    const documentation = {
        readDocumentation: (_args, { signal }) => new Promise((_resolve, reject) => {
            started();
            signal.addEventListener('abort', () => { cancelled(); reject(Object.assign(new Error('private fetch state'), { name: 'AbortError' })); }, { once: true });
        }),
        dispose: () => { disposed += 1; }
    };
    const { server, client } = await connected(t, { documentation });
    const controller = new AbortController();
    const pending = client.callTool({ name: 'netsuite_read_documentation', arguments: { url: 'https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4267258486.html' } }, { signal: controller.signal });
    await startedPromise;
    controller.abort();
    await assert.rejects(pending);
    await cancelledPromise;
    await server.close();
    assert.equal(disposed, 1);
});

for (const era of ['legacy', 'modern']) test(`packaged stdio entry point serves ${era} clients with clean protocol output`, { timeout: 15000 }, async t => {
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key, value]) =>
        typeof value === 'string' && ![CONNECTION_ENV, CREDENTIALS_ENV, 'ELECTRON_RUN_AS_NODE'].includes(key)));
    const transport = new StdioClientTransport({ command: process.execPath,
        args: [path.join(__dirname, '../mcp/server.js')], env: environment, stderr: 'pipe' });
    const client = new Client({ name: 'supersuite-stdio-tests', version: '1.0.0' }, era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {});
    let stderr = '';
    transport.stderr.on('data', chunk => { stderr += chunk.toString(); });
    t.after(async () => { await client.close(); await transport.close(); });
    await client.connect(transport);
    assert.equal(client.getServerVersion().name, 'supersuite-readonly');
    assert.equal((await client.listTools()).tools.length, 5);
    const result = await client.callTool({ name: 'netsuite_search_documentation', arguments: { query: 'SuiteCloud' } });
    assert.notEqual(result.isError, true);
    assert.ok(result.structuredContent.results.length > 0);
    const prompt = await client.getPrompt({ name: 'inspect_record_and_update_script', arguments: { recordType: 'invoice', internalId: '123', change: 'Use a safe fallback.' } });
    assert.match(prompt.messages[0].content.text, /invoice internal ID 123/);
    assert.equal(stderr, '');
});

test('stdio startup configuration failures never print credentials or malformed input', { timeout: 15000 }, async () => {
    const run = promisify(execFile);
    const secret = 'DO_NOT_EXPOSE_PRIVATE_TOKEN';
    await assert.rejects(run(process.execPath, [path.join(__dirname, '../mcp/server.js')], {
        env: { ...process.env, [CONNECTION_ENV]: '{' + secret, [CREDENTIALS_ENV]: secret }, timeout: 10000
    }), error => {
        assert.equal(error.code, 1);
        assert.equal(error.stdout, '');
        assert.match(error.stderr, /could not start/);
        assert.ok(!error.stderr.includes(secret));
        return true;
    });
});
