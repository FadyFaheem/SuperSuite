'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { sourceFolder, inspectProject, assertCreateTarget, fingerprintProject, testConfigured } = require('../suitecloud/project');

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'supersuite-sdf-'));
    const projectRoot = path.join(root, 'Example');
    await fs.mkdir(path.join(projectRoot, 'src', 'Objects'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'suitecloud.config.js'), 'module.exports = { defaultProjectFolder: "src", commands: {} };');
    await fs.writeFile(path.join(projectRoot, 'src', 'manifest.xml'), '<manifest projecttype="ACCOUNTCUSTOMIZATION"><projectname>Example</projectname></manifest>');
    await fs.writeFile(path.join(projectRoot, 'src', 'deploy.xml'), '<deploy><objects><path>~/Objects/*</path></objects></deploy>');
    t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
    return { root, projectRoot, project: await inspectProject(root, projectRoot) };
}

test('project selection parses static configuration without evaluating its code', async t => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.projectRoot, 'suitecloud.config.js'), '"use strict"; module.exports = {defaultProjectFolder: "src", commands: {"project:validate": {beforeExecuting: () => { throw new Error("must never execute while selecting"); }}}};');
    assert.equal((await inspectProject(f.root, f.projectRoot)).type, 'ACCOUNTCUSTOMIZATION');
    assert.equal(sourceFolder('module.exports = {defaultProjectFolder: "."};'), '.');
    for (const configuration of ['module.exports = loadConfiguration();', 'module.exports = {defaultProjectFolder: process.env.SOURCE};', 'module.exports = {defaultProjectFolder: "../outside"};', 'module.exports = {defaultProjectFolder: "/tmp"};', 'module.exports = {get defaultProjectFolder() { return "src"; }};', 'module.exports = {...other, defaultProjectFolder: "src"};']) assert.throws(() => sourceFolder(configuration));
});

test('configuration cannot mutate the selected project folder at evaluation time', () => {
    const invalid = [
        'module.exports = {defaultProjectFolder:"src"}; module.exports.defaultProjectFolder = "../other";',
        'const config = {defaultProjectFolder:"src"}; module.exports = config;',
        'module.exports = {defaultProjectFolder:"src", commands: setupHooks()};',
        'module.exports = {defaultProjectFolder:"src", commands: {get deployment() { module.exports.defaultProjectFolder="../other"; }}};',
        'module.exports = {defaultProjectFolder:"src", commands: {"project:deploy": {projectFolder: "different"}}};',
        'module.exports = {defaultProjectFolder:"src", commands: {}, commands: other};',
        'module.exports = {defaultProjectFolder:"src", commands: {...other}};'
    ];
    for (const configuration of invalid) assert.throws(() => sourceFolder(configuration), /SuiteCloud configuration|projectFolder overrides/);
});

test('projects must have manifest and deployment definitions inside the chosen workspace', async t => {
    const f = await fixture(t);
    await assert.rejects(inspectProject(f.projectRoot, f.root), /inside the selected workspace/);
    await assert.rejects(inspectProject(f.root, path.join(f.root, '.config', 'supersuite-sdf')), /managed separately/);
    await fs.writeFile(path.join(f.projectRoot, 'src', 'manifest.xml'), '<!DOCTYPE manifest [<!ENTITY x "bad">]><manifest projecttype="ACCOUNTCUSTOMIZATION"/>');
    await assert.rejects(inspectProject(f.root, f.projectRoot), /XML entities/);
    await fs.writeFile(path.join(f.projectRoot, 'src', 'manifest.xml'), '<manifest projecttype="SUITEAPP"/>');
    assert.equal((await inspectProject(f.root, f.projectRoot)).type, 'SUITEAPP');
    await fs.unlink(path.join(f.projectRoot, 'src', 'deploy.xml'));
    await assert.rejects(inspectProject(f.root, f.projectRoot), /ENOENT/);
});

test('project creation rejects existing targets, traversal and shell metacharacters', async t => {
    const f = await fixture(t);
    assert.equal(await assertCreateTarget(f.root, 'New_Project-1'), path.join(f.root, 'New_Project-1'));
    await assert.rejects(assertCreateTarget(f.root, 'Example'), /already exists/);
    for (const name of ['../outside', '.', 'foo/bar', 'foo;echo', '$(danger)', '%PATH%', '-flag', 'x'.repeat(65)]) await assert.rejects(assertCreateTarget(f.root, name));
});

