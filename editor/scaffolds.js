'use strict';

const { scriptTypes } = require('./catalog');

function createHeader(type = 'UserEventScript', version = '2.1', eol = '\n') {
    if (type !== 'CustomModule' && !scriptTypes[type]) throw new Error('Unsupported script type.');
    if (!['2.0', '2.1'].includes(version)) throw new Error('Choose SuiteScript 2.0 or 2.1.');
    return ['/**', ' * @NApiVersion ' + version,
        ...(type === 'CustomModule' ? [] : [' * @NScriptType ' + type]),
        ' * @NModuleScope SameAccount', ' */'].join(eol);
}

function createScript(type = 'UserEventScript', version = '2.1') {
    const header = createHeader(type, version);
    const entries = type === 'CustomModule' ? ['execute'] : scriptTypes[type];
    const lines = [header, version === '2.0' ? 'define([], function () {' : 'define([], () => {', "    'use strict';", ''];
    entries.forEach(entry => {
        const name = type === 'Restlet' ? entry + 'Handler' : entry;
        lines.push('    /**', '     * ' + entry + ' entry point.', '     * @param {Object} context - NetSuite entry point context.', '     */', '    function ' + name + '(context) {');
        if (type === 'ClientScript' && /^(saveRecord|validate)/.test(entry)) {
            lines.push('        // Return false only when validation should prevent the operation.', '        return true;');
        } else if (entry === 'getInputData') {
            lines.push('        // Return input data or a search; keep processing in map/reduce stages.', '        return [];');
        } else if (type === 'MapReduceScript' && ['map', 'reduce'].includes(entry)) {
            lines.push('        // Handle context.isRestarted and make writes idempotent before processing.', '        // TODO: Implement this stage.');
        } else if (type === 'Restlet') {
            lines.push('        // Validate the request and enforce the deployed role permissions.', '        return { success: true };');
        } else {
            lines.push('        // TODO: Implement ' + entry + '.');
        }
        lines.push('    }', '');
    });
    lines.push('    return {');
    entries.forEach((entry, index) => lines.push('        ' + entry + ': ' + (type === 'Restlet' ? entry + 'Handler' : entry) + (index < entries.length - 1 ? ',' : '')));
    lines.push('    };', '});', '');
    return lines.join('\n');
}

function isSuiteScript(source) {
    return /\/\*\*[\s\S]*?@NApiVersion\s+2\.(?:0|1|x)\b[\s\S]*?\*\//i.test(source) || /\b(?:define|require)\s*\(\s*\[[^\]]*['"]N\//.test(source);
}

/** Only offer account identifiers in field option strings, not arbitrary JavaScript. */
function getFieldContext(source, offset) {
    const before = source.slice(Math.max(0, offset - 1500), offset);
    const match = before.match(/\b(fieldId|sublistId)\s*:\s*(['"])([\w]*)$/);
    if (!match) return null;
    const objectStart = before.lastIndexOf('{');
    // Include following properties too: fieldId may precede sublistId in the options object.
    const after = source.slice(offset, offset + 1500).split('}')[0];
    const objectText = before.slice(objectStart) + after;
    const sublist = objectText.match(/\bsublistId\s*:\s*['"]([\w]+)['"]/);
    return { kind: match[1], prefix: match[3], sublistId: sublist ? sublist[1] : undefined };
}

function filterFields(fields, context) {
    const unique = new Map();
    if (!Array.isArray(fields)) return [];
    for (const field of fields) {
        if (!field || typeof field.id !== 'string' || !/^[\w]+$/.test(field.id)) continue;
        const id = context.kind === 'sublistId' ? field.sublistId : field.id;
        if (!id || (context.sublistId && field.sublistId !== context.sublistId)) continue;
        if (context.kind === 'fieldId' && !context.sublistId && field.sublistId) continue;
        if (!id.toLowerCase().startsWith(context.prefix.toLowerCase())) continue;
        const key = id + ':' + (field.recordType || '') + ':' + (field.sublistId || '');
        if (!unique.has(key)) unique.set(key, { ...field, id, ...(context.kind === 'sublistId' ? { label: field.sublistLabel || id } : {}) });
    }
    return [...unique.values()];
}

module.exports = { createHeader, createScript, isSuiteScript, getFieldContext, filterFields };
