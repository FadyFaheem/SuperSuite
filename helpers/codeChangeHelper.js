'use strict';

const { findModule, buildModuleEdits } = require('../editor/modules');

// Compatibility helpers for extensions of the original project. New code should
// use editor.addModuleToEditor(), which applies both changes as a single undo step.
function getCoords(source) {
    const { dependencies, factory } = findModule(source);
    const coords = node => ({
        start: { row: node.loc.start.line, col: node.loc.start.column },
        end: { row: node.loc.end.line, col: node.loc.end.column },
        range: [node.start, node.end]
    });
    const depParam = coords(factory);
    depParam.end = { row: factory.body.loc.start.line, col: factory.body.loc.start.column };
    depParam.range[1] = factory.body.start;
    return { depPath: dependencies ? coords(dependencies) : null, depParam };
}

function getUpdatedFunctionParams(alias, header) {
    // Run the same parser-based edit logic even for legacy header-only callers.
    const params = header.match(/\(([^)]*)\)/);
    const names = params ? params[1].split(',').map(value => value.trim()).filter(Boolean) : [header.split('=>')[0].trim()];
    const paths = names.map((_, index) => "'legacy/" + index + "'").join(', ');
    const prefix = 'define([' + paths + '], ';
    const source = prefix + header + '{});';
    const result = buildModuleEdits(source, 'legacy/new', alias);
    const edit = result.edits.find(value => value.start >= prefix.length);
    if (!edit) return header;
    return header.slice(0, edit.start - prefix.length) + edit.text + header.slice(edit.end - prefix.length);
}

function getUpdatedDepPath(modulePath, oldString) {
    const array = oldString || '[]';
    const acorn = require('acorn');
    const parsed = acorn.parseExpressionAt(array, 0, { ecmaVersion: 'latest' });
    if (parsed.type !== 'ArrayExpression') throw new Error('Expected a module dependency array.');
    const aliases = parsed.elements.map((_, index) => 'dependency' + index).join(', ');
    const prefix = 'define(';
    const source = prefix + array + ', function (' + aliases + ') {});';
    const result = buildModuleEdits(source, modulePath, 'newDependency');
    const edit = result.edits.find(value => value.start < prefix.length + array.length);
    return edit ? array.slice(0, edit.start - prefix.length) + edit.text + array.slice(edit.end - prefix.length) : array;
}

function createPosition(row, col) { return new (require('vscode').Position)(row, col); }
async function editCurrentDocument(editor, coords, content) {
    const vscode = require('vscode');
    const range = new vscode.Range(coords.start.line, coords.start.char, coords.end.line, coords.end.char);
    const applied = await editor.edit(builder => builder.replace(range, content));
    if (!applied) throw new Error('VS Code could not apply the edit.');
}
async function updateDocument(editor, startLine, startChar, endLine, endChar, content) {
    return editCurrentDocument(editor, { start: { line: startLine, char: startChar }, end: { line: endLine, char: endChar } }, content);
}
module.exports = { getCoords, getUpdatedFunctionParams, getUpdatedDepPath, createPosition, editCurrentDocument, updateDocument, buildModuleEdits };
