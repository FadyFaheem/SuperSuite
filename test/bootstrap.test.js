'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {
    createBootstrapProject, readBootstrapProject, validateBootstrapOptions, suiteCloudCommands, PROJECT_DIRECTORY, ensureConfigIgnored
} = require('../setup/bootstrap');

const extensionRoot = path.resolve(__dirname, '..');
const options = { realm: '1234567_SB1', rootDirectory: 'SuiteScripts/My Project', roleId: 'customrole_supersuite' };

async function fixture(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'supersuite-bootstrap-'));
    t.after(async () => {
        assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
        await fs.rm(directory, { recursive: true, force: true });
    });
    return directory;
}

test('bootstrap creates only a private scoped RESTlet deployment and preserves bundled source bytes', async t => {
    const root = await fixture(t);
    const project = await createBootstrapProject(root, options, extensionRoot);
    assert.equal(project.created, true);
    assert.equal(project.projectRoot, path.join(root, PROJECT_DIRECTORY));
    assert.match(project.scriptId, /^customscript_supersuite_[a-f0-9]{12}$/);
    assert.ok(project.scriptId.length <= 40 && project.deploymentId.length <= 40);
    const source = await fs.readFile(path.join(project.sourceRoot, 'FileCabinet', project.scriptPath));
    assert.deepEqual(source, await fs.readFile(path.join(extensionRoot, 'netSuiteRestlet/vscodeExtensionRestlet.js')));
    const xml = await fs.readFile(path.join(project.sourceRoot, 'Objects', `${project.scriptId}.xml`), 'utf8');
    assert.match(xml, /<audslctrole>\[scriptid=customrole_supersuite\]<\/audslctrole>/);
    assert.match(xml, /<custscript_supersuite_root>SuiteScripts\/My Project<\/custscript_supersuite_root>/);
    assert.match(xml, /<allroles>F<\/allroles>/);
    assert.match(xml, /<allemployees>F<\/allemployees>/);
    assert.doesNotMatch(xml, /<runasrole>|<isonline>|ADMINISTRATOR/);
    const manifest = await fs.readFile(path.join(project.sourceRoot, 'manifest.xml'), 'utf8');
    assert.match(manifest, /projecttype="ACCOUNTCUSTOMIZATION"/);
    assert.match(manifest, /<object>customrole_supersuite<\/object>/);
    const instructions = await fs.readFile(path.join(project.projectRoot, 'README.md'), 'utf8');
    assert.match(instructions, /## Manual deployment in NetSuite/);
    assert.match(instructions, /Documents > Files > File Cabinet > SuiteScripts/);
    assert.match(instructions, /Customization > Scripting > Scripts > New/);
    assert.match(instructions, /Free-Form Text/);
    assert.ok(instructions.includes(project.scriptId) && instructions.includes(project.deploymentId));
    assert.match(instructions, /custscript_supersuite_root/);
    assert.match(instructions, /External URL/);
    const deploy = await fs.readFile(path.join(project.sourceRoot, 'deploy.xml'), 'utf8');
    assert.equal((deploy.match(/<path>/g) || []).length, 2);
    assert.doesNotMatch(deploy, /\*/);
    const url = new URL(project.restletUrl);
    assert.equal(url.host, '1234567-sb1.restlets.api.netsuite.com');
    assert.equal(url.searchParams.get('script'), project.scriptId);
    assert.equal(url.searchParams.get('deploy'), project.deploymentId);
    assert.equal(await fs.readFile(path.join(project.projectRoot, '.gitignore'), 'utf8'), '*\n');
    assert.deepEqual((await fs.readdir(root)).sort(), ['.config', '.gitignore']);
    assert.match(await fs.readFile(path.join(root, '.gitignore'), 'utf8'), /\n\/\.config\/\n$/);
});

test('bootstrap resumes identical setup, preserves CLI profile and rejects account changes', async t => {
    const root = await fixture(t);
    const original = await createBootstrapProject(root, options, extensionRoot);
    await fs.writeFile(path.join(original.projectRoot, 'project.json'), '{"defaultAuthId":"sandbox"}\n');
    const resumed = await createBootstrapProject(root, options, extensionRoot);
    assert.deepEqual(resumed, { ...original, created: false });
    assert.equal(await fs.readFile(path.join(original.projectRoot, 'project.json'), 'utf8'), '{"defaultAuthId":"sandbox"}\n');
    for (const changed of [{ realm: '7654321' }, { rootDirectory: 'SuiteScripts' }, { roleId: 'DEVELOPER' }]) {
        await assert.rejects(createBootstrapProject(root, { ...options, ...changed }, extensionRoot), /different account, root, or role/);
    }
});

test('bootstrap declares the read-only switch using the SDF checkbox default and leaves the development deployment writable', async t => {
    // Oracle's RESTlet scriptcustomfield schema defines defaultchecked as a
    // boolean; defaultvalue is a separate string field, not the checkbox default.
    // https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/SDFxml_1719665444.html
    const root = await fixture(t);
    const project = await createBootstrapProject(root, options, extensionRoot);
    const source = await fs.readFile(path.join(project.sourceRoot, 'Objects', `${project.scriptId}.xml`), 'utf8');
    const parameter = /<scriptcustomfield scriptid="custscript_supersuite_readonly">([\s\S]*?)<\/scriptcustomfield>/.exec(source)?.[1];
    assert.ok(parameter, 'Generated RESTlet must declare the MCP read-only switch.');
    assert.match(parameter, /<fieldtype>CHECKBOX<\/fieldtype>/);
    assert.match(parameter, /<defaultchecked>F<\/defaultchecked>/);
    assert.doesNotMatch(parameter, /<defaultvalue>/);
    const deployment = /<scriptdeployment\s[^>]*>([\s\S]*?)<\/scriptdeployment>/.exec(source)?.[1];
    assert.ok(deployment);
    assert.match(deployment, /<custscript_supersuite_readonly>F<\/custscript_supersuite_readonly>/);
    const guide = await fs.readFile(path.join(project.projectRoot, 'README.md'), 'utf8');
    assert.match(guide, /\*\*Checkbox\*\* parameter[\s\S]*custscript_supersuite_readonly/);
    assert.match(guide, /separate deployment with a dedicated View-only role and enable the read-only checkbox/);
});

test('bootstrap never overwrites unrelated, incomplete, or locally edited projects', async t => {
    const root = await fixture(t);
    const projectRoot = path.join(root, PROJECT_DIRECTORY);
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'mine.txt'), 'keep me');
    await assert.rejects(createBootstrapProject(root, options, extensionRoot), /already exists/);
    assert.equal(await fs.readFile(path.join(projectRoot, 'mine.txt'), 'utf8'), 'keep me');
    const other = await fixture(t);
    const project = await createBootstrapProject(other, options, extensionRoot);
    const filename = path.join(project.sourceRoot, 'deploy.xml');
    await fs.writeFile(filename, '<deploy><objects><path>~/Objects/*</path></objects></deploy>');
    await assert.rejects(createBootstrapProject(other, options, extensionRoot), /was modified/);
    assert.match(await fs.readFile(filename, 'utf8'), /\*/);
});

