'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { batchBytes, partitionBatches, runBatches } = require('../helpers/transfer');
const { normalizeRemotePath, toLocalPath, toRemotePath, isWithinDirectory } = require('../helpers/paths');

const files = count => Array.from({ length: count }, (_, index) => ({ path: `SuiteScripts/${index}.js`, content: 'test', encoding: 'utf8' }));
const success = items => ({ results: items.map(item => ({ ok: true, path: item.path })) });

test('batch partition honors both count and actual UTF-8 JSON envelope bytes', () => {
    const items = files(5);
    assert.deepEqual(partitionBatches(items, { batchSize: 2 }).batches.map(batch => batch.length), [2, 2, 1]);
    items[0].content = 'é\n"'.repeat(10);
    const limit = batchBytes(items.slice(0, 2));
    const { batches, failures } = partitionBatches(items, { maxBatchBytes: limit });
    assert.equal(failures.length, 0);
    assert.deepEqual(batches[0], items.slice(0, 2));
    assert.ok(batches.every(batch => Buffer.byteLength(JSON.stringify({ action: 'push', files: batch })) <= limit));
});

test('oversized files and duplicate paths are reported without blocking remaining files', () => {
    const items = files(3);
    items[1].content = 'x'.repeat(1000);
    const { batches, failures } = partitionBatches([...items, items[0]], { maxBatchBytes: 250 });
    assert.deepEqual(batches.flat().map(item => item.path), [items[0].path, items[2].path]);
    assert.deepEqual(failures.map(result => result.error.code), ['FILE_EXCEEDS_BATCH_LIMIT', 'DUPLICATE_PATH']);
});

test('batch options are bounded and empty transfers create no requests', async () => {
    for (const options of [{ batchSize: 21 }, { batchSize: 0 }, { maxBatchBytes: 4194305 }, { maxBatchBytes: 0 }, { action: 'delete' }]) {
        assert.throws(() => partitionBatches(files(1), options));
    }
    assert.deepEqual(await runBatches([], () => { throw new Error('Must not run'); }), { results: [], succeeded: 0, failed: 0, cancelled: false });
});

test('batch requests execute sequentially and continue after a permanent failure', async () => {
    let active = 0;
    let maximum = 0;
    const progress = [];
    const summary = await runBatches(files(5), async items => {
        active++;
        maximum = Math.max(maximum, active);
        await new Promise(resolve => setImmediate(resolve));
        active--;
        if (items[0].path.endsWith('2.js')) throw Object.assign(new Error('Permission denied'), { code: 'PERMISSION_VIOLATION' });
        return success(items);
    }, { batchSize: 2, onProgress: progressValue => progress.push(progressValue.completed) });
    assert.equal(maximum, 1);
    assert.equal(summary.succeeded, 3);
    assert.equal(summary.failed, 2);
    assert.deepEqual(progress, [1, 2, 3, 4, 5]);
    assert.equal(summary.results[4].ok, true);
});

test('only retryable failed files replay individually; successful files are never replayed', async () => {
    const calls = [];
    const summary = await runBatches(files(3), async items => {
        calls.push(items.map(item => item.path));
        if (calls.length === 1) return { results: [
            { ok: true, path: items[0].path },
            { ok: false, path: items[1].path, error: { code: 'BATCH_BYTES_EXCEEDED', retryable: true } },
            { ok: false, path: items[2].path, error: { code: 'GOVERNANCE_LIMIT', retryable: true } }
        ] };
        return success(items);
    }, { sleep: async () => {} });
    assert.deepEqual(calls.map(call => call.length), [3, 1, 1]);
    assert.equal(calls.flat().filter(name => name.endsWith('0.js')).length, 1);
    assert.equal(summary.succeeded, 3);
});

test('per-file retries stop at the configured bound and do not retry permanent errors', async () => {
    let attempts = 0;
    const summary = await runBatches(files(2), async items => {
        attempts++;
        return { results: items.map(item => ({ ok: false, path: item.path, error: {
            code: item.path.endsWith('0.js') ? 'GOVERNANCE_LIMIT' : 'PERMISSION_VIOLATION', retryable: true
        } })) };
    }, { maxItemRetries: 2, sleep: async () => {} });
    assert.equal(attempts, 3);
    assert.equal(summary.failed, 2);
});

test('invalid, duplicate, missing, and unsolicited results cannot be counted as successful', async () => {
    const items = files(2);
    const duplicate = { ok: true, path: items[0].path };
    for (const returned of [undefined, {}, { results: [duplicate, duplicate] }, { results: [{ ok: true, path: '../escape' }] }]) {
        const summary = await runBatches(items, async () => returned);
        assert.equal(summary.succeeded, 0);
        assert.equal(summary.failed, 2);
    }
    const missing = await runBatches(items, async () => ({ results: [duplicate] }));
    assert.equal(missing.succeeded, 1);
    assert.equal(missing.results[1].error.code, 'MISSING_RESULT');
});

test('cancellation preserves completed outcomes and accounts for every pending file', async () => {
    const controller = new AbortController();
    let calls = 0;
    const summary = await runBatches(files(5), async items => {
        calls++;
        controller.abort();
        return success(items);
    }, { batchSize: 2, signal: controller.signal });
    assert.equal(calls, 1);
    assert.equal(summary.cancelled, true);
    assert.equal(summary.succeeded, 2);
    assert.equal(summary.failed, 3);
    assert.ok(summary.results.slice(2).every(result => result.error.code === 'ABORT_ERR'));
});

test('aborting an active request accounts for that batch and never starts another', async () => {
    const summary = await runBatches(files(3), async () => { throw Object.assign(new Error('Cancelled'), { name: 'AbortError' }); }, { batchSize: 2 });
    assert.equal(summary.cancelled, true);
    assert.equal(summary.failed, 3);
});

test('remote/local mapping supports nested custom roots and both local path separators', () => {
    const workspace = path.resolve('test-workspace');
    const local = path.join(workspace, 'scripts', 'hello.js');
    assert.equal(toRemotePath(workspace, local, 'SuiteScripts/Team'), 'SuiteScripts/Team/scripts/hello.js');
    assert.equal(toLocalPath(workspace, 'SuiteScripts/Team/scripts/hello.js', 'SuiteScripts/Team'), local);
    assert.equal(toRemotePath(workspace, workspace), 'SuiteScripts');
    assert.equal(toLocalPath(workspace, 'SuiteScripts'), workspace);
    assert.equal(normalizeRemotePath('SuiteScripts\\Team\\hello.js'), 'SuiteScripts/Team/hello.js');
});

test('path mapping rejects traversal, root-prefix confusion, and Windows device paths', () => {
    const workspace = path.resolve('test-workspace');
    for (const unsafe of ['SuiteScripts/../outside', '/SuiteScripts/test', 'SuiteScripts//file', 'C:\\file', 'SuiteScripts/a:stream', 'SuiteScripts/a.', 'SuiteScripts/CON.txt', 'SuiteScripts/test\u0000.js']) {
        assert.throws(() => toLocalPath(workspace, unsafe), undefined, unsafe);
    }
    assert.throws(() => toLocalPath(workspace, 'SuiteScripts/TeamOther/file.js', 'SuiteScripts/Team'));
    assert.throws(() => toRemotePath(workspace, path.resolve('test-workspace-other', 'file.js')));
    assert.equal(isWithinDirectory(workspace, path.join(workspace, 'nested')), true);
    assert.equal(isWithinDirectory(workspace, path.resolve('test-workspace-other')), false);
});
