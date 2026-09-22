# SuperSuite

Guided NetSuite workspace setup, SuiteScript editing, read-only MCP context, and SuiteCloud development for Visual Studio Code.

**Marketplace identity:** `fadyfaheem.supersuite` · **VS Code:** 1.96 or newer · **RESTlet protocol:** 2

SuperSuite modernizes the original NetSuite Upload extension. Start from an empty repository, connect your account, deploy the RESTlet, and import your files and selected business records. It also includes bounded push/pull batches, SuiteScript 2.0 and 2.1 editing tools, secure credential storage, and account-specific field completions.

## What you can do

- Initialize an empty workspace through a guided account, credentials, RESTlet deployment, and import flow; resume unfinished setup later.
- Give an AI assistant read-only record/search context and official documentation through the bundled MCP server, then use its editor tools to update local scripts.
- Create/select SuiteCloud projects, authenticate, import objects/files, validate, run configured tests, preview, and deploy through Oracle's installed CLI.
- Push, pull, compare, and delete individual files; recursively transfer folders in sequential batches.
- Cancel a transfer, inspect per-file results, and retry only failed files. Directory downloads use pagination, including folders with more than 4,000 files.
- Start a Client, User Event, Suitelet, RESTlet, Scheduled, Map/Reduce, Mass Update, Workflow Action, Portlet, Bundle Installation, or custom module script.
- Complete NetSuite header tags inside `/** */`, insert module dependencies and callback parameters together, and insert common API calls with their option objects.
- Highlight SuiteScript annotations and module references while keeping VS Code's JavaScript language features.
- Fetch field IDs and labels from your account and use them in `fieldId` completions without a request on every keystroke.
- Export selected customers, transactions, vendors, and contacts as local JSON snapshots with body fields, accessible sublists, and bounded subrecords.
- Configure a workspace using the **SuperSuite** button in the status bar or the **SuperSuite** Explorer panel.

## Quick start

1. Install the SuperSuite VSIX through **Extensions: Install from VSIX**, or install `fadyfaheem.supersuite` after its first Marketplace release. Disable the original NetSuite Upload extension if it is installed; SuperSuite retains its legacy command aliases.
2. Open an empty local repository or folder. Click **Init / Resume Setup** in the SuperSuite Explorer panel, click the status bar button, or run **SuperSuite: Init: Set Up and Import**. With no folder open, the command lets you choose one and continues there. Each folder in a multi-root workspace has its own connection.
3. Choose **Deploy a new RESTlet with SuiteCloud**, **Connect to an existing SuperSuite RESTlet**, or **Prepare RESTlet for manual deployment**. Enter your NetSuite account ID and the existing `SuiteScripts` folder to import. Use a sandbox first.
4. Choose TBA keys or an OAuth 2.0 access token. For a new RESTlet, supply the integration role's **script ID**, such as `customrole_supersuite`, or `DEVELOPER` for the standard Developer role. Select business record types to export, or deselect them all for files only; choose whether to fetch field IDs for completions.
5. Follow the credential prompts. **Open Key Setup Guide** explains the required NetSuite account setup; you can also open [Access Key Setup Guide](docs/ACCESS_SETUP.md) from the SuperSuite panel. Credentials are stored in VS Code SecretStorage.
6. For automatic deployment, authenticate with Oracle SuiteCloud in the task terminal/browser or select an existing CLI profile. Review the deployment preview and verify its account and role before deploying. For manual deployment, follow the generated instructions and paste the deployment's **External URL** when ready.
7. SuperSuite tests the connection, pulls your selected File Cabinet root in batches, optionally caches field IDs, and exports the selected record types. Inspect **SuperSuite: Show Output** for results. If setup is cancelled or incomplete, run **Init / Resume Setup** again.

After initialization, right-click files or folders in Explorer to push, pull, or compare. **Configure Workspace**, **Configure Credentials**, and **Test Connection** remain available individually. Installing or upgrading the extension alone does not deploy account changes. Business-record exports require the bundled **2.1 or newer RESTlet**; file transfers continue to use protocol 2.

## RESTlet setup options

Automatic setup uses the installed [Oracle SuiteCloud CLI for Node.js](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/chapter_1558708800.html). Install its supported Node.js and Java prerequisites, enable the account features, and authorize a deployment role as described in Oracle's [installation prerequisites](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_1558708810.html). SuperSuite does not install the CLI or accept Oracle's SDK license. Browser-based SuiteCloud authentication does not work in WSL; use a supported environment or an already prepared deployment.

