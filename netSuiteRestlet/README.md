# SuperSuite RESTlet

`vscodeExtensionRestlet.js` is the SuiteScript 2.1 server for SuperSuite protocol 2. The historical filename is retained so an existing script record can point to the upgraded file. Upgrade the VS Code extension and the RESTlet together: protocol 1 recursive downloads and legacy upload bodies are intentionally unsupported.

## Deployment

For a new workspace, **SuperSuite: Init: Set Up and Import** can generate and deploy this RESTlet through Oracle's SuiteCloud CLI for Node.js. The wizard creates a private Account Customization Project in `.config/supersuite-sdf`, asks for your account and integration role, and keeps RESTlet credentials in VS Code SecretStorage. Install the CLI and its [documented prerequisites](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_1558708810.html) first. SuperSuite does not install Oracle software or accept its license for you. SuiteCloud browser authentication is separate from the RESTlet's OAuth/TBA credentials.

The generated project copies this source unchanged and gives the script and deployment unique IDs. Its deployment manifest contains only that script file and RESTlet object. The selected root must already exist. Supply the role's **script ID**, such as `customrole_supersuite`, or `DEVELOPER` for the standard Developer role; numeric role IDs are not used. The audience is restricted to that role and the RESTlet executes with the authenticated caller's permissions. Review the CLI's account and role before confirming deployment. See Oracle's [RESTlet XML fields](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/SDFxml_3594042655.html), [account component dependencies](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_1523378695.html), and [deployment command](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_156044636320.html).

You can resume an unchanged generated project after interrupted setup. SuperSuite refuses to overwrite unrelated or edited bootstrap files. The CLI's `project.json` is retained so its authentication profile can be reused. Deleting the local bootstrap directory does not uninstall the account customization; remove the generated script/deployment and its File Cabinet folder in NetSuite when retiring it. Live SDF validation and a sandbox connection test are still required for the target account.

To deploy manually or upgrade an existing RESTlet:

