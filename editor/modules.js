'use strict';

const acorn = require('acorn');

function parse(source) {
    const tokens = [];
    const tree = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script', locations: true, onToken: tokens });
    return { tree, tokens };
}

function findModule(source) {
    let parsed;
    try { parsed = parse(source); } catch (error) {
        throw new Error('Finish or fix the JavaScript syntax before adding a module. ' + error.message);
    }
    const calls = parsed.tree.body.filter(node => node.type === 'ExpressionStatement')
        .map(node => node.expression)
        .filter(node => node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'define');
    if (calls.length !== 1) throw new Error('Expected exactly one top-level AMD define() call.');
    const call = calls[0];
    const args = call.arguments.slice();
    if (args[0] && args[0].type === 'Literal' && typeof args[0].value === 'string') args.shift();
    const dependencies = args[0] && args[0].type === 'ArrayExpression' ? args.shift() : null;
    const factory = args.shift();
    if (args.length || !factory || !['FunctionExpression', 'ArrowFunctionExpression'].includes(factory.type) || factory.async || factory.generator) {
        throw new Error('Use a synchronous function or arrow callback in define() before adding a module.');
    }
    if (factory.params.some(param => param.type !== 'Identifier')) throw new Error('Module imports require simple callback parameter names.');
    if (dependencies && dependencies.elements.some(element => !element || element.type !== 'Literal' || typeof element.value !== 'string')) {
        throw new Error('Module dependencies must be an array of string literals.');
    }
    if ((dependencies ? dependencies.elements.length : 0) !== factory.params.length) {
        throw new Error('The dependency array and callback parameters must have matching lengths before adding a module.');
    }
    return { ...parsed, call, dependencies, factory };
}

function walk(node, visit) {
    if (!node || typeof node !== 'object') return;
    if (typeof node.type === 'string') visit(node);
    for (const [key, value] of Object.entries(node)) {
        if (key === 'loc') continue;
        if (Array.isArray(value)) value.forEach(child => walk(child, visit));
        else if (value && typeof value === 'object') walk(value, visit);
    }
}

function bindingNames(tree) {
    const names = new Set();
    const addPattern = pattern => walk(pattern, node => { if (node.type === 'Identifier') names.add(node.name); });
    walk(tree, node => {
        if (node.type === 'VariableDeclarator') addPattern(node.id);
        if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) {
            if (node.id) names.add(node.id.name);
            node.params.forEach(addPattern);
        }
        if (node.type === 'ClassDeclaration' && node.id) names.add(node.id.name);
        if (node.type === 'CatchClause') addPattern(node.param);
    });
    return names;
}

function validateAlias(alias) {
    if (!/^[A-Za-z_$][\w$]*$/.test(alias || '')) return false;
    try { parse('function check(' + alias + ') {}'); return !['arguments', 'eval', 'define', 'require'].includes(alias); } catch { return false; }
}

function validatePath(path) {
    return typeof path === 'string' && path.length > 0 && path.length <= 500 && !/[\x00-\x20\\'"`]/.test(path) && !/^[a-z][a-z\d+.-]*:/i.test(path);
}

/** Produce offset edits for one atomic TextEditor.edit; never rewrite the script body. */
function buildModuleEdits(source, modulePath, alias) {
    if (!validatePath(modulePath)) throw new Error('Use a NetSuite module ID or File Cabinet module path without quotes, spaces, or a URL scheme.');
    if (!validateAlias(alias)) throw new Error('Choose a valid, non-reserved JavaScript parameter name.');
    const { tree, tokens, dependencies, factory } = findModule(source);
    const existing = dependencies ? dependencies.elements.findIndex(element => element.value === modulePath) : -1;
    if (existing !== -1) return { edits: [], alias: factory.params[existing].name, alreadyImported: true };
    if (bindingNames(tree).has(alias)) throw new Error('The name "' + alias + '" is already declared. Choose another module parameter name.');
    const edits = [];
    if (dependencies) {
        const close = dependencies.end - 1;
        const innerTokens = tokens.filter(token => token.start > dependencies.start && token.end <= close);
        const trailingComma = innerTokens.length && innerTokens[innerTokens.length - 1].type.label === ',';
        const first = dependencies.elements[0];
        const quote = first && source[first.start] === '"' ? '"' : "'";
        edits.push({ start: close, end: close, text: (first && !trailingComma ? ', ' : '') + quote + modulePath + quote });
    } else {
        edits.push({ start: factory.start, end: factory.start, text: "['" + modulePath + "'], " });
    }
    const header = tokens.filter(token => token.start >= factory.start && token.end <= factory.body.start);
    const arrow = factory.type === 'ArrowFunctionExpression' ? header.findIndex(token => token.type.label === '=>') : -1;
    const last = arrow >= 0 ? header[arrow - 1] : header[header.length - 1];
    if (last && last.type.label === ')') {
        const preceding = tokens[tokens.indexOf(last) - 1];
        const separator = factory.params.length && preceding.type.label !== ',' ? ', ' : '';
        edits.push({ start: last.start, end: last.start, text: separator + alias });
    } else if (factory.type === 'ArrowFunctionExpression' && factory.params.length === 1) {
        const param = factory.params[0];
        edits.push({ start: param.start, end: param.end, text: '(' + param.name + ', ' + alias + ')' });
    } else {
        throw new Error('Could not locate the module callback parameter list safely.');
    }
    // Reparse before exposing edits. This also detects unexpected comma/comment syntax.
    findModule(applyEdits(source, edits));
    return { edits, alias, alreadyImported: false };
}

function applyEdits(source, edits) {
    for (const edit of edits.slice().sort((a, b) => b.start - a.start || b.end - a.end)) {
        source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
    }
    return source;
}

function getModuleBindings(source) {
    try {
        const { dependencies, factory } = findModule(source);
        return dependencies ? dependencies.elements.map((element, index) => ({ path: element.value, alias: factory.params[index].name })) : [];
    } catch { return []; }
}

module.exports = { buildModuleEdits, applyEdits, findModule, getModuleBindings, validateAlias, validatePath };
