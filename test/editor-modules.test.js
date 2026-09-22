'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const acorn = require('acorn');
const { buildModuleEdits, applyEdits, findModule, getModuleBindings, validateAlias, validatePath } = require('../editor/modules');

const forms = [
    'define([], function () { return {}; });',
    'define(function () { return {}; });',
    'define([], () => { return {}; });',
    "define('custom/id', [], () => ({ value: 1 }));",
    "define('custom/id', function () { return {}; });",
    "define(['N/log'], log => ({ log }));",
    "define(['N/log',], (log,) => ({ log }));",
    "define([\n'N/log' // dependency comment\n], function (log /* parameter comment */) { const a = data?.value ?? 1; return {a}; });",
    "define([\"N/log\", /* dependency comment */], (log, /* parameter comment */) => { return {}; });",
    'define([/* empty */], function (/* empty */) { return {}; });'
];
for (const [index, source] of forms.entries()) {
    test('module import preserves order and syntax for callback form ' + index, () => {
        const result = buildModuleEdits(source, 'N/record', 'record');
        const updated = applyEdits(source, result.edits);
        const original = findModule(source);
        const changed = findModule(updated);
        assert.equal(updated.slice(changed.factory.body.start, changed.factory.body.end), source.slice(original.factory.body.start, original.factory.body.end));
        assert.deepEqual(getModuleBindings(updated).at(-1), { path: 'N/record', alias: 'record' });
        assert.equal(result.edits.length, 2);
        assert.doesNotThrow(() => acorn.parse(updated, { ecmaVersion: 'latest' }));
    });
}

test('duplicate imports are idempotent and report the actual alias', () => {
    assert.deepEqual(buildModuleEdits("define(['N/record'], function (rec) {});", 'N/record', 'record'), { edits: [], alias: 'rec', alreadyImported: true });
});

for (const source of [
    'const ordinaryJavaScript = 1;',
    'function nested() { define([], function () {}); }',
    'define([], function () {}); define([], function () {});',
    "define(['N/log'], function () {});",
    'define(function (require) {});',
    'define([moduleName], function (module) {});',
    'define([,], function (module) {});',
    "define(['N/log'], function ({ debug }) {});",
    'define([], async function () {});',
    'define([], function () {',
    'define({execute() {}});'
]) {
    test('unsafe input refuses import: ' + source, () => assert.throws(() => buildModuleEdits(source, 'N/record', 'record')));
}

test('aliases cannot overwrite existing bindings, including nested bindings', () => {
    for (const body of ['var record = 1;', 'const {record} = data;', 'function record() {}', 'function fn(record) {}', 'try {} catch(record) {}']) {
        assert.throws(() => buildModuleEdits('define([], function () {' + body + '});', 'N/record', 'record'), /already declared/);
    }
});

test('module paths and aliases reject injection and reserved words', () => {
    for (const path of ['https://example.com/file', "x'); alert(1);//", 'a\\b', 'a\nb', '']) assert.equal(validatePath(path), false);
    for (const alias of ['function', 'record,x', '1record', 'define', 'require', 'eval', '']) assert.equal(validateAlias(alias), false);
    assert.equal(validatePath('./lib/my-helper'), true);
    assert.equal(validateAlias('myHelper'), true);
});

test('nested define calls do not change the selected outer callback', () => {
    const source = 'define([], function () { function example() { define([], function () {}); } return {example}; });';
    const result = buildModuleEdits(source, 'N/search', 'search');
    assert.match(applyEdits(source, result.edits), /function example\(\) \{ define\(\[\], function \(\) \{\}\); \}/);
});
