'use strict';

const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomicWrite, assertSafeLocalPath } = require('./localFiles');
const { abortError } = require('./netSuiteRestClient');

const RECORD_TYPES = Object.freeze([
    { id: 'customer', label: 'Customers', picked: true },
    { id: 'salesorder', label: 'Sales orders', picked: true },
    { id: 'invoice', label: 'Invoices', picked: true },
    { id: 'vendor', label: 'Vendors' },
    { id: 'contact', label: 'Contacts' },
    { id: 'purchaseorder', label: 'Purchase orders' },
    { id: 'vendorbill', label: 'Vendor bills' },
    { id: 'creditmemo', label: 'Credit memos' },
    { id: 'cashsale', label: 'Cash sales' },
    { id: 'customerpayment', label: 'Customer payments' }
]);
const ALLOWED = new Set(RECORD_TYPES.map(type => type.id));
const DIRECTORY = '.supersuite-data';
const MAX_RECORD_BYTES = 3 * 1024 * 1024;
const validId = value => typeof value === 'string' && /^[1-9]\d{0,14}$/.test(value);
const validCursor = value => value === '0' || validId(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);

function assertCleanDocument(filename) {
    if ((vscode.workspace.textDocuments || []).some(document => document.isDirty && document.uri.scheme !== 'untitled' &&
        typeof document.uri.fsPath === 'string' && path.relative(filename, document.uri.fsPath) === '')) {
        throw Object.assign(new Error(`Save your ${path.basename(filename)} edits before exporting business records.`), { code: 'DIRTY_EDITOR' });
    }
}

async function writeProtected(root, filename, data, check = () => {}) {
    check();
    assertCleanDocument(filename);
    await atomicWrite(root, filename, data, () => { check(); assertCleanDocument(filename); });
}

async function selectRecordTypes() {
    const selected = await vscode.window.showQuickPick(RECORD_TYPES.map(type => ({ ...type, description: type.id })), {
        title: 'SuperSuite: Select business records to export', canPickMany: true,
        placeHolder: 'Read-only JSON snapshots, including body fields and sublists, visible to your integration role'
    });
    return selected?.map(type => type.id);
}

