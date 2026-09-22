# SuiteScript module coverage

SuperSuite covers every entry in the supplied Oracle module-reference table: **54 currently supported concrete modules** have import completion, unique default aliases, descriptions, Oracle reference links, context/version metadata, and **268 documented synchronous top-level method starters**. The catalog was reviewed against the linked Oracle references on **September 22, 2026**.

Two reference-table entries are handled explicitly:

- **N/commerce is a namespace, not an importable module.** SuperSuite suggests the documented concrete module **N/commerce/recordView**. It requires an active shopping session and a supported SuiteCommerce release. See [Oracle's commerce namespace reference](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_1532341439.html).
- **N/sso is retired.** Oracle ended SuiteSignOn and N/sso support in NetSuite 2025.1. The catalog retains a migration note but offers no new imports or method starters for it. See the [Oracle module reference](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/chapter_4220488571.html).

## Using the catalog

Type an `N/` path in a dependency list, use **SuperSuite: Add NetSuite Module**, or use module/member completions while editing a SuiteScript file. SuperSuite keeps AMD dependency paths aligned with factory parameters. Imported aliases are honored; the catalog's default alias is used for a new import. Member starters insert a call with editable placeholders. They do not run the call, supply account secrets, or choose account-specific records for you.

For example, `cache.getCache` supplies the required `name` option; `recordView.viewItems` supplies `ids` and `fields`; `productionCharges.updateChargesToCustomUnitCost` supplies `transactionId`, `transactionLineIds`, and `newUnitCost`. Complex values such as dataset columns, workbook axes, and cryptographic key handles are placeholders for values you must build with the documented APIs. Every method starter links to its individual Oracle API page.

The editor reads `@NApiVersion` and `@NScriptType`. Known client scripts exclude server-only modules, RESTlet-specific APIs are limited to RESTlets, and known SuiteScript 2.0/2.x scripts exclude documented 2.1-only modules. `N/crypto/random` remains available in 2.0 client scripts but requires 2.1 in server scripts. `N/manufacturing/productionCharges` is also server-side 2.1 only, as its [module page](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_1110531599.html) states even though the summary table leaves that cell blank.

Method-specific context restrictions also apply. For example, client scripts can use ordinary HTTPS methods but do not get server-only RESTlet request methods. `N/redirect` is limited to Suitelets and qualifying user events. Its exact entry-point and UI-trigger restrictions still need developer review: a header alone cannot distinguish a synchronous `afterSubmit` from an asynchronous invocation. The same limitation applies to `beforeLoad` UI construction.

Custom modules and files without a recognized script-type header have an unknown execution context, so available modules remain discoverable with their restriction notes. A custom module can later be called from different script types; the editor cannot infer every caller. An unrecognized or missing API-version header likewise does not prove 2.0 compatibility. Add the correct header to narrow suggestions.

## Scope and limits

This is a curated editor catalog, not a replacement for Oracle's SDK reference or a complete type checker. Coverage includes documented top-level synchronous functions selected from the module pages. It does not promise every promise overload, instance method, enum member, object property, optional parameter, API signature alternative, or newly released API. The linked Oracle page remains authoritative. `Since` values identify NetSuite releases, not SuiteScript language versions.

Three legacy quota helpers remain discoverable and are marked deprecated: `documentCapture.getRemainingFreeUsage()`, `llm.getRemainingFreeUsage()`, and `llm.getRemainingFreeEmbedUsage()`. Oracle recommends `llm.getRemainingUsage()` for remaining NetSuite AI Units; using that replacement from document-capture code requires importing `N/llm`. The old methods are included in the 268-starter count, with replacement guidance and their original Oracle references.

Required options are included for a documented starter path. Where Oracle supports mutually exclusive alternatives, starters choose one: API-secret references for secret-key/SFTP authentication, a field ID for a dataset column, and type/ID inputs for record-context discovery. Optional and conditional inputs still depend on the operation. Replace placeholder variables with actual values before execution. The snippets parse as ES5, including those for modules whose runtime requires 2.1; syntax compatibility does not override module availability.

Permissions listed in the catalog summarize the module reference and notable prerequisites. They are not a grant and do not mean every listed permission is required by every method. Account features, subsidiary restrictions, script deployment roles, forms, governance, available models, certificates, and service quotas can further limit an API. Server-side record changes, personal-information removal, credential changes, task submission, and external requests still require deliberate review and sandbox testing. Completion suggestions themselves perform no NetSuite writes.

The checked-in data is in `editor/moduleMetadata.json` and `editor/methodCatalog.json`; `editor/catalog.js` applies availability rules. Tests account for every supplied reference entry, check unique aliases and source links, parse all 268 method starters as ES5, validate required option placeholders, and exercise context/version restrictions. Extension integration tests separately verify imports and member completion for every current module. Live API behavior requires a suitable NetSuite account.

## Current modules

The method count is the number of starters included in this release. Follow each module link for its complete reference and prerequisites.

| Module | Default alias | Context | API version | Starters |
| --- | --- | --- | --- | --- |
| [N/action](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_1510761537.html) | action | client, server | 2.0+ | 5 |
| [N/auth](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4296360422.html) | auth | server | 2.0+ | 2 |
| [N/cache](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4642573343.html) | cache | server | 2.0+ | 1 |
| [N/certificateControl](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_1547247950.html) | certificateControl | server | 2.0+ | 7 |
| [N/commerce/recordView](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_1532341950.html) | recordView | client, server | 2.0+ | 2 |
| [N/compress](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_158584507367.html) | compress | server | 2.0+ | 3 |
| [N/config](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4261803800.html) | config | server | 2.0+ | 1 |
| [N/crypto](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4358549582.html) | crypto | server | 2.0+ | 6 |
| [N/crypto/certificate](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_1543432423.html) | certificate | server | 2.0+ | 4 |
| [N/crypto/random](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_13113107585.html) | random | client, server | 2.0 client / 2.1 server | 3 |
| [N/currency](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4358551775.html) | currency | client, server | 2.0+ | 1 |
| [N/currentRecord](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4625600928.html) | currentRecord | client | 2.0+ | 1 |
| [N/dataset](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_158946741680.html) | dataset | server | 2.0+ | 9 |
| [N/documentCapture](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_8134325498.html) | documentCapture | server | 2.1+ | 5 |
| [N/email](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4358552361.html) | email | client, server | 2.0+ | 3 |
| [N/encode](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4369847722.html) | encode | server | 2.0+ | 1 |
| [N/error](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4243798608.html) | error | server | 2.0+ | 1 |
| [N/file](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4205693274.html) | file | server | 2.0+ | 4 |
| [N/format](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4388721627.html) | format | client, server | 2.0+ | 2 |
| [N/format/i18n](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_1543861741.html) | i18n | client, server | 2.0+ | 5 |
| [N/http](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4296361104.html) | http | client, server | 2.0+ | 5 |
| [N/https](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4418229131.html) | https | client, server | 2.0+ | 10 |
| [N/https/clientCertificate](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_1543986321.html) | clientCertificate | server | 2.0+ | 5 |
| [N/keyControl](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_1557413213.html) | keyControl | server | 2.0+ | 6 |
| [N/llm](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_9123730083.html) | llm | server | 2.1+ | 13 |
| [N/log](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4574548135.html) | log | client, server | 2.0+ | 4 |
| [N/machineTranslation](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_3151132758.html) | machineTranslation | server | 2.1+ | 2 |
| [N/manufacturing/productionCharges](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_1110531599.html) | productionCharges | server | 2.1+ | 3 |
| [N/pgp](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_5095832176.html) | pgp | server | 2.1+ | 7 |
| [N/piremoval](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_156173791240.html) | piremoval | server | 2.0+ | 4 |
| [N/plugin](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4558176297.html) | plugin | server | 2.0+ | 2 |
| [N/portlet](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4473510730.html) | portlet | client | 2.0+ | 2 |
| [N/query](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_1510275060.html) | query | client, server | 2.0+ | 8 |
| [N/record](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4267255811.html) | record | client, server | 2.0+ | 8 |
| [N/recordContext](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_158627324548.html) | recordContext | client, server | 2.0+ | 1 |
| [N/redirect](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4424286105.html) | redirect | server (Suitelet, UserEventScript) | 2.0+ | 9 |
| [N/render](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4412042824.html) | render | server | 2.0+ | 8 |
| [N/runtime](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4296359529.html) | runtime | client, server | 2.0+ | 5 |
| [N/scriptTypes/restlet](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_4130555042.html) | restlet | restlet | 2.0+ | 1 |
| [N/search](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4345764122.html) | search | client, server | 2.0+ | 9 |
| [N/sftp](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4617004932.html) | sftp | server | 2.0+ | 1 |
| [N/suiteAppInfo](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_160236086332.html) | suiteAppInfo | client, server | 2.0+ | 6 |
| [N/task](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4345787858.html) | task | server | 2.0+ | 2 |
| [N/task/accounting/recognition](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_1554472720.html) | recognition | server | 2.0+ | 2 |
| [N/transaction](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4413162576.html) | transaction | client, server | 2.0+ | 1 |
| [N/translation](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_1538666156.html) | translation | client, server | 2.0+ | 3 |
| [N/ui/dialog](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4497725142.html) | dialog | client | 2.0+ | 3 |
| [N/ui/message](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4497735093.html) | message | client | 2.0+ | 1 |
| [N/ui/serverWidget](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4321345532.html) | serverWidget | server (Suitelet, UserEventScript) | 2.0+ | 3 |
| [N/url](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4358552918.html) | url | client, server | 2.0+ | 5 |
| [N/util](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4569538303.html) | util | client, server | 2.0+ | 11 |
| [N/workbook](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_159006350818.html) | workbook | server | 2.0+ | 48 |
| [N/workflow](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4341725558.html) | workflow | server | 2.0+ | 2 |
| [N/xml](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4344917661.html) | xml | client, server | 2.0+ | 2 |
