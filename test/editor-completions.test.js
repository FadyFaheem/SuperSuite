'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { modules, methods, availableModules, availableMethods } = require('../editor/catalog');
const { applyEdits, getModuleBindings } = require('../editor/modules');

class Position {
    constructor(line, character) { Object.assign(this, { line, character }); }
    translate(line, character) { return new Position(this.line + line, this.character + character); }
}
class Range {
    constructor(start, end) { Object.assign(this, { start, end }); }
}
class SnippetString { constructor(value) { this.value = value; } }
class MarkdownString { constructor(value) { this.value = value; } }

function mockEditor(initial) {
    let text = initial;
    const history = [];
    const document = {
        languageId: 'javascript', version: 1, uri: { scheme: 'untitled' },
        getText() { return text; },
        positionAt(offset) { const lines = text.slice(0, offset).split('\n'); return new Position(lines.length - 1, lines.at(-1).length); },
        offsetAt(position) { const lines = text.split('\n'); return lines.slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0) + position.character; },
        lineAt(line) { return { text: text.split('\n')[line] }; }
    };
    return {
        document, editCount: 0,
        async edit(callback) {
            const edits = [];
            callback({ replace(range, value) { edits.push({ start: document.offsetAt(range.start), end: document.offsetAt(range.end), text: value }); } });
            history.push(text);
            text = applyEdits(text, edits);
            document.version++;
            this.editCount++;
            return true;
        },
        undo() { text = history.pop(); document.version++; }
    };
}

function fixture() {
    const f = { enabled: true, pickerItems: [] };
    const vscode = {
        Position, Range, SnippetString, MarkdownString,
        TextEdit: { replace: (range, newText) => ({ range, newText }) },
        CompletionItem: class { constructor(label, kind) { Object.assign(this, { label, kind }); } },
        CompletionItemKind: { Value: 1, EnumMember: 2, Keyword: 3, Field: 4, Module: 5, Method: 6 },
        CompletionItemTag: { Deprecated: 1 },
        workspace: { getConfiguration() { return { get() { return f.enabled; } }; } },
        window: { async showQuickPick(items) { f.pickerItems = items; return undefined; } }
    };
    const filename = path.resolve(__dirname, '../editor/index.js');
    const localRequire = createRequire(filename);
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        module, require: name => name === 'vscode' ? vscode : localRequire(name)
    }, { filename });
    return Object.assign(f, module.exports);
}

function sourceFor(module, expression, { version = '2.1', type } = {}) {
    const scriptType = type || module.scriptTypes?.[0] || (module.contexts?.includes('server') ? 'ScheduledScript' : module.contexts?.includes('restlet') ? 'Restlet' : module.contexts?.includes('client') ? 'ClientScript' : 'ScheduledScript');
    return `/**\n * @NApiVersion ${version}\n * @NScriptType ${scriptType}\n */\ndefine([], function() {\n    function run(context) {\n        ${expression}\n    }\n    return { execute: run };\n});\n`;
}

async function complete(f, editor, marker, token = { isCancellationRequested: false }) {
    const text = editor.document.getText();
    const position = editor.document.positionAt(text.indexOf(marker) + marker.length);
    return f.createCompletionProvider().provideCompletionItems(editor.document, position, token);
}

test('every supported module has atomic imports and methods through canonical and custom aliases', async t => {
    const f = fixture();
    const current = modules.filter(module => module.status === 'supported');
    assert.equal(new Set(current.map(module => module.param)).size, current.length, 'Canonical aliases must identify exactly one module.');
    for (const module of current) {
        await t.test(module.path, async () => {
            assert.ok(methods[module.path]?.length, 'Every advertised module needs at least one usable API starter.');
            const original = sourceFor(module, 'void context;');
            assert.ok(availableModules(original).some(value => value.path === module.path));
            const editor = mockEditor(original);
            await f.addModuleToEditor(editor, module.path, module.param);
            assert.deepEqual(getModuleBindings(editor.document.getText()), [{ path: module.path, alias: module.param }]);
            assert.equal(editor.editCount, 1, 'Import and parameter must share one edit transaction.');
            await f.addModuleToEditor(editor, module.path, module.param);
            assert.equal(editor.editCount, 1, 'Repeated imports must not add undo entries.');
            editor.undo();
            assert.equal(editor.document.getText(), original);

            const unbound = mockEditor(sourceFor(module, module.param + '.'));
            const advertisedMethods = availableMethods(module.path, unbound.document.getText());
            assert.ok(advertisedMethods.length, 'The selected supported context needs usable methods.');
            const items = await complete(f, unbound, module.param + '.');
            assert.equal(items.length, advertisedMethods.length);
            assert.ok(items.every(item => item.additionalTextEdits.length === 2));
            assert.ok(items.every((item, index) => item.documentation.value.includes(advertisedMethods[index][3]?.documentationUrl || module.documentationUrl)));
            const first = items[0];
            // Completion edits are non-overlapping and can be applied with its primary edit
            // as one transaction; the real host tests also verify VS Code undo behavior.
            await unbound.edit(builder => {
                first.additionalTextEdits.forEach(edit => builder.replace(edit.range, edit.newText));
                builder.replace(first.range, first.label + '()');
            });
            assert.deepEqual(getModuleBindings(unbound.document.getText()), [{ path: module.path, alias: module.param }]);
            unbound.undo();
            assert.equal(unbound.document.getText(), sourceFor(module, module.param + '.'));

            const customAlias = 'accountModule';
            const bound = mockEditor(sourceFor(module, customAlias + '.').replace('define([], function()', `define(['${module.path}'], function(${customAlias})`));
            const aliases = await complete(f, bound, customAlias + '.');
            assert.equal(aliases.length, advertisedMethods.length);
            assert.ok(aliases.every(item => item.additionalTextEdits.length === 0));
            for (let index = 0; index < aliases.length; index++) {
                const expected = advertisedMethods[index][1].replace(new RegExp('\\b' + module.param + '\\.', 'g'), customAlias + '.');
                assert.equal(aliases[index].insertText.value, expected);
                assert.equal(aliases[index].documentation.isTrusted, false);
            }
        });
    }
});

