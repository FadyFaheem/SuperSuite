'use strict';
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const picomatch = require('picomatch');
const { toRemotePath, toLocalPath } = require('../helpers/paths');
const { runBatches, validBatchResults } = require('../helpers/transfer');
const { abortError } = require('../helpers/netSuiteRestClient');
const { assertSafeLocalPath, walkFiles, atomicWrite, isProtected } = require('../helpers/localFiles');
// Keep aligned with the text types in the bundled RESTlet. File.isText on the
// server is the final check; a mismatch is reported rather than saving corrupt data.
const TEXT_EXTENSIONS = new Set(['.js', '.json', '.xml', '.html', '.htm', '.css', '.csv', '.txt', '.md', '.ts', '.svg', '.sql', '.log', '.yml', '.yaml', '.scss', '.map', '.jsx', '.tsx', '.mjs', '.cjs', '.xsd', '.ftl', '.config', '.appcache', '.ssp', '.ss', '.eml']);

class NetSuiteCommands {
    constructor(context, configuration, output) {
        Object.assign(this, { context, configuration, output });
        this.active = new Set();
        this.controllers = new Set();
        this.previews = new Map();
        this.disposed = false;
        context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('supersuite-preview', { provideTextDocumentContent: uri => this.previews.get(uri.toString()) || '' }));
    }
    dispose() { this.disposed = true; for (const controller of this.controllers) controller.abort(); this.previews.clear(); }
    selected(uri, folderAction) {
        const explicit = Boolean(uri?.fsPath);
        uri = explicit ? uri : vscode.window.activeTextEditor?.document.uri;
        if (!uri) throw new Error('Select a file or folder in Explorer, or open a file in an editor.');
        if (uri.scheme !== 'file') throw new Error('Select a filesystem file or folder.');
        return folderAction && !explicit ? vscode.Uri.file(path.dirname(uri.fsPath)) : uri;
    }
    requireProtocol(version) {
        if (version.protocolVersion !== 2) throw new Error('Deploy the bundled SuperSuite 2.0 RESTlet before transferring files. The old RESTlet does not support safe batches.');
    }
    async execute(action, uri) {
        if (action === 'retryFailed') {
            if (!this.lastFailed) return vscode.window.showInformationMessage('No failed SuperSuite files to retry.');
            return this.transfer(this.lastFailed.action, this.lastFailed.uri, this.lastFailed.paths, this.lastFailed.connection);
        }
        if (['uploadFile', 'uploadFolder', 'downloadFile', 'downloadFolder'].includes(action)) return this.transfer(action, this.selected(uri, action.endsWith('Folder')));
        const target = action === 'getRestletVersion' ? uri : this.selected(uri);
        const folder = await this.configuration.folder(target);
        if (!folder) return;
        const { client, config } = await this.configuration.connection(folder);
        const version = await client.request('version');
        this.requireProtocol(version);
        if (action === 'getRestletVersion') return vscode.window.showInformationMessage(`SuperSuite connected. RESTlet ${version.restletVersion}, protocol ${version.protocolVersion}.`);
        await assertSafeLocalPath(folder.uri.fsPath, target.fsPath);
        const remotePath = toRemotePath(folder.uri.fsPath, target.fsPath, config.rootDirectory);
        if (isProtected(path.relative(folder.uri.fsPath, target.fsPath).split(path.sep).join('/'))) throw new Error('Hidden files, dependency folders and private keys cannot be transferred.');
        if (action === 'deleteFile') {
            const confirmation = await vscode.window.showWarningMessage(`Delete ${remotePath} from NetSuite?`, { modal: true, detail: 'This deletes only the remote file. There is no extension undo.' }, 'Delete Remote File');
            if (confirmation !== 'Delete Remote File') return;
            const key = folder.uri.toString();
            if (this.active.has(key)) throw new Error('Wait for the active transfer in this workspace to finish.');
            this.active.add(key);
            try {
                await client.request('delete', { path: remotePath });
                return vscode.window.showInformationMessage(`Deleted ${remotePath} from NetSuite.`);
            } finally { this.active.delete(key); }
        }
        if (action === 'previewFile') {
            const result = await client.request('pull', { files: [{ path: remotePath }] });
            const file = result.results?.find(item => item.path === remotePath);
            if (!file?.ok) throw new Error(file?.error?.message || 'RESTlet did not return the requested file.');
            if (file.encoding === 'base64') throw new Error('Binary files cannot be shown in a text comparison.');
            const preview = vscode.Uri.parse(`supersuite-preview:/${encodeURIComponent(remotePath)}?${Date.now()}`);
            this.previews.set(preview.toString(), file.content);
            if (this.previews.size > 20) this.previews.delete(this.previews.keys().next().value);
            return vscode.commands.executeCommand('vscode.diff', target, preview, `${path.basename(target.fsPath)}: Local ↔ NetSuite`);
        }
    }
    async transfer(action, uri, retryPaths, retryConnection) {
        const stopped = { succeeded: 0, failed: 0, cancelled: true };
        if (this.disposed) return stopped;
        const folder = await this.configuration.folder(uri);
        if (!folder || this.disposed) return stopped;
        const key = folder.uri.toString();
        if (this.active.has(key)) throw new Error('A SuperSuite transfer is already running in this workspace.');
        this.active.add(key);
        const results = [];
        let cancelled = false;
        let connection;
        try {
            const { config, client } = await this.configuration.connection(folder);
            if (this.disposed) return stopped;
            connection = JSON.stringify([config.restlet, config.realm, config.rootDirectory]);
            if (retryConnection && retryConnection !== connection) throw new Error('Connection changed since the failed transfer. Start a new transfer for this account.');
            const push = action.startsWith('upload');
            const directory = action.endsWith('Folder');
            await assertSafeLocalPath(folder.uri.fsPath, uri.fsPath);
            const relative = path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/');
            if (isProtected(relative)) throw new Error('Hidden files, dependency folders and private keys cannot be transferred.');
            const matches = picomatch(config.exclude, { dot: true });
            const excluded = (relative, directory) => isProtected(relative) || matches(relative) || (directory && matches(`${relative}/`));
            const decision = await vscode.window.showWarningMessage(`${push ? 'Push to NetSuite' : 'Pull from NetSuite'}: ${retryPaths ? `${retryPaths.length} failed files` : relative || config.rootDirectory}?`, {
                modal: true, detail: push ? `Existing remote files under ${config.rootDirectory} will be replaced. Unsaved local files are skipped.` : 'Existing local files will be replaced. Unsaved editors are skipped. No files are deleted.'
            }, push ? 'Push Files' : 'Pull Files');
            if (decision !== (push ? 'Push Files' : 'Pull Files') || this.disposed) return stopped;
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `SuperSuite: ${push ? 'Pushing' : 'Pulling'} files`, cancellable: true }, async (progress, token) => {
                const controller = new AbortController();
                this.controllers.add(controller);
                const cancel = token.onCancellationRequested(() => controller.abort());
                if (this.disposed || token.isCancellationRequested) controller.abort();
                const signal = controller.signal;
                try {
                    if (signal.aborted) { cancelled = true; return; }
                    const version = await client.request('version', {}, { signal });
                    if (signal.aborted) throw abortError();
                    this.requireProtocol(version);
                    const maxFileBytes = Math.min(version.limits?.maxFileBytes || 3145728, 3145728);
                    const options = { ...config, maxItemRetries: config.maxRetries, batchSize: Math.min(config.batchSize, version.limits?.maxBatchFiles || 20), maxBatchBytes: Math.min(config.maxBatchBytes, version.limits?.maxBatchBytes || 4194304), signal, action: push ? 'push' : 'pull' };
                    const process = async filenames => {
                        if (signal.aborted) return;
                        const items = [];
                        for (const filename of filenames) {
                            const remotePath = toRemotePath(folder.uri.fsPath, filename, config.rootDirectory);
                            try {
                                await assertSafeLocalPath(folder.uri.fsPath, filename);
                                if (this.isDirty(filename)) throw new Error('Unsaved editor: save or revert this file before retrying.');
                                if (push) {
                                    const stat = await fs.stat(filename);
                                    if (!stat.isFile() || stat.size > maxFileBytes) throw new Error(`File must be regular and at most ${maxFileBytes} bytes. Use SuiteCloud/SDF for larger files.`);
                                    const content = await fs.readFile(filename);
                                    const encoding = TEXT_EXTENSIONS.has(path.extname(filename).toLowerCase()) ? 'utf8' : 'base64';
                                    const text = encoding === 'utf8' ? new TextDecoder('utf-8', { fatal: true }).decode(content) : content.toString('base64');
                                    items.push({ path: remotePath, content: text, encoding });
                                } else items.push({ path: remotePath });
                            } catch (error) { results.push({ ok: false, path: remotePath, error: { code: 'LOCAL_FILE', message: error.message } }); }
                        }
                        const summary = await runBatches(items, async batch => {
                            progress.report({ message: `${results.filter(item => item.ok).length} complete · ${batch.length} in this batch` });
                            const response = await client.request(push ? 'push' : 'pull', { files: batch }, { signal });
                            if (!validBatchResults(batch, response.results)) throw new Error('Invalid, duplicate, or unexpected RESTlet batch results. No files in this response were saved.');
                            if (!push) {
                                const requested = new Set(batch.map(item => item.path));
                                for (const item of response.results) {
                                    if (signal.aborted) {
                                        item.ok = false;
                                        item.error = { code: 'ABORT_ERR', message: 'Transfer cancelled; file was not saved.', retryable: false };
                                        continue;
                                    }
                                    if (!item.ok || !requested.has(item.path)) continue;
                                    try {
                                        const filename = toLocalPath(folder.uri.fsPath, item.path, config.rootDirectory);
                                        if (this.isDirty(filename)) throw new Error('Editor changed during pull; file was not overwritten.');
                                        if (!['utf8', 'base64'].includes(item.encoding) || typeof item.content !== 'string') throw new Error('Invalid file content or encoding in RESTlet response.');
                                        const data = Buffer.from(item.content, item.encoding);
                                        if (item.encoding === 'base64' && data.toString('base64') !== item.content) throw new Error('RESTlet returned invalid base64 file content.');
                                        if (data.length > maxFileBytes) throw new Error('RESTlet returned a file exceeding the advertised size limit.');
                                        await atomicWrite(folder.uri.fsPath, filename, data, () => {
                                            if (signal.aborted) throw abortError();
                                            if (this.isDirty(filename)) throw new Error('Editor changed during pull; file was not overwritten.');
                                        });
                                    } catch (error) { item.ok = false; item.error = { code: error.code === 'ABORT_ERR' ? 'ABORT_ERR' : 'LOCAL_WRITE', message: error.message, retryable: false }; }
                                }
                            }
                            // Keep only outcomes after the batch is written. Retaining
                            // content here would accumulate the whole folder in memory.
                            for (const item of response.results) delete item.content;
                            return response;
                        }, options);
                        results.push(...summary.results);
                        cancelled ||= summary.cancelled;
                    };
                    if (retryPaths) {
                        for (let offset = 0; offset < retryPaths.length && !signal.aborted; offset += options.batchSize) await process(retryPaths.slice(offset, offset + options.batchSize).map(remotePath => toLocalPath(folder.uri.fsPath, remotePath, config.rootDirectory)));
                    } else if (!directory) await process([uri.fsPath]);
                    else if (push) {
                        let files = [];
                        for await (const filename of walkFiles(folder.uri.fsPath, uri.fsPath, excluded, signal)) {
                            files.push(filename);
                            if (files.length === options.batchSize) { await process(files); files = []; }
                        }
                        if (files.length) await process(files);
                    } else {
                        const queue = [toRemotePath(folder.uri.fsPath, uri.fsPath, config.rootDirectory)];
                        const visited = new Set();
                        while (queue.length && !signal.aborted) {
                            const remoteDirectory = queue.shift();
                            if (visited.has(remoteDirectory)) throw new Error('RESTlet returned a directory cycle.');
                            visited.add(remoteDirectory);
                            const cursors = new Set();
                            const listedEntries = new Set();
                            let cursor;
                            try { do {
                                const page = await client.request('list', { path: remoteDirectory, ...(cursor ? { cursor } : {}), pageSize: 100 }, { signal });
                                if (!Array.isArray(page.entries)) throw new Error('Invalid RESTlet directory listing.');
                                // Validate the whole page before creating folders or saving files.
                                for (const entry of page.entries) {
                                    if (!entry || typeof entry.path !== 'string' || !['file', 'folder'].includes(entry.type) || path.posix.dirname(entry.path) !== remoteDirectory || listedEntries.has(entry.path)) {
                                        throw new Error('RESTlet returned an invalid, duplicate, or out-of-folder directory entry.');
                                    }
                                    toLocalPath(folder.uri.fsPath, entry.path, config.rootDirectory);
                                    listedEntries.add(entry.path);
                                }
                                const files = [];
                                for (const entry of page.entries) {
                                    if (signal.aborted) break;
                                    if (path.posix.dirname(entry.path) !== remoteDirectory) throw new Error('RESTlet returned an entry outside the requested folder.');
                                    const filename = toLocalPath(folder.uri.fsPath, entry.path, config.rootDirectory);
                                    const relative = path.relative(folder.uri.fsPath, filename).split(path.sep).join('/');
                                    if (excluded(relative, entry.type === 'folder')) continue;
                                    if (entry.type === 'folder') {
                                        await assertSafeLocalPath(folder.uri.fsPath, filename);
                                        await fs.mkdir(filename, { recursive: true });
                                        queue.push(entry.path);
                                    } else if (entry.type === 'file') files.push(filename);
                                }
                                for (let offset = 0; offset < files.length && !signal.aborted; offset += options.batchSize) await process(files.slice(offset, offset + options.batchSize));
                                cursor = page.nextCursor;
                                if (cursor && cursors.has(cursor)) throw new Error('RESTlet repeated a pagination cursor.');
                                if (cursor) cursors.add(cursor);
                            } while (cursor && !signal.aborted); } catch (error) {
                                if (signal.aborted) throw error;
                                results.push({ ok: false, path: remoteDirectory, type: 'folder', error: {
                                    code: 'LIST_FAILED', message: `${error.message} Run Pull Folder again to retry this directory.`
                                } });
                            }
                        }
                    }
                    cancelled ||= signal.aborted;
                } catch (error) {
                    if (signal.aborted) cancelled = true;
                    else throw error;
                } finally { cancel.dispose(); this.controllers.delete(controller); }
            });
            const failed = results.filter(item => !item.ok);
            const failedFiles = failed.filter(item => item.type !== 'folder');
            this.lastFailed = failedFiles.length ? { action, uri, paths: [...new Set(failedFiles.map(item => item.path))], connection } : undefined;
            // Setup workflows need an explicit outcome, including an empty remote
            // folder and partial directory failures, before marking import complete.
            const summary = { succeeded: results.filter(item => item.ok).length, failed: failed.length, cancelled: cancelled || this.disposed };
            if (this.disposed) return summary;
            this.logResults(results, cancelled);
            const message = `SuperSuite: ${summary.succeeded} succeeded, ${failed.length} failed${cancelled ? '. Cancelled; files not yet visited remain.' : '.'}`;
            if (failed.length || cancelled) {
                const choice = await vscode.window.showWarningMessage(message, 'Show Output', ...(failedFiles.length ? ['Retry Failed Files'] : []));
                if (choice === 'Show Output') this.output.show();
                if (choice === 'Retry Failed Files') setTimeout(() => vscode.commands.executeCommand('supersuite.retryFailed'), 0);
            } else await vscode.window.showInformationMessage(message);
            return summary;
        } catch (error) {
            const failed = results.filter(item => !item.ok && item.type !== 'folder');
            if (failed.length) this.lastFailed = { action, uri, paths: [...new Set(failed.map(item => item.path))], connection };
            if (this.disposed) return { succeeded: results.filter(item => item.ok).length, failed: results.filter(item => !item.ok).length, cancelled: true };
            this.logResults(results, cancelled);
            throw error;
        } finally { this.active.delete(key); }
    }
    isDirty(filename) {
        const canonical = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
        return vscode.workspace.textDocuments.some(document => document.uri.scheme === 'file' && canonical(document.uri.fsPath) === canonical(filename) && document.isDirty);
    }
    logResults(results, cancelled) {
        this.output.appendLine(`${new Date().toISOString()}: ${results.filter(item => item.ok).length} succeeded, ${results.filter(item => !item.ok).length} failed${cancelled ? ', cancelled (unvisited files remain)' : ''}.`);
        for (const item of results.filter(item => !item.ok)) this.output.appendLine(`${item.path}: ${item.error?.code || 'ERROR'} — ${item.error?.message || 'Transfer failed'}`);
    }
}
module.exports = { NetSuiteCommands };
