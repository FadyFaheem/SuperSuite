# SuperSuite sandbox verification

Use a dedicated NetSuite sandbox folder and a restricted integration role. These checks exercise account behavior that mocked tests cannot prove. Record the extension version, RESTlet version, VS Code version, NetSuite release and role used. Do not include credentials in test reports.

## Init from an empty repository

- Begin with an empty local Git repository. Run **SuperSuite: Init: Set Up and Import**, then repeat from the **Init / Resume Setup** panel button and status bar. With no folder open, choose an empty folder and confirm setup continues after it opens. Verify a multi-root workspace initializes only the selected folder.
- Review [ACCESS_SETUP.md](docs/ACCESS_SETUP.md) with the account administrator. Confirm the account features, integration, role, audience, and RESTlet keys are prepared. Verify **Access Key Setup Guide** opens from the panel and from credential prompts. No integration, role, token, or OAuth grant should be silently created.
- Test **Deploy a new RESTlet with SuiteCloud** with a freshly authorized sandbox CLI profile. Inspect `.config/supersuite-sdf`: the copied script matches the bundled RESTlet, the script/deployment IDs are unique, and `deploy.xml` includes only its script file and object XML. Confirm the role script ID and `custscript_supersuite_root` match the chosen existing folder.
- Complete SuiteCloud browser authentication. Confirm the preview identifies the expected sandbox account/role before approving deployment. Repeat with an existing CLI authentication ID. Use a deliberately wrong account/profile in a disposable test setup, inspect the preview, and cancel; no deployment should run. SuiteCloud credentials must remain separate from the RESTlet credentials.
- Cancel at each setup prompt, during CLI authentication, after the deployment preview, and during deployment/import progress. Resume Init and verify previous successful stages are retained and unfinished stages are retried. A deployment may finish remotely before cancellation reaches it; inspect the NetSuite script record and task log, then verify resume reuses the same IDs.
- Test missing SuiteCloud CLI, missing Java, denied SDF permission, failed preview, and failed deployment. Each must stop the deployment/import sequence with useful output. No package should be installed and no license accepted automatically. Do not test browser authentication in WSL; Oracle does not support that flow there.
- Test **Connect to an existing SuperSuite RESTlet** and **Prepare RESTlet for manual deployment**. For manual setup, follow the generated project instructions, restrict its audience/root in NetSuite, then paste the actual External URL. Each route must verify the connection before pulling files.
- Interrupt credential entry partway through; existing stored credentials must remain intact. Correct a bad URL or expired token in the connection retry flow. If the URL changes after partial imports, import stages must reset for the new connection rather than report results from the old endpoint.
- Check `.gitignore` preserves existing rules and ends with an effective `/.config/` exclusion. Keep `.gitignore` or `.config/supersuite.json` dirty in an editor; setup must ask you to save/revert before writing it. A pre-existing unrelated bootstrap folder, changed generated source/config, symlink, or account/root/role mismatch must be refused without overwriting it.
- Change the connection settings while Init is running. The next phase must stop and require review instead of mixing results from different connections. Confirm an untrusted workspace cannot initialize, execute CLI tasks, or connect.
- Select files only, then test files plus field IDs and business records. The final success message should appear only after all selected stages complete; permission failures and incomplete records must leave setup resumable.

## Setup and lifecycle

- Install the generated `supersuite.vsix` in current VS Code. Confirm SuperSuite Explorer and status bar buttons appear, commands activate without deprecated-API errors, and ordinary JavaScript editing still works.
- Click Configure Workspace twice. Confirm `.config/supersuite.json` is created once and your edits are preserved. Verify schema diagnostics on invalid batch sizes.
- In a multi-root workspace, configure different test folders/connections; confirm Explorer selections route to the selected root. Trust restriction must disable connections in an untrusted workspace.
- Configure TBA HMAC-SHA256 or a RESTlets-scoped OAuth2 access token. Test Connection must show RESTlet 2.2.0/protocol 2. Test missing/expired credentials and revoked deployment audience; errors must contain no secret or authorization header.
- If testing migration, keep a backup of nonsecret configuration, migrate an isolated folder's legacy credentials, and verify another workspace connection remains usable.
- Redeploy an older RESTlet in the test deployment: transfers must stop with an upgrade message. Restore the current version.