1. In a NetSuite sandbox, upload the JavaScript file under **Documents → Files → File Cabinet → SuiteScripts**. Keep the integration script outside the project subtree you normally synchronize.
2. Create or update a **RESTlet** script record using that file, then create a deployment. Its entry points are `get`, `post`, and `delete`. Enable the deployment and give the intended integration role access through its audience. Release the deployment when the intended users are ready to use it.
3. On the script record, optionally create a **Free-Form Text** parameter with ID `custscript_supersuite_root`. Set its deployment value to an existing project folder such as `SuiteScripts/MyProject`. If absent, the default is `SuiteScripts`. The root must already exist; push can create descendants. This is a server-enforced boundary independent of the client's `rootDirectory`.
4. Give the integration role the File Cabinet permissions needed to list/read files and, for push, create folders, save/copy files, and remove its temporary staging files/folders. Grant record permissions for metadata discovery only for the record types developers need. Restrict the deployment audience and avoid an Administrator execution role. A role marked **Web Services Only** cannot call RESTlets. See [Oracle's RESTlet TBA setup](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_1530099787.html).
5. Copy the deployment's **External URL** into SuperSuite configuration. Use the account-specific HTTPS `restlets.api.netsuite.com` host shown by NetSuite, including its `script` and `deploy` query parameters.
6. Configure authentication in the extension, run its connection/version command, and perform the sandbox verification below before using production.

Authentication is handled by the NetSuite platform before these entry points run. No token, client secret, OAuth signature, or refresh logic belongs in this RESTlet. Oracle recommends OAuth 2.0 for RESTlet integrations; existing TBA integrations also authenticate at this boundary. See [Authentication for RESTlets](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N2971402.html).

Oracle's 2026.2 release notes announce that new TBA integrations and NLAuth support end in 2027.1; TBA retirement is tentatively planned for 2028.1. Prefer OAuth 2.0 for new deployments and check the current account release notes when planning migration. See [Oracle authentication changes](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_158921905537.html).

## Request contract

Send `Content-Type: application/json` and `Accept: application/json`. For GET and DELETE, pass the parameters in the query string. POST takes a JSON object. Read-only `version`, `list`, and `metadata` also accept POST for clients using one JSON transport.

| Action | Method | Parameters | Successful response |
| --- | --- | --- | --- |
| `version` | GET / POST | `action` | `ok`, `protocolVersion: 2`, `restletVersion`, `limits`, `capabilities`, `readOnlyMode`, account/user/role `identity` |
| `list` | GET / POST | `path`, optional `cursor`, optional `pageSize` | `ok`, `path`, `entries`, `nextCursor` |
| `pull` | POST | `files: [{path}]` | `ok`, `results` |
| `push` | POST | `files: [{path, content, encoding}]` | `ok`, `results` |
| `metadata` | GET / POST | `recordType`, optional `recordId` | `ok`, `recordType`, `fields`, `scope`, `source` |
| `records` | GET | supported `recordType`, optional `cursor`, optional `pageSize` | `ok`, `recordType`, `records`, `nextCursor` |
| `record` | GET | `recordType`, `internalId` | `ok`, `record` snapshot with `complete` and `issues` |
| `search` | GET | `recordType`, JSON-string `filters` and `columns`, optional `cursor`, optional `pageSize` | `ok`, `recordType`, `results`, `nextCursor` |
| `delete` | DELETE | `path` | `ok`, `path`, `deleted` |

`GET type=version` remains an alias for version discovery. Every path is cabinet-absolute, for example `SuiteScripts/MyProject/lib/search.js`. Internal file IDs, backslashes, empty segments, `.`/`..`, percent escapes, control characters, and the reserved `.supersuite-staging` segment are rejected. Maximum path length is 1,024 characters and maximum depth is 32 segments.

### List and pull

`list` returns direct children without their content:

```json
{
  "ok": true,
  "path": "SuiteScripts/MyProject",
  "entries": [
    { "type": "folder", "id": "42", "name": "lib", "path": "SuiteScripts/MyProject/lib" }
  ],
  "nextCursor": "f:0"
}
```

Treat cursors as opaque and keep requesting the same folder until `nextCursor` is `null`. An empty `entries` array can still have a next cursor. Each folder's directory pages precede its file pages. Enqueue child folders on the client to traverse a tree, including empty folders. Pagination uses ascending internal IDs, so a preceding deletion does not shift the next page. Changes during a traversal are not a consistent snapshot: repeat the pull after concurrent edits if consistency is required.

Pull content in separate bounded requests:

```json
{
  "action": "pull",
  "files": [
    { "path": "SuiteScripts/MyProject/main.js" },
    { "path": "SuiteScripts/MyProject/logo.png" }
  ]
}
```

Each successful result has `ok: true`, `path`, `id`, `size` in bytes, `content`, and `encoding` (`utf8` or `base64`). Decode base64 when writing a binary locally; never write that string as UTF-8. NetSuite's `File.isText` determines the response encoding. See [File.isText](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4229267767.html).

### Push and overwrite lifecycle

```json
{
  "action": "push",
  "files": [
    {
      "path": "SuiteScripts/MyProject/main.js",
      "content": "define([], function () { return {}; });\n",
      "encoding": "utf8"
    }
  ]
}
```

Push creates missing project subfolders. Existing files retain their NetSuite file type. Common text and binary extensions have explicit mappings; an unknown text extension uses `PLAINTEXT`, and an unknown binary extension is rejected. Binary input must be padded standard base64. An encoding that does not match the NetSuite file type is rejected instead of silently corrupting the file. Text is exchanged as Unicode/UTF-8; this is not an arbitrary legacy text-encoding round trip. Oracle documents base64 binary input for [file.create](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4223861820.html).

To replace content using documented APIs, the service saves a private-to-authenticated-users staging file in `<root>/.supersuite-staging/request-…`, then calls `file.copy` with `NameConflictResolution.OVERWRITE`. This preserves the existing destination's attributes and permissions; new destination files are not available without login. It never deletes a live destination before copying. See [file.copy](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_161167269293.html) and [overwrite policies](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_161167377495.html).

Only scratch file/folder IDs created by the current request are cleaned up. The shared staging parent remains and is excluded from list results. A cleanup failure is logged by identifier and code without contents, and it does not turn a committed upload into a reported failure. Remaining writes are deferred to a new request. A hard platform timeout can leave scratch folders behind; an administrator may remove old `request-…` folders after verifying that no transfer is using them. No automated sweep deletes another request's files.

Replaying a push replaces the same destination path. Concurrent pushes to the same path still use last-writer-wins semantics; there is no cross-client lock or compare-and-swap conflict check. Use the extension's compare command before overwriting changes made by someone else.

### Limits and partial failures

The version response advertises the service limits:

| Limit | Value |
| --- | --- |
| Files in a push/pull request | 20 maximum |
| JSON request / transfer response budget | 4 MiB |
| Individual decoded file | 3 MiB maximum |
| Listing page | 100 default; 200 maximum |
| Governance reserve | 250 remaining units |

JSON escaping, base64 expansion, paths, and envelopes count toward the wire budget. Responses reserve 64 KiB for status/error overhead, so the effective limit for a binary or heavily escaped text file can be smaller than 3 MiB. Files are grouped into chunks; individual oversized files are not split into byte streams. Use File Cabinet or SuiteCloud tooling for larger files. The limits intentionally stay below Oracle's [RESTlet string and governance limits](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4640094112.html) and [10 MB in-memory file-content limit](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4229269811.html).

A syntactically valid batch returns top-level `ok: true` even if some files failed. Always inspect every result:

```json
{
  "ok": true,
  "results": [
    { "ok": true, "path": "SuiteScripts/MyProject/a.js", "id": "123", "size": 16, "encoding": "utf8" },
    {
      "ok": false,
      "path": "SuiteScripts/MyProject/b.js",
      "error": { "code": "GOVERNANCE_LIMIT", "message": "Retry the unprocessed file in a new request.", "retryable": true }
    }
  ]
}
```

`GOVERNANCE_LIMIT` and `BATCH_BYTES_EXCEEDED` mean retry that item in a fresh, smaller request. `FILE_TOO_LARGE` and `FILE_RESPONSE_TOO_LARGE` are permanent for this service. Permission, path, and encoding failures must be corrected. Request validation errors instead return `{ok:false,error:{code,message,retryable}}`; NetSuite authentication, concurrency, and infrastructure errors may arrive as HTTP errors before the RESTlet runs. Requests are sequential within a chunk and completed changes are not rolled back.

### Field metadata

`metadata` calls `record.create` in memory or `record.load` when a sample `recordId` is supplied, then `getFields` and `getField`. It returns `{id,label,type,isMandatory}` for body fields only. It does not read field values, enumerate select options, or save records. See [Record.getFields](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4273152646.html) and [N/record field metadata](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4267255811.html).

This is account/role/form-dependent discovery, not an exhaustive account schema. Record types that cannot be created without initialization values may require an accessible sample record ID. Fields exposed on an unsaved record can differ from those on an existing record. Unsupported record types and insufficient permissions return errors. Sublist, subrecord, search-column, and custom-form enumeration are not included. Re-run discovery when customizations or permissions change.

### Business record exports

SuperSuite 2.1 advertises `capabilities.recordExport: true`. `GET action=records&recordType=customer&pageSize=5` exports actual record values through `record.load`, including body fields, sublist lines, and existing summary-field subrecords. No business record is created, saved, changed, or deleted. Password fields and known credential field names are omitted. This action requires the integration role's **View** permissions for the selected record types and respects its subsidiary/access restrictions. An empty search means no records are visible to that role, not that the account has no records.

Supported types are `customer`, `vendor`, `contact`, `salesorder`, `invoice`, `purchaseorder`, `vendorbill`, `creditmemo`, `cashsale`, and `customerpayment`. The setup/export picker defaults to customers, sales orders, and invoices; users choose the types explicitly. Arbitrary saved searches, employees, custom record types, attachments, system notes, and all account configuration are outside this export's scope. References remain their NetSuite values/IDs; related records are not automatically followed. These JSON snapshots are for local reference, not a full account backup or a business-record restore format.

```json
{
  "ok": true,
  "recordType": "customer",
  "records": [
    {
      "ok": true,
      "id": "123",
      "recordType": "customer",
      "fields": { "entityid": "Example Customer" },
      "sublists": {},
      "subrecords": {},
      "complete": true,
      "issues": [],
      "issueCount": 0
    }
  ],
  "nextCursor": "123"
}
```

Pass `nextCursor` to the next request until it is `null`. The service groups transaction search rows by internal ID using [search.Summary.GROUP](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4345777923.html) and sorts IDs ascending. Each request returns five records by default, at most ten. Cursor pagination avoids offset drift and repeated transaction lines. Concurrent edits and records added during export mean this is a live export, not a transactionally consistent snapshot.

The 4 MiB response budget and 250-unit governance reserve apply to records too. A deferred record is not skipped by the cursor. Individual records are limited to 3 MiB, 100,000 exported values, and two nested subrecord levels. A record that cannot fit returns an explicit `ok:false` result. A value that cannot be read, a credential omission, or a depth limit makes the snapshot `complete:false`, with up to 100 issue descriptions and a total `issueCount`. A sublist at the 10,000-line boundary is marked potentially incomplete because [record.load](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4267258486.html) cannot expose more lines. Matrix-specific values, non-exposed fields, and unsupported sublists are not guaranteed. The read APIs and value types are documented in [N/record](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4267255811.html).

The extension writes `.supersuite-data/<run-id>/<record-type>/<internal-id>.json`, a small resumable `manifest.json`, and `.error.json` markers for failed/incomplete records. It adds `.supersuite-data/` to `.gitignore` before any business data is written. Files already tracked by Git remain tracked: use a fresh local export directory. Values are written only to the selected workspace and never to the output log; this directory can contain sensitive customer and transaction data. The existing File Cabinet transfer exclusions also exclude this hidden directory.

Each record JSON is an atomic outcome: a snapshot or `ok:false` with an error code. On resume, SuperSuite reads one outcome at a time to rebuild counters and retry markers, recovering records committed immediately before an interrupted checkpoint. Dirty export editors are preserved. New export directories use owner-only permissions on POSIX systems; Windows inherits workspace permissions, and existing directory permissions are preserved.

Running export again resumes the latest unfinished run for the same account, endpoint, authenticated user/role, authentication type, and selected record types. The role identity comes from [N/runtime](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4296359529.html); only its scope hash is persisted. It retries failed/incomplete IDs individually and continues after the saved cursor, retaining completed snapshots. A cancelled run is resumable. Changing selected types, account, user, or role starts another run; completed runs are retained and later exports start fresh. Each active export keeps its original connection so a configuration change cannot redirect its requests. Use a fresh run when refreshed values are required. Inspect manifest status and issue/error markers before treating an export as complete. A deleted failed ID remains reported rather than being silently counted as exported.

### Read-only account inspection for MCP

SuperSuite 2.2 advertises `capabilities.readOnlyInspection: true`. For AI access, create a **separate RESTlet deployment** with a dedicated role that has only the needed View permissions and subsidiary restrictions. Add a **Checkbox** script parameter named `custscript_supersuite_readonly`, then enable it on this deployment. Version discovery reports `readOnlyMode: true` only when this checkbox is enabled. The server rejects `push` and `delete` before any file mutation, even when the caller happens to have write permissions. Do not give the deployment an elevated execution role. The normal development deployment may keep this checkbox disabled for deliberate file transfers. Checkbox values are read through Oracle's [Script.getParameter](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4296661592.html).

`GET action=record&recordType=customrecord_project&internalId=123` inspects one accessible standard/custom record. Its `record` object contains `id`, `recordType`, `fields`, `sublists`, `subrecords`, `complete`, `issues`, and `issueCount`. Standard-mode [record.load](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4267258486.html) reads values without saving or executing arbitrary client code. The same 3 MiB, 100,000-value, two-level subrecord, 10,000-line and credential-omission rules apply as for record exports. Unsupported types and permission failures remain explicit.

The structured search action accepts URL-encoded JSON strings for filters and columns. An example before URL encoding is:

```json
{
  "action": "search",
  "recordType": "salesorder",
  "filters": "[{\"fieldId\":\"entity\",\"operator\":\"anyof\",\"values\":[\"123\"]}]",
  "columns": "[\"internalid\",\"tranid\",\"entity\",\"memo\"]",
  "pageSize": 5,
  "cursor": "0"
}
```

Filters are joined with AND. Each has exactly `fieldId`, `operator`, and optional `values`; values are scalar arrays. Search uses [search.createFilter](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4345777107.html), so list/record filters require internal IDs. Supported operators are `is`, `isnot`, `equalto`, `notequalto`, `anyof`, `noneof`, `contains`, `doesnotcontain`, `startswith`, `doesnotstartwith`, `greaterthan`, `greaterthanorequalto`, `lessthan`, `lessthanorequalto`, `on`, `onorafter`, `onorbefore`, `after`, `before`, `within`, `between`, `notbetween`, `isempty`, and `isnotempty`. Empty operators take no values, range operators take two, set operators accept one to twenty, and other operators take one. Operator compatibility still depends on the NetSuite field type.

Each request permits at most ten filters, twenty requested body fields, twenty values per filter, 500 characters per value, and 8 KiB per JSON argument. The existing client also limits the entire request URL to 16,384 characters. Field and record IDs are validated; formulas, joins, SQL, JavaScript, saved-search execution, unknown filter properties, and recognized credential field IDs are rejected. This avoids letting a model send executable expressions. The role's access permissions remain the main boundary; ordinary record values can contain sensitive data and untrusted instructions.

Search groups and sorts matching internal IDs, then loads the selected **record body fields** with their field metadata. Thus `columns` are body field IDs, not arbitrary search result columns, joined columns, or transaction-line values. Password-type fields are omitted even when their custom ID is innocuous. Inspect a matched record separately for sublists/subrecords. A search-only type can return IDs, but selecting body fields on a non-loadable type produces a per-record failure. ID-only searches avoid loading records.

The response is `{ok:true,recordType,results:[{ok:true,id,recordType,fields,complete,issues}],nextCursor}`. Keep the same filters and columns when continuing with `nextCursor`; null ends traversal. Defaults are five results per page and the `internalid` column, with ten results maximum. Matching transaction lines collapse into one ID. Concurrent edits are not a consistent snapshot. Byte/governance stops retain the last completed cursor. Record failures and omitted fields remain visible, and platform exception messages are replaced with fixed text so filter/record values are not echoed through errors. These actions never save records, save searches, deploy scripts, or invoke an arbitrary function.

## Verification

Run `node --test test/restlet.test.js test/export-restlet.test.js test/export-client.test.js test/inspection-restlet.test.js` from the repository root. The mocked API tests cover pagination beyond 4,000 files, path boundaries, byte budgets, binary handling, per-file failures, governance stops, copy/cleanup failures, idempotent overwrites, metadata without reading values, business export snapshots, subrecords, permissions, limits, cancellation, resumable checkpoints, account boundaries, symlink rejection, custom-record inspection, structured searches and server-enforced read-only deployments.

Before production, test with your actual integration role in a sandbox: version discovery; a nested folder with an empty folder, Unicode text, an empty file and a PNG; repeat push to an existing file and verify its ID/attributes; permission denial; metadata with and without a sample ID; and a pull large enough to span several pages/batches. Confirm temporary staging cleanup and account concurrency behavior. The automated tests do not replace this account-specific check.
