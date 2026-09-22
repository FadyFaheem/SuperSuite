'use strict';

const vscode = require('vscode');
const acorn = require('acorn');
const { availableModules, availableMethods, scriptTypes } = require('./catalog');
const { buildModuleEdits, getModuleBindings, findModule, validateAlias, validatePath } = require('./modules');
const { createHeader, createScript, isSuiteScript, getFieldContext, filterFields } = require('./scaffolds');

const documentationUrl = 'https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_4140956840.html';
const supportedLanguages = ['javascript', 'javascriptreact'];

function asTextEdit(document, edit) {
    return vscode.TextEdit.replace(new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end)), edit.text);
}

async function addModuleToEditor(editor, path, alias) {
    if (!editor || !supportedLanguages.includes(editor.document.languageId)) throw new Error('Open a JavaScript SuiteScript file first.');
    const document = editor.document;
    const version = document.version;
    const result = buildModuleEdits(document.getText(), path, alias);
    if (result.alreadyImported) return result;
    if (document.version !== version) throw new Error('The document changed. Please add the module again.');
    const applied = await editor.edit(builder => {
        result.edits.forEach(edit => builder.replace(new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end)), edit.text));
    });
    if (!applied) throw new Error('VS Code could not apply the module import. Please retry.');
    return result;
}

async function chooseModule(editor = vscode.window.activeTextEditor) {
    if (!editor) throw new Error('Open a SuiteScript file first.');
    const selected = await vscode.window.showQuickPick(availableModules(editor.document.getText()).map(module => ({
        label: module.path,
        description: [module.param, contextLabel(module), module.minVersion && 'SuiteScript ' + module.minVersion + '+'].filter(Boolean).join(' · '),
        detail: [module.description, permissionsLabel(module), module.notes].filter(Boolean).join(' '), module
    })), {
        title: 'SuperSuite: Add NetSuite Module', placeHolder: 'Choose a module to add to define() and its callback'
    });
    if (!selected) return;
    const result = await addModuleToEditor(editor, selected.module.path, selected.module.param);
    if (result.alreadyImported) await vscode.window.showInformationMessage(selected.module.path + ' is already imported as ' + result.alias + '.');
}

async function chooseCustomModule(editor = vscode.window.activeTextEditor) {
    if (!editor) throw new Error('Open a SuiteScript file first.');
    const path = await vscode.window.showInputBox({ title: 'SuperSuite: Custom Module', prompt: 'File Cabinet module path (omit .js)', placeHolder: './lib/helper', validateInput: value => validatePath(value) ? undefined : 'Enter a module path without spaces, quotes, or a URL scheme.' });
    if (!path) return;
    const suggested = path.split('/').pop().replace(/\.js$/, '').replace(/[^\w$]/g, '');
    const alias = await vscode.window.showInputBox({ title: 'SuperSuite: Module Parameter', value: validateAlias(suggested) ? suggested : 'customModule', validateInput: value => validateAlias(value) ? undefined : 'Enter a valid JavaScript parameter name.' });
    if (!alias) return;
    await addModuleToEditor(editor, path, alias);
}

async function chooseScriptOptions() {
    const type = await vscode.window.showQuickPick([...Object.keys(scriptTypes), 'CustomModule'], { title: 'SuperSuite: Script Type' });
    if (!type) return;
    const version = await vscode.window.showQuickPick(['2.1', '2.0'], { title: 'SuperSuite: SuiteScript Version', placeHolder: 'Choose the language version used by this script' });
    return version ? { type, version } : undefined;
}

async function insertHeader() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !supportedLanguages.includes(editor.document.languageId)) throw new Error('Open a JavaScript file first.');
    const options = await chooseScriptOptions();
    if (!options) return;
    const text = editor.document.getText();
    if (/@NApiVersion\b|@NScriptType\b/.test(text)) throw new Error('This file already has a SuiteScript header. Edit its existing tags to avoid duplicate declarations.');
    if (/^(?:\uFEFF)?#!/.test(text)) throw new Error('Remove the executable shebang before creating a NetSuite script header.');
    const eol = editor.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    await editor.edit(builder => builder.insert(editor.document.positionAt(text.startsWith('\uFEFF') ? 1 : 0), createHeader(options.type, options.version, eol) + eol));
}

async function newScript() {
    const options = await chooseScriptOptions();
    if (!options) return;
    const document = await vscode.workspace.openTextDocument({ language: 'javascript', content: createScript(options.type, options.version) });
    await vscode.window.showTextDocument(document);
}

function isCodeAt(source, offset) {
    let inComment = false;
    try {
        const tokenizer = acorn.tokenizer(source, { ecmaVersion: 'latest', onComment: (_block, _text, start, end) => {
            if (start <= offset && end >= offset) inComment = true;
        } });
        for (;;) {
            const token = tokenizer.getToken();
            if (inComment) return false;
            if (token.start >= offset || token.type.label === 'eof') return true;
            if (token.end >= offset) return !['string', 'regexp', 'template', '`'].includes(token.type.label);
        }
    } catch { return false; }
}

