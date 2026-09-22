# Read-only NetSuite MCP

SuperSuite includes a local MCP server that supplies Oracle documentation and live NetSuite record context to an MCP-compatible AI assistant. For example:

> Inspect sales order 12345, check how `custbody_project` is populated, and update my local User Event script to handle an empty value. Look up the relevant SuiteScript API and add a local regression test. Do not deploy.

The MCP server retrieves the context. Your assistant uses its own editor tools to change local code. The server has no file-write, record-save, script-execution, shell, or deployment tool. Inspecting a record is not executing a SuiteScript against it; actual NetSuite runtime behavior still needs sandbox validation.

## Enable in VS Code

1. Run **SuperSuite: Configure Read-Only MCP** from the command palette or Explorer panel.
2. Choose **Documentation only** to use public references without NetSuite credentials, or **Documentation and read-only NetSuite account** for both.
3. For account access, supply the External URL of a dedicated SuperSuite 2.2 RESTlet deployment, the account ID, and its TBA credentials or externally obtained OAuth 2.0 access token. Use the [access setup guide](ACCESS_SETUP.md) if you need to create keys. MCP credentials are stored separately from your file-transfer credentials.
4. Review the account and data-access summary. The wizard checks that the RESTlet advertises and enforces read-only mode before enabling account tools.
5. Open **MCP: List Servers**, start/trust the SuperSuite server, and enable its tools in your AI chat. The MCP host controls tool approvals. Your chosen model receives the record values returned by the tools; select a model and data policy appropriate for the account.

