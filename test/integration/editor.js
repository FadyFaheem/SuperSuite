'use strict';

const assert = require('node:assert/strict');
const vscode = require('vscode');
const { addModuleToEditor, createCompletionProvider } = require('../../editor');
const { getModuleBindings } = require('../../editor/modules');
const { createScript } = require('../../editor/scaffolds');
const { modules, methods } = require('../../editor/catalog');

async function run() {
    const original = createScript('ScheduledScript', '2.1');
    const document = await vscode.workspace.openTextDocument({ language: 'javascript', content: original });
    const editor = await vscode.window.showTextDocument(document);
    await addModuleToEditor(editor, 'N/record', 'record');
    assert.deepEqual(getModuleBindings(document.getText()), [{ path: 'N/record', alias: 'record' }]);
    await vscode.commands.executeCommand('undo');
    assert.equal(document.getText(), original, 'One undo must remove both the dependency and callback parameter.');
    await addModuleToEditor(editor, 'N/log', 'log');
    const once = document.getText();
    await addModuleToEditor(editor, 'N/log', 'log');
    assert.equal(document.getText(), once, 'Adding the same module must be idempotent.');

    const completionSource = original.replace('// TODO: Implement execute.', 'record.');
    const completionDocument = await vscode.workspace.openTextDocument({ language: 'javascript', content: completionSource });
    const completionPosition = completionDocument.positionAt(completionSource.indexOf('record.') + 'record.'.length);
    const completions = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', completionDocument.uri, completionPosition, '.');
    const load = completions.items.find(item => item.label === 'load' && item.detail && item.detail.includes('N/record'));
    assert.ok(load, 'Registered provider should complete record.load and add N/record automatically.');
    assert.equal(load.additionalTextEdits.length, 2, 'Auto import must edit both AMD positions.');
    assert.match(load.insertText.value || load.insertText, /load\(\{ type:/);

    const aliasSource = completionSource.replace('define([], ()', "define(['N/record'], (rec)").replace('record.', 'rec.');
    const aliasDocument = await vscode.workspace.openTextDocument({ language: 'javascript', content: aliasSource });
    const aliasPosition = aliasDocument.positionAt(aliasSource.indexOf('rec.') + 4);
    const aliasCompletions = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', aliasDocument.uri, aliasPosition, '.');
    const aliasLoad = aliasCompletions.items.find(item => item.label === 'load' && item.detail === 'N/record');
    assert.ok(aliasLoad, 'Methods must complete through the actual AMD alias.');
    assert.equal((aliasLoad.additionalTextEdits || []).length, 0);

    const reactDocument = await vscode.workspace.openTextDocument({ language: 'javascriptreact', content: completionSource });
    const reactItems = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', reactDocument.uri, completionPosition, '.');
    assert.ok(reactItems.items.some(item => item.label === 'load' && item.detail && item.detail.includes('N/record')), 'The manifest JavaScript React selector must also register completions.');

    const fieldSource = original.replace('// TODO: Implement execute.', "context.newRecord.getValue({ fieldId: 'custbody_' });");
    const fieldDocument = await vscode.workspace.openTextDocument({ language: 'javascript', content: fieldSource });
    const fieldPosition = fieldDocument.positionAt(fieldSource.indexOf("'custbody_") + "'custbody_".length);
    const provider = createCompletionProvider({ getFieldMetadata: async () => [
        { id: 'custbody_project', label: 'Project', type: 'select', recordType: 'salesorder' },
        { id: 'entity', label: 'Customer', type: 'select', recordType: 'salesorder' }
    ] });
    const fieldItems = await provider.provideCompletionItems(fieldDocument, fieldPosition, new vscode.CancellationTokenSource().token);
    assert.deepEqual(fieldItems.map(item => item.label), ['custbody_project']);
    assert.match(fieldItems[0].detail, /Project/);

    const callSource = original.replace('// TODO: Implement execute.', "record.lo({ type: 'customer', id: 1 });");
    const callDocument = await vscode.workspace.openTextDocument({ language: 'javascript', content: callSource });
    const callItems = await provider.provideCompletionItems(callDocument, callDocument.positionAt(callSource.indexOf('record.lo') + 9), new vscode.CancellationTokenSource().token);
    assert.equal(callItems.find(item => item.label === 'load').insertText, 'load', 'Existing call arguments must not be duplicated by a method completion.');

    const ordinarySource = 'function run() { record. }';
    const ordinary = await vscode.workspace.openTextDocument({ language: 'javascript', content: ordinarySource });
    const ordinaryItems = await provider.provideCompletionItems(ordinary, ordinary.positionAt(ordinarySource.indexOf('record.') + 7), new vscode.CancellationTokenSource().token);
    assert.deepEqual(ordinaryItems, [], 'The provider must leave ordinary JavaScript alone.');

    const addedDocuments = [];
    const representative = ['N/crypto/random', 'N/https/clientCertificate', 'N/ui/message', modules.find(module => module.path.startsWith('N/commerce/'))?.path];
    for (const modulePath of representative) {
        const module = modules.find(value => value.path === modulePath);
        assert.ok(module && methods[modulePath]?.length, 'Expanded module coverage needs metadata and a callable API starter: ' + modulePath);
        const moduleSource = createScript('CustomModule', '2.1');
        const moduleDocument = await vscode.workspace.openTextDocument({ language: 'javascript', content: moduleSource });
        addedDocuments.push(moduleDocument);
        const moduleEditor = await vscode.window.showTextDocument(moduleDocument);
        await addModuleToEditor(moduleEditor, modulePath, 'accountApi');
        assert.deepEqual(getModuleBindings(moduleDocument.getText()), [{ path: modulePath, alias: 'accountApi' }]);
        await vscode.commands.executeCommand('undo');
        assert.equal(moduleDocument.getText(), moduleSource, modulePath + ' import must be a single undo step.');

        const suggestedSource = moduleSource.replace('// TODO: Implement execute.', module.param + '.');
        const suggestedDocument = await vscode.workspace.openTextDocument({ language: 'javascript', content: suggestedSource });
        addedDocuments.push(suggestedDocument);
        const suggestedPosition = suggestedDocument.positionAt(suggestedSource.indexOf(module.param + '.') + module.param.length + 1);
        const suggested = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', suggestedDocument.uri, suggestedPosition, '.');
        const method = suggested.items.find(item => item.label === methods[modulePath][0][0] && item.detail?.includes(modulePath));
        assert.ok(method, modulePath + ' should advertise a method through the registered completion provider.');
        assert.equal(method.additionalTextEdits.length, 2);
        assert.match(method.documentation.value, /https:\/\/docs\.oracle\.com\//);
        const suggestedEditor = await vscode.window.showTextDocument(suggestedDocument);
        await suggestedEditor.edit(builder => {
            for (const edit of method.additionalTextEdits) builder.replace(edit.range, edit.newText);
            builder.replace(method.range instanceof vscode.Range ? method.range : method.range.replacing, method.label + '()');
        });
        assert.deepEqual(getModuleBindings(suggestedDocument.getText()), [{ path: modulePath, alias: module.param }]);
        await vscode.commands.executeCommand('undo');
        assert.equal(suggestedDocument.getText(), suggestedSource, 'The method and both imports must support one edit transaction.');
    }

    // Discard only documents created by this test, leaving the host workspace untouched.
    for (const created of [document, completionDocument, aliasDocument, reactDocument, fieldDocument, callDocument, ordinary, ...addedDocuments]) {
        await vscode.window.showTextDocument(created);
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
}

module.exports = { run };