function simpleItem(label, kind, text, detail) {
    const item = new vscode.CompletionItem(label, kind);
    item.insertText = text || label;
    item.detail = detail;
    return item;
}

function contextLabel(module) {
    return (module.contexts || []).map(context => context === 'restlet' ? 'RESTlet' : context === 'client' ? 'Client' : 'Server').join(' / ');
}

function permissionsLabel(module) {
    return module.permissions?.length ? 'Permissions: ' + module.permissions.join(', ') + '.' : '';
}

function moduleDocumentation(module, description, methodMetadata) {
    const paragraphs = [description || module.description];
    if (description && module.description && description !== module.description) paragraphs.push(module.description);
    if (module.contexts?.length) paragraphs.push('Supported contexts: ' + contextLabel(module) + '.');
    if (module.scriptTypes?.length) paragraphs.push('Script types: ' + module.scriptTypes.join(', ') + '.');
    if (methodMetadata?.contexts?.length) paragraphs.push('Method contexts: ' + contextLabel(methodMetadata) + '.');
    if (methodMetadata?.scriptTypes?.length) paragraphs.push('Method script types: ' + methodMetadata.scriptTypes.join(', ') + '.');
    if (methodMetadata?.since) paragraphs.push('Available since NetSuite ' + methodMetadata.since + '.');
    if (methodMetadata?.deprecated) paragraphs.push(methodMetadata.deprecationMessage || (methodMetadata.replacement ? 'Deprecated. Use ' + methodMetadata.replacement + ' instead.' : 'Deprecated by Oracle; review the linked reference before using this API.'));
    if (module.minVersion) paragraphs.push('Requires SuiteScript ' + module.minVersion + ' or later.');
    if (module.serverMinVersion) paragraphs.push('Server scripts require SuiteScript ' + module.serverMinVersion + ' or later.');
    paragraphs.push(permissionsLabel(module));
    if (module.notes) paragraphs.push(module.notes);
    const url = methodMetadata?.documentationUrl || module.documentationUrl || documentationUrl;
    paragraphs.push('[Oracle documentation](' + url + ')');
    const markdown = new vscode.MarkdownString(paragraphs.filter(Boolean).join('\n\n'));
    markdown.isTrusted = false;
    markdown.supportHtml = false;
    return markdown;
}

