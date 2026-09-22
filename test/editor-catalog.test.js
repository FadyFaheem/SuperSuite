'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const acorn = require('acorn');
const { modules, methods, availableModules, availableMethods, getScriptContext } = require('../editor/catalog');

// The module-reference table supplied for this release. Commerce is a namespace;
// Oracle retired SuiteSignOn in 2025.1, so neither is an executable import.
const referenceNames = [
    'action', 'auth', 'cache', 'certificateControl', 'commerce', 'compress', 'config', 'crypto',
    'crypto/certificate', 'crypto/random', 'currency', 'currentRecord', 'dataset', 'documentCapture',
    'email', 'encode', 'error', 'file', 'format', 'format/i18n', 'http', 'https', 'https/clientCertificate',
    'keyControl', 'llm', 'log', 'machineTranslation', 'manufacturing/productionCharges', 'pgp', 'piremoval',
    'plugin', 'portlet', 'query', 'record', 'recordContext', 'redirect', 'render', 'runtime', 'scriptTypes/restlet',
    'search', 'sftp', 'sso', 'suiteAppInfo', 'task', 'task/accounting/recognition', 'transaction', 'translation',
    'ui/dialog', 'ui/message', 'ui/serverWidget', 'url', 'util', 'workbook', 'workflow', 'xml'
];
const header = (type, version = '2.1') => '/** @NApiVersion ' + version + '\n * @NScriptType ' + type + ' */';
const paths = source => availableModules(source).map(module => module.path);
const expand = snippet => snippet.replace(/\$\{\d+\|([^}]+)\|\}/g, (_, values) => values.split(',')[0])
    .replace(/\$\{\d+:([^}]*)\}/g, '$1').replace(/\$\{\d+\}/g, '').replace(/\$\d+/g, '');

test('catalog accounts for every supplied reference entry and expands Commerce into its real leaf module', () => {
    const entries = new Map(modules.map(module => [module.path, module]));
    for (const name of referenceNames) assert.ok(entries.has('N/' + name), name);
    assert.equal(entries.get('N/commerce').status, 'namespace');
    assert.equal(entries.get('N/commerce/recordView').status, 'supported');
    assert.equal(entries.get('N/sso').status, 'retired');
    assert.match(entries.get('N/sso').notes, /2025\.1/);
    assert.ok(!paths('').includes('N/sso'));
    assert.ok(!paths('').includes('N/commerce'));
    assert.equal(modules.filter(module => module.status === 'supported').length, 54);
});

test('each supported module has a distinct import alias, verified reference metadata and useful starters', () => {
    const aliases = new Set();
    for (const module of modules.filter(module => module.status === 'supported')) {
        assert.match(module.param, /^[a-zA-Z_$][\w$]*$/);
        assert.ok(!aliases.has(module.param), module.param);
        aliases.add(module.param);
        assert.ok(module.description.length > 10, module.path);
        assert.match(module.documentationUrl, /^https:\/\/docs\.oracle\.com\/en\/cloud\/saas\/netsuite\/ns-online-help\/(?:section|article)_\d+\.html$/);
        assert.ok(module.contexts.length > 0);
        assert.ok(module.contexts.every(context => ['client', 'server', 'restlet'].includes(context)));
        assert.ok(Array.isArray(module.permissions));
        assert.ok(['2.0', '2.1'].includes(module.minVersion));
        assert.ok(methods[module.path]?.length > 0, module.path);
    }
});

