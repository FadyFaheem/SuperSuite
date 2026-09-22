'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const CONFIG_PATH = '.config/supersuite.json';
const DEFAULTS = Object.freeze({
    restlet: '', realm: '', authType: 'tba', rootDirectory: 'SuiteScripts',
    batchSize: 10, maxBatchBytes: 1048576, timeoutMs: 60000, maxRetries: 3,
    exclude: ['**/node_modules/**', '**/.*/**', '**/*.vsix', '**/*.pem', '**/*.key'],
    metadataRecordTypes: []
});
const SECRET_NAMES = ['consumerToken', 'consumerSecret', 'netSuiteKey', 'netSuiteSecret', 'accessToken'];

function validateConfig(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('SuperSuite configuration must be a JSON object.');
    for (const key of [...SECRET_NAMES, 'authentication', 'password', 'clientSecret', 'refreshToken']) {
        if (Object.hasOwn(input, key)) throw new Error(`Keep ${key} out of ${CONFIG_PATH}. Use SuperSuite: Configure Credentials.`);
    }
    const result = { ...DEFAULTS, ...input };
    if (!['tba', 'oauth2'].includes(result.authType)) throw new Error('authType must be tba or oauth2.');
    for (const key of ['restlet', 'realm', 'rootDirectory']) {
        if (typeof result[key] !== 'string') throw new Error(`${key} must be a string.`);
        result[key] = result[key].trim();
    }
    if (!/^SuiteScripts(?:\/[^/\\]+)*$/.test(result.rootDirectory) || result.rootDirectory.length > 1024 || result.rootDirectory.split('/').length > 32 || result.rootDirectory.split('/').some(part => ['.', '..', '.supersuite-staging'].includes(part.toLowerCase())) || /[\x00-\x1f\x7f:%]/.test(result.rootDirectory)) {
        throw new Error('rootDirectory must be SuiteScripts or a subfolder, without traversal or backslashes.');
    }
    for (const [key, min, max] of [['batchSize', 1, 20], ['maxBatchBytes', 1024, 4194304], ['timeoutMs', 1000, 300000], ['maxRetries', 0, 5]]) {
        if (!Number.isInteger(result[key]) || result[key] < min || result[key] > max) throw new Error(`${key} must be an integer from ${min} to ${max}.`);
    }
    for (const key of ['exclude', 'metadataRecordTypes']) {
        if (!Array.isArray(result[key]) || result[key].some(item => typeof item !== 'string' || !item.trim())) throw new Error(`${key} must be an array of nonempty strings.`);
        result[key] = result[key].slice();
    }
    result.metadataRecordTypes = [...new Set(result.metadataRecordTypes.map(type => type.trim().toLowerCase()))];
    if (result.metadataRecordTypes.length > 25 || result.metadataRecordTypes.some(type => !/^[a-z][a-z0-9_]{0,127}$/.test(type))) throw new Error('Configure at most 25 valid metadata record type IDs.');
    return result;
}

async function readConfig(folder, settings = {}) {
    let file = {};
    try {
        const filename = path.join(folder, CONFIG_PATH);
        const stat = await fs.lstat(filename);
        if (!stat.isFile() || stat.size > 65536) throw new Error('SuperSuite configuration must be a regular file under 64 KiB.');
        try { file = JSON.parse(await fs.readFile(filename, 'utf8')); } catch (error) {
            // JSON.parse errors can include source snippets containing credentials.
            if (error instanceof SyntaxError) throw new Error('Invalid JSON; correct the configuration syntax.');
            throw error;
        }
        if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error('Configuration must be a JSON object.');
    } catch (error) {
        if (error.code !== 'ENOENT') throw new Error(`Cannot read ${CONFIG_PATH}: ${error.message}`);
    }
    return validateConfig({ ...settings, ...file });
}

function connectionKey(folderUri, config) {
    // Bind credentials/cache to the exact workspace and endpoint. Changing a checked-in
    // URL must never silently send existing credentials to another deployment/account.
    const identity = JSON.stringify([folderUri, config.restlet, config.realm, config.authType]);
    return `supersuite.connection.${crypto.createHash('sha256').update(identity).digest('hex')}`;
}

module.exports = { CONFIG_PATH, DEFAULTS, SECRET_NAMES, validateConfig, readConfig, connectionKey };