/** Append a specific ignore entry before writing any business data. */
async function protectExportDirectory(root, check = () => {}) {
    const filename = path.join(root, '.gitignore');
    check();
    assertCleanDocument(filename);
    await assertSafeLocalPath(root, filename);
    let existing = '';
    try {
        const info = await fs.stat(filename);
        if (!info.isFile() || info.size > 1024 * 1024) throw new Error('The workspace .gitignore must be a regular file smaller than 1 MiB.');
        existing = await fs.readFile(filename, 'utf8');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    // Put the rule last so a later negation in a pre-existing file cannot undo it.
    if (existing.trimEnd().split(/\r?\n/).at(-1) === `${DIRECTORY}/`) return;
    await writeProtected(root, filename, `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}\n# SuperSuite local business record snapshots\n${DIRECTORY}/\n`, check);
}

function validatePage(response, type, cursor, pageSize) {
    if (!object(response) || response.ok !== true || response.recordType !== type ||
        !Array.isArray(response.records) || response.records.length > pageSize ||
        !(response.nextCursor === null || validId(response.nextCursor))) throw new Error('Invalid business record export response.');
    let previous = Number(cursor);
    for (const record of response.records) {
        if (!object(record) || !validId(record.id) || Number(record.id) <= previous ||
            record.recordType !== type || typeof record.ok !== 'boolean' ||
            (record.ok && (!object(record.fields) || !object(record.sublists) || typeof record.complete !== 'boolean')) ||
            (!record.ok && (!object(record.error) || typeof record.error.code !== 'string')) ||
            Buffer.byteLength(JSON.stringify(record)) > MAX_RECORD_BYTES) throw new Error('Invalid business record export response.');
        previous = Number(record.id);
    }
    if (response.nextCursor !== null && (!response.records.length || response.nextCursor !== response.records.at(-1).id)) {
        throw new Error('Business record export pagination did not advance.');
    }
    return response.records;
}

function scopeFor(config, identity) {
    if (!object(identity) || typeof identity.accountId !== 'string' || !/^[a-z\d_-]{1,64}$/i.test(identity.accountId) ||
        !/^-?\d{1,15}$/.test(identity.userId) || !/^\d{1,15}$/.test(identity.roleId)) {
        throw new Error('Deploy the current SuperSuite RESTlet: export requires its account/user/role identity response.');
    }
    return crypto.createHash('sha256').update(JSON.stringify([config.restlet, config.realm || '', config.authType || 'tba',
        identity.accountId, String(identity.userId), String(identity.roleId)])).digest('hex');
}

function validManifest(manifest, scope, recordTypes) {
    if (!object(manifest) || manifest.schemaVersion !== 1 || manifest.scope !== scope ||
        !Array.isArray(manifest.recordTypes) || manifest.recordTypes.join(',') !== recordTypes.join(',') || !object(manifest.types) ||
        Object.keys(manifest.types).length !== recordTypes.length) return false;
    return recordTypes.every(type => {
        const state = manifest.types[type];
        return object(state) && validCursor(state.cursor) && typeof state.done === 'boolean' &&
            ['succeeded', 'failed', 'incomplete'].every(key => Number.isSafeInteger(state[key]) && state[key] >= 0);
    });
}

class RecordExporter {
    constructor(context, configuration, output) {
        this.context = context;
        this.configuration = configuration;
        this.output = output;
        this.controllers = new Set();
        this.active = new Set();
        this.disposed = false;
    }

    dispose() {
        this.disposed = true;
        for (const controller of this.controllers) controller.abort();
        this.controllers.clear();
    }

    async exportRecords(folder, recordTypes, { resume = true } = {}) {
        if (this.disposed) throw new Error('SuperSuite is shutting down.');
        if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before exporting NetSuite business records.');
        if (!folder || folder.uri.scheme !== 'file') throw new Error('Open a filesystem workspace to export business records.');
        if (!Array.isArray(recordTypes) || !recordTypes.length || recordTypes.some(type => !ALLOWED.has(type))) {
            throw new Error('Select one or more supported business record types.');
        }
        recordTypes = [...new Set(recordTypes)].sort();
        const root = folder.uri.fsPath;
        if (this.active.has(root)) throw new Error('A business record export is already running in this workspace.');
        this.active.add(root);
        const controller = new AbortController();
        this.controllers.add(controller);
        const check = () => { if (controller.signal.aborted || this.disposed) throw abortError(); };
        try {
            await assertSafeLocalPath(root, path.join(root, DIRECTORY));
            check();
            const connection = await this.configuration.connection(folder);
            check();
            const version = await connection.client.request('version', {}, { signal: controller.signal });
            check();
            if (version.protocolVersion !== 2 || version.capabilities?.recordExport !== true) {
                throw new Error('Deploy the SuperSuite 2.1 or newer RESTlet to export business records.');
            }
            const scope = scopeFor(connection.config, version.identity);
            await protectExportDirectory(root, check);
            check();
            const run = await this.openRun(root, scope, recordTypes, resume, check);
            check();
            return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
                title: 'SuperSuite: Export business records', cancellable: true }, async (progress, token) => {
                const cancellation = token.onCancellationRequested(() => controller.abort());
                if (token.isCancellationRequested) controller.abort();
                try { return await this.run(root, run, connection.client, progress, controller.signal); }
                finally { cancellation.dispose(); }
            });
        } finally {
            this.controllers.delete(controller);
            this.active.delete(root);
        }
    }

    async openRun(root, scope, recordTypes, resume, check) {
        const base = path.join(root, DIRECTORY);
        await assertSafeLocalPath(root, base);
        check();
        // New POSIX export roots are private; Windows inherits workspace ACLs.
        // An existing directory's permissions are never silently changed.
        await fs.mkdir(base, { recursive: true, mode: 0o700 });
        if (resume) {
            const candidates = (await fs.readdir(base, { withFileTypes: true }))
                .filter(entry => entry.isDirectory() && /^\d{13}-[a-f0-9-]{36}$/.test(entry.name)).map(entry => entry.name).sort().reverse();
            for (const name of candidates) {
                const directory = path.join(base, name);
                const filename = path.join(directory, 'manifest.json');
                await assertSafeLocalPath(root, filename);
                check();
                assertCleanDocument(filename);
                try {
                    if ((await fs.stat(filename)).size > 128 * 1024) continue;
                    const manifest = JSON.parse(await fs.readFile(filename, 'utf8'));
                    if (validManifest(manifest, scope, recordTypes) && manifest.status !== 'complete') return { directory, manifest, resumed: true };
                } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
            }
        }
        const directory = path.join(base, `${Date.now()}-${crypto.randomUUID()}`);
        const manifest = { schemaVersion: 1, scope, recordTypes, startedAt: new Date().toISOString(),
            status: 'running', consistency: 'Live role-visible export; not a transactionally consistent account backup.',
            types: Object.fromEntries(recordTypes.map(type => [type, { cursor: '0', done: false, succeeded: 0, failed: 0, incomplete: 0 }])) };
        await writeProtected(root, path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, check);
        return { directory, manifest };
    }

    /**
     * A record's JSON is its sole atomic commit. Retry markers and manifest
     * counters are indexes rebuilt after interruption, one snapshot at a time.
     * Thus a kill between any two local writes never loses a committed outcome.
     */
    async reconcileType(root, directory, type, state, check) {
        const typeDirectory = path.join(directory, type);
        await assertSafeLocalPath(root, typeDirectory);
        check();
        let entries;
        try { entries = await fs.opendir(typeDirectory); } catch (error) {
            if (error.code === 'ENOENT' && state.succeeded + state.failed === 0) return;
            throw error;
        }
        const counts = { succeeded: 0, failed: 0, incomplete: 0 };
        let cursor = '0';
        for await (const entry of entries) {
            check();
            if (!/^[1-9]\d{0,14}\.json$/.test(entry.name)) continue;
            const filename = path.join(typeDirectory, entry.name);
            await assertSafeLocalPath(root, filename);
            assertCleanDocument(filename);
            // Wire-sized JSON is stored compactly; bounded stat precedes parsing.
            if (!entry.isFile() || (await fs.stat(filename)).size > MAX_RECORD_BYTES + 1) throw new Error('Invalid local record export snapshot.');
            const result = JSON.parse(await fs.readFile(filename, 'utf8'));
            validatePage({ ok: true, recordType: type, records: [result], nextCursor: null }, type, '0', 1);
            if (entry.name !== `${result.id}.json`) throw new Error('Invalid local record export snapshot.');
            const marker = path.join(typeDirectory, `${result.id}.error.json`);
            await assertSafeLocalPath(root, marker);
            check();
            assertCleanDocument(marker);
            if (!result.ok || !result.complete) {
                const kind = result.ok ? 'incomplete' : 'failed';
                await writeProtected(root, marker, JSON.stringify({ id: result.id, kind,
                    ...(!result.ok ? { code: String(result.error.code).slice(0, 128) } : {}) }), check);
            } else await fs.rm(marker, { force: true });
            if (result.ok) { counts.succeeded += 1; if (!result.complete) counts.incomplete += 1; }
            else counts.failed += 1;
            if (Number(result.id) > Number(cursor)) cursor = result.id;
        }
        if (counts.succeeded + counts.failed < state.succeeded + state.failed || Number(cursor) < Number(state.cursor)) {
            throw new Error('Committed record snapshots are missing. Restore them or start a fresh export.');
        }
        // If the record commit won a race with the manifest checkpoint, recover
        // that ID and query once more before marking the enumeration finished.
        if (Number(cursor) > Number(state.cursor)) state.done = false;
        Object.assign(state, counts, { cursor });
    }

    async run(root, run, client, progress, signal) {
        const { directory, manifest } = run;
        let cancelled = false;
        let blockedTypes = 0;
        const check = () => { if (signal.aborted || this.disposed) throw abortError(); };
        const save = () => writeProtected(root, path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
        const totals = () => Object.values(manifest.types).reduce((sum, state) => ({
            succeeded: sum.succeeded + state.succeeded, failed: sum.failed + state.failed,
            incomplete: sum.incomplete + state.incomplete
        }), { succeeded: 0, failed: 0, incomplete: 0 });
        const writeRecord = async (type, result, prior) => {
            check();
            const state = manifest.types[type];
            const filename = path.join(directory, type, `${result.id}.json`);
            const marker = path.join(directory, type, `${result.id}.error.json`);
            // Commit one complete outcome before updating either derived index.
            // Failure text is deliberately excluded: it can contain record values.
            const outcome = result.ok ? result : { ok: false, id: result.id, recordType: type,
                error: { code: String(result.error.code).slice(0, 128) } };
            await writeProtected(root, filename, `${JSON.stringify(outcome)}\n`, check);
            if (!result.ok || !result.complete) await writeProtected(root, marker,
                JSON.stringify({ id: result.id, kind: result.ok ? 'incomplete' : 'failed',
                    ...(!result.ok ? { code: outcome.error.code } : {}) }), check);
            else {
                await assertSafeLocalPath(root, marker);
                assertCleanDocument(marker);
                await fs.rm(marker, { force: true });
            }
            if (prior === 'failed') state.failed -= 1;
            if (prior === 'incomplete') { state.incomplete -= 1; state.succeeded -= 1; }
            if (result.ok) { state.succeeded += 1; if (!result.complete) state.incomplete += 1; }
            else state.failed += 1;
            // Keep only counters and cursors after writing a bounded response page.
            delete result.fields;
            delete result.sublists;
            delete result.subrecords;
            delete result.issues;
        };
        manifest.status = 'running';
        delete manifest.finishedAt;
        await save();
        for (const type of manifest.recordTypes) {
            const state = manifest.types[type];
            try {
                check();
                if (run.resumed) {
                    await this.reconcileType(root, directory, type, state, check);
                    await save();
                }
                // Failures are retried one at a time. Successful records are never
                // revisited during a normal resume; a deleted failed ID stays explicit.
                if (state.failed || state.incomplete) {
                    const typeDirectory = path.join(directory, type);
                    await assertSafeLocalPath(root, typeDirectory);
                    const entries = await fs.opendir(typeDirectory);
                    for await (const entry of entries) {
                        if (!entry.isFile() || !/^[1-9]\d{0,14}\.error\.json$/.test(entry.name)) continue;
                        check();
                        const marker = path.join(typeDirectory, entry.name);
                        await assertSafeLocalPath(root, marker);
                        if ((await fs.stat(marker)).size > 1024) throw new Error('Invalid record export checkpoint.');
                        const previous = JSON.parse(await fs.readFile(marker, 'utf8'));
                        if (!validId(previous.id) || entry.name !== `${previous.id}.error.json` || !['failed', 'incomplete'].includes(previous.kind)) {
                            throw new Error('Invalid record export checkpoint.');
                        }
                        const cursor = String(Number(previous.id) - 1);
                        const page = await client.request('records', { recordType: type, cursor, pageSize: 1 }, { signal });
                        const records = validatePage(page, type, cursor, 1);
                        if (records[0]?.id === previous.id) await writeRecord(type, records[0], previous.kind);
                        await save();
                    }
                }
                while (!state.done) {
                    check();
                    progress.report({ message: `${type}: ${totals().succeeded} records saved` });
                    const page = await client.request('records', { recordType: type, cursor: state.cursor, pageSize: 5 }, { signal });
                    const records = validatePage(page, type, state.cursor, 5);
                    for (const result of records) {
                        await writeRecord(type, result);
                        state.cursor = result.id;
                        await save();
                    }
                    state.done = page.nextCursor === null;
                    await save();
                }
                delete state.errorCode;
            } catch (error) {
                if (signal.aborted || error.name === 'AbortError' || error.code === 'ABORT_ERR') { cancelled = true; break; }
                state.errorCode = /^[A-Z0-9_]{1,128}$/.test(error.code || '') ? error.code : 'EXPORT_INTERRUPTED';
                blockedTypes += 1;
                const guidance = state.errorCode === 'DIRTY_EDITOR' ? 'Save your export editors, then run export again to resume.' :
                    'Check role View permissions, connection, and export limits; run export again to resume.';
                this.output.appendLine(`Business record export ${type}: ${state.errorCode}. ${guidance}`);
                await save();
            }
        }
        const summary = totals();
        manifest.status = cancelled ? 'cancelled' : blockedTypes || summary.failed || summary.incomplete ? 'partial' : 'complete';
        manifest.finishedAt = new Date().toISOString();
        await save();
        this.output.appendLine(`Business record export: ${summary.succeeded} saved, ${summary.failed} failed, ${summary.incomplete} incomplete, ${blockedTypes} interrupted types${cancelled ? ', cancelled' : ''}.`);
        return { ...summary, failed: summary.failed + blockedTypes, blockedTypes, cancelled,
            complete: manifest.status === 'complete', exportDirectory: directory, manifestPath: path.join(directory, 'manifest.json') };
    }
}

module.exports = { RecordExporter, RECORD_TYPES, selectRecordTypes, protectExportDirectory, validatePage };
