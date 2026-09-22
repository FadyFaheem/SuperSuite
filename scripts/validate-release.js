'use strict';
const fs = require('node:fs');
const manifest = require('../package.json');
const tag = process.env.RELEASE_TAG;
if (!/^v\d+\.\d+\.\d+$/.test(tag || '') || tag !== `v${manifest.version}`) throw new Error(`Release tag must be v${manifest.version}, got ${tag || '(missing)'}.`);
if (manifest.publisher !== 'fadyfaheem' || manifest.name !== 'supersuite') throw new Error('Unexpected Marketplace identity.');
const lockfile = JSON.parse(fs.readFileSync(require('node:path').join(__dirname, '..', 'package-lock.json'), 'utf8'));
if (lockfile.version !== manifest.version || lockfile.packages[''].version !== manifest.version) throw new Error('Update package-lock.json with package.json before releasing.');
console.log(`Validated ${tag} for ${manifest.publisher}.${manifest.name}`);
