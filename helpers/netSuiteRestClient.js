'use strict';

const https = require('node:https');
const { authorizationHeader, validateRestletUrl } = require('./auth');

const MAX_WIRE_BYTES = 4 * 1024 * 1024;
const READ_ACTIONS = new Set(['version', 'list', 'metadata', 'records', 'record', 'search']);
const TRANSIENT_CODES = new Set([
    'SSS_REQUEST_LIMIT_EXCEEDED', 'SSS_USAGE_LIMIT_EXCEEDED', 'GOVERNANCE_LIMIT',
    'CONCURRENCY_LIMIT_EXCEEDED', 'REQUEST_LIMIT_EXCEEDED',
    'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE'
]);

class NetSuiteError extends Error {
    constructor(message, { code = 'NETSUITE_ERROR', status, retryable = false, retryAfterMs } = {}) {
        super(message);
        this.name = 'NetSuiteError';
        this.code = code;
        this.status = status;
        this.retryable = retryable;
        this.retryAfterMs = retryAfterMs;
    }
}

function abortError() {
    const error = new NetSuiteError('Transfer cancelled.', { code: 'ABORT_ERR' });
    error.name = 'AbortError';
    return error;
}

function delay(milliseconds, signal) {
    return new Promise((resolve, reject) => {
        if (signal && signal.aborted) return reject(abortError());
        const aborted = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', aborted);
            reject(abortError());
        };
        const timer = setTimeout(() => {
            if (signal) signal.removeEventListener('abort', aborted);
            resolve();
        }, milliseconds);
        if (signal) signal.addEventListener('abort', aborted, { once: true });
    });
}

function boundedInteger(value, fallback, minimum, maximum, label) {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
        throw new NetSuiteError(`${label} must be an integer between ${minimum} and ${maximum}.`, { code: 'INVALID_CONFIG' });
    }
    return value;
}

function retryAfter(value) {
    if (!value) return undefined;
    const seconds = Number(value);
    const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
    return Number.isFinite(milliseconds) ? Math.min(60000, Math.max(0, milliseconds)) : undefined;
}

