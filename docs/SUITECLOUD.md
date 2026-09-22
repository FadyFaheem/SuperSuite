# SuiteCloud projects in SuperSuite

SuperSuite runs Oracle's installed SuiteCloud CLI in visible VS Code task terminals. Use it to manage SDF files and custom-object definitions alongside the RESTlet file-transfer and record-inspection features. Oracle's [SuiteCloud SDK repository](https://github.com/oracle/netsuite-suitecloud-sdk) is the source for the CLI, its VS Code extension, and the SuiteScript unit-testing tools.

## Install the tools

Install the Oracle SuiteCloud CLI and its prerequisites on the computer where the VS Code workspace runs. For Remote SSH or a development container, that means the remote host. The current SDK repository specifies Node.js 24 LTS and Oracle JDK 17 or 21; check the [CLI installation instructions](https://github.com/oracle/netsuite-suitecloud-sdk/tree/master/packages/node-cli) for the version you install and its NetSuite release compatibility. Oracle's Help Center prerequisites may describe an earlier CLI release.

After reviewing Oracle's installation and license instructions, install the CLI in your terminal:

```sh
npm install -g @oracle/suitecloud-cli
suitecloud --version
```

SuperSuite does not install packages, accept Oracle's license, create certificates, or change machine-wide configuration for you. Restart VS Code if a newly installed CLI is not found on PATH. The CLI uses its own account authentication; your RESTlet token in VS Code SecretStorage does not automatically authenticate SDF.

## Start or select a project

1. Open your repository and trust its code. SuiteCloud configuration hooks, project tests, and npm lifecycle scripts execute as local code.
2. Run **SuperSuite: SuiteCloud: Create Account Customization Project**. Choose a new folder name. This invokes Oracle's non-interactive ACP generator without overwriting an existing directory or installing test dependencies.
3. Alternatively, run **SuiteCloud: Select Project** for an existing ACP or SuiteApp. Choose the folder containing `suitecloud.config.js`, usually with `src/manifest.xml` and `src/deploy.xml`. The selection is remembered separately for each workspace folder.
4. Run **SuiteCloud: Authenticate Project**, and choose browser sign-in or an existing Oracle CLI authentication ID. In the browser/terminal, select the intended account and role and finish Oracle's prompts. Browser authentication is not supported in WSL; use an existing supported CLI authentication configuration or run the tools on a supported host.
5. Run **SuiteCloud: Import Objects** or **SuiteCloud: Import Files**. Select items and accept any overwrite confirmation in the task terminal. Save open files first.

The project must be inside the chosen workspace. SuperSuite accepts a single literal `module.exports` object in `suitecloud.config.js`, with a literal `defaultProjectFolder`, optional directives, static settings, and inline command hooks. Selecting it only parses the JavaScript and does not run it. Additional top-level statements, computed values, spreads, accessors and command-specific `projectFolder` overrides are rejected so the inspected source folder matches the exported configuration. Advanced configuration can still be used directly through Oracle's CLI. The wizard's private `.config/supersuite-sdf` deployment bundle is managed by **Init / Resume Setup**, separately from your application project.

The ordinary RESTlet push/pull commands map the selected workspace root to its configured NetSuite folder. SDF commands use the selected SuiteCloud project and its `src/FileCabinet`, `src/Objects`, manifest and deployment files. When mixing both workflows, open the relevant `FileCabinet/SuiteScripts` directory as a separate workspace folder and configure its RESTlet root before using folder push/pull there. A full SDF project root should be deployed through SuiteCloud.

## Import and validate

| SuperSuite command | Oracle command | Effect |
| --- | --- | --- |
| Create Account Customization Project | `suitecloud project:create --type ACCOUNTCUSTOMIZATION --projectname <name>` | Creates a new local ACP directory. |
| Authenticate Project: browser | `suitecloud account:setup --interactive` | Connects the project to an account/role through Oracle's browser flow. |
| Authenticate Project: existing ID | `suitecloud account:setup:ci --select <alias>` | Selects a previously authorized CLI account/role alias. |
| Import Objects | `suitecloud object:import --interactive` | Imports selected SDF definitions and, for ACPs, their referenced scripts by default. |
| Import Files | `suitecloud file:import --interactive` | Imports selected File Cabinet files into an ACP. Oracle does not support this operation for SuiteApp projects. |
| Validate Project | `suitecloud project:validate` | Runs Oracle's default project validation. |
| Preview Deployment | `suitecloud project:deploy --dryrun` | Previews the project deployment without deploying it. |
| Deploy Project | Dry run, review confirmation, then `suitecloud project:deploy` | Deploys the reviewed project using its configured account and deployment definition. |
| Run Unit Tests | `npm test` | Runs the existing local SuiteCloud test setup. |

Importing SDF objects brings their customization definitions into source control. Customer, invoice and other ordinary business-record snapshots use **Export Business Records** or read-only MCP inspection; SDF object import is not a general record backup. Oracle describes the supported behavior in [object:import](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_156042181820.html), [file:import](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_156041963273.html), and [project:validate](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_156049843194.html).

## Review and deploy

Save your project, validate it, and run **SuiteCloud: Deploy Project**. Review the dry-run terminal's account, role, and proposed deployment, then choose **Deploy Project** in the confirmation. The selected project's `project.json` authentication ID and `deploy.xml` control the target and included components. The default Oracle settings treat account-specific values as errors and do not apply SuiteApp installation preferences. See [project:deploy](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_156044636320.html).

SuperSuite stops if project files change between preview and deployment. It also refuses dirty editors, linked project files, simultaneous operations for the same workspace, and projects exceeding its inspection limits of 20,000 files or 128 MiB. For projects outside these limits, review and use Oracle's CLI directly. Project hooks are trusted code: inspect them before running commands, including preview and validation. Hooks that rewrite project files during preview require reviewing the changes and starting the deployment again.

Each operation is cancellable through the VS Code progress notification. Cancel terminates only the task started by SuperSuite; it does not undo changes already completed by Oracle's CLI or NetSuite. The 15-minute task timeout also stops its owned task. Inspect the task terminal and account deployment history before retrying an interrupted deployment.

## SuiteScript unit tests

Run **SuiteCloud: Run Unit Tests** after configuring the selected project with a `test` script, `@oracle/suitecloud-unit-testing`, and installed dependencies. It never invokes `npx` or downloads missing packages. Review and install your project's dependencies yourself using your normal package-lock workflow.

Oracle's [unit-testing guide](https://github.com/oracle/netsuite-suitecloud-sdk/tree/master/packages/unit-testing) explains Jest configuration, SuiteScript module stubs and custom stubs. These are local mocked tests; they do not execute a script against a live NetSuite record. Use read-only record inspection to obtain representative input, write a test around that input, and validate deployment in a sandbox before production.

## Authentication and verification

Credentials stay in Oracle's CLI authentication storage. SuperSuite passes only an existing alias or starts the browser flow; it does not place tokens, private keys or certificate material in task arguments. The complete authentication options are documented under [account:setup](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_89132630266.html) and [account:setup:ci](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_81134826821.html).

Automated extension tests cover command selection, argument validation, project guards, preview/approval sequencing and task cancellation. Live authentication, import, deployment and account permissions still require validation in your own NetSuite sandbox.