## File Cabinet transfers

- Push a directory with nested folders, UTF-8/non-ASCII text, binary images, unsupported extensions, and more files than one batch. Include `.config`, `.env`, `.git`, `node_modules`, and a symbolic link; protected paths must not transfer.
- Test an existing destination referenced by a script record. Overwrite its content and verify its internal ID, script reference, permissions and attributes are retained as expected. Oracle documents overwrite attributes/permissions; account validation is essential before relying on it for deployed scripts.
- Pull the files into a second clean workspace root, compare text and binary bytes, then use Compare File with NetSuite. Verify remote comparison is read-only and does not need a temporary-folder setting.
- Use a folder with over 4,000 files or reduce `pageSize` in a test client to exercise multiple pages. Verify direct child folders/files are visited without duplicates; do not modify the remote folder during this check.
- Make one file fail permissions and one exceed the payload budget. Other files must finish; output must identify failures. Fix the causes and run Retry Failed Files; completed files must not be needlessly resent.
- Keep an editor dirty, then try push and pull. It must be skipped. Make it dirty while a pull is in progress; its unsaved content must remain untouched.
- Cancel during requests and during a folder transfer. Completed files should remain; later work must stop. Rerun the folder command for files not yet visited. Test a transient 429/concurrency error if your sandbox permits it; no infinite retries.
- Compare behavior with 1-file/1KiB batches and default batches. Files too large for a single configured batch must fail clearly rather than be silently truncated.
- Set `custscript_supersuite_root` on the deployment to a narrower folder. Requests outside it, path traversal, and access to `.supersuite-staging` must be refused.
- After successful and failed pushes, inspect the reserved staging folder. Temporary files/subfolders created for finished requests should be removed. Follow RESTlet documentation for remnants after a hard platform termination.
- Delete a disposable remote test file; cancel once, then confirm once. The local file must remain. Repeated deletion must not affect another file.

## Business record exports

- Select customers, sales orders, and invoices during Init, then run **SuperSuite: Export Business Records** for each additional supported type: vendor, contact, purchase order, vendor bill, credit memo, cash sale, and customer payment. Use records whose values and subsidiary visibility you can verify independently.
- Confirm the RESTlet uses read-only searches/loads; record timestamps and business values must not change. Compare representative JSON body fields, custom values, item/address sublists, and address or inventory-detail subrecords to the values visible to the integration role.
- Inspect `.supersuite-data/<run-id>/manifest.json` and `<type>/<id>.json`. Confirm `.gitignore` excludes the export directory before any record snapshot is written. `git status` should not offer new snapshots for commit, and a whole-workspace File Cabinet push must not upload them. Keep exports on approved local storage; they contain plaintext business data.
- Export more records than one page. Transaction line searches must produce one snapshot per record ID; there must be no missing/duplicate records in an otherwise unchanged sandbox. Empty record types should complete without an error. The normal client request should contain no more than five records per page.
- Cancel in the middle of a type, reload the extension host, and export the same types again. Verify the same partial run resumes at its checkpoint and previously successful records are retained. A fully completed export followed by another export must create a fresh run. Different accounts or type selections must never resume each other's checkpoints.
- Deny View permission for a selected type or restrict subsidiaries. Only role-visible records should be exported. Other selected types should continue when possible; permission failures must leave a partial manifest and useful error code without record values in the output log.
- Exercise a per-record failure, unavailable field, deeply nested subrecord, record above the 3 MiB limit, and sublist at the NetSuite 10,000-line boundary. Failures and omitted data must produce `.error.json` markers or `complete: false` with issues. Init must not call an incomplete snapshot run fully successful.
- Correct a failed or incomplete record where possible and resume. Its marker and counters should clear after a complete snapshot; successful records must not be needlessly loaded again. If a failed record was deleted, its unresolved checkpoint should remain visible rather than silently disappear.
- Check credential-like fields are omitted and flagged. Output, manifests, and error markers should contain identifiers/counters/error codes, not dumped record values or raw platform error messages. Record JSON files intentionally contain the exported business values.
- Modify records during an export to document its live, nontransactional consistency limits. Do not certify the JSON as a complete account backup or test it as a restore/import format; no restore feature is supplied.
- Repeat with an older protocol-2 RESTlet lacking the `recordExport` capability. File transfers may still work, but business exports must stop with an upgrade message before any snapshot is written.

