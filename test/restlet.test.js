'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '../netSuiteRestlet/vscodeExtensionRestlet.js'), 'utf8');
const binaryTypes = new Set(['PDF', 'PNGIMAGE', 'JPGIMAGE', 'ZIP', 'EXCEL']);

/** Stateful mock of the documented APIs, including copy conflict semantics. */
function cabinet(options = {}) {
  let nextId = 100;
  let restlet;
  const calls = [];
  const folders = new Map([
    [1, { id: 1, name: 'SuiteScripts', parent: null }],
    [2, { id: 2, name: 'Project', parent: 1 }],
    [3, { id: 3, name: 'Other', parent: 1 }]
  ]);
  const files = new Map();
  function error(code) { return Object.assign(new Error(code), { name: code }); }
  function filePath(item) {
    const parts = [item.name];
    let parent = item.folder;
    while (parent !== null) {
      const folder = folders.get(Number(parent));
      if (!folder) throw error('INVALID_KEY_OR_REF');
      parts.unshift(folder.name);
      parent = folder.parent;
    }
    return parts.join('/');
  }
  function object(item) {
    return { ...item, isText: !binaryTypes.has(item.fileType),
      size: item.size === undefined ? Buffer.byteLength(item.content, binaryTypes.has(item.fileType) ? 'base64' : 'utf8') : item.size,
      getContents() { calls.push(['contents', item.id]); return item.content; } };
  }
  function addFile(name, content = '', fileType = 'JAVASCRIPT', folder = 2, attributes = {}) {
    const id = nextId++;
    files.set(id, { id, name, folder, content, fileType, isOnline: false, ...attributes });
    return id;
  }
  function matches(row, filter) {
    if (!Array.isArray(filter)) return true;
    if (Array.isArray(filter[0])) return filter.every(part => part === 'AND' || matches(row, part));
    const [field, operator, raw] = filter;
    const value = Array.isArray(raw) ? raw[0] : raw;
    let actual = row[field];
    if (field === 'internalidnumber') actual = row.id;
    if (field === 'istoplevel') actual = row.parent === null ? 'T' : 'F';
    if (operator === 'greaterthan') return Number(actual) > Number(value);
    if (operator === 'isnot') return String(actual).toLowerCase() !== String(value).toLowerCase();
    return String(actual) === String(value);
  }
  const recordMetadata = {
    getFields() { calls.push(['getFields']); return ['entityid', 'custbody_project']; },
    getField({ fieldId }) {
      calls.push(['getField', fieldId]);
      return { id: fieldId, label: fieldId === 'entityid' ? 'ID' : 'Project', type: 'text', isMandatory: fieldId === 'entityid' };
    },
    getValue() { throw new Error('Metadata must never read a record value'); },
    save() { throw new Error('Metadata must never save a business record'); }
  };
  const modules = {
    'N/file': {
      Type: new Proxy({}, { get: (_, key) => key }), Encoding: { UTF8: 'UTF-8' },
      NameConflictResolution: { OVERWRITE: 'OVERWRITE' },
      load({ id }) {
        calls.push(['load', id]);
        if (options.loadFailure) throw error(options.loadFailure);
        const item = typeof id === 'number' ? files.get(id) : [...files.values()].find(value => filePath(value) === id);
        if (!item) throw error('RCRD_DSNT_EXIST');
        return object(item);
      },
      create(config) {
        calls.push(['createFile', config.name]);
        const staged = { ...config, isText: !binaryTypes.has(config.fileType),
          save() {
            const id = addFile(staged.name, staged.contents, staged.fileType, staged.folder,
              { isOnline: staged.isOnline, encoding: staged.encoding });
            calls.push(['saveFile', id]);
            return id;
          }
        };
        return staged;
      },
      copy({ id, folder, conflictResolution }) {
        calls.push(['copy', id, folder, conflictResolution]);
        if (options.copyFailure) throw error(options.copyFailure);
        assert.equal(conflictResolution, 'OVERWRITE');
        const source = files.get(id);
        const destination = [...files.values()].find(item => item.folder === folder && item.name === source.name);
        if (destination) {
          destination.content = source.content;
          return object(destination);
        }
        return object(files.get(addFile(source.name, source.content, source.fileType, folder)));
      },
      delete({ id }) {
        calls.push(['deleteFile', Number(id)]);
        if (options.cleanupFailure && filePath(files.get(Number(id))).includes('.supersuite-staging')) {
          throw error('INSUFFICIENT_PERMISSION');
        }
        files.delete(Number(id));
      }
    },
    'N/search': {
      Type: { FOLDER: 'folder' }, Sort: { ASC: 'ASC' },
      createColumn: value => value,
      create(config) {
        assert.ok(['folder', 'file'].includes(config.type), 'Search type must use a documented enum or record ID');
        calls.push(['search', config.type, config.filters]);
        return { run: () => ({ getRange({ start, end }) {
          assert.ok(end - start <= 1000, 'N/search getRange maximum is 1000');
          assert.equal(config.columns[0].sort, 'ASC', 'All pages require deterministic sorting');
          return [...(config.type === 'folder' ? folders : files).values()]
            .filter(item => matches(item, config.filters)).sort((a, b) => a.id - b.id)
            .slice(start, end).map(item => ({ id: String(item.id), getValue: ({ name }) => item[name] }));
        } }) };
      }
    },
    'N/record': {
      Type: { FOLDER: 'folder' },
      create(config) {
        calls.push(['createRecord', config.type]);
        if (config.type !== 'folder') {
          if (options.metadataFailure) throw error(options.metadataFailure);
          return recordMetadata;
        }
        const draft = {};
        return {
          setValue({ fieldId, value }) { draft[fieldId] = value; },
          save() {
            const id = nextId++;
            folders.set(id, { id, ...draft });
            calls.push(['saveFolder', id]);
            return id;
          }
        };
      },
      load(config) { calls.push(['loadRecord', config]); return recordMetadata; },
      delete({ id }) {
        assert.ok(![...files.values()].some(value => value.folder === id));
        calls.push(['deleteFolder', id]);
        folders.delete(id);
      }
    },
    'N/runtime': { accountId: '123456', getCurrentUser: () => ({ id: 42, role: 1001 }), getCurrentScript: () => ({
      getParameter: () => options.root || null,
      getRemainingUsage: () => options.usage ? options.usage(calls) : 5000
    }) },
    'N/log': { error: event => calls.push(['log', event]) }
  };
  vm.runInNewContext(script, { define: (names, factory) => { restlet = factory(...names.map(name => modules[name])); } });
  const api = Object.fromEntries(Object.entries(restlet).map(([name, handler]) =>
    [name, request => JSON.parse(JSON.stringify(handler(request)))]));
  return { api, files, folders, calls, addFile, filePath };
}