/** Creates a credential-scoped client. It never follows redirects or logs headers. */
function createClient(configuration, dependencies = {}) {
    const config = { ...configuration };
    const endpoint = validateRestletUrl(config.restlet);
    const timeoutMs = boundedInteger(config.timeoutMs, 30000, 1, 300000, 'timeoutMs');
    const maxRetries = boundedInteger(config.maxRetries, 2, 0, 5, 'maxRetries');
    const requestImpl = dependencies.request || https.request;
    const sleep = dependencies.sleep || delay;
    const random = dependencies.random || Math.random;
    const secretValues = ['consumerToken', 'consumerSecret', 'netSuiteKey', 'netSuiteSecret', 'accessToken']
        .map(key => config[key]).filter(value => typeof value === 'string' && value.length > 0);
    const sanitize = value => {
        let message = String(value || 'The NetSuite request failed.');
        for (const secret of secretValues) message = message.split(secret).join('[redacted]');
        return message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 1024);
    };

    function responseError(body, status, headers) {
        let details = body && typeof body === 'object' ? body.error : undefined;
        if (typeof details === 'string') details = { message: details };
        details = details && typeof details === 'object' ? details : {};
        // NetSuite sometimes wraps a SuiteScript error object in error.message JSON.
        if (typeof details.message === 'string' && details.message.trim().startsWith('{')) {
            try { details = { ...details, ...JSON.parse(details.message) }; } catch { /* Use its text. */ }
        }
        const code = sanitize(details.code || details.name || `HTTP_${status}`);
        const transientStatus = [408, 429, 502, 503, 504].includes(status);
        return new NetSuiteError(sanitize(details.message || `NetSuite returned HTTP ${status}.`), {
            code, status,
            retryable: status !== 401 && status !== 403 && (transientStatus || TRANSIENT_CODES.has(code)),
            retryAfterMs: retryAfter(headers['retry-after'])
        });
    }

    function perform(url, method, body, signal) {
        return new Promise((resolve, reject) => {
            if (signal && signal.aborted) return reject(abortError());
            let req;
            let response;
            let timer;
            let settled = false;
            const finish = (error, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (signal) signal.removeEventListener('abort', aborted);
                if (error) reject(error); else resolve(value);
            };
            const stop = error => {
                finish(error);
                if (response) response.destroy();
                if (req) req.destroy();
            };
            const aborted = () => stop(abortError());
            try {
                const headers = {
                    Accept: 'application/json',
                    'Content-Type': 'application/json; charset=utf-8',
                    Authorization: authorizationHeader(config, method, url),
                    'User-Agent': 'SuperSuite/2'
                };
                if (body !== undefined) headers['Content-Length'] = Buffer.byteLength(body, 'utf8');
                req = requestImpl(url, { method, headers }, res => {
                    response = res;
                    const status = res.statusCode || 0;
                    if (status >= 300 && status < 400) {
                        return stop(new NetSuiteError('NetSuite redirected the request. Use the account-specific deployment External URL.', {
                            code: 'REDIRECT_REJECTED', status
                        }));
                    }
                    const limit = status >= 400 ? 64 * 1024 : MAX_WIRE_BYTES;
                    if (Number(res.headers['content-length']) > limit) {
                        return stop(new NetSuiteError('The NetSuite response exceeded the size limit. Reduce the batch size.', { code: 'RESPONSE_TOO_LARGE', status }));
                    }
                    const chunks = [];
                    let bytes = 0;
                    res.on('data', chunk => {
                        if (settled) return;
                        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                        bytes += buffer.length;
                        if (bytes > limit) {
                            stop(new NetSuiteError('The NetSuite response exceeded the size limit. Reduce the batch size.', { code: 'RESPONSE_TOO_LARGE', status }));
                        } else chunks.push(buffer);
                    });
                    res.on('aborted', () => finish(new NetSuiteError('NetSuite closed the response before it completed.', { code: 'ECONNRESET', retryable: true })));
                    res.on('error', () => finish(new NetSuiteError('Could not read the NetSuite response.', { code: 'ECONNRESET', retryable: true })));
                    res.on('end', () => {
                        if (settled) return;
                        let parsed;
                        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
                            if (status < 200 || status >= 300) return finish(responseError(null, status, res.headers));
                            return finish(new NetSuiteError('NetSuite returned invalid JSON. Verify the deployed SuperSuite RESTlet.', { code: 'INVALID_RESPONSE', status }));
                        }
                        if (status < 200 || status >= 300 || (parsed && (parsed.ok === false || parsed.error))) {
                            return finish(responseError(parsed, status, res.headers));
                        }
                        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                            return finish(new NetSuiteError('NetSuite returned an unexpected response. Update the SuperSuite RESTlet.', { code: 'INVALID_RESPONSE', status }));
                        }
                        finish(null, parsed);
                    });
                });
                req.on('error', error => {
                    const code = typeof error.code === 'string' ? error.code : 'NETWORK_ERROR';
                    finish(new NetSuiteError(`Could not reach NetSuite (${sanitize(code)}).`, { code, retryable: TRANSIENT_CODES.has(code) }));
                });
                timer = setTimeout(() => stop(new NetSuiteError('The NetSuite request timed out.', { code: 'ETIMEDOUT', retryable: true })), timeoutMs);
                if (signal) signal.addEventListener('abort', aborted, { once: true });
                req.end(body);
            } catch (error) {
                finish(error instanceof NetSuiteError ? error : new NetSuiteError(sanitize(error.message), { code: 'INVALID_CONFIG' }));
            }
        });
    }

    return {
        async request(action, payload = {}, { signal, retrySafe } = {}) {
            if (!READ_ACTIONS.has(action) && !['push', 'pull', 'delete'].includes(action)) {
                throw new NetSuiteError('Unsupported RESTlet action.', { code: 'INVALID_ACTION' });
            }
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
                throw new NetSuiteError('Request payload must be an object.', { code: 'INVALID_PAYLOAD' });
            }
            const method = READ_ACTIONS.has(action) ? 'GET' : action === 'delete' ? 'DELETE' : 'POST';
            const url = new URL(endpoint);
            const data = { ...payload, action };
            let body;
            if (method === 'POST') {
                try { body = JSON.stringify(data); } catch {
                    throw new NetSuiteError('Request payload cannot be serialized.', { code: 'INVALID_PAYLOAD' });
                }
                if (Buffer.byteLength(body, 'utf8') > MAX_WIRE_BYTES) {
                    throw new NetSuiteError('Request exceeds 4 MiB. Reduce the batch size.', { code: 'REQUEST_TOO_LARGE' });
                }
            } else {
                for (const [key, value] of Object.entries(data)) {
                    if (value === undefined || value === null) continue;
                    if (typeof value === 'object' || key === 'script' || key === 'deploy' || key.startsWith('oauth_')) {
                        throw new NetSuiteError('Invalid RESTlet query parameter.', { code: 'INVALID_PAYLOAD' });
                    }
                    url.searchParams.set(key, String(value));
                }
                if (url.href.length > 16384) throw new NetSuiteError('Request URL exceeds the size limit.', { code: 'REQUEST_TOO_LARGE' });
            }
            // Protocol 2 push is an upsert by canonical path. Delete is deliberately not replayed.
            const canRetry = retrySafe === undefined ? action !== 'delete' : retrySafe === true;
            for (let attempt = 0; ; attempt++) {
                try { return await perform(url, method, body, signal); } catch (error) {
                    if (!canRetry || !error.retryable || attempt >= maxRetries || (signal && signal.aborted)) throw error;
                    const pause = error.retryAfterMs === undefined ? Math.min(10000, 500 * (2 ** attempt)) + Math.floor(random() * 250) : error.retryAfterMs;
                    await sleep(pause, signal);
                }
            }
        }
    };
}

module.exports = { createClient, validateRestletUrl, NetSuiteError, abortError, delay };
