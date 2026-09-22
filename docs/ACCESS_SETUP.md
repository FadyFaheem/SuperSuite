# SuperSuite access setup

Keep this guide open beside the **SuperSuite: Init: Set Up and Import** wizard. The wizard collects each value separately, masks credentials, and saves them in VS Code SecretStorage. You can close a prompt and run **Init / Resume Setup** later. An unfinished credential form does not replace saved credentials.

SuperSuite guides you through account authorization; it does not create NetSuite users, integration records, roles, or keys on your behalf. An account administrator may need to complete the NetSuite steps below. Start in a sandbox and use a role limited to the files and records you intend to access.

## 1. Choose the account and RESTlet

Open an empty local folder in VS Code and click **Init / Resume Setup** in the SuperSuite Explorer panel. Choose one of these paths:

- **Deploy a new RESTlet with SuiteCloud:** generate a small deployment project and run Oracle's CLI in a visible VS Code task terminal.
- **Connect to an existing SuperSuite RESTlet:** paste its account-specific HTTPS External URL.
- **Prepare RESTlet for manual deployment:** generate the project and follow its README to deploy through NetSuite, then paste the External URL.

Enter the account ID (for example `1234567_SB1`) and the existing File Cabinet folder to import, such as `SuiteScripts` or `SuiteScripts/MyProject`. Use the sandbox's own account ID, URL and credentials. For a new deployment, enter the existing integration role's **script ID**, such as `customrole_supersuite`; a numeric role internal ID is a different value. The role must be in the RESTlet deployment audience. The wizard also accepts `DEVELOPER` for a developer sandbox role.

Choose the business record types to export and whether to fetch field IDs. Customers, sales orders and invoices are initially selected; deselect all types to import only files. Review the summary before starting.

## 2. Choose authentication

SuperSuite supports **TBA consumer/token credentials** and an **externally obtained OAuth 2.0 access token**. Oracle prefers OAuth 2.0 and has announced that new TBA integrations will be restricted beginning with NetSuite 2027.1; existing integrations continue under Oracle's lifecycle policy. See [Oracle's TBA integration guidance](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/bridgehead_4249032125.html).

### TBA: prepare the account and role

1. In NetSuite, open **Setup > Company > Enable Features > SuiteCloud**. Enable **Client SuiteScript**, **Server SuiteScript**, and **Token-based Authentication**, accepting any applicable terms, then save. [Oracle feature instructions](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/bridgehead_4253254429.html).
2. Ask your administrator to assign an integration role to your user. It needs **Log in using Access Tokens** (or **User Access Tokens**), plus permissions for the File Cabinet and selected records. **Access Token Management** alone permits token administration, not RESTlet login. [Oracle role instructions](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/bridgehead_4248124361.html).
3. Include that role in the RESTlet deployment audience. Use the least permissions needed for your intended pull/push/export operations; see the bundled [RESTlet deployment guide](../netSuiteRestlet/README.md).

### TBA: create the two credential pairs

1. Open **Setup > Integration > Manage Integrations > New**. Name the integration, leave its state **Enabled**, and enable **Token-based Authentication** on its Authentication subtab. Save and securely retain its **Consumer Key** and **Consumer Secret**, shown on initial creation. Use an existing authorized integration when appropriate; resetting shared credentials affects its other clients. [Oracle integration instructions](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/bridgehead_4249032125.html).
2. A user with **Access Token Management** opens **Setup > Users/Roles > Access Tokens > New Access Token**, chooses that application, your user, and the integration role, then saves. Retain the **Token ID** and **Token Secret** from the confirmation page; they cannot be retrieved after leaving it. Tokens are specific to the account and must be recreated after a sandbox refresh. [Oracle token instructions](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/bridgehead_4254081947.html).
3. Return to the wizard and choose **Enter Keys**. Paste, in order: consumer key, consumer secret, token ID, token secret. These are four different values. SuperSuite writes none of them to `.config`, the generated deployment project, Git, or task arguments.

### OAuth 2.0: prepare and supply an access token

1. Under **Setup > Company > Enable Features > SuiteCloud**, enable **Client SuiteScript**, **Server SuiteScript**, and **OAuth 2.0**. [Oracle feature instructions](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_157771482304.html).
2. Assign a role with **Log in using OAuth 2.0 Access Tokens** and the required file/record permissions. The administrative application-management permission alone does not authorize RESTlet access. [Oracle role instructions](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_157771510070.html).
3. Create or configure the integration under **Setup > Integration > Manage Integrations**. Enable the OAuth 2.0 flow used by your authorized token client and select the **RESTlets** scope. Its redirect URI or certificate setup belongs to that client. [Oracle integration instructions](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_157771733782.html).
4. Obtain an access token through your organization's authorized OAuth client with the `restlets` scope. SuperSuite does not implement the consent callback, token exchange, certificate signing, or automatic refresh. Follow [Oracle's authorization code flow](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_158074210415.html) or your organization's configured flow.
5. Choose **OAuth 2.0 access token** in Init, then paste the access token alone into the masked prompt. Do not paste a refresh token, client secret, or the `Bearer ` prefix. Replace an expired token with **Configure Credentials**, then resume Init.

RESTlets do not support roles marked **Web Services Only**. Sandbox and Release Preview OAuth applications require their own authorization, including after sandbox refreshes. [Oracle RESTlet authentication notes](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_157780293862.html).

## 3. Authorize RESTlet deployment

For automatic deployment, install Oracle's SuiteCloud CLI and its current prerequisites, then make `suitecloud` available to the VS Code task terminal. The wizard offers an installation-guide link. Oracle's browser-based CLI sign-in is a separate authorization from the RESTlet credentials entered above. Follow the account and role prompts in the visible terminal or select an already authorized CLI authentication ID. See the [SuiteCloud CLI guide](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/chapter_1558708800.html).

The wizard previews deployment first. Check the account and role in that terminal output, then choose **Deploy to This Account**. Only the generated RESTlet file, script record and deployment are in the deployment project. The wizard does not change your existing SDF project. Deployment requires an authorized SuiteCloud role and an existing target File Cabinet root.

For manual deployment, follow `.config/supersuite-sdf/README.md`, return to the prompt and choose **Deployment Is Ready**, then paste the deployment's External URL. Connecting to an existing RESTlet skips deployment.

## 4. Test and import

Init tests the connection before importing. A failed test lets you retry, edit the URL, or replace credentials. Then it pulls files in bounded batches, fetches selected field metadata, and exports selected business records to the Git-ignored `.supersuite-data` directory. Existing local files require confirmation before replacement.

Business exports are read-only JSON snapshots of accessible body fields, sublists and bounded subrecords. They are not a complete account backup and cannot be pushed back as records. Review the export manifest and incomplete-record issues; permission limits or a changing account can affect results. Git ignore prevents ordinary accidental commits, but local snapshots still contain business data and belong under your organization's access and retention controls.

Cancellation keeps completed local work. Run **Init / Resume Setup** to continue unfinished phases; business exports resume their saved cursors and retry failed/incomplete records. **SuperSuite: Show Output** provides diagnostics without printing credential or business-field values.