test('version advertises bounded protocol and refuses writes on GET', () => {
  const { api } = cabinet();
  assert.equal(api.get({ type: 'version' }).protocolVersion, 2);
  assert.equal(api.post({ action: 'version' }).limits.maxBatchFiles, 20);
  assert.equal(api.get({ action: 'push', files: [] }).error.code, 'UNSUPPORTED_ACTION');
  assert.equal(api.post({ action: 'delete', path: 'SuiteScripts/file.js' }).error.code, 'UNSUPPORTED_ACTION');
  assert.equal(api.post(null).error.code, 'INVALID_REQUEST');
});

test('root boundaries reject traversal, encoded paths, IDs and reserved staging paths', () => {
  const { api, calls } = cabinet({ root: 'SuiteScripts/Project' });
  const paths = ['SuiteScripts/Other/a.js', 'SuiteScripts/ProjectTwo/a.js', '123',
    'SuiteScripts/Project/../a.js', 'SuiteScripts/Project/%2e%2e/a.js',
    'SuiteScripts\\Project\\a.js', '/SuiteScripts/Project/a.js',
    'SuiteScripts/Project//a.js', 'SuiteScripts/Project/.supersuite-staging/a.js'];
  const response = api.post({ action: 'pull', files: paths.map(path => ({ path })) });
  assert.equal(response.ok, true);
  assert.ok(response.results.every(item => !item.ok && !item.error.retryable));
  assert.equal(calls.filter(call => call[0] === 'load').length, 0);
  assert.equal(api.delete({ action: 'delete', path: paths[0] }).error.code, 'PATH_OUTSIDE_ROOT');
});

test('invalid batches and multibyte request size are rejected before file operations', () => {
  const { api, calls } = cabinet();
  assert.equal(api.post({ action: 'pull', files: [] }).error.code, 'INVALID_BATCH');
  assert.equal(api.post({ action: 'pull', files: Array.from({ length: 21 }, () => ({ path: 'SuiteScripts/x' })) }).error.code, 'INVALID_BATCH');
  assert.equal(api.post({ action: 'push', files: [{ path: 'SuiteScripts/a.txt', encoding: 'utf8',
    content: '😀'.repeat(1024 * 1024) }] }).error.code, 'REQUEST_TOO_LARGE');
  assert.equal(calls.filter(call => call[0] === 'load').length, 0);
});

