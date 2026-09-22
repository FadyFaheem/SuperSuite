'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const acorn = require('acorn');
const { inside, assertSafeLocalPath } = require('../helpers/localFiles');

const MAX_FILES = 20000;
const MAX_BYTES = 128 * 1024 * 1024;
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const AUTH_ALIAS = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;

function projectKey(folder) {
    return `supersuite.suitecloud.project.${crypto.createHash('sha256').update(folder.uri.toString()).digest('hex')}`;
}

function assertProjectLocation(workspaceRoot, projectRoot) {
    if (!path.isAbsolute(projectRoot) || !inside(workspaceRoot, projectRoot)) throw new Error('Choose a SuiteCloud project inside the selected workspace.');
    if (path.relative(workspaceRoot, projectRoot).split(path.sep).some(part => part.startsWith('.') || part === 'node_modules')) throw new Error('Choose a regular SuiteCloud project folder. The private Init deployment project and dependency folders are managed separately.');
}

async function readSmall(root, filename) {
    await assertSafeLocalPath(root, filename);
    const stat = await fs.stat(filename);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error(`Invalid or oversized SuiteCloud configuration file: ${path.basename(filename)}.`);
    return fs.readFile(filename, 'utf8');
}

/** Inspect JavaScript as syntax only: selecting a project never executes its hooks. */
function sourceFolder(configuration) {
    const ast = acorn.parse(configuration, { ecmaVersion: 'latest', sourceType: 'script' });
    const statements = ast.body.filter(node => node.type !== 'EmptyStatement' && !(node.type === 'ExpressionStatement' && typeof node.directive === 'string'));
    const statement = statements.length === 1 && statements[0];
    const assignment = statement?.type === 'ExpressionStatement' && statement.expression;
    const exported = assignment?.type === 'AssignmentExpression' && assignment.operator === '=' && assignment.left.type === 'MemberExpression' && !assignment.left.computed && assignment.left.object.name === 'module' && assignment.left.property.name === 'exports' && assignment.right;
    if (!exported || exported.type !== 'ObjectExpression') throw new Error('SuiteCloud configuration must contain only a literal module.exports object and optional directives. Dynamic configuration can be run directly with the Oracle CLI.');
    const hooks = new Set(['beforeExecuting', 'onCompleted', 'onError']);
    function inspectLiteral(node, keys) {
        if (node.type === 'Literal' && !node.regex && typeof node.value !== 'bigint') return;
        if (keys[0] === 'commands' && hooks.has(keys.at(-1)) && (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression')) return;
        if (node.type === 'ArrayExpression' && node.elements.every(item => item !== null)) { for (const item of node.elements) inspectLiteral(item, keys); return; }
        if (node.type === 'ObjectExpression') {
            const names = new Set();
            for (const property of node.properties) {
                if (property.type !== 'Property' || property.computed || property.kind !== 'init') throw new Error('SuiteCloud configuration must use literal properties without spreads, computed names or accessors.');
                const name = property.key.type === 'Identifier' ? property.key.name : property.key.value;
                if (typeof name !== 'string' || names.has(name) || ['__proto__', 'constructor', 'prototype'].includes(name)) throw new Error('SuiteCloud configuration contains an unsupported or duplicate property.');
                if (keys[0] === 'commands' && name === 'projectFolder') throw new Error('Command-specific SuiteCloud projectFolder overrides must be run directly with the Oracle CLI.');
                names.add(name);
                inspectLiteral(property.value, [...keys, name]);
            }
            return;
        }
        throw new Error('SuiteCloud configuration must use literal values or inline command hooks. Dynamic expressions can be run directly with the Oracle CLI.');
    }
    inspectLiteral(exported, []);
    const properties = exported.properties.filter(node => (node.key.name || node.key.value) === 'defaultProjectFolder');
    const value = properties.length === 1 && properties[0].kind === 'init' && properties[0].value.type === 'Literal' && properties[0].value.value;
    if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/') || value.split('/').some(part => part === '..' || (part.startsWith('.') && part !== '.')) || !/^[A-Za-z0-9_./ -]+$/.test(value)) throw new Error('defaultProjectFolder must be a literal relative folder inside the SuiteCloud project.');
    return value;
}

async function inspectProject(workspaceRoot, projectRoot) {
    workspaceRoot = path.resolve(workspaceRoot);
    projectRoot = path.resolve(projectRoot);
    assertProjectLocation(workspaceRoot, projectRoot);
    await assertSafeLocalPath(workspaceRoot, projectRoot);
    const configuration = await readSmall(workspaceRoot, path.join(projectRoot, 'suitecloud.config.js'));
    const sourceRoot = path.resolve(projectRoot, sourceFolder(configuration));
    if (!inside(projectRoot, sourceRoot)) throw new Error('SuiteCloud source folder must be inside its project.');
    const manifest = await readSmall(workspaceRoot, path.join(sourceRoot, 'manifest.xml'));
    if (/<!DOCTYPE|<!ENTITY/i.test(manifest)) throw new Error('SuiteCloud manifest must not contain XML entities.');
    const type = /<manifest\b[^>]*\bprojecttype\s*=\s*["'](ACCOUNTCUSTOMIZATION|SUITEAPP)["']/i.exec(manifest)?.[1]?.toUpperCase();
    if (!type) throw new Error('The selected folder does not contain a supported SuiteCloud manifest.');
    await readSmall(workspaceRoot, path.join(sourceRoot, 'deploy.xml'));
    await assertSafeLocalPath(workspaceRoot, path.join(projectRoot, 'project.json'));
    return { workspaceRoot, projectRoot, sourceRoot, type };
}

async function assertCreateTarget(workspaceRoot, name) {
    if (!PROJECT_NAME.test(name)) throw new Error('Use 1–64 letters, numbers, underscores or hyphens for the project name, starting with a letter or number.');
    const destination = path.join(workspaceRoot, name);
    await assertSafeLocalPath(workspaceRoot, destination);
    try { await fs.lstat(destination); } catch (error) { if (error.code === 'ENOENT') return destination; throw error; }
    throw new Error('That project folder already exists. Choose another name; existing files are never overwritten by project creation.');
}

/** Reject linked source files and bind deployment approval to the reviewed bytes. */
async function fingerprintProject(project) {
    const hash = crypto.createHash('sha256');
    let count = 0;
    let bytes = 0;
    async function visit(directory) {
        for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
            // CLI auth caches, Git internals, dependencies and logs are not SDF source.
            const filename = path.join(directory, entry.name);
            const outsideSource = !inside(project.sourceRoot, filename);
            if (outsideSource && (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.suitecloud-sdk')) continue;
            if (directory === project.projectRoot && outsideSource && (entry.name === 'build' || entry.name.endsWith('.log'))) continue;
            if (entry.isSymbolicLink()) throw new Error('SuiteCloud project files must not be symbolic links.');
            await assertSafeLocalPath(project.workspaceRoot, filename);
            if (entry.isDirectory()) await visit(filename);
            else if (entry.isFile()) {
                const size = (await fs.stat(filename)).size;
                if (++count > MAX_FILES || (bytes += size) > MAX_BYTES) throw new Error('SuiteCloud project exceeds the safety limit of 20,000 files or 128 MiB. Run large projects directly with the Oracle CLI.');
                hash.update(path.relative(project.projectRoot, filename).split(path.sep).join('/'));
                hash.update('\0');
                hash.update(await fs.readFile(filename));
                hash.update('\0');
            }
        }
    }
    await visit(project.projectRoot);
    return hash.digest('hex');
}

async function testConfigured(project) {
    const filename = path.join(project.projectRoot, 'package.json');
    let manifest;
    try { manifest = JSON.parse(await readSmall(project.workspaceRoot, filename)); }
    catch (error) { if (error.code === 'ENOENT') throw new Error('This project has no unit-test package.json. Follow the SuiteCloud guide to configure Oracle’s Jest stubs first.'); throw error; }
    if (typeof manifest.scripts?.test !== 'string' || !manifest.scripts.test.trim() || !(manifest.devDependencies?.['@oracle/suitecloud-unit-testing'] || manifest.dependencies?.['@oracle/suitecloud-unit-testing'])) throw new Error('Configure a test script and @oracle/suitecloud-unit-testing in this project before running SuiteCloud tests.');
    const installed = path.join(project.projectRoot, 'node_modules', '@oracle', 'suitecloud-unit-testing', 'package.json');
    await assertSafeLocalPath(project.workspaceRoot, installed);
    try { await fs.access(installed); } catch { throw new Error('SuiteCloud unit-test dependencies are not installed. Install this project’s reviewed dependencies in its terminal first.'); }
}

module.exports = { PROJECT_NAME, AUTH_ALIAS, projectKey, sourceFolder, inspectProject, assertCreateTarget, fingerprintProject, testConfigured };
