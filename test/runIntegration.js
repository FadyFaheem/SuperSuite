'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const { runTests } = require('@vscode/test-electron');

async function main() {
    const root = path.resolve(__dirname, '..');
    const temporaryRoot = path.join(root, '.vscode-test');
    await fs.mkdir(temporaryRoot, { recursive: true });
    const workspace = await fs.mkdtemp(path.join(temporaryRoot, 'workspace-'));
    try {
        await runTests({
            version: process.env.VSCODE_VERSION || 'stable',
            extensionDevelopmentPath: root,
            extensionTestsPath: path.join(__dirname, 'integration', 'index.js'),
            launchArgs: [workspace, `--user-data-dir=${path.join(workspace, '.user-data')}`, `--extensions-dir=${path.join(workspace, '.extensions')}`, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : [])],
            // Electron-based parent applications can set this; the test host
            // must launch as VS Code, rather than interpreting the folder as JS.
            extensionTestsEnv: { SUPERSUITE_TEST_WORKSPACE: workspace, ELECTRON_RUN_AS_NODE: undefined }
        });
    } finally {
        const relative = path.relative(temporaryRoot, workspace);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Refusing to clean up a workspace outside the test directory.');
        try {
            // Windows may retain extension-host log handles briefly after exit.
            await fs.rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch (error) {
            if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code)) throw error;
            console.warn(`VS Code still holds its isolated test directory (${error.code}); it remains under .vscode-test for later cleanup.`);
        }
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