test('listing pages direct folders then more than 4,000 files without leaking staging', () => {
  const { api, folders, addFile } = cabinet();
  folders.set(4, { id: 4, name: '.supersuite-staging', parent: 1 });
  folders.set(5, { id: 5, name: 'Nested', parent: 2 });
  for (let i = 0; i < 4051; i += 1) addFile('file-' + i + '.js', '', 'JAVASCRIPT', 1);
  const entries = [];
  let cursor;
  do {
    const response = api.get({ action: 'list', path: 'SuiteScripts', pageSize: 200, cursor });
    assert.equal(response.ok, true);
    assert.ok(response.entries.length <= 200);
    entries.push(...response.entries);
    cursor = response.nextCursor;
  } while (cursor);
  assert.equal(entries.length, 4053);
  assert.equal(new Set(entries.map(entry => entry.path)).size, entries.length);
  assert.ok(entries.every(entry => !entry.path.includes('staging') && !entry.path.includes('Nested')));
  assert.equal(entries[0].type, 'folder');
  assert.equal(api.get({ action: 'list', path: 'SuiteScripts', cursor: 'x:3' }).error.code, 'INVALID_CURSOR');
});

test('ID cursor keeps the next page intact when a prior file is removed', () => {
  const { api, files, addFile } = cabinet();
  const ids = Array.from({ length: 5 }, (_, i) => addFile(i + '.js'));
  const first = api.get({ action: 'list', path: 'SuiteScripts/Project', cursor: 'f:0', pageSize: 2 });
  files.delete(ids[0]);
  const second = api.get({ action: 'list', path: 'SuiteScripts/Project', cursor: first.nextCursor, pageSize: 2 });
  assert.deepEqual(second.entries.map(entry => Number(entry.id)), ids.slice(2, 4));
});

test('pull returns text, binary and empty content alongside a per-file failure', () => {
  const { api, addFile } = cabinet();
  addFile('text.js', 'const greeting = "你好";');
  addFile('image.png', 'AAEC/w==', 'PNGIMAGE');
  addFile('empty.js');
  const response = api.post({ action: 'pull', files: ['text.js', 'missing.js', 'image.png', 'empty.js']
    .map(name => ({ path: 'SuiteScripts/Project/' + name })) });
  assert.deepEqual(response.results.map(item => item.ok), [true, false, true, true]);
  assert.equal(response.results[2].encoding, 'base64');
  assert.equal(response.results[2].content, 'AAEC/w==');
  assert.equal(response.results[3].content, '');
});

test('pull response budget defers files to a new request and rejects oversized files before read', () => {
  const { api, addFile, calls } = cabinet();
  addFile('a.js', 'a'.repeat(2 * 1024 * 1024));
  addFile('b.js', 'b'.repeat(2 * 1024 * 1024));
  const largeId = addFile('large.js', '', 'JAVASCRIPT', 2, { size: 4 * 1024 * 1024 });
  const response = api.post({ action: 'pull', files: ['a.js', 'b.js', 'large.js'].map(name => ({ path: 'SuiteScripts/Project/' + name })) });
  assert.equal(response.results[0].ok, true);
  assert.equal(response.results[1].error.code, 'BATCH_BYTES_EXCEEDED');
  assert.equal(response.results[1].error.retryable, true);
  assert.equal(response.results[2].error.code, 'FILE_TOO_LARGE');
  assert.ok(Buffer.byteLength(JSON.stringify(response)) < 4 * 1024 * 1024);
  assert.ok(!calls.some(call => call[0] === 'contents' && call[1] === largeId));
  assert.equal(api.post({ action: 'pull', files: [{ path: 'SuiteScripts/Project/b.js' }] }).results[0].ok, true);
});

test('push uses documented overwrite, preserves destination attributes and cleans only its own scratch', () => {
  const { api, addFile, files, folders, calls } = cabinet({ root: 'SuiteScripts/Project' });
  const id = addFile('script.js', 'old', 'JAVASCRIPT', 2, { isOnline: true, description: 'Retain me' });
  const request = { action: 'push', files: [{ path: 'SuiteScripts/Project/script.js', content: 'new', encoding: 'utf8' }] };
  for (let i = 0; i < 2; i += 1) assert.equal(api.post(request).results[0].id, String(id));
  assert.equal(files.size, 1);
  assert.equal(files.get(id).content, 'new');
  assert.equal(files.get(id).isOnline, true);
  assert.equal(files.get(id).description, 'Retain me');
  assert.equal([...folders.values()].filter(folder => folder.name.startsWith('request-')).length, 0);
  assert.ok(calls.filter(call => call[0] === 'deleteFile').every(call => call[1] !== id));
  assert.ok(calls.filter(call => call[0] === 'deleteFolder').every(call => call[1] > 3));
});

