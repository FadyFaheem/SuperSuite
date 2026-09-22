'use strict';

const { delay } = require('./netSuiteRestClient');

const RETRYABLE_ITEM_CODES = new Set([
    'BATCH_BYTES_EXCEEDED', 'SSS_USAGE_LIMIT_EXCEEDED', 'GOVERNANCE_LIMIT',
    'SSS_REQUEST_LIMIT_EXCEEDED', 'CONCURRENCY_LIMIT_EXCEEDED', 'REQUEST_LIMIT_EXCEEDED',
    'RCRD_LOCKED', 'RCRD_HAS_BEEN_CHANGED', 'SSS_REQUEST_TIME_EXCEEDED', 'STAGING_CLEANUP_FAILED'
]);

function failure(item, code, message, retryable = false) {
    return { ok: false, path: item && item.path, error: { code, message, retryable } };
}

function batchOptions(options) {
    const { batchSize = 10, maxBatchBytes = 1024 * 1024, action = 'push' } = options;
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 20) throw new Error('batchSize must be between 1 and 20.');
    if (!Number.isInteger(maxBatchBytes) || maxBatchBytes < 1 || maxBatchBytes > 4 * 1024 * 1024) throw new Error('maxBatchBytes must be between 1 and 4194304.');
    if (!['push', 'pull'].includes(action)) throw new Error('Batch action must be push or pull.');
    return { batchSize, maxBatchBytes, action };
}

/** Count the actual UTF-8 JSON envelope, including escaped file contents and commas. */
function batchBytes(files, action = 'push') {
    return Buffer.byteLength(JSON.stringify({ action, files }), 'utf8');
}

/** Validate the complete response before callers perform any local writes. */
function validBatchResults(batch, returned) {
    const expected = new Set(batch.map(item => item.path));
    const received = new Set();
    return Array.isArray(returned) && returned.every(result => {
        if (!result || typeof result.ok !== 'boolean' || !expected.has(result.path) || received.has(result.path)) return false;
        received.add(result.path);
        return result.ok || (result.error && typeof result.error.code === 'string');
    });
}

/** Oversized/invalid items become failures; subsequent items still form valid batches. */
function partitionBatches(items, options = {}) {
    const { batchSize, maxBatchBytes, action } = batchOptions(options);
    if (!Array.isArray(items)) throw new Error('Batch items must be an array.');
    const batches = [];
    const failures = [];
    const seen = new Set();
    let current = [];
    for (const item of items) {
        if (!item || typeof item.path !== 'string' || !item.path) {
            failures.push(failure(item, 'INVALID_PATH', 'Each batch file must have a non-empty path.'));
            continue;
        }
        if (seen.has(item.path)) {
            failures.push(failure(item, 'DUPLICATE_PATH', 'The transfer contains this path more than once.'));
            continue;
        }
        seen.add(item.path);
        let size;
        try { size = batchBytes([item], action); } catch {
            failures.push(failure(item, 'INVALID_PAYLOAD', 'This file cannot be serialized.'));
            continue;
        }
        if (size > maxBatchBytes) {
            failures.push(failure(item, 'FILE_EXCEEDS_BATCH_LIMIT', `The serialized file exceeds the ${maxBatchBytes}-byte batch limit. Increase maxBatchBytes or reduce this file.`));
            continue;
        }
        if (current.length && (current.length >= batchSize || batchBytes([...current, item], action) > maxBatchBytes)) {
            batches.push(current);
            current = [];
        }
        current.push(item);
    }
    if (current.length) batches.push(current);
    return { batches, failures };
}

/**
 * Run one request at a time. Never replay successful items when another item needs
 * another request. Byte/governance failures retry individually with bounded backoff.
 * worker(batch, {signal}) returns a protocol-2 {results:[{ok,path,...}]} object.
 */
async function runBatches(items, worker, options = {}) {
    const { signal, onProgress, maxItemRetries = 2 } = options;
    if (!Number.isInteger(maxItemRetries) || maxItemRetries < 0 || maxItemRetries > 5) throw new Error('maxItemRetries must be between 0 and 5.');
    const { batches, failures } = partitionBatches(items, options);
    const results = [...failures];
    const pending = batches.map(batch => ({ batch, attempt: 0 }));
    const sleep = options.sleep || delay;
    let cancelled = false;
    const report = async result => {
        results.push(result);
        if (onProgress) await onProgress({ completed: results.length, total: items.length, result });
    };
    for (const result of failures) {
        if (onProgress) await onProgress({ completed: results.indexOf(result) + 1, total: items.length, result });
    }
    while (pending.length) {
        if (signal && signal.aborted) { cancelled = true; break; }
        const { batch, attempt } = pending.shift();
        let response;
        try {
            if (attempt) await sleep(Math.min(10000, 500 * (2 ** (attempt - 1))), signal);
            response = await worker(batch, { signal });
        } catch (error) {
            if ((signal && signal.aborted) || error.name === 'AbortError' || error.code === 'ABORT_ERR') {
                pending.unshift({ batch, attempt });
                cancelled = true;
                break;
            }
            for (const item of batch) await report(failure(item, error.code || 'BATCH_FAILED', String(error.message || 'The batch request failed.').slice(0, 1024)));
            continue;
        }
        const returned = response && response.results;
        if (!validBatchResults(batch, returned)) {
            for (const item of batch) await report(failure(item, 'INVALID_RESPONSE', 'NetSuite returned invalid, duplicate, or unexpected batch results.'));
            continue;
        }
        const byPath = new Map(returned.map(result => [result.path, result]));
        const retries = [];
        for (const item of batch) {
            const result = byPath.get(item.path) || failure(item, 'MISSING_RESULT', 'NetSuite did not return a result for this file.');
            if (!result.ok && result.error.retryable === true && RETRYABLE_ITEM_CODES.has(result.error.code) && attempt < maxItemRetries) {
                retries.push({ batch: [item], attempt: attempt + 1 });
            } else await report(result);
        }
        pending.unshift(...retries);
    }
    if (cancelled) {
        for (const { batch } of pending) {
            for (const item of batch) await report(failure(item, 'ABORT_ERR', 'Transfer cancelled; this file may not have completed.'));
        }
    }
    // Preserve request order (including duplicates) while keeping every per-item outcome.
    const positions = new Map(items.map((item, index) => [item && item.path, index]));
    results.sort((left, right) => positions.get(left.path) - positions.get(right.path));
    return {
        results,
        succeeded: results.filter(result => result.ok).length,
        failed: results.filter(result => !result.ok).length,
        cancelled
    };
}

module.exports = { partitionBatches, batchBytes, runBatches, validBatchResults };
