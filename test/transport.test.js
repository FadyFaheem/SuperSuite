'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createClient, delay } = require('../helpers/netSuiteRestClient');
const { authorizationHeader, createTbaHeader, percentEncode, validateRestletUrl } = require('../helpers/auth');

const endpoint = 'https://123456-sb1.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=6&deploy=1';
const config = { restlet: endpoint, authType: 'oauth2', accessToken: 'private.test.token', maxRetries: 0 };

function fakeNetwork(sequence) {
    const calls = [];
    const request = (url, options, receive) => {
        const req = new EventEmitter();
        const call = { url: new URL(url), ...options, destroyed: false };
        calls.push(call);
        req.destroy = () => { call.destroyed = true; };
        req.end = body => {
            call.body = body;
            queueMicrotask(() => {
                const step = sequence[calls.length - 1] || sequence.at(-1);
                if (step.hang) return;
                if (step.networkError) return req.emit('error', Object.assign(new Error('private internals'), { code: step.networkError }));
                const res = new PassThrough();
                res.statusCode = step.status || 200;
                res.headers = step.headers || {};
                receive(res);
                if (res.destroyed) return;
                if (step.aborted) return res.emit('aborted');
                if (step.chunks) {
                    for (const chunk of step.chunks) if (!res.destroyed) res.write(chunk);
                    if (!res.destroyed) res.end();
                } else res.end(step.raw === undefined ? JSON.stringify(step.body || { ok: true }) : step.raw);
            });
        };
        return req;
    };
    return { request, calls };
}

test('TBA HMAC-SHA256 matches the Oracle RESTlet signature example', () => {
    // Oracle's published test credentials, not real account secrets:
    // https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_1534941088.html
    const credentials = {
        realm: '123456',
        consumerToken: 'ef40afdd8abaac111b13825dd5e5e2ddddb44f86d5a0dd6dcf38c20aae6b67e4',
        consumerSecret: 'd26ad321a4b2f23b0741c8d38392ce01c3e23e109df6c96eac6d099e9ab9e8b5',
        netSuiteKey: '2b0ce516420110bcbd36b69e99196d1b7f6de3c6234c5afb799b73d87569f5cc',
        netSuiteSecret: 'c29a677df7d5439a458c063654187e3d678d73aca8e3c9d8bea1478a3eb0d295'
    };
    const url = 'https://123456.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=6&deploy=1&customParam=someValue&testParam=someOtherValue';
    const header = createTbaHeader(credentials, 'POST', url, { nonce: 'fjaLirsIcCGVZWzBX0pg', timestamp: '1508242306' });
    assert.match(header, /oauth_signature="%2BKK4SKNgz4ZiILGLwOMtfYlgcXSy1eis8ldE9X90azQ%3D"/);
    assert.match(header, /oauth_signature_method="HMAC-SHA256"/);
    assert.ok(!header.includes(credentials.consumerSecret));
    assert.ok(!header.includes(credentials.netSuiteSecret));
});

test('OAuth uses RFC 5849 encoding and signs every repeated query value once', () => {
    assert.equal(percentEncode("!*'() /é"), '%21%2A%27%28%29%20%2F%C3%A9');
    const credentials = { realm: '123456_SB1', consumerToken: 'consumer', consumerSecret: 'secret', netSuiteKey: 'token', netSuiteSecret: 'token-secret' };
    const seed = { nonce: 'fixed', timestamp: 1 };
    const first = createTbaHeader(credentials, 'GET', `${endpoint}&path=a%2Fb&tag=z&tag=a`, seed);
    const reordered = createTbaHeader(credentials, 'GET', `${endpoint}&tag=a&path=a%2Fb&tag=z`, seed);
    assert.equal(first, reordered);
    assert.notEqual(first, createTbaHeader(credentials, 'GET', `${endpoint}&path=a%2Fb&tag=z`, seed));
    assert.notEqual(first, createTbaHeader(credentials, 'GET', `${endpoint}&path=a%2Fc&tag=z&tag=a`, seed));
});

