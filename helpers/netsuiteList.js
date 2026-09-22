'use strict';

const { modules } = require('../editor/catalog');
function getSuiteScriptDependencies() { return modules.map(module => ({ ...module })); }
// Retain the historical misspelling for existing callers.
module.exports = { getSuiteScriptDependencies, getSuiteScriptDependecies: getSuiteScriptDependencies };