test('module picker exposes descriptions, contexts, permissions and direct official references', async () => {
    const f = fixture();
    const source = '/** @NApiVersion 2.1 */\ndefine([], function() { return {}; });';
    await f.chooseModule(mockEditor(source));
    assert.equal(f.pickerItems.length, availableModules(source).length);
    assert.ok(!f.pickerItems.some(item => item.label === 'N/sso'));
    assert.ok(!f.pickerItems.some(item => item.label === 'N/commerce'));
    for (const item of f.pickerItems) {
        assert.ok(item.detail.includes(item.module.description));
        assert.ok(item.description.includes(item.module.param));
        if (item.module.permissions.length) assert.match(item.detail, /Permissions:/u);
    }
    const pathSource = source.replace('define([]', "define(['N/']");
    const pathEditor = mockEditor(pathSource);
    const paths = await complete(f, pathEditor, "'N/");
    assert.equal(paths.length, availableModules(pathSource).length);
    assert.ok(paths.every(item => item.documentation.value.includes('https://docs.oracle.com/')));
});

test('N/crypto/random respects client and server version requirements', async () => {
    const f = fixture();
    const random = modules.find(module => module.path === 'N/crypto/random');
    for (const [version, type, expected] of [['2.0', 'ClientScript', true], ['2.0', 'ScheduledScript', false], ['2.1', 'ScheduledScript', true]]) {
        const source = sourceFor(random, 'random.', { version, type });
        assert.equal((await complete(f, mockEditor(source), 'random.')).length > 0, expected, `${type} ${version}`);
        const bound = source.replace('define([], function()', "define(['N/crypto/random'], function(rand)").replace('random.', 'rand.');
        assert.equal((await complete(f, mockEditor(bound), 'rand.')).length > 0, expected, `Imported alias: ${type} ${version}`);
    }
});

test('retired and context-incompatible imported modules do not advertise methods', async () => {
    const f = fixture();
    for (const [modulePath, alias, type] of [['N/sso', 'sso', 'Suitelet'], ['N/file', 'file', 'ClientScript'], ['N/currentRecord', 'currentRecord', 'ScheduledScript'], ['N/scriptTypes/restlet', 'restlet', 'ScheduledScript']]) {
        const module = modules.find(value => value.path === modulePath);
        assert.ok(module, modulePath);
        const source = sourceFor(module, alias + '.', { type }).replace('define([], function()', `define(['${modulePath}'], function(${alias})`);
        assert.equal((await complete(f, mockEditor(source), alias + '.')).length, 0, modulePath);
    }
});

test('enum defaults preserve aliases containing dollar characters literally', async () => {
    const f = fixture();
    const search = modules.find(module => module.path === 'N/search');
    const source = sourceFor(search, '$$.').replace('define([], function()', () => "define(['N/search'], function($$)");
    const items = await complete(f, mockEditor(source), '$$.');
    const column = items.find(item => item.label === 'createColumn');
    assert.ok(column);
    assert.match(column.insertText.value, /\$\$\.Sort\.ASC/u);
});

test('cancelled or disabled completion requests return no edits', async () => {
    const f = fixture();
    const record = modules.find(module => module.path === 'N/record');
    const editor = mockEditor(sourceFor(record, 'record.'));
    assert.equal((await complete(f, editor, 'record.', { isCancellationRequested: true })).length, 0);
    f.enabled = false;
    assert.equal((await complete(f, editor, 'record.')).length, 0);
    assert.equal(editor.editCount, 0);
});

test('nested object properties are not mistaken for module aliases', async () => {
    const f = fixture();
    const record = modules.find(module => module.path === 'N/record');
    for (const expression of ['context.record.', 'context?.record']) {
        const editor = mockEditor(sourceFor(record, expression));
        assert.equal((await complete(f, editor, expression)).length, 0);
    }
});

test('deprecated APIs remain identifiable with replacement guidance and completion tags', async () => {
    const f = fixture();
    for (const [modulePath, name] of [['N/documentCapture', 'getRemainingFreeUsage'], ['N/llm', 'getRemainingFreeUsage'], ['N/llm', 'getRemainingFreeEmbedUsage']]) {
        const module = modules.find(value => value.path === modulePath);
        const editor = mockEditor(sourceFor(module, module.param + '.'));
        const items = await complete(f, editor, module.param + '.');
        const item = items.find(value => value.label === name);
        const metadata = methods[modulePath].find(method => method[0] === name)[3];
        assert.ok(metadata.deprecated, modulePath + '.' + name);
        assert.deepEqual([...item.tags], [1]);
        assert.match(item.documentation.value, /deprecated/i);
        if (metadata.replacement) assert.ok(item.documentation.value.includes(metadata.replacement));
        assert.ok(items.filter(value => value.label !== name && !methods[modulePath].find(method => method[0] === value.label)[3]?.deprecated).every(value => value.tags === undefined));
    }
});
