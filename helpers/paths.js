'use strict';

const path = require('node:path');

/** File Cabinet paths use forward slashes and must be portable to the local OS. */
function normalizeRemotePath(value) {
    if (typeof value !== 'string' || !value || value.length > 4096) throw new Error('A non-empty File Cabinet path is required.');
    const normalized = value.replace(/\\/g, '/');
    const segments = normalized.split('/');
    if (segments.some(segment => !segment || segment === '.' || segment === '..' ||
        /[\u0000-\u001f\u007f<>:"|?*]/.test(segment) || /[. ]$/.test(segment) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) {
        throw new Error('File Cabinet paths cannot contain traversal, empty segments, or names unsafe on local filesystems.');
    }
    return segments.join('/');
}

function isWithinDirectory(directory, candidate) {
    const relative = path.relative(path.resolve(directory), path.resolve(candidate));
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function toRemotePath(workspaceRoot, localPath, rootDirectory = 'SuiteScripts') {
    const root = normalizeRemotePath(rootDirectory);
    if (!isWithinDirectory(workspaceRoot, localPath)) throw new Error('The selected path is outside its workspace folder.');
    const relative = path.relative(path.resolve(workspaceRoot), path.resolve(localPath));
    return relative ? normalizeRemotePath(`${root}/${relative.split(path.sep).join('/')}`) : root;
}

/** Lexical containment only. Callers must also reject symlink/reparse-point ancestors before writes. */
function toLocalPath(workspaceRoot, remotePath, rootDirectory = 'SuiteScripts') {
    const root = normalizeRemotePath(rootDirectory);
    const remote = normalizeRemotePath(remotePath);
    if (remote !== root && !remote.startsWith(`${root}/`)) throw new Error('NetSuite returned a path outside the configured File Cabinet root.');
    const relative = remote === root ? '' : remote.slice(root.length + 1);
    const local = path.resolve(workspaceRoot, ...relative.split('/'));
    if (!isWithinDirectory(workspaceRoot, local)) throw new Error('NetSuite returned a path outside the workspace folder.');
    return local;
}

module.exports = { normalizeRemotePath, isWithinDirectory, toRemotePath, toLocalPath };
