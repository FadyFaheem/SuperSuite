'use strict';

const crypto = require('node:crypto');

/** RFC 5849 percent encoding; encodeURIComponent alone leaves five extra characters. */
function percentEncode(value) {
    return encodeURIComponent(String(value)).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function validateRestletUrl(value) {
    let endpoint;
    try { endpoint = new URL(value); } catch { throw new Error('Configure a valid NetSuite RESTlet External URL.'); }
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash ||
        (endpoint.port && endpoint.port !== '443') ||
        !/^[a-z0-9][a-z0-9-]*\.(?:restlets\.api|app)\.netsuite\.com$/i.test(endpoint.hostname) ||
        endpoint.pathname !== '/app/site/hosting/restlet.nl') {
        throw new Error('Use an HTTPS account-specific NetSuite RESTlet External URL.');
    }
    for (const key of ['script', 'deploy']) {
        if (endpoint.searchParams.getAll(key).length !== 1 || !endpoint.searchParams.get(key).trim()) {
            throw new Error(`The RESTlet External URL must contain one ${key} parameter.`);
        }
    }
    for (const key of endpoint.searchParams.keys()) {
        if (key.startsWith('oauth_') || /^(?:access_token|authorization)$/i.test(key)) {
            throw new Error('Credentials must not appear in the RESTlet URL.');
        }
    }
    return endpoint;
}

/** Oracle RESTlet signatures include URL query parameters, but never the JSON body.
 * https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_1534939551.html
 */
function createTbaHeader(config, method, endpoint, { nonce, timestamp } = {}) {
    for (const name of ['realm', 'consumerToken', 'consumerSecret', 'netSuiteKey', 'netSuiteSecret']) {
        if (typeof config[name] !== 'string' || !config[name].trim()) throw new Error(`Missing TBA credential: ${name}.`);
    }
    const url = new URL(endpoint);
    const oauth = {
        oauth_consumer_key: config.consumerToken,
        oauth_token: config.netSuiteKey,
        oauth_nonce: nonce || crypto.randomBytes(24).toString('hex'),
        oauth_timestamp: String(timestamp === undefined ? Math.floor(Date.now() / 1000) : timestamp),
        oauth_signature_method: 'HMAC-SHA256',
        oauth_version: '1.0'
    };
    const pairs = [...url.searchParams.entries(), ...Object.entries(oauth)]
        .map(([key, value]) => [percentEncode(key), percentEncode(value)])
        .sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0);
    const parameters = pairs.map(([key, value]) => `${key}=${value}`).join('&');
    const baseString = [method.toUpperCase(), `${url.origin}${url.pathname}`, parameters].map(percentEncode).join('&');
    const key = `${percentEncode(config.consumerSecret)}&${percentEncode(config.netSuiteSecret)}`;
    oauth.oauth_signature = crypto.createHmac('sha256', key).update(baseString).digest('base64');
    return `OAuth ${Object.entries({ realm: config.realm, ...oauth }).map(([name, value]) => `${name}="${percentEncode(value)}"`).join(', ')}`;
}

function authorizationHeader(config, method, endpoint) {
    const authType = config.authType || 'tba';
    if (authType === 'oauth2') {
        if (typeof config.accessToken !== 'string' || !/^[A-Za-z0-9\-._~+/]+=*$/.test(config.accessToken)) {
            throw new Error('Configure a valid OAuth 2.0 access token with the RESTlets scope.');
        }
        return `Bearer ${config.accessToken}`;
    }
    if (authType !== 'tba') throw new Error('Authentication must use tba or oauth2. NLAuth is no longer supported.');
    return createTbaHeader(config, method, endpoint);
}

module.exports = { authorizationHeader, createTbaHeader, percentEncode, validateRestletUrl };
