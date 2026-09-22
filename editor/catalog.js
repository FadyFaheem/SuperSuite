'use strict';

// Reviewed against Oracle's module/member references on 2026-09-22.
// See docs/MODULES.md for coverage, context restrictions and starter limitations.
const modules = require('./moduleMetadata.json');
const methods = require('./methodCatalog.json');

function getScriptContext(source) {
    const legacy = /@NApiVersion\s+2\.(?:0|x)\b/i.test(source);
    const scriptType = /@NScriptType\s+(\w+)/i.exec(source)?.[1];
    const known = Object.keys(scriptTypes).find(type => type.toLowerCase() === scriptType?.toLowerCase());
    const context = known === 'ClientScript' ? 'client' : known === 'Restlet' ? 'restlet' : known ? 'server' : undefined;
    return { scriptType: known, context, legacy };
}

function contextMatches(metadata, script) {
    return (!script.context || !metadata.contexts?.length || metadata.contexts.includes(script.context) ||
        (script.context === 'restlet' && metadata.contexts.includes('server'))) &&
        (!script.scriptType || !metadata.scriptTypes?.length || metadata.scriptTypes.includes(script.scriptType));
}

function availableModules(source) {
    const script = getScriptContext(source);
    return modules.filter(module => module.status === 'supported' &&
        (!script.legacy || module.minVersion !== '2.1') && contextMatches(module, script) &&
        !(script.legacy && script.context && script.context !== 'client' && module.serverMinVersion === '2.1'));
}

function availableMethods(modulePath, source) {
    if (!availableModules(source).some(module => module.path === modulePath)) return [];
    const script = getScriptContext(source);
    return (methods[modulePath] || []).filter(method => !method[3] || contextMatches(method[3], script));
}

const scriptTypes = {
    ClientScript: ['pageInit', 'saveRecord', 'validateField', 'fieldChanged', 'postSourcing', 'lineInit', 'validateDelete', 'validateInsert', 'validateLine', 'sublistChanged'],
    UserEventScript: ['beforeLoad', 'beforeSubmit', 'afterSubmit'],
    Suitelet: ['onRequest'], Restlet: ['get', 'post', 'put', 'delete'], ScheduledScript: ['execute'],
    MapReduceScript: ['getInputData', 'map', 'reduce', 'summarize'], MassUpdateScript: ['each'],
    WorkflowActionScript: ['onAction'], Portlet: ['render'],
    BundleInstallationScript: ['beforeInstall', 'afterInstall', 'beforeUpdate', 'afterUpdate', 'beforeUninstall']
};

module.exports = { modules, availableModules, availableMethods, getScriptContext, methods, scriptTypes };