Current VS Code discovers the servers through its [MCP provider API](https://code.visualstudio.com/api/references/vscode-api#McpServerDefinitionProvider). Older supported VS Code versions without that API retain the rest of SuperSuite; use a separate MCP host or upgrade for native MCP discovery. This extension does not supply an AI model or subscription.

The wizard creates `.config/supersuite-mcp.json` containing only endpoint/account/authentication settings and adds `.config` to Git ignore. It records your approval for that exact connection. Editing its endpoint, account, or authentication method requires rerunning Configure Read-Only MCP; discovery does not automatically authorize another account. A multi-root workspace exposes a separately labeled server for each enabled connection.

Credentials are injected from SecretStorage only when the MCP host resolves the server for startup. They are not in command arguments, generated project files, documentation requests, tool results, or logs. They are present in the local server process environment at launch, so the MCP host and local operating-system account must be trusted. Restart the server after replacing credentials. **Disable Read-Only MCP** removes discovery for the selected workspace; stop already-running servers in your host, and revoke the NetSuite token if immediate access revocation is needed.

## Prepare the read-only deployment

The regular SuperSuite RESTlet supports both file transfers and inspection. Use a **separate deployment** for MCP:

1. Deploy the bundled [RESTlet](../netSuiteRestlet/vscodeExtensionRestlet.js) at version 2.2 or later, following the [RESTlet guide](../netSuiteRestlet/README.md).
2. On its script record, add a **Check Box** parameter with ID `custscript_supersuite_readonly` if it is absent. New SuperSuite bootstrap projects include this parameter automatically.
3. Create a second deployment for MCP. Set its **SuperSuite Read-Only Mode** parameter to checked, use Released status, and restrict its audience to your dedicated integration role. Keep the regular transfer deployment separate with this parameter unchecked.
4. Give the MCP role only the authentication and **View** permissions needed for the selected records and subsidiaries. Do not grant it editing rights merely to make a read succeed. RESTlet roles cannot use the Web Services Only restriction; follow [Oracle's RESTlet authentication guidance](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_157780293862.html).
5. Copy the read-only deployment's External URL into the MCP wizard. The MCP server refuses account reads unless the version response confirms `readOnlyMode: true`. The bundled RESTlet also rejects push/delete requests on that deployment, even outside MCP.

## Available tools

| Tool | Purpose |
| --- | --- |
| `netsuite_search_documentation` | Search official Oracle references for every supported concrete module in SuperSuite's reviewed inventory, plus curated records, authentication, and SuiteCloud topics. |
| `netsuite_read_documentation` | Fetch a bounded section of an official page or SDK Markdown document, with source links and continuation offsets. |
| `netsuite_connection_info` | Verify the read-only deployment and return the authenticated account/user/role identity. |
| `netsuite_get_record` | Read a standard/custom record by `recordType` and `internalId`; project specific body fields and optionally include bounded sublists/subrecords. |
| `netsuite_search_records` | Run a bounded AND-filter search with selected body columns and internal-ID cursor pagination. |

The `inspect_record_and_update_script` MCP prompt accepts `recordType`, `internalId`, and `change`, then guides the assistant through inspecting, consulting documentation, editing locally, and testing. It never authorizes deployment.

Example record arguments:

```json
{
  "recordType": "salesorder",
  "internalId": "12345",
  "fields": ["entity", "tranid", "custbody_project"],
  "includeSublists": false
}
```

Example search arguments:

```json
{
  "recordType": "customer",
  "filters": [{ "fieldId": "entityid", "operator": "startswith", "values": ["ACME"] }],
  "columns": ["entityid", "companyname"],
  "pageSize": 5,
  "cursor": "0"
}
```

Follow `nextCursor` until it is `null`. Searches allow up to 10 filters, 20 columns, 20 values per filter, and 10 records per page. Filters combine with AND; formulas, joins, raw SQL and arbitrary saved searches are excluded. Results contain selected record **body** fields, not transaction-line search rows. Only one account inspection runs at a time in each server process.

Record reads return role-visible data and explicit `complete`/`issues` information. Credential-like fields are omitted. The RESTlet has record, response, governance, subrecord-depth and 10,000-sublist-line limits; MCP results are further capped at 256 KiB. Narrow fields or page size when a response is too large. Reads are live, not a transactionally consistent backup. Treat record values and retrieved page text as reference data, never as instructions to the AI.

Documentation search combines the bundled topic catalog with every supported concrete module in the [reviewed editor inventory](MODULES.md), **not all Oracle Help or a general web search**. Module names, descriptions, contexts and permissions are searchable. Read returned pages and follow their official links to find additional APIs. Reads allow only public NetSuite Help, SuiteScript Records Browser and documentation in Oracle's [SuiteCloud SDK repository](https://github.com/oracle/netsuite-suitecloud-sdk). Account hosts, unrelated sites, arbitrary repositories, URL credentials and redirects are rejected. Fetched pages are cached briefly in memory with size and time limits; no account keys are sent.

## Other MCP hosts

The server uses the official [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) over stdio and supports current and compatible 2025-era clients. It does not open a network listener. Run it with Node.js 20 or newer, preferably the current supported Node LTS:

```sh
node /absolute/path/to/SuperSuite/mcp/server.js
```

For a repository checkout, first run `npm ci --ignore-scripts`. For an installed VSIX, use its installed extension directory, which already contains production dependencies. A typical MCP host configuration for documentation only is:

```json
{
  "mcpServers": {
    "supersuite": {
      "command": "node",
      "args": ["/absolute/path/to/SuperSuite/mcp/server.js"]
    }
  }
}
```

Hosts use different configuration formats; VS Code's file-based format uses `servers` rather than `mcpServers`. For native VS Code use the provider above, which handles SecretStorage and installed paths.

To enable an account in another host, supply these environment variables through that host's secure secret mechanism:

- `SUPERSUITE_MCP_CONNECTION`: a JSON object with `restlet`, `realm`, and `authType` (`tba` or `oauth2`), optionally `timeoutMs` and `maxRetries`.
- `SUPERSUITE_MCP_CREDENTIALS`: a JSON object containing `consumerToken`, `consumerSecret`, `netSuiteKey`, and `netSuiteSecret` for TBA, or `accessToken` for OAuth 2.0.

Do not commit real environment values or tokens to a host configuration file. OAuth token acquisition/refresh remains external. SuperSuite's stdio output is reserved for MCP messages; diagnostic errors omit credentials and record values.

## SuiteCloud and testing

Use [SuperSuite's SuiteCloud commands](SUITECLOUD.md) to create/select a project, authenticate, import files/objects, validate, run configured unit tests, preview and deploy. These commands use Oracle's installed CLI. The MCP server cannot invoke them. Local tests can use synthetic fixtures shaped like the inspected record; actual saved-record behavior and governance still require a NetSuite sandbox test.