## Editor features and field metadata

- Create each script type for 2.0 and 2.1. Deploy representative Client, User Event, Map/Reduce and RESTlet templates after implementing the TODO business logic.
- Complete JSDoc tags, insert headers, insert NetSuite/custom modules, undo the import once, try an existing dependency, and try a callback with a conflicting variable. Changes must be atomic and duplicates/conflicts handled safely.
- Type `record.load` and `search.create` in a SuiteScript module and select method completions. Verify the options and required AMD imports, including a module imported with a custom alias.
- Confirm annotation/module highlighting under both light and dark themes; normal JavaScript syntax and completions remain available.
- Refresh field IDs for a standard record and a custom record. Verify labels/type suggestions in `fieldId` strings include a custom field visible to the role. Inspect cached metadata/output to ensure no record values are stored.
- Try a record type requiring an existing record or defaults; use the optional sample record ID. Document role/form limitations. Refresh after changing fields and verify one connection's fields do not leak into another workspace/account.
- Reload the extension host, verify stored credentials and cached fields still work, then test Clear Credentials.

## Read-only MCP and SuiteCloud

- Enable documentation-only MCP and start the discovered server in VS Code. Search Oracle references, read a page and follow its continuation offset. No NetSuite credentials should be requested or sent to documentation hosts.
- Configure a separate read-only deployment and View-only role. Verify the account/user/role with `netsuite_connection_info`, inspect a known standard/custom record by ID, and compare selected fields and sublists with the integration role's UI access.
- Search with filters and a small page size. Follow cursors and check that selected body columns correspond to the matched record IDs; formulas, joins, arbitrary SQL and extra tool parameters must be rejected.
- Use a transfer-enabled RESTlet URL for MCP once: account tools must refuse it until `custscript_supersuite_readonly` is enabled. Direct push/delete calls on a read-only deployment must also fail before modifying data.
- Confirm credentials never appear in discovery definitions, command arguments, workspace files, tool results, documentation requests, or logs. Resolved server environment contains credentials intentionally; keep the MCP host trusted. Change account settings and revoke approval during startup; the previous definition must not start with credentials.
- Ask the assistant to inspect a record and update a local script. Verify its changes and local tests; no MCP tool should execute scripts or modify the account. Stop an active tool call and restart after credential changes. Disable discovery, stop the server in the host, and verify revoking the NetSuite token blocks reads.
- Create/select an ACP and select an existing SuiteApp with SuiteCloud commands. Authenticate, import supported files/objects, validate, and run configured Oracle unit tests. Missing CLI/dependencies must produce instructions rather than installing packages automatically.
- Review a SuiteCloud deployment dry run, decline it once, then test a disposable sandbox deployment. Change a deployable file or project config after the preview; deployment must stop. Cancellation must terminate only SuperSuite's owned task. Check linked source paths and unsupported dynamic configuration are refused.

## Release pipeline

- Run local checks and inspect VSIX contents before tagging. Confirm the Init code and access guide are included; `.config`, `.supersuite-data`, local credentials, and sandbox snapshots are excluded.
- Confirm CI passes on a pull request and provides an installable artifact.
- Configure the Marketplace trust policy described in PUBLISHING.md. A valid matching version tag should publish the tested artifact; a mismatched tag or failed check must not publish.
- Do not mark live SDF deployment, record exports, NetSuite permissions, or Marketplace publication as verified solely because mocked tests pass. Record any skipped live checks explicitly.