SuiteCloud deployment authorization is separate from the credentials used to call the RESTlet. The wizard helps you enter existing access keys; NetSuite integrations, roles, permissions, tokens, and OAuth grants must be created or approved by your account administrator. See the [access setup guide](docs/ACCESS_SETUP.md).

The wizard generates a private SDF Account Customization Project under `.config/supersuite-sdf`, with unique script/deployment IDs and a manifest restricted to the bundled RESTlet. The selected role is its audience, and `custscript_supersuite_root` restricts File Cabinet access to your chosen existing root. The root restriction applies to files; business-record access follows the role's record and subsidiary permissions. Generated project files must match the installed SuperSuite version before automatic deployment; unrelated or edited files are never overwritten. See [RESTlet deployment details](netSuiteRestlet/README.md).

Setup writes `.config/supersuite.json` and adds `/.config/` to `.gitignore`. Completed account changes and local downloads remain after cancellation; they are not rolled back. Resuming retries unfinished stages without recreating a successfully deployed RESTlet. Deleting the local bootstrap project does not uninstall its NetSuite script/deployment.

## Read-only AI context through MCP

Run **SuperSuite: Configure Read-Only MCP** to enable public documentation tools or connect a dedicated read-only NetSuite deployment. An assistant can inspect `salesorder` internal ID `12345`, search customers, consult Oracle APIs, and use its own editor tools to update your local script. The MCP server has no write, script-execution, or deployment tools; remote changes use the separate SuiteCloud or file-transfer commands.

Account access requires the bundled 2.2 RESTlet with `custscript_supersuite_readonly` enabled and an appropriate View-only role. MCP credentials are stored separately in SecretStorage and released only when its host starts the selected server. Current VS Code supports native discovery; other MCP hosts can run the bundled stdio server with Node.js. Documentation lookup searches a curated official catalog and reads linked Oracle pages. See [MCP setup, tools and examples](docs/MCP.md).

## SuiteCloud project workflows

SuperSuite's **SuiteCloud** commands support creating an Account Customization Project, selecting an existing ACP/SuiteApp project, authentication, interactive object/file imports, validation, configured unit tests, and deployment previews. **SuiteCloud: Deploy Project** runs a dry run, presents the target for review, and checks that project contents have not changed before deployment. It uses Oracle's CLI and keeps your SDF project separate from the private Init bootstrap project.