test('deployment fingerprints detect contents and auth-target changes but ignore dependencies and logs', async t => {
    const f = await fixture(t);
    const initial = await fingerprintProject(f.project);
    await fs.mkdir(path.join(f.projectRoot, 'node_modules'));
    await fs.writeFile(path.join(f.projectRoot, 'node_modules', 'ignored.js'), 'package code');
    await fs.writeFile(path.join(f.projectRoot, 'deployment.log'), 'transient output');
    assert.equal(await fingerprintProject(f.project), initial);
    await fs.writeFile(path.join(f.projectRoot, 'project.json'), '{"defaultAuthId":"sandbox"}');
    const accountChanged = await fingerprintProject(f.project);
    assert.notEqual(accountChanged, initial);
    await fs.writeFile(path.join(f.projectRoot, 'src', 'Objects', 'example.xml'), '<customrecordtype/>');
    assert.notEqual(await fingerprintProject(f.project), accountChanged);
});

test('SuiteCloud source symlinks are refused before CLI execution', async t => {
    const f = await fixture(t);
    const destination = path.join(f.projectRoot, 'src', 'external');
    const outside = path.join(f.root, 'outside');
    await fs.mkdir(outside);
    try { await fs.symlink(outside, destination, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { if (error.code === 'EPERM') return t.skip('Symbolic links unavailable in this environment.'); throw error; }
    await assert.rejects(fingerprintProject(f.project), /symbolic links/);
});

test('custom build source folders and deployable log files remain part of the deployment fingerprint', async t => {
    const f = await fixture(t);
    await fs.rename(path.join(f.projectRoot, 'src'), path.join(f.projectRoot, 'build'));
    await fs.writeFile(path.join(f.projectRoot, 'suitecloud.config.js'), 'module.exports = {defaultProjectFolder:"build"};');
    const project = await inspectProject(f.root, f.projectRoot);
    const initial = await fingerprintProject(project);
    await fs.writeFile(path.join(project.sourceRoot, 'sample.log'), 'source data');
    assert.notEqual(await fingerprintProject(project), initial);
});

test('dependency and cache directory names inside SDF source cannot bypass deployment fingerprints', async t => {
    const f = await fixture(t);
    for (const name of ['node_modules', '.git', '.suitecloud-sdk']) {
        const directory = path.join(f.project.sourceRoot, 'FileCabinet', 'SuiteScripts', name);
        await fs.mkdir(directory, { recursive: true });
        const filename = path.join(directory, 'library.js');
        await fs.writeFile(filename, 'original source');
        const initial = await fingerprintProject(f.project);
        await fs.writeFile(filename, 'changed source');
        assert.notEqual(await fingerprintProject(f.project), initial, name);
    }
});

test('dependency-named symbolic links inside SDF source are rejected', async t => {
    const f = await fixture(t);
    const scripts = path.join(f.project.sourceRoot, 'FileCabinet', 'SuiteScripts');
    const outside = path.join(f.root, 'outside');
    await fs.mkdir(scripts, { recursive: true });
    await fs.mkdir(outside);
    const destination = path.join(scripts, 'node_modules');
    try { await fs.symlink(outside, destination, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { if (error.code === 'EPERM') return t.skip('Symbolic links unavailable in this environment.'); throw error; }
    await assert.rejects(fingerprintProject(f.project), /symbolic links/);
});

test('unit tests require configured and installed Oracle testing support', async t => {
    const f = await fixture(t);
    await assert.rejects(testConfigured(f.project), /no unit-test package/);
    await fs.writeFile(path.join(f.projectRoot, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
    await assert.rejects(testConfigured(f.project), /@oracle\/suitecloud-unit-testing/);
    await fs.writeFile(path.join(f.projectRoot, 'package.json'), JSON.stringify({ scripts: { test: 'jest' }, devDependencies: { '@oracle/suitecloud-unit-testing': '3.0.0' } }));
    await assert.rejects(testConfigured(f.project), /not installed/);
    const installed = path.join(f.projectRoot, 'node_modules', '@oracle', 'suitecloud-unit-testing');
    await fs.mkdir(installed, { recursive: true });
    await fs.writeFile(path.join(installed, 'package.json'), '{}');
    await assert.doesNotReject(testConfigured(f.project));
});
