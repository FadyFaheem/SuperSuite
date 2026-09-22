'use strict';

// Run `node editor/generate-snippets.js` after changing scaffolds.
const fs = require('node:fs');
const path = require('node:path');
const { createScript, createHeader } = require('./scaffolds');
const types = {
    ClientScript: ['client', 'defineClient'], UserEventScript: ['userevent', 'defineUserEvent'],
    Suitelet: ['suitelet', 'defineSuitelet'], Restlet: ['restlet', 'defineRestlet'],
    ScheduledScript: ['scheduled', 'defineScheduled'], MapReduceScript: ['mapreduce', 'defineMapReduce'],
    MassUpdateScript: ['massupdate', 'defineMassUpdate'], WorkflowActionScript: ['workflow', 'defineWorkflowAction'],
    Portlet: ['portlet', 'definePortlet'], BundleInstallationScript: ['bundle', 'defineBundleInstall'],
    CustomModule: ['module', 'defineModule']
};
const snippets = {};
for (const version of ['2.0', '2.1']) {
    for (const [type, [short, legacy]] of Object.entries(types)) {
        snippets['SuiteScript ' + version + ' ' + type] = {
            prefix: ['ss' + version.replace('.', '') + '-' + short, ...(version === '2.0' ? [legacy] : [])],
            body: createScript(type, version).trimEnd().replace('    //', '    $0//').split('\n'),
            description: 'SuiteScript ' + version + ' ' + type + ' with documented entry points and AMD module callback'
        };
    }
    snippets['SuiteScript ' + version + ' header'] = {
        prefix: 'ss' + version.replace('.', '') + '-header',
        body: createHeader('UserEventScript', version).replace('UserEventScript', '${1|' + Object.keys(types).filter(type => type !== 'CustomModule').join(',') + '|}').split('\n'),
        description: 'NetSuite script JSDoc header with script type selection'
    };
}
Object.assign(snippets, {
    'SuiteScript debugger require': {
        prefix: ['ss-require', 'requireModule'],
        body: ["require(['${1:N/record}'], function (${2:record}) {", '    $0', '});'],
        description: 'AMD require callback for the SuiteScript debugger'
    },
    'SuiteScript get field': {
        prefix: 'ss-getvalue', body: "${1:record}.getValue({ fieldId: '${2:fieldid}' })$0", description: 'Read a record body field value'
    },
    'SuiteScript set field': {
        prefix: 'ss-setvalue', body: "${1:record}.setValue({ fieldId: '${2:fieldid}', value: ${3:null} });$0", description: 'Set a record body field value'
    },
    'SuiteScript sublist field': {
        prefix: 'ss-sublistvalue', body: "${1:record}.getSublistValue({ sublistId: '${2:item}', fieldId: '${3:item}', line: ${4:0} })$0", description: 'Read a zero-based sublist line field'
    },
    'SuiteScript paged search': {
        prefix: 'ss-search-paged', body: [
            '// Import N/search as search. Use a unique, deterministic sort for paging.',
            'var ${1:paged} = search.create({', "    type: '${2:customer}',", '    filters: [${3}],',
            "    columns: [search.createColumn({ name: 'internalid', sort: search.Sort.ASC })]",
            '}).runPaged({ pageSize: ${4:1000} });',
            '$1.pageRanges.forEach(function (pageRange) {', '    var page = $1.fetch({ index: pageRange.index });',
            '    page.data.forEach(function (result) {', '        $0', '    });', '});'
        ], description: 'Process a search one page at a time; requires N/search'
    },
    'SuiteScript parameter': {
        prefix: 'ss-parameter', body: "runtime.getCurrentScript().getParameter({ name: '${1:custscript_parameter}' })$0", description: 'Read a deployment parameter; requires N/runtime'
    },
    'SuiteScript governance': {
        prefix: 'ss-governance', body: 'runtime.getCurrentScript().getRemainingUsage()$0', description: 'Read remaining governance units; requires N/runtime'
    },
    'SuiteScript function JSDoc': {
        prefix: 'ss-jsdoc', body: ['/**', ' * ${1:Describe the function.}', ' * @param {${2:Object}} ${3:context} - ${4:Description}', ' * @returns {${5:void}} ${6:Description}', ' */', '$0'], description: 'Document a SuiteScript function'
    }
});
if (require.main === module) fs.writeFileSync(path.join(__dirname, '..', 'snippets', 'snippets.json'), JSON.stringify(snippets, null, 2) + '\n');
module.exports = snippets;