test('bootstrap validates root/account/role before creating files and XML-escapes allowed folder names', async t => {
    const root = await fixture(t);
    for (const changed of [
        { realm: 'acct.example.com' }, { realm: 'acct\nmalicious' }, { rootDirectory: 'SuiteScripts/../outside' },
        { rootDirectory: 'Images' }, { rootDirectory: 'SuiteScripts/%2e%2e' }, { rootDirectory: 'SuiteScripts/.supersuite-staging' },
        { roleId: '3' }, { roleId: 'ADMINISTRATOR' }, { roleId: 'customrole_x</audslctrole>' }
    ]) {
        await assert.rejects(createBootstrapProject(root, { ...options, ...changed }, extensionRoot));
        assert.deepEqual(await fs.readdir(root), []);
    }
    const project = await createBootstrapProject(root, { ...options, roleId: 'DEVELOPER', rootDirectory: 'SuiteScripts/A&B' }, extensionRoot);
    const xml = await fs.readFile(path.join(project.sourceRoot, 'Objects', `${project.scriptId}.xml`), 'utf8');
    assert.match(xml, /SuiteScripts\/A&amp;B/);
    assert.match(xml, /<audslctrole>DEVELOPER<\/audslctrole>/);
    assert.doesNotMatch(await fs.readFile(path.join(project.sourceRoot, 'manifest.xml'), 'utf8'), /<objects>/);
    assert.equal(validateBootstrapOptions({ ...options, realm: '1234567_sb1' }).realm, '1234567_SB1');
});