Use these commands for SDF objects, manifests and SuiteApps; use RESTlet transfers for File Cabinet files. A repository containing `src/FileCabinet/SuiteScripts` needs that folder mapped correctly before ordinary RESTlet transfers. Installation prerequisites, supported project layouts, and workflow examples are in the [SuiteCloud guide](docs/SUITECLOUD.md), based on [Oracle's SDK](https://github.com/oracle/netsuite-suitecloud-sdk).

## Business record snapshots

Choose record types during Init, or run **SuperSuite: Export Business Records** later. Supported types are customers, sales orders, invoices, vendors, contacts, purchase orders, vendor bills, credit memos, cash sales, and customer payments. Each type is exported only as visible to the authenticated integration role.

Requests load up to five records at a time, with governance and response-size limits. A run is saved under `.supersuite-data/<run-id>/`, containing `manifest.json` and `<record-type>/<internal-id>.json` files. SuperSuite adds `.supersuite-data/` to `.gitignore` before writing snapshots. These files contain business data in plaintext; Git exclusion does not encrypt them or remove previously tracked copies. Hidden paths are protected from ordinary File Cabinet push commands.

The manifest records progress, failures, and incomplete records. Cancelled or partial runs resume from saved IDs when the connection and selected record types match. Failed or incomplete records are retried; completed records are retained. After a completed run, another export creates a fresh run. Review `.error.json` markers and record `issues` when an export remains partial.

Snapshots include accessible body values, sublist rows, and subrecords within bounded traversal limits. Unavailable fields, omitted credential fields, deep subrecords, and sublist limits are reported rather than treated as a complete export. Records above the 3 MiB budget fail individually. Changes made in NetSuite during an export can appear at different times across records.

This is a read-only snapshot feature, **not a complete account backup or restore system**. It does not export every record type, custom object definition, attached file, or system history, and it does not import JSON snapshots back into NetSuite. Field-ID discovery is separate and stores metadata without record values.

## Connection and credentials

The workspace file contains connection settings, never credentials:

```json
{
  "restlet": "https://1234567-sb1.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=123&deploy=1",
  "realm": "1234567_SB1",
  "authType": "tba",
  "rootDirectory": "SuiteScripts/MyProject",
  "batchSize": 10,
  "maxBatchBytes": 1048576,
  "timeoutMs": 60000,
  "maxRetries": 3,
  "exclude": ["**/node_modules/**", "**/.*/**", "**/*.vsix", "**/*.pem", "**/*.key"],
  "metadataRecordTypes": ["salesorder", "customer"]
}
```

The same properties can be set under `supersuite.*` in VS Code settings. `.config/supersuite.json` takes precedence. JSON validation is included. Configure each workspace root separately; the active file or Explorer selection determines the account used by a transfer.

**Token-based authentication (TBA):** set `authType` to `tba`. Configure Credentials asks for the integration consumer key/secret and token ID/secret, then stores them in VS Code SecretStorage. Each request uses a fresh nonce and HMAC-SHA256 signature; OAuth headers are never logged. The integration role and deployment audience must authorize the operation.

**OAuth 2.0 bearer authentication:** set `authType` to `oauth2`, obtain an access token through your authorized NetSuite OAuth 2.0 flow with the `restlets` scope, and use Configure Credentials to store it. RESTlet token acquisition, consent, and refresh remain external, including certificate-based machine-to-machine acquisition. Oracle's separate SuiteCloud browser login authorizes deployment and does not supply a RESTlet access token. When a token expires, obtain a new one and replace it with Configure Credentials. Authentication failures are not retried. See Oracle's [RESTlet OAuth 2.0 guide](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_158263562006.html).

Oracle recommends OAuth 2.0 for new integrations and has announced restrictions on new TBA integrations beginning in 2027.1. Existing TBA support here is retained for migration; consult Oracle's [current authentication lifecycle guidance](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_158921905537.html) when choosing your integration. NLAuth/password headers are no longer supported by SuperSuite.

Credentials are bound to the workspace, endpoint, realm, and authentication method. Changing those settings requires configuring credentials for the new connection. **Clear Credentials** removes the current connection's stored credentials. **Migrate Legacy Credentials** moves complete `netSuiteUpload.*` TBA credentials into SecretStorage and removes the selected folder's plaintext credential settings. Shared workspace/user settings are retained for other projects; migrate those projects, then remove the shared plaintext copies. Copies in backups or Git history must be removed separately.

## Reliable transfers

One transfer request runs at a time per workspace. The default upload batch is at most 10 files and 1 MiB of serialized JSON; configure up to 20 files and 4 MiB. Pulls use the same file-count bound and a server-enforced 4 MiB response budget. File contents are loaded one bounded group at a time. A single file is not split across requests: files above the RESTlet's 3 MiB raw-file limit, or the configured JSON batch budget after encoding, are reported as failures. Increase `maxBatchBytes` within its limit when appropriate; use SuiteCloud/SDF or the File Cabinet UI for larger files.

The client uses bounded exponential backoff for transient network, concurrency, and service failures. Byte-budget and governance failures retry only affected items in smaller requests. Successful items are retained in the summary. A lost response can mean a push already completed remotely; replay uses a path-based overwrite, so transfers are **not** exactly-once transactions. The RESTlet uses documented `N/file.copy` overwrite behavior and cleans up its own staging files. See [RESTlet lifecycle details](netSuiteRestlet/README.md).

Pulls validate paths and responses, skip dirty editors, and replace each completed local file through a temporary file and rename. Binary data is transferred as base64; supported text files use UTF-8. Pushes skip unsaved files rather than silently saving your editor. **Retry Failed Files** reprocesses the last transfer's failed paths using current local content. Cancelled or interrupted folder enumeration can leave unvisited files; rerun the folder command to include them. Completed files are not rolled back.

Folder transfers preserve remote/local files not included in the operation. Empty local folders are created remotely only when their first file is pushed. Transfers do not synchronize deletions, move script deployments, or resolve concurrent edits by other users. Use **Compare File with NetSuite** before replacing changes you want to inspect; it opens a read-only remote snapshot without a temporary-folder setting. Remote deletion is a separate, confirmed single-file command.

Hidden paths (including `.config`, `.git`, and `.env`), `node_modules`, private-key files, and symbolic links are protected. Extra `exclude` patterns apply to folder transfers. Workspace Trust is required for configuration and NetSuite connections. The deployment's optional `custscript_supersuite_root` parameter independently restricts server access; client settings alone are not an authorization boundary.

## SuiteScript editing

Run **SuperSuite: Create SuiteScript** to choose a script type and SuiteScript 2.0 or 2.1. The generated 2.0 templates use ES5 syntax; 2.1 templates use modern JavaScript. Choose the version supported by your deployment context. Run **Build SuiteScript Header** for an existing JavaScript file, or use the `ss20-header`/`ss21-header` snippets.

Examples of snippet prefixes:

| Prefix | Result |
| --- | --- |
| `ss20-userevent`, `ss21-userevent` | User Event script and entry points |
| `ss20-client`, `ss21-client` | Client script with validation return values |
| `ss20-mapreduce`, `ss21-mapreduce` | Map/Reduce entry points and restart reminders |
| `ss20-restlet`, `ss21-restlet` | RESTlet handlers |
| `ss-getvalue`, `ss-setvalue` | Field-access option objects |
| `ss-search-paged` | Paged search loop |
| `ss-jsdoc` | Function documentation |

**Add NetSuite Module** and **Add Custom Module** insert the dependency path and factory parameter in one undoable edit. Duplicate dependencies are detected. In a SuiteScript AMD module, selecting an API completion such as `record.load` can add the matching `N/record` import and insert its options. Existing aliases are respected. Dynamic dependency arrays, malformed JavaScript, ambiguous factories, or conflicting bindings are rejected without rewriting the file.

Every currently supported module in Oracle's module reference has import support, API starters, and linked documentation, including nested modules such as `N/crypto/random` and `N/task/accounting/recognition`. The catalog records version, script-context, and permission requirements; suggestions use your header to filter incompatible modules and methods. `N/commerce` is represented by its documented `N/commerce/recordView` module, and retired `N/sso` is documented without being offered for new imports. See the [complete module coverage table](docs/MODULES.md).

API starters help build calls and option objects; they do not provide exhaustive instance-method signatures or account-aware type checking. Feature availability and permissions still depend on your NetSuite account. SuiteScript annotations, AMD rules and script types follow Oracle's [entry-point/module documentation](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4387811519.html) and [JSDoc guidance](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/bridgehead_4387808822.html).

## Account field ID completions

1. Set `metadataRecordTypes` to record type IDs such as `salesorder`, `customer`, or `customrecord_project`.
2. Run **SuperSuite: Refresh Account Field IDs**. If no types are configured, the command prompts for one type and an optional existing record internal ID.
3. In a SuiteScript file, type inside an option such as `fieldId: 'custbody_` and invoke completion.

The RESTlet inspects accessible record body fields through `N/record` and returns IDs, labels and types. It does not save records or return field values. Results are cached in VS Code workspace state, isolated by connection, and available offline while editing. Enable `supersuite.autoRefreshMetadata` to refresh configured types on activation in a trusted workspace; it is off by default. Refresh explicitly after changing customizations, role permissions or forms.

Discovery reflects the connected role and the selected/new record. Some record types require a sample record or defaults and cannot be inspected by creating a new record. Form-specific fields can vary. This release discovers **body fields**, not every sublist, saved-search column, or field in the account. It does not infer the type of every record variable, so cached candidates include their record type for context.

## Development and automated releases

Use Node.js 22.13 or newer (Node 24 is recommended):

```sh
npm ci --ignore-scripts
npm run check
npm run test:integration
npm run package
```

`check` runs lint plus offline tests for OAuth signatures, transport failures, batching, filesystem boundaries, configuration, setup/resume flows, SDF project generation, CLI task cancellation, record-export checkpoints, editor changes, and mocked NetSuite APIs. Integration tests launch isolated VS Code extension hosts. On headless Linux, run `xvfb-run -a npm run test:integration`. Set `VSCODE_VERSION=insiders` or a specific version to select a host. The installable artifact is `supersuite.vsix`.

GitHub CI runs offline tests on Windows, macOS and Linux with Node 22/24, and extension-host tests against the minimum VS Code version, current stable and Insiders. Packaging waits for those jobs. A pushed `vX.Y.Z` tag matching `package.json` runs the checks and publishes the tested VSIX to `fadyfaheem.supersuite` through Marketplace OIDC trusted publishing. One-time publisher/workflow authorization is required; see [PUBLISHING.md](PUBLISHING.md).

Live SDF deployment and account imports have not been verified by these offline tests. NetSuite permissions, authentication, record visibility, and file behavior must be checked in a sandbox before production use. Automated RESTlet tests mock NetSuite APIs and cannot establish account-specific behavior. Follow [MANUAL_TESTS.md](MANUAL_TESTS.md) for the release smoke test.

## Migration from NetSuite Upload

SuperSuite is a new extension identity, not an automatic upgrade of `nsupload-org.netsuite-upload`. Disable the old extension before enabling this one. Existing `netsuite-upload.*` command bindings remain aliases, and legacy URL/realm/root settings can seed configuration. Use Configure Workspace and Migrate Legacy Credentials, deploy the new RESTlet, then test the connection. NLAuth and the old temporary diff folder setting are not used.

The original project is credited in the MIT [LICENSE](LICENSE).
