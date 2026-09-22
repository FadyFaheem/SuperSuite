'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { validateConfig, readConfig, connectionKey } = require('../helpers/config');
const { atomicWrite, assertSafeLocalPath, isProtected } = require('../helpers/localFiles');

test('configuration rejects plaintext secrets, traversal, unsafe transfer bounds', () => {
    assert.throws(() => validateConfig({ consumerSecret: 'secret' }), /Keep consumerSecret out/);
    for (const rootDirectory of ['../SuiteScripts', 'SuiteScripts/../Other', 'SuiteScripts\\Test', 'SuiteScripts//Test']) assert.throws(() => validateConfig({ rootDirectory }));
    assert.throws(() => validateConfig({ batchSize: 0 }));
    assert.throws(() => validateConfig({ maxRetries: 50 }));
    assert.equal(validateConfig({ rootDirectory: 'SuiteScripts/Test' }).batchSize, 10);
});
test('credentials are bound to workspace, account and endpoint', () => {
    const config = validateConfig({});
    assert.notEqual(connectionKey('a', config), connectionKey('b', config));
    assert.notEqual(connectionKey('a', config), connectionKey('a', { ...config, restlet: 'other' }));
    assert.notEqual(connectionKey('a', config), connectionKey('a', { ...config, realm: 'other' }));
});
test('config defaults and atomic writes preserve workspace boundary', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'supersuite-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    assert.equal((await readConfig(root)).rootDirectory, 'SuiteScripts');
    await atomicWrite(root, path.join(root, 'sub', 'test.js'), Buffer.from('hello'));
    assert.equal(await fs.readFile(path.join(root, 'sub', 'test.js'), 'utf8'), 'hello');
    await assert.rejects(assertSafeLocalPath(root, path.join(root, '..', 'escape')), /outside/);
    assert.equal(isProtected('.config/supersuite.json'), true);
    assert.equal(isProtected('foo/.env'), true);
    assert.equal(isProtected('script.js'), false);
});
