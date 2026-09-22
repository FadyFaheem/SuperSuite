'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    createDocumentationService, searchDocumentation, validateDocumentationUrl, parseDocumentation
} = require('../mcp/documentation');
const catalog = require('../mcp/doc-catalog.json');

const RECORD_URL = 'https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4267258486.html';
const SEARCH_URL = 'https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4345764122.html';
const html = '<html><head><title>Fallback title</title><script>secret script</script></head><body><nav>Navigation</nav><main><h1>record.load(options)</h1><p>Load &amp; inspect a record.</p><pre>const a = 1;\n  return a &lt; 2;</pre><a href="section_4345764122.html">N/search</a><a href="https://untrusted.example/">Untrusted</a><footer>Footer</footer></main></body></html>';
const response = (text = html, options = {}) => new globalThis.Response(text, { headers: { 'content-type': 'text/html; charset=utf-8' }, ...options });

test('catalog search is useful for API names and clearly states limited coverage', () => {
    const found = searchDocumentation({ query: 'record.load', limit: 3 });
    assert.equal(found.results[0].title, 'record.load(options)');
    assert.equal(found.coverage, 'curated-catalog');
    assert.match(found.coverageNote, /not all NetSuite documentation/u);
    assert.ok(searchDocumentation({ query: 'SuiteCloud unit testing' }).results.some(item => item.title.includes('unit testing')));
    assert.equal(searchDocumentation({ query: 'no-such-api-abcdef' }).total, 0);
    assert.equal(searchDocumentation({ query: 'how do i load a record in netsuite' }).results[0].title, 'record.load(options)');
    assert.throws(() => searchDocumentation({ query: ' ' }), /query/u);
    assert.throws(() => searchDocumentation({ query: 'x'.repeat(257) }), /query/u);
    assert.throws(() => searchDocumentation({ query: 'record', limit: 21 }), /limit/u);
    found.results[0].tags.push('changed');
    assert.ok(!searchDocumentation({ query: 'record.load' }).results[0].tags.includes('changed'));
});

test('every catalog entry has a unique approved source and metadata', () => {
    const urls = new Set();
    for (const entry of catalog.entries) {
        assert.ok(entry.title && entry.summary && entry.tags.length);
        assert.equal(validateDocumentationUrl(entry.url).sourceUrl, entry.url);
        assert.ok(!urls.has(entry.url), entry.url);
        urls.add(entry.url);
    }
});

test('documentation discovery includes every currently supported module from the editor inventory', () => {
    const modules = require('../editor/moduleMetadata.json').filter(module => module.status === 'supported');
    for (const module of modules) {
        const result = searchDocumentation({ query: module.path, limit: 20 });
        assert.ok(result.results.some(entry => entry.url === module.documentationUrl), module.path);
        assert.equal(validateDocumentationUrl(module.documentationUrl).sourceUrl, module.documentationUrl);
        assert.ok(result.catalogEntries >= modules.length);
    }
});

test('URL allowlist rejects credentials, account endpoints, host confusion, unsafe paths and queries', () => {
    for (const url of [
        'http://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/a.html',
        'https://docs.oracle.com.evil.example/en/cloud/saas/netsuite/ns-online-help/a.html',
        'https://docs.oracle.com@evil.example/en/cloud/saas/netsuite/ns-online-help/a.html',
        'https://user:password@docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/a.html',
        'https://docs.oracle.com:444/en/cloud/saas/netsuite/ns-online-help/a.html',
        'https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/a.html?token=value',
        'https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/../other/a.html',
        'https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/%2e%2e/a.html',
        'https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/a.pdf',
        'https://123.restlets.api.netsuite.com/app/site/hosting/restlet.nl',
        'https://system.netsuite.com/app/login/secure/enterpriselogin.nl',
        'https://github.com/another-user/netsuite-suitecloud-sdk/blob/master/README.md',
        'https://github.com/oracle/netsuite-suitecloud-sdk/issues/1',
        'https://raw.githubusercontent.com/oracle/netsuite-suitecloud-sdk/master/package.json',
        'file:///etc/passwd', 'https://127.0.0.1/', RECORD_URL + '\n'
    ]) assert.throws(() => validateDocumentationUrl(url), undefined, url);
    assert.equal(validateDocumentationUrl(`${RECORD_URL}#parameters`).fetchUrl, RECORD_URL);
    assert.ok(validateDocumentationUrl('https://system.netsuite.com/help/helpcenter/en_US/srbrowser/Browser2026_1/script/record/customer.html'));
});

