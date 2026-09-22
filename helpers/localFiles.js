'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

function inside(root, target) {
    const relative = path.relative(root, target);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function assertSafeLocalPath(root, target) {
    root = path.resolve(root);
    target = path.resolve(target);
    if (!inside(root, target)) throw new Error('File is outside the selected workspace.');
    // Reject links, including existing ancestors of paths that will be created.
    // This also prevents a pulled file from following a link out of the workspace.
    const rootReal = await fs.realpath(root);
    let current = root;
    for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
        current = path.join(current, segment);
        try {
            const info = await fs.lstat(current);
            if (info.isSymbolicLink()) throw new Error(`Symbolic links are not transferred: ${path.relative(root, current)}`);
            if (!inside(rootReal, await fs.realpath(current))) throw new Error('Resolved file is outside the selected workspace.');
        } catch (error) {
            if (error.code === 'ENOENT') break;
            throw error;
        }
    }
    return target;
}

async function* walkFiles(root, directory, excluded, signal) {
    await assertSafeLocalPath(root, directory);
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (signal?.aborted) return;
        const fullPath = path.join(directory, entry.name);
        const relative = path.relative(root, fullPath).split(path.sep).join('/');
        if (entry.isSymbolicLink() || excluded(relative, entry.isDirectory())) continue;
        if (entry.isDirectory()) yield* walkFiles(root, fullPath, excluded, signal);
        else if (entry.isFile()) yield fullPath;
    }
}

async function atomicWrite(root, filename, data, beforeCommit) {
    await assertSafeLocalPath(root, filename);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await assertSafeLocalPath(root, filename);
    const temporary = path.join(path.dirname(filename), `.supersuite-${crypto.randomUUID()}.tmp`);
    try {
        await fs.writeFile(temporary, data, { flag: 'wx' });
        await assertSafeLocalPath(root, filename);
        // The synchronous guard runs after staging, immediately before replacing the
        // destination, so cancellation or an editor edit during disk I/O wins.
        if (beforeCommit) beforeCommit();
        await fs.rename(temporary, filename);
    } finally {
        await fs.rm(temporary, { force: true });
    }
}

// These are always excluded even when the user replaces configurable patterns.
function isProtected(relative) {
    return relative.split('/').some(segment => segment.startsWith('.') || segment === 'node_modules') || /\.(?:pem|key|p12|pfx)$/i.test(relative);
}

module.exports = { inside, assertSafeLocalPath, walkFiles, atomicWrite, isProtected };