test('endpoint validation rejects credential forwarding and ambiguous endpoints', () => {
    for (const url of [
        endpoint.replace('https:', 'http:'), endpoint.replace('netsuite.com', 'netsuite.com.evil.example'),
        endpoint.replace('123456-sb1.restlets.api.netsuite.com', 'localhost'),
        endpoint.replace('https://', 'https://user:password@'), `${endpoint}#fragment`,
        endpoint.replace('.com/', '.com:8443/'), endpoint.replace('/restlet.nl', '/other'),
        `${endpoint}&script=9`, `${endpoint}&oauth_signature=bad`, `${endpoint}&access_token=bad`,
        endpoint.replace('&deploy=1', '')
    ]) assert.throws(() => validateRestletUrl(url), undefined, url);
    assert.equal(validateRestletUrl(endpoint).hostname, '123456-sb1.restlets.api.netsuite.com');
    assert.doesNotThrow(() => validateRestletUrl(endpoint.replace('restlets.api', 'app')));
});

test('authentication accepts bearer tokens, rejects NLAuth and header injection', () => {
    assert.equal(authorizationHeader(config, 'GET', endpoint), 'Bearer private.test.token');
    assert.throws(() => authorizationHeader({ authType: 'oauth2', accessToken: 'x\r\nAuthorization: x' }, 'GET', endpoint));
    assert.throws(() => authorizationHeader({ authType: 'nlauth' }, 'GET', endpoint), /NLAuth/);
    assert.throws(() => authorizationHeader({ authType: 'tba' }, 'GET', endpoint), /realm/);
});

test('read query parameters are encoded and push JSON stays out of the URL', async () => {
    const network = fakeNetwork([{ body: { ok: true, entries: [] } }]);
    const client = createClient(config, network);
    await client.request('list', { path: 'SuiteScripts/a & b', cursor: 'x+y=' });
    assert.equal(network.calls[0].method, 'GET');
    assert.equal(network.calls[0].url.searchParams.get('path'), 'SuiteScripts/a & b');
    assert.equal(network.calls[0].url.searchParams.get('cursor'), 'x+y=');
    assert.equal(network.calls[0].url.searchParams.get('script'), '6');
    await client.request('push', { files: [{ path: 'SuiteScripts/x.js', content: 'é' }] });
    assert.equal(network.calls[1].method, 'POST');
    assert.equal(network.calls[1].url.searchParams.has('files'), false);
    assert.equal(network.calls[1].headers['Content-Length'], Buffer.byteLength(network.calls[1].body));
    assert.equal(JSON.parse(network.calls[1].body).files[0].content, 'é');
});

test('redirects are rejected without making another request', async () => {
    const network = fakeNetwork([{ status: 302, headers: { location: 'https://evil.example' } }]);
    await assert.rejects(createClient({ ...config, maxRetries: 3 }, network).request('version'), { code: 'REDIRECT_REJECTED' });
    assert.equal(network.calls.length, 1);
    assert.equal(network.calls[0].destroyed, true);
});

test('record snapshot export uses authenticated GET and encodes the cursor', async () => {
    const network = fakeNetwork([{ body: { ok: true, recordType: 'customer', records: [], nextCursor: null } }]);
    await createClient(config, network).request('records', { recordType: 'customer', cursor: '42', pageSize: 5 });
    assert.equal(network.calls[0].method, 'GET');
    assert.equal(network.calls[0].url.searchParams.get('action'), 'records');
    assert.equal(network.calls[0].url.searchParams.get('cursor'), '42');
    assert.equal(network.calls[0].body, undefined);
    assert.match(network.calls[0].headers.Authorization, /^Bearer /);
});

test('inspection actions use GET with encoded structured filters and no request body', async () => {
    const network = fakeNetwork([{ body: { ok: true } }]);
    const client = createClient(config, network);
    await client.request('record', { recordType: 'customrecord_project', internalId: '12' });
    const filters = JSON.stringify([{ fieldId: 'email', operator: 'contains', values: ['a&b+tag@example.com'] }]);
    await client.request('search', { recordType: 'customer', filters, columns: '["email"]', cursor: '12' });
    assert.equal(network.calls[0].method, 'GET');
    assert.equal(network.calls[0].url.searchParams.get('internalId'), '12');
    assert.equal(network.calls[1].method, 'GET');
    assert.equal(network.calls[1].url.searchParams.get('filters'), filters);
    assert.equal(network.calls[1].url.searchParams.get('columns'), '["email"]');
    assert.equal(network.calls[1].url.searchParams.has('b+tag@example.com'), false);
    assert.equal(network.calls[1].body, undefined);
});