test('Oracle SDK Markdown fetches canonical raw content instead of GitHub navigation', async () => {
    const sourceUrl = 'https://github.com/oracle/netsuite-suitecloud-sdk';
    let requested;
    const service = createDocumentationService({ fetch: async (url, init) => {
        requested = { url, init };
        return response('# SuiteCloud SDK\n\nRead [CLI](./packages/node-cli/README.md).\n\nsuitecloud <command> <option>', { headers: { 'content-type': 'text/plain' } });
    } });
    const page = await service.readDocumentation({ url: sourceUrl });
    assert.equal(requested.url, 'https://raw.githubusercontent.com/oracle/netsuite-suitecloud-sdk/master/README.md');
    assert.equal(requested.init.method, 'GET');
    assert.equal(requested.init.redirect, 'manual');
    assert.equal(requested.init.credentials, 'omit');
    assert.deepEqual(Object.keys(requested.init.headers), ['Accept']);
    assert.equal(page.sourceUrl, sourceUrl);
    assert.equal(page.title, 'SuiteCloud SDK');
    assert.match(page.text, /suitecloud <command> <option>/u);
    assert.equal(page.links[0].url, 'https://raw.githubusercontent.com/oracle/netsuite-suitecloud-sdk/master/packages/node-cli/README.md');
    service.dispose();
});

test('HTML reader removes executable/chrome content and preserves readable code and official links', () => {
    const parsed = parseDocumentation(html, validateDocumentationUrl(RECORD_URL));
    assert.equal(parsed.title, 'record.load(options)');
    assert.match(parsed.text, /Load & inspect a record/u);
    assert.match(parsed.text, /const a = 1;\n  return a < 2;/u);
    assert.doesNotMatch(parsed.text, /secret script|Navigation|Footer|<script/u);
    assert.deepEqual(parsed.links, [{ title: 'N/search', url: SEARCH_URL }]);
    assert.equal(parseDocumentation('<h1>&#x110000; &#0; &#xD800;</h1>', validateDocumentationUrl(RECORD_URL)).title, '� � �');
});

test('reader returns bounded paginated text with stable source attribution and cache timestamps', async () => {
    let fetches = 0;
    const service = createDocumentationService({ fetch: async () => { fetches++; return response(); }, now: () => 1000000 });
    const first = await service.readDocumentation({ url: RECORD_URL, maxChars: 17 });
    assert.equal(first.text.length, 17);
    assert.equal(first.start, 0);
    assert.equal(first.nextStart, 17);
    assert.equal(first.truncated, true);
    assert.equal(first.cacheHit, false);
    assert.equal(first.fetchedAt, '1970-01-01T00:16:40.000Z');
    const second = await service.readDocumentation({ url: RECORD_URL, start: first.nextStart, maxChars: 24000 });
    assert.equal(second.cacheHit, true);
    assert.equal(second.nextStart, null);
    assert.equal(first.text + second.text, parseDocumentation(html, validateDocumentationUrl(RECORD_URL)).text);
    assert.equal(fetches, 1);
    await assert.rejects(service.readDocumentation({ url: RECORD_URL, start: second.totalChars + 1 }), /start exceeds/u);
    await assert.rejects(service.readDocumentation({ url: RECORD_URL, maxChars: 24001 }), /maxChars/u);
    service.dispose();
});