test('bootstrap rejects a linked configuration directory before any write', async t => {
    const root = await fixture(t);
    const outside = await fixture(t);
    try { await fs.symlink(outside, path.join(root, '.config'), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { if (error.code === 'EPERM') return t.skip('Directory links are not permitted.'); throw error; }
    await assert.rejects(createBootstrapProject(root, options, extensionRoot), /Symbolic links|outside/);
    assert.deepEqual(await fs.readdir(outside), []);
});

test('bootstrap marker cannot inject file traversal and unique workspaces never reuse remote script IDs', async t => {
    const root = await fixture(t);
    const second = await fixture(t);
    assert.equal(await readBootstrapProject(root), null);
    const firstProject = await createBootstrapProject(root, options, extensionRoot);
    const secondProject = await createBootstrapProject(second, options, extensionRoot);
    assert.notEqual(firstProject.scriptId, secondProject.scriptId);
    const markerFile = path.join(firstProject.projectRoot, 'supersuite-bootstrap.json');
    const marker = JSON.parse(await fs.readFile(markerFile, 'utf8'));
    marker.files['../../outside'] = 'bad';
    await fs.writeFile(markerFile, JSON.stringify(marker));
    await assert.rejects(readBootstrapProject(root), /file list is invalid/);
});

test('SuiteCloud command descriptors use documented authentication and explicit deployment verbs only', () => {
    assert.deepEqual(suiteCloudCommands(), {
        authenticate: ['account:setup', '--interactive'], preview: ['project:deploy', '--dryrun'], deploy: ['project:deploy']
    });
    assert.deepEqual(suiteCloudCommands('sandbox.profile-1').authenticate, ['account:setup:ci', '--select', 'sandbox.profile-1']);
    for (const invalid of ['', '--help', 'profile && deploy', 'profile\nfoo', 'profile"', '$HOME']) {
        assert.throws(() => suiteCloudCommands(invalid), /profile ID/);
    }
});

test('configuration Git ignore preserves existing rules and adds a final rule after negations', async t => {
    const root = await fixture(t);
    const filename = path.join(root, '.gitignore');
    const previous = 'node_modules/\r\n/.config/\r\n!/.config/\r\n!/.config/**';
    await fs.writeFile(filename, previous);
    assert.equal(await ensureConfigIgnored(root), true);
    const actual = await fs.readFile(filename, 'utf8');
    assert.ok(actual.startsWith(previous + '\r\n'));
    assert.ok(actual.endsWith('/.config/\r\n'));
    assert.equal(await ensureConfigIgnored(root), false);
    assert.equal(await fs.readFile(filename, 'utf8'), actual);
});

test('configuration Git ignore rejects links and blocks bootstrap before creating project files', async t => {
    const root = await fixture(t);
    const outside = await fixture(t);
    const outsideFile = path.join(outside, 'keep.txt');
    await fs.writeFile(outsideFile, 'untouched');
    try { await fs.symlink(outsideFile, path.join(root, '.gitignore'), 'file'); }
    catch (error) { if (error.code === 'EPERM') return t.skip('File links are not permitted.'); throw error; }
    await assert.rejects(createBootstrapProject(root, options, extensionRoot), /Symbolic links|outside/);
    assert.equal(await fs.readFile(outsideFile, 'utf8'), 'untouched');
    assert.deepEqual(await fs.readdir(root), ['.gitignore']);
});

test('modified executable sources cannot be authorized by updating their workspace marker hashes', async t => {
    for (const relative of ['suitecloud.config.js', 'RESTLET']) {
        const root = await fixture(t);
        const project = await createBootstrapProject(root, options, extensionRoot);
        const target = relative === 'RESTLET' ? `src/FileCabinet/${project.scriptPath}` : relative;
        const filename = path.join(project.projectRoot, target);
        const bytes = Buffer.from('module.exports = { commands: { arbitrary: true } };\n');
        await fs.writeFile(filename, bytes);
        const markerFile = path.join(project.projectRoot, 'supersuite-bootstrap.json');
        const marker = JSON.parse(await fs.readFile(markerFile, 'utf8'));
        marker.files[target] = crypto.createHash('sha256').update(bytes).digest('hex');
        await fs.writeFile(markerFile, JSON.stringify(marker));
        await assert.rejects(readBootstrapProject(root), /was modified/);
    }
});

test('configuration ignore rejects oversized and nonregular files before creating bootstrap files', async t => {
    for (const kind of ['directory', 'oversized']) {
        const root = await fixture(t);
        const filename = path.join(root, '.gitignore');
        if (kind === 'directory') await fs.mkdir(filename);
        else await fs.writeFile(filename, Buffer.alloc(1024 * 1024 + 1, 65));
        await assert.rejects(createBootstrapProject(root, options, extensionRoot), /regular file at most 1 MiB/);
        assert.deepEqual(await fs.readdir(root), ['.gitignore']);
        if (kind === 'oversized') assert.equal((await fs.stat(filename)).size, 1024 * 1024 + 1);
    }
});