test('push creates descendants, handles sizeable base64 and reports encoding/type errors per item', () => {
  const { api, files, filePath } = cabinet();
  const content = Buffer.alloc(1024 * 1024, 127).toString('base64');
  const response = api.post({ action: 'push', files: [
    { path: 'SuiteScripts/Project/new/image.png', content, encoding: 'base64' },
    { path: 'SuiteScripts/Project/bad.png', content: 'not base64', encoding: 'base64' },
    { path: 'SuiteScripts/Project/bad.js', content: 'aGk=', encoding: 'base64' },
    { path: 'SuiteScripts/Project/empty.js', content: '', encoding: 'utf8' }
  ] });
  assert.deepEqual(response.results.map(item => item.ok), [true, false, false, true]);
  assert.equal(response.results[1].error.code, 'INVALID_BASE64');
  assert.equal(response.results[2].error.code, 'ENCODING_MISMATCH');
  const image = [...files.values()].find(item => filePath(item) === 'SuiteScripts/Project/new/image.png');
  assert.equal(image.content, content);
  assert.equal(image.isOnline, false);
});

test('failed copy keeps the original intact and cleans temporary files', () => {
  const { api, files, addFile, folders } = cabinet({ copyFailure: 'INSUFFICIENT_PERMISSION' });
  const id = addFile('script.js', 'original');
  const response = api.post({ action: 'push', files: [{ path: 'SuiteScripts/Project/script.js', content: 'replacement', encoding: 'utf8' }] });
  assert.equal(response.results[0].error.code, 'INSUFFICIENT_PERMISSION');
  assert.equal(files.size, 1);
  assert.equal(files.get(id).content, 'original');
  assert.equal([...folders.values()].filter(folder => folder.name.startsWith('request-')).length, 0);
});

test('cleanup failure keeps committed success and defers remaining writes', () => {
  const { api } = cabinet({ cleanupFailure: true });
  const response = api.post({ action: 'push', files: ['a.js', 'b.js'].map(name =>
    ({ path: 'SuiteScripts/Project/' + name, content: name, encoding: 'utf8' })) });
  assert.equal(response.results[0].ok, true);
  assert.equal(response.results[1].error.code, 'STAGING_CLEANUP_FAILED');
  assert.equal(response.results[1].error.retryable, true);
});

test('governance reserve preserves completed results and marks remaining files retryable', () => {
  const { api, addFile } = cabinet({ usage: calls => calls.some(call => call[0] === 'contents') ? 200 : 5000 });
  addFile('a.js', 'a');
  addFile('b.js', 'b');
  const response = api.post({ action: 'pull', files: ['a.js', 'b.js'].map(name => ({ path: 'SuiteScripts/Project/' + name })) });
  assert.equal(response.results[0].ok, true);
  assert.equal(response.results[1].error.code, 'GOVERNANCE_LIMIT');
  assert.equal(response.results[1].error.retryable, true);
});

test('metadata discovers labels without reading values or saving records', () => {
  const { api, calls } = cabinet();
  const created = api.get({ action: 'metadata', recordType: 'customer' });
  assert.equal(created.source, 'new-record');
  assert.equal(created.scope, 'body');
  assert.deepEqual(created.fields[1], { id: 'custbody_project', label: 'Project', type: 'text', isMandatory: false });
  const loaded = api.post({ action: 'metadata', recordType: 'salesorder', recordId: '12' });
  assert.equal(loaded.source, 'record');
  assert.ok(calls.some(call => call[0] === 'loadRecord' && call[1].id === 12));
  assert.equal(api.get({ action: 'metadata', recordType: '../customer' }).error.code, 'INVALID_RECORD_TYPE');
  assert.equal(api.get({ action: 'metadata', recordType: 'customer', recordId: '-1' }).error.code, 'INVALID_RECORD_ID');
  const denied = cabinet({ metadataFailure: 'INSUFFICIENT_PERMISSION' }).api;
  assert.equal(denied.get({ action: 'metadata', recordType: 'employee' }).error.code, 'INSUFFICIENT_PERMISSION');
});

test('delete handles exactly one validated file and repeat deletion is safe', () => {
  const { api, addFile, files } = cabinet();
  addFile('a.js');
  addFile('b.js');
  assert.equal(api.delete({ action: 'delete', path: 'SuiteScripts/Project/a.js' }).deleted, true);
  assert.equal(api.delete({ action: 'delete', path: 'SuiteScripts/Project/a.js' }).deleted, false);
  assert.equal(files.size, 1);
  assert.equal(api.delete({ action: 'delete', path: 'SuiteScripts' }).error.code, 'INVALID_PATH');
});
