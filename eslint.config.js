'use strict';
module.exports = [
    { ignores: ['node_modules/**', '.npm-cache/**', '.vscode-test/**', 'test/fixtures/**'] },
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 'latest', sourceType: 'commonjs',
            globals: Object.fromEntries(['Buffer', 'TextDecoder', 'URL', 'URLSearchParams', 'AbortController', 'setTimeout', 'clearTimeout', 'setImmediate', 'queueMicrotask', 'console', 'process', '__dirname', '__filename'].map(name => [name, 'readonly']))
        },
        rules: {
            'no-undef': 'error', 'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
            'no-unreachable': 'error', 'no-dupe-args': 'error', 'no-dupe-keys': 'error',
            'no-constant-condition': ['error', { checkLoops: false }],
            'valid-typeof': 'error', 'constructor-super': 'error', 'no-this-before-super': 'error'
        }
    },
    { files: ['netSuiteRestlet/**/*.js'], languageOptions: { globals: { define: 'readonly' } } }
];
