# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.2.0] - 2026-09-22

- Import and API-starter coverage for every currently supported Oracle module, with documentation links, permissions, and version/context filtering; commerce namespace and retired SSO handling.
- Read-only stdio MCP server using the official SDK, with native VS Code discovery, dedicated credentials, record inspection, structured searches, and official documentation tools.
- Curated Oracle documentation catalog with bounded live reads, source links, pagination, cache, cancellation, and host restrictions.
- RESTlet read-only deployment mode, standard/custom record lookup by internal ID, and bounded AND-filter searches with explicit omissions.
- SuiteCloud ACP creation, ACP/SuiteApp selection, authentication, interactive imports, validation, configured unit tests, preview, and reviewed deployment through Oracle's CLI.
- MCP protocol, credential lifecycle, read-only boundary, and SuiteCloud regression tests.

**Deployment:** update the account RESTlet for MCP inspection and create a dedicated deployment with `custscript_supersuite_readonly` enabled. MCP inspects data; the host editor performs local code changes. Live sandbox validation remains required.

## [2.1.0] - 2026-09-22

- Init wizard for an empty repository or existing workspace, including account settings, secure credential prompts, an access setup guide, connection verification, file imports, and optional field-ID discovery.
- New RESTlet setup through Oracle SuiteCloud CLI, connection to an existing deployment, or a prepared manual deployment project. SuiteCloud authentication remains separate from RESTlet access keys.
- Scoped SDF bootstrap with unique script/deployment IDs, preview and account review, explicit deployment paths, canonical source checks, and protection against overwriting unrelated projects.
- Read-only JSON snapshots of selected customers, transactions, vendors, and contacts, including accessible body fields, sublists, and bounded subrecords. Snapshot storage is excluded from Git and File Cabinet transfers.
- Resumable setup and record exports, cancellation, per-record failure/incomplete markers, and persistent progress checkpoints.
- Automated tests for initialization, bootstrap filesystem boundaries, CLI task lifecycle, and record export behavior.

**Upgrade:** deploy the bundled RESTlet 2.1 to enable business-record exports. Protocol 2 file transfers remain supported. Init does not create NetSuite integrations, roles, or access keys; follow `docs/ACCESS_SETUP.md`. JSON snapshots are not a complete account backup or restore format. Live account deployment and import checks remain part of the sandbox release checklist.

## [2.0.0] - 2026-09-22

- New `fadyfaheem.supersuite` identity, current VS Code APIs and multi-root support.
- Sequential count/byte-limited transfers, paginated pulls, cancellation, transient retries, per-file summaries and retry-failed command.
- Protocol-2 RESTlet with scoped paths, governance limits, documented file overwrite/staging lifecycle, and body-field metadata discovery.
- SecretStorage credentials, HMAC-SHA256 TBA, externally obtained OAuth 2.0 bearer tokens, and legacy TBA migration. NLAuth removed.
- SuiteScript 2.0/2.1 templates, snippets, JSDoc header builder/completions, syntax injection, atomic AMD imports and API call starters.
- Account field metadata cache with explicit refresh and optional refresh on activation.
- Workspace setup buttons and `.config/supersuite.json` schema.
- Automated lint/unit/extension-host checks and tested VSIX publication on matching version tags using Marketplace OIDC.

**Migration:** install the new extension identity, disable NetSuite Upload, configure credentials, and deploy the bundled RESTlet before transferring files. See README.md and netSuiteRestlet/README.md. OAuth2 token acquisition/refresh is external in this release.

## [1.2.4] - 2019-12-26

- Closes Issue #31 "Add Netsuite dependency command doesn't work properly" https://github.com/netsuite-upload-org/netsuite-upload/issues/31

### Added

- Added support for pushing a whole folder. Thank you @alejndr https://github.com/netsuite-upload-org/netsuite-upload/pull/35

## [1.2.2] - 2019-09-13

### Changed

- Added support for uploading and downloading .ts TypeScript files. https://github.com/netsuite-upload-org/netsuite-upload/pull/32
- Updated npm dependencies to eliminate security vulnerabilities.

## [1.1.2] - 2019-02-08

### Changed

- Publishing to VS Code Marketplace under a new publisher name, `nsupload-org`. This will make it appear as a different extension than the old one. Going to remove the old extension from the VS Code Marketplace.
- Added keybinding for upload. Ctrl+n,Ctrl+u.  This complements the download keybinding, Ctrl+n,Ctrl+d.
- Improved some Settings descriptions.

### Fixed

- Checking the version of the RESTlet was too strict. I don't need the version of the Extension to equal the version of the RESTlet. I just need all the supported functions to work properly.

## [1.0.2] - 2019-02-07

### Fixed

- Fixed OAuth support. NetSuite OAuth is weird.

### Added

- Assigned a version to the RESTlet, and created a GET request that will pull down the version number of the RESTlet. This allows the extension to detect when the RESTlet version is not up-to-date, and to warn the user. There's also a new palette command, `Get NSUpload RESTlet version` which will fetch the value and display it in a notification.
- Continued improving error handling. Now can detect bad authentication and warn the user.

### Changed

- This release requires that you update the RESTlet in NetSuite. Find the RESTlet at `netSuiteRestlet\vscodeExtensionRestlet.js`.

## [1.0.1] - 2019-02-05

### Added

- This release adds a feature requested by [@JonnyBoy333](https://github.com/JonnyBoy333). It allows for a setting to change the base folder path to upload scripts. For example, if you keep a copy of all scripts in SuiteScripts/Developer, then you can change this setting and push and pull files there. When you're done with development, you can change the setting back and push files to production.

### Changed

- This release requires that you update the RESTlet in NetSuite. Find the RESTlet at `netSuiteRestlet\vscodeExtensionRestlet.js`.

## [1.0.0] - 2019-02-05

Original author Tomáš Tvrdý [tvrdytom](https://github.com/tvrdytom) has turned over ownership of this project to me. I'm releasing an updated version 1.0 with many fixes.

See the [readme.md](https://github.com/netsuite-upload-org/netsuite-upload) for install instructions. This version is not in the VS Code Marketplace yet.

- Enabled pushing up the active document in the editor using a keybinding (I chose Ctrl+U, personally).
- Improved cross-platform support (mac). Previously, Windows local file paths were assumed.
- Now properly recognizes and sets the correct file type by inspecting the filename extension when uploading a new file to NetSuite. Supports all file extensions that are documented in NetSuite documentation.
- Improved file vs. folder recognition in the left explorer pane. Previously, if a file type wasn't a type of code file that VS Code knew about (like a .csv file), the NetSuite context menu wouldn't show.
- Improved messaging. More comprehensive messages will be shown in the VS Code "toast" notification when a file or folder operation succeeds or fails.
- Stopped using node-rest-client and replaced with SuperAgent, easier to use.

I attempted to add OAuth support. I'd appreciate if anyone would like to try a test. I couldn't get it working on my machine. Config instructions are in the README.md.

*If you upgrade to this version, you **must** also upgrade the RESTlet `vscodeExtensionRestlet.js` in NetSuite.*