test('only transient responses retry; Retry-After is respected and capped', async () => {
    const network = fakeNetwork([
        { status: 429, headers: { 'retry-after': '999999' }, body: { error: { code: 'RATE_LIMIT' } } },
        { status: 503, raw: '<html>unavailable</html>' },
        { body: { ok: true, protocolVersion: 2 } }
    ]);
    const pauses = [];
    const client = createClient({ ...config, maxRetries: 2 }, { ...network, random: () => 0, sleep: async milliseconds => pauses.push(milliseconds) });
    assert.equal((await client.request('version')).protocolVersion, 2);
    assert.deepEqual(pauses, [60000, 1000]);
    assert.equal(network.calls.length, 3);
});

test('authentication failures do not retry and secrets in remote errors are redacted', async () => {
    const network = fakeNetwork([{ status: 401, body: { error: { code: 'INVALID_LOGIN_ATTEMPT', message: `Denied ${config.accessToken}` } } }]);
    await assert.rejects(createClient({ ...config, maxRetries: 3 }, network).request('version'), error => {
        assert.equal(error.status, 401);
        assert.equal(error.retryable, false);
        assert.ok(!error.message.includes(config.accessToken));
        assert.match(error.message, /\[redacted\]/);
        return true;
    });
    assert.equal(network.calls.length, 1);
});

test('HTTP 200 application errors and nested SuiteScript errors are failures', async () => {
    const network = fakeNetwork([{ body: { ok: false, error: { message: JSON.stringify({ name: 'PERMISSION_VIOLATION', message: 'Access denied' }) } } }]);
    await assert.rejects(createClient(config, network).request('metadata', { recordType: 'customer' }), { code: 'PERMISSION_VIOLATION', message: 'Access denied' });
});

test('malformed JSON and invalid response shapes fail explicitly', async () => {
    for (const raw of ['<html>Login</html>', 'true', '[]', 'null']) {
        const network = fakeNetwork([{ raw }]);
        await assert.rejects(createClient(config, network).request('version'), { code: 'INVALID_RESPONSE' });
    }
});

test('network retries are bounded and disabled for delete by default', async () => {
    const network = fakeNetwork([{ networkError: 'ECONNRESET' }]);
    const client = createClient({ ...config, maxRetries: 2 }, { ...network, sleep: async () => {} });
    await assert.rejects(client.request('version'), { code: 'ECONNRESET' });
    assert.equal(network.calls.length, 3);
    await assert.rejects(client.request('delete', { path: 'SuiteScripts/test.js' }), { code: 'ECONNRESET' });
    assert.equal(network.calls.length, 4);
});

test('timeout covers requests that never establish a connection', async () => {
    const network = fakeNetwork([{ hang: true }]);
    await assert.rejects(createClient({ ...config, timeoutMs: 5 }, network).request('version'), { code: 'ETIMEDOUT' });
    assert.equal(network.calls[0].destroyed, true);
});

test('cancellation stops an active request and retry backoff', async () => {
    const network = fakeNetwork([{ hang: true }]);
    const controller = new AbortController();
    const pending = createClient(config, network).request('version', {}, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(network.calls[0].destroyed, true);
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(createClient(config, network).request('version', {}, { signal: cancelled.signal }), { name: 'AbortError' });
    const backoff = new AbortController();
    const waiting = delay(60000, backoff.signal);
    backoff.abort();
    await assert.rejects(waiting, { name: 'AbortError' });
});

test('request and response byte limits stop oversized transfers', async () => {
    const network = fakeNetwork([{ chunks: [Buffer.alloc(4 * 1024 * 1024), Buffer.from('x')] }]);
    const client = createClient(config, network);
    await assert.rejects(client.request('push', { files: [{ content: 'x'.repeat(4 * 1024 * 1024) }] }), { code: 'REQUEST_TOO_LARGE' });
    assert.equal(network.calls.length, 0);
    await assert.rejects(client.request('pull', { files: [] }), { code: 'RESPONSE_TOO_LARGE' });
    assert.equal(network.calls[0].destroyed, true);
    const errors = fakeNetwork([{ status: 500, chunks: [Buffer.alloc(65537)] }]);
    await assert.rejects(createClient(config, errors).request('version'), { code: 'RESPONSE_TOO_LARGE' });
});

test('requests reject parameter overrides and unsupported actions before network activity', async () => {
    const network = fakeNetwork([{ body: { ok: true } }]);
    const client = createClient(config, network);
    await assert.rejects(client.request('list', { script: '99' }), { code: 'INVALID_PAYLOAD' });
    await assert.rejects(client.request('list', { value: {} }), { code: 'INVALID_PAYLOAD' });
    await assert.rejects(client.request('unknown'), { code: 'INVALID_ACTION' });
    assert.equal(network.calls.length, 0);
});
