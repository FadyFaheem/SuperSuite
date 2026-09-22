'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const acorn = require('acorn');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createScript, createHeader, isSuiteScript, getFieldContext, filterFields } = require('../editor/scaffolds');
const { scriptTypes, methods, modules, availableModules } = require('../editor/catalog');

for (const version of ['2.0', '2.1']) {
    for (const type of [...Object.keys(scriptTypes), 'CustomModule']) {
        test('valid SuiteScript ' + version + ' scaffold for ' + type, () => {
            const source = createScript(type, version);
            assert.doesNotThrow(() => acorn.parse(source, { ecmaVersion: version === '2.0' ? 5 : 'latest' }));
            assert.equal(isSuiteScript(source), true);
            let exports;
            vm.runInNewContext(source, { define: (_dependencies, factory) => { exports = factory(); } });
            assert.deepEqual(Object.keys(exports), type === 'CustomModule' ? ['execute'] : scriptTypes[type]);
            if (type === 'ClientScript') for (const [name, handler] of Object.entries(exports)) {
                if (/^(saveRecord|validate)/.test(name)) assert.equal(handler({}), true);
            }
            if (type === 'MapReduceScript') assert.equal(exports.getInputData({}).length, 0);
        });
    }
}

test('header validates types and preserves the requested line endings', () => {
    assert.throws(() => createHeader('WrongType'));
    assert.throws(() => createHeader('UserEventScript', '1.0'));
    assert.match(createHeader('UserEventScript', '2.0', '\r\n'), /\r\n \* @NApiVersion 2.0\r\n/);
    assert.doesNotMatch(createHeader('CustomModule'), /@NScriptType/);
    assert.equal(isSuiteScript('const x = 1;'), false);
});

test('2.1-only modules are not suggested for SuiteScript 2.0 headers', () => {
    assert.ok(availableModules(createHeader('Suitelet', '2.1')).some(module => module.path === 'N/llm'));
    assert.ok(!availableModules(createHeader('Suitelet', '2.0')).some(module => module.path === 'N/llm'));
    assert.ok(availableModules(createHeader('Suitelet', '2.0')).some(module => module.path === 'N/record'));
});

test('field completion selects appropriate sublist fields and deduplicates', () => {
    const fields = [
        {id: 'memo', label: 'Memo', recordType: 'salesorder'},
        {id: 'quantity', sublistId: 'item', recordType: 'salesorder'},
        {id: 'quantity', sublistId: 'item', recordType: 'salesorder'},
        {id: 'amount', sublistId: 'expense', recordType: 'salesorder'},
        {id: 'bad-id', recordType: 'salesorder'}
    ];
    const text = "record.getSublistValue({ sublistId: 'item', fieldId: 'qu";
    const context = getFieldContext(text, text.length);
    assert.deepEqual(context, {kind: 'fieldId', prefix: 'qu', sublistId: 'item'});
    assert.deepEqual(filterFields(fields, context).map(field => field.id), ['quantity']);
    assert.equal(getFieldContext("const anything = 'me", 20), null);
    assert.deepEqual(filterFields(fields, {kind: 'sublistId', prefix: 'it'}).map(field => field.id), ['item']);
    assert.deepEqual(filterFields(fields, {kind: 'fieldId', prefix: ''}).map(field => field.id), ['memo']);
    const reversed = "record.getSublistValue({ fieldId: 'qu', sublistId: 'item' });";
    assert.equal(getFieldContext(reversed, reversed.indexOf("'qu") + 3).sublistId, 'item');
});

function expand(snippet) {
    return snippet.replace(/\$\{\d+\|([^}]+)\|\}/g, (_, choices) => choices.split(',')[0])
        .replace(/\$\{\d+:([^}]*)\}/g, '$1').replace(/\$\{\d+\}/g, '').replace(/\$\d+/g, '');
}

test('generated snippets are checked in and all full script templates parse', () => {
    const snippets = require('../editor/generate-snippets');
    const checkedIn = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'snippets', 'snippets.json'), 'utf8'));
    assert.deepEqual(checkedIn, snippets);
    for (const [name, snippet] of Object.entries(snippets)) {
        if (name.includes('2.0') || name.includes('2.1')) {
            assert.doesNotThrow(() => acorn.parse(expand(snippet.body.join('\n')), { ecmaVersion: name.includes('2.0') ? 5 : 'latest' }), name);
        }
    }
});

test('every method starter expands to valid JavaScript and belongs to a module', () => {
    for (const [module, entries] of Object.entries(methods)) {
        assert.ok(modules.some(value => value.path === module));
        for (const [name, snippet] of entries) assert.doesNotThrow(() => acorn.parse('const result = api.' + expand(snippet) + ';', { ecmaVersion: 'latest' }), module + '.' + name);
    }
});