test('cache expires and evicts old entries without returning mutable shared metadata', async () => {
    let time = 0;
    let fetches = 0;
    const service = createDocumentationService({ fetch: async () => { fetches++; return response(); }, now: () => time, cacheTtlMs: 20, maxCacheEntries: 1 });
    const first = await service.readDocumentation({ url: RECORD_URL });
    first.links[0].title = 'tampered';
    const cached = await service.readDocumentation({ url: RECORD_URL });
    assert.equal(cached.links[0].title, 'N/search');
    time = 21;
    assert.equal((await service.readDocumentation({ url: RECORD_URL })).cacheHit, false);
    await service.readDocumentation({ url: SEARCH_URL });
    await service.readDocumentation({ url: RECORD_URL });
    assert.equal(fetches, 4);
    service.dispose();
});

test('reader refuses redirects including fetch implementations that already followed a redirect', async () => {
    let calls = 0;
    const redirect = createDocumentationService({ fetch: async () => { calls++; return response('', { status: 302, headers: { location: 'https://evil.example/' } }); } });
    await assert.rejects(redirect.readDocumentation({ url: RECORD_URL }), /redirects/u);
    assert.equal(calls, 1);
    redirect.dispose();
    const followed = createDocumentationService({ fetch: async () => {
        const result = response();
        Object.defineProperty(result, 'url', { value: 'https://evil.example/' });
        return result;
    } });
    await assert.rejects(followed.readDocumentation({ url: RECORD_URL }), /redirects/u);
    followed.dispose();
});

test('response byte cap covers advertised length and streamed bytes independently', async () => {
    const advertised = createDocumentationService({ maxBytes: 20, fetch: async () => response('short', { headers: { 'content-type': 'text/plain', 'content-length': '21' } }) });
    await assert.rejects(advertised.readDocumentation({ url: RECORD_URL }), /size limit/u);
    advertised.dispose();
    const streamed = createDocumentationService({ maxBytes: 20, fetch: async () => response('x'.repeat(21)) });
    await assert.rejects(streamed.readDocumentation({ url: RECORD_URL }), /size limit/u);
    streamed.dispose();
});

test('reader rejects unsupported or failed responses without including their body', async () => {
    for (const result of [response('private error body', { status: 403 }), response('private body', { headers: { 'content-type': 'application/octet-stream' } })]) {
        const service = createDocumentationService({ fetch: async () => result });
        await assert.rejects(service.readDocumentation({ url: RECORD_URL }), error => !error.message.includes('private') && /HTTP 403|HTML or text/u.test(error.message));
        service.dispose();
    }
});

test('cancellation before a request prevents all network access', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const service = createDocumentationService({ fetch: async () => { calls++; return response(); } });
    await assert.rejects(service.readDocumentation({ url: RECORD_URL }, { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(calls, 0);
    service.dispose();
});

function pendingFetch(_url, { signal }) {
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
}

test('timeout terminates a stalled fetch', async () => {
    const service = createDocumentationService({ fetch: pendingFetch, timeoutMs: 10 });
    await assert.rejects(service.readDocumentation({ url: RECORD_URL }), /timed out/u);
    service.dispose();
});

test('caller cancellation and service disposal stop outstanding requests', async () => {
    const service = createDocumentationService({ fetch: pendingFetch });
    const controller = new AbortController();
    const pending = service.readDocumentation({ url: RECORD_URL }, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    const owned = service.readDocumentation({ url: SEARCH_URL });
    service.dispose();
    await assert.rejects(owned, { name: 'AbortError' });
    await assert.rejects(service.readDocumentation({ url: RECORD_URL }), { name: 'AbortError' });
});

test('concurrent download count is bounded', async () => {
    const service = createDocumentationService({ fetch: pendingFetch });
    const pending = Array.from({ length: 4 }, () => service.readDocumentation({ url: RECORD_URL }));
    await assert.rejects(service.readDocumentation({ url: RECORD_URL }), /concurrent/u);
    service.dispose();
    assert.ok((await Promise.allSettled(pending)).every(result => result.status === 'rejected' && result.reason.name === 'AbortError'));
});