function createCompletionProvider(options = {}) {
    return {
        async provideCompletionItems(document, position, token) {
            if (token?.isCancellationRequested) return [];
            if (!vscode.workspace.getConfiguration('supersuite', document.uri).get('editorCompletions', true)) return [];
            const source = document.getText();
            const offset = document.offsetAt(position);
            const before = source.slice(0, offset);
            const line = document.lineAt(position.line).text.slice(0, position.character);
            const inJsdoc = before.lastIndexOf('/**') > before.lastIndexOf('*/');
            if (inJsdoc) {
                const apiVersion = line.match(/@NApiVersion\s+([\w.]*)$/);
                if (apiVersion) return ['2.1', '2.0', '2.x'].map(value => {
                    const item = simpleItem(value, vscode.CompletionItemKind.Value);
                    item.range = new vscode.Range(position.translate(0, -apiVersion[1].length), position);
                    return item;
                });
                if (/@NScriptType\s+\w*$/.test(line)) return Object.keys(scriptTypes).map(value => simpleItem(value, vscode.CompletionItemKind.EnumMember));
                if (/@NModuleScope\s+\w*$/.test(line)) return ['SameAccount', 'TargetAccount', 'Public'].map(value => simpleItem(value, vscode.CompletionItemKind.EnumMember));
                if (/@[A-Za-z]*$/.test(line)) return [
                    ['NApiVersion', 'NApiVersion ${1|2.1,2.0,2.x|}'],
                    ['NScriptType', 'NScriptType ${1|' + Object.keys(scriptTypes).join(',') + '|}'],
                    ['NModuleScope', 'NModuleScope ${1|SameAccount,TargetAccount,Public|}'],
                    ['NAmdConfig', 'NAmdConfig ${1:./amdconfig.json}']
                ].map(([name, snippet]) => {
                    const item = simpleItem(name, vscode.CompletionItemKind.Keyword, new vscode.SnippetString(snippet), 'NetSuite JSDoc tag');
                    item.range = new vscode.Range(position.translate(0, -(line.match(/@([A-Za-z]*)$/)[1].length)), position);
                    return item;
                });
                return [];
            }
            if (!isSuiteScript(source)) return [];

            const fieldContext = getFieldContext(source, offset);
            if (fieldContext && options.getFieldMetadata) {
                const quoteOffset = offset - fieldContext.prefix.length - 1;
                if (!isCodeAt(source.slice(0, quoteOffset), quoteOffset)) return [];
                try {
                    const fields = await options.getFieldMetadata(document);
                    if (token?.isCancellationRequested) return [];
                    return filterFields(fields, fieldContext).map(field => {
                        const item = simpleItem(field.id, vscode.CompletionItemKind.Field, field.id,
                            [field.label, field.type, field.recordType, field.sublistId].filter(Boolean).join(' · '));
                        item.range = new vscode.Range(position.translate(0, -fieldContext.prefix.length), position);
                        item.documentation = 'Account field metadata cached by SuperSuite. Availability depends on the connected role and record type.';
                        return item;
                    });
                } catch { return []; }
            }

            const pathMatch = line.match(/['"](N\/[\w/]*)$/);
            if (pathMatch && /\b(?:define|require)\s*\([\s\S]*\[[^\]]*$/.test(before.slice(0, offset - pathMatch[1].length - 1))) {
                return availableModules(source).map(module => {
                    const item = simpleItem(module.path, vscode.CompletionItemKind.Module, module.path, 'NetSuite module; add its matching callback parameter');
                    item.range = new vscode.Range(position.translate(0, -pathMatch[1].length), position);
                    item.documentation = moduleDocumentation(module);
                    return item;
                });
            }
            if (!isCodeAt(source, offset)) return [];
            const member = line.match(/(?<![\w$.])([A-Za-z_$][\w$]*)\.([\w$]*)$/);
            if (member) {
                // Mask only the incomplete property access. Import offsets are before the callback body.
                const accessStart = offset - member[0].length;
                const suffix = source.slice(offset).match(/^[\w$]*/)[0];
                const parsable = source.slice(0, accessStart) + member[1] + source.slice(offset + suffix.length);
                const bindings = getModuleBindings(parsable);
                const binding = bindings.find(value => value.alias === member[1]);
                // Availability applies to existing aliases as well as auto imports.
                // A retired or context-incompatible module must not advertise methods.
                const module = availableModules(source).find(value => binding ? value.path === binding.path : value.param === member[1]);
                if (!module) return [];
                const methodItems = availableMethods(module.path, source);
                if (!methodItems.length) return [];
                let imports = [];
                try {
                    const parsed = findModule(parsable);
                    if (accessStart < parsed.factory.body.start) return [];
                    if (!binding) {
                        const result = buildModuleEdits(parsable, module.path, member[1]);
                        // A dependency already imported under another name cannot be imported twice.
                        if (result.alreadyImported && result.alias !== member[1]) return [];
                        imports = result.edits;
                    }
                } catch { return []; }
                return methodItems.map(([name, snippet, description, methodMetadata]) => {
                    // Enum defaults must use the actual imported alias too.
                    const canonical = module.param.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const existingCall = /^\s*\(/.test(source.slice(offset + suffix.length));
                    const insertion = existingCall ? name : new vscode.SnippetString(snippet.replace(new RegExp('\\b' + canonical + '\\.', 'g'), () => member[1] + '.'));
                    const item = simpleItem(name, vscode.CompletionItemKind.Method, insertion, module.path + (binding ? '' : ' · auto import'));
                    if (methodMetadata?.deprecated) item.tags = [vscode.CompletionItemTag.Deprecated];
                    item.range = new vscode.Range(position.translate(0, -member[2].length), position.translate(0, suffix.length));
                    item.additionalTextEdits = imports.map(edit => asTextEdit(document, edit));
                    item.documentation = moduleDocumentation(module, description, methodMetadata);
                    return item;
                });
            }
            const word = line.match(/(?<![\w$.])([A-Za-z_$][\w$]*)$/);
            if (!word || word[1].length < 2) return [];
            return availableModules(source).filter(module => module.param.startsWith(word[1])).flatMap(module => {
                try {
                    const parsed = findModule(source);
                    if (offset <= parsed.factory.body.start) return [];
                    const result = buildModuleEdits(source, module.path, module.param);
                    if (result.alreadyImported) return [];
                    const item = simpleItem(module.param, vscode.CompletionItemKind.Module, module.param, 'Auto import ' + module.path);
                    item.additionalTextEdits = result.edits.map(edit => asTextEdit(document, edit));
                    item.documentation = moduleDocumentation(module);
                    return [item];
                } catch { return []; }
            });
        }
    };
}

function register(context, options = {}) {
    const command = (name, handler) => vscode.commands.registerCommand(name, async (...args) => {
        try { return await handler(...args); } catch (error) { await vscode.window.showErrorMessage('SuperSuite: ' + error.message); }
    });
    context.subscriptions.push(
        command('supersuite.addModule', () => chooseModule()),
        command('supersuite.addCustomModule', () => chooseCustomModule()),
        command('supersuite.insertHeader', insertHeader),
        command('supersuite.createScript', newScript),
        vscode.languages.registerCompletionItemProvider(supportedLanguages.map(language => ({ language })), createCompletionProvider(options), '.', '/', '@', "'", '"')
    );
}

module.exports = { register, addModuleToEditor, chooseModule, chooseCustomModule, createCompletionProvider };