test('every starter is ES5-parseable and includes its documented required input placeholders', () => {
    let count = 0;
    for (const [module, entries] of Object.entries(methods)) {
        const names = new Set();
        for (const [name, snippet, description, metadata] of entries) {
            count += 1;
            assert.ok(!names.has(name), module + '.' + name);
            names.add(name);
            assert.match(metadata.documentationUrl, /^https:\/\/docs\.oracle\.com\//);
            assert.ok(description.length > 10);
            const parsed = acorn.parse('var result = api.' + expand(snippet) + ';', { ecmaVersion: 5 });
            const call = parsed.body[0].declarations[0].init;
            assert.equal(call.type, 'CallExpression');
            assert.equal(call.callee.property.name, name);
            const keys = call.arguments[0]?.type === 'ObjectExpression' ? call.arguments[0].properties.map(property => property.key.name || property.key.value) : [];
            for (const required of metadata.requiredOptions) assert.ok(keys.includes(required), module + '.' + name + ': ' + required);
        }
    }
    assert.equal(count, 268);
});

test('2.0, 2.x and 2.1 availability honors server-only and version-specific modules', () => {
    for (const version of ['2.0', '2.x']) {
        const client = paths(header('ClientScript', version));
        const server = paths(header('ScheduledScript', version));
        assert.ok(client.includes('N/crypto/random'));
        assert.ok(!server.includes('N/crypto/random'));
        assert.ok(client.includes('N/currentRecord'));
        assert.ok(!client.includes('N/file'));
        assert.ok(!server.includes('N/currentRecord'));
        for (const name of ['documentCapture', 'llm', 'machineTranslation', 'manufacturing/productionCharges', 'pgp']) {
            assert.ok(!server.includes('N/' + name));
            assert.ok(paths(header('ScheduledScript', '2.1')).includes('N/' + name));
        }
    }
    assert.ok(paths(header('Restlet')).includes('N/scriptTypes/restlet'));
    assert.ok(!paths(header('ScheduledScript')).includes('N/scriptTypes/restlet'));
    assert.ok(!paths(header('MapReduceScript')).includes('N/redirect'));
    assert.ok(paths(header('Suitelet')).includes('N/redirect'));
    assert.equal(getScriptContext(header('ClientScript')).context, 'client');
});

test('unknown custom-module contexts retain useful modules while method-specific restrictions remain accurate', () => {
    const unknown = paths('/** @NApiVersion 2.1 */');
    assert.equal(unknown.length, 54);
    assert.equal(paths(header('CustomModule')).length, 54);
    const clientHttps = availableMethods('N/https', header('ClientScript')).map(method => method[0]);
    assert.ok(clientHttps.includes('get'));
    assert.ok(!clientHttps.includes('requestRestlet'));
    assert.deepEqual(availableMethods('N/sso', ''), []);
    assert.deepEqual(availableMethods('N/commerce', ''), []);
    assert.ok(!availableMethods('N/ui/serverWidget', header('UserEventScript')).some(method => method[0] === 'createAssistant'));
    assert.ok(availableMethods('N/ui/serverWidget', header('Suitelet')).some(method => method[0] === 'createAssistant'));
});

test('security-sensitive starter alternatives do not combine incompatible authentication inputs', () => {
    const find = (module, name) => methods[module].find(entry => entry[0] === name)[1];
    for (const module of ['N/crypto', 'N/https']) {
        assert.match(find(module, 'createSecretKey'), /secret:/);
        assert.doesNotMatch(find(module, 'createSecretKey'), /guid:/);
    }
    assert.match(find('N/sftp', 'createConnection'), /secret:/);
    assert.doesNotMatch(find('N/sftp', 'createConnection'), /passwordGuid:|keyId:/);
    assert.match(find('N/recordContext', 'getContext'), /recordType:/);
    assert.doesNotMatch(find('N/recordContext', 'getContext'), /record:/);
});

test('deprecated AI quota methods remain discoverable with current replacement guidance', () => {
    for (const [module, name] of [['N/documentCapture', 'getRemainingFreeUsage'],
        ['N/llm', 'getRemainingFreeUsage'], ['N/llm', 'getRemainingFreeEmbedUsage']]) {
        const entry = methods[module].find(method => method[0] === name);
        assert.equal(entry[3].deprecated, true);
        assert.equal(entry[3].replacement, 'llm.getRemainingUsage()');
        assert.match(entry[2], /Deprecated.*llm\.getRemainingUsage/);
        assert.match(entry[3].deprecationMessage, /NetSuite AI Units/);
        assert.match(entry[3].documentationUrl, /^https:\/\/docs\.oracle\.com\//);
        assert.ok(availableMethods(module, header('Suitelet')).some(method => method[0] === name));
    }
    assert.notEqual(methods['N/llm'].find(method => method[0] === 'getRemainingUsage')[3].deprecated, true);
});
