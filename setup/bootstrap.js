'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { normalizeRemotePath } = require('../helpers/paths');
const { assertSafeLocalPath } = require('../helpers/localFiles');

const PROJECT_DIRECTORY = '.config/supersuite-sdf';
const MARKER = 'supersuite-bootstrap.json';
const GUIDE_URL = 'https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/chapter_1558708800.html';
const PREREQUISITES = 'Install Oracle SuiteCloud CLI for Node.js and its supported Node.js/Java prerequisites, accept Oracle’s SDK license, and enable SuiteCloud Development Framework, Server SuiteScript, and OAuth 2.0 in NetSuite. The deployment login needs the SuiteCloud Development Framework permission; the RESTlet role needs File Cabinet access and permission to authenticate to RESTlets. Browser authentication is separate from the RESTlet credentials and is not supported in WSL.';

function xml(value) {
    return String(value).replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
    })[character]);
}

function validateBootstrapOptions(options) {
    const realm = String(options.realm || '').trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9_-]{0,63}$/.test(realm)) throw new Error('Enter a NetSuite account ID, such as 1234567_SB1.');
    const rootDirectory = normalizeRemotePath(options.rootDirectory || 'SuiteScripts');
    if ((rootDirectory !== 'SuiteScripts' && !rootDirectory.startsWith('SuiteScripts/')) ||
        rootDirectory.length > 1024 || rootDirectory.includes('%') || rootDirectory.split('/').length > 32 ||
        rootDirectory.split('/').some(segment => segment.toLowerCase() === '.supersuite-staging')) {
        throw new Error('Choose SuiteScripts or an existing folder below SuiteScripts for the RESTlet root.');
    }
    const roleId = String(options.roleId || '').trim();
    if (roleId !== 'DEVELOPER' && !/^customrole_[a-z0-9_]{1,29}$/.test(roleId)) {
        throw new Error('Enter the integration role script ID (customrole_...), or DEVELOPER for the standard Developer role.');
    }
    return { realm, rootDirectory, roleId };
}

function descriptor(projectRoot, options, instance, created) {
    const scriptId = `customscript_supersuite_${instance}`;
    const deploymentId = `customdeploy_supersuite_${instance}`;
    const accountHost = options.realm.toLowerCase().replace(/_/g, '-');
    return {
        projectRoot, sourceRoot: path.join(projectRoot, 'src'), created,
        scriptId, deploymentId, ...options,
        scriptPath: `SuiteScripts/SuperSuite/setup_${instance}/vscodeExtensionRestlet.js`,
        restletUrl: `https://${accountHost}.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=${scriptId}&deploy=${deploymentId}`
    };
}

function projectFiles(info, restletSource) {
    const customRole = info.roleId.startsWith('customrole_');
    const role = customRole ? `[scriptid=${info.roleId}]` : info.roleId;
    return new Map([
        ['suitecloud.config.js', "module.exports = { defaultProjectFolder: 'src' };\n"],
        ['.gitignore', '*\n'],
        ['src/manifest.xml', `<?xml version="1.0" encoding="UTF-8"?>
<manifest projecttype="ACCOUNTCUSTOMIZATION">
    <projectname>SuperSuite Bootstrap</projectname>
    <frameworkversion>1.0</frameworkversion>
    <dependencies>
        <features><feature required="true">SERVERSIDESCRIPTING</feature></features>${customRole ? `
        <objects><object>${xml(info.roleId)}</object></objects>` : ''}
    </dependencies>
</manifest>
`],
        ['src/deploy.xml', `<?xml version="1.0" encoding="UTF-8"?>
<deploy>
    <files><path>~/FileCabinet/${xml(info.scriptPath)}</path></files>
    <objects><path>~/Objects/${info.scriptId}.xml</path></objects>
</deploy>
`],
        [`src/Objects/${info.scriptId}.xml`, `<?xml version="1.0" encoding="UTF-8"?>
<!-- A RESTlet runs as its authenticated caller. Restrict the audience to that role. -->
<restlet scriptid="${info.scriptId}">
    <name>SuperSuite Workspace</name>
    <description>SuperSuite File Cabinet, field metadata and business record export service.</description>
    <isinactive>F</isinactive>
    <notifyowner>T</notifyowner>
    <scriptfile>[/${xml(info.scriptPath)}]</scriptfile>
    <scriptcustomfields>
        <scriptcustomfield scriptid="custscript_supersuite_root">
            <fieldtype>TEXT</fieldtype>
            <label>SuperSuite File Cabinet Root</label>
            <defaultvalue>${xml(info.rootDirectory)}</defaultvalue>
            <description>Existing SuiteScripts folder to which this RESTlet is restricted.</description>
            <storevalue>T</storevalue>
        </scriptcustomfield>
        <scriptcustomfield scriptid="custscript_supersuite_readonly">
            <fieldtype>CHECKBOX</fieldtype>
            <label>SuperSuite Read-Only Mode</label>
            <defaultchecked>F</defaultchecked>
            <description>Enable on a separate MCP deployment to reject file writes and deletes.</description>
            <storevalue>T</storevalue>
        </scriptcustomfield>
    </scriptcustomfields>
    <scriptdeployments>
        <scriptdeployment scriptid="${info.deploymentId}">
            <title>SuperSuite Workspace</title>
            <isdeployed>T</isdeployed>
            <status>RELEASED</status>
            <loglevel>AUDIT</loglevel>
            <allroles>F</allroles>
            <allemployees>F</allemployees>
            <audslctrole>${xml(role)}</audslctrole>
            <custscript_supersuite_root>${xml(info.rootDirectory)}</custscript_supersuite_root>
            <custscript_supersuite_readonly>F</custscript_supersuite_readonly>
        </scriptdeployment>
    </scriptdeployments>
</restlet>
`],
        [`src/FileCabinet/${info.scriptPath}`, restletSource],
        ['README.md', `# SuperSuite bootstrap project

This private Account Customization Project installs only the bundled SuperSuite RESTlet and its scoped deployment. It does not deploy files pulled into your workspace. Keep this directory out of version control.

- Target account: ${info.realm}
- Existing remote root: ${info.rootDirectory}
- Audience role script ID: ${info.roleId}
- Script ID: ${info.scriptId}
- Deployment ID: ${info.deploymentId}

${PREREQUISITES}

Run **suitecloud account:setup --interactive** here and select the target account above in the browser, or select an already authenticated profile with **suitecloud account:setup:ci --select YOUR_AUTH_ID**. A successful login writes the default profile into project.json. Confirm that the profile belongs to this account before deploying.

Review src/manifest.xml, src/deploy.xml and src/Objects/${info.scriptId}.xml. Preview with **suitecloud project:deploy --dryrun**, then deploy with **suitecloud project:deploy**. The deployment uses the caller’s role and grants access only to the selected audience role. The remote root must already exist.

## Manual deployment in NetSuite

If you chose manual setup, the following steps replace the CLI deployment commands:

1. In the target NetSuite account, open **Documents > Files > File Cabinet > SuiteScripts**. Create the **SuperSuite/setup_${info.scriptId.slice('customscript_supersuite_'.length)}** folders if needed, then upload the prepared **src/FileCabinet/${info.scriptPath}** JavaScript file to that location.
2. Open **Customization > Scripting > Scripts > New**, choose the uploaded script file, and create its RESTlet script record. Use the script ID **${info.scriptId}**, name it **SuperSuite Workspace**, and leave it active. Its entry points are get, post, and delete.
3. On the script record's **Parameters** tab, create a **Free-Form Text** parameter named **SuperSuite File Cabinet Root**, with ID **custscript_supersuite_root**. Set its default value to **${info.rootDirectory}**. Also create a **Checkbox** parameter named **SuperSuite Read-Only Mode**, with ID **custscript_supersuite_readonly**, leaving its default unchecked. Save the script record.
4. Create a deployment with ID **${info.deploymentId}**, enable **Deployed**, and set status to **Released**. On **Audience**, select only the integration role identified by **${info.roleId}**; leave all-role/all-employee options unchecked. On **Parameters**, set **custscript_supersuite_root** to **${info.rootDirectory}** and leave **custscript_supersuite_readonly** unchecked for this development deployment's push/pull commands. The folder must already exist. Use **Audit** logging and save the deployment. For MCP access, create a separate deployment with a dedicated View-only role and enable the read-only checkbox there.
5. Copy the deployment's **External URL**. Return to SuperSuite Init, select **Deployment Is Ready**, paste that URL, and finish the RESTlet credential prompts. SuperSuite verifies the connection before pulling files or exporting selected records.

An administrator must already have enabled the required features and assigned appropriate permissions to this role. These steps create the RESTlet script/deployment; they do not create integration records, roles, or access keys. File Cabinet scope follows the root parameter, while business-record access follows the authenticated role's record and subsidiary permissions.

The SuperSuite wizard verifies the RESTlet connection before importing. If your account returns a different External URL, copy it from the deployment record into the wizard. RESTlet OAuth/TBA credentials are separate from SuiteCloud authentication and are stored by VS Code SecretStorage, never in this project.

Account Customization Projects have no automatic uninstall. Remove the generated script/deployment and script folder manually in NetSuite if they are no longer needed; deleting this local directory does not remove account changes.

Documentation: [RESTlet XML](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_160514060027.html), [deployment fields](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/SDFxml_3594042655.html), [SuiteCloud authentication](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_89132630266.html), [deployment](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_156044636320.html).
`]
    ]);
}

function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

/** Append a final ignore rule without rewriting or reordering existing Git rules. */
async function ensureConfigIgnored(workspaceRoot) {
    const filename = path.join(path.resolve(workspaceRoot), '.gitignore');
    await assertSafeLocalPath(workspaceRoot, filename);
    let previous = '';
    try {
        const info = await fs.lstat(filename);
        if (!info.isFile() || info.size > 1024 * 1024) throw new Error('The workspace .gitignore must be a regular file at most 1 MiB.');
        previous = await fs.readFile(filename, 'utf8');
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    // A previous ignore followed by a negation may expose the directory again.
    // Only a final rule is sufficient; append after all user-supplied rules.
    if (previous.trimEnd().split(/\r?\n/).at(-1) === '/.config/') return false;
    const eol = previous.includes('\r\n') ? '\r\n' : '\n';
    const separator = previous && !previous.endsWith('\n') ? eol : '';
    await assertSafeLocalPath(workspaceRoot, filename);
    await fs.appendFile(filename, `${separator}# SuperSuite account configuration and deployment metadata${eol}/.config/${eol}`, { mode: 0o600 });
    return true;
}

async function readBootstrapProject(workspaceRoot, extensionRoot = path.resolve(__dirname, '..')) {
    const projectRoot = path.join(path.resolve(workspaceRoot), PROJECT_DIRECTORY);
    await assertSafeLocalPath(workspaceRoot, projectRoot);
    try { await fs.lstat(projectRoot); } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
    const markerPath = path.join(projectRoot, MARKER);
    await assertSafeLocalPath(workspaceRoot, markerPath);
    let marker;
    try { marker = JSON.parse(await fs.readFile(markerPath, 'utf8')); } catch {
        throw new Error(`${PROJECT_DIRECTORY} already exists and is not a completed SuperSuite bootstrap project. Review or move it before initializing.`);
    }
    const options = validateBootstrapOptions(marker);
    if (marker.version !== 1 || !/^[a-f0-9]{12}$/.test(marker.instance || '') ||
        !marker.files || typeof marker.files !== 'object' || Array.isArray(marker.files)) {
        throw new Error('The SuperSuite bootstrap project marker is invalid. Review the project before initializing.');
    }
    const info = descriptor(projectRoot, options, marker.instance, false);
    // Do not allow modified manifests, launch hooks, or deployment sources to be
    // executed silently when the wizard resumes. The CLI's project.json is owned
    // by Oracle and intentionally excluded because account:setup creates it.
    const bundledSource = await fs.readFile(path.join(extensionRoot, 'netSuiteRestlet/vscodeExtensionRestlet.js'));
    const canonicalFiles = projectFiles(info, bundledSource);
    const expectedNames = [...canonicalFiles.keys()].sort();
    if (JSON.stringify(Object.keys(marker.files).sort()) !== JSON.stringify(expectedNames)) {
        throw new Error('The SuperSuite bootstrap project file list is invalid.');
    }
    for (const [relative, expected] of Object.entries(marker.files)) {
        const filename = path.join(projectRoot, relative);
        await assertSafeLocalPath(workspaceRoot, filename);
        let bytes;
        try { bytes = await fs.readFile(filename); } catch {
            throw new Error(`The bootstrap file ${relative} is missing. Review or move ${PROJECT_DIRECTORY} before initializing.`);
        }
        // The marker itself is editable workspace data. Matching its hashes alone
        // must not authorize a changed executable hook or deployment source.
        if (digest(bytes) !== expected || !bytes.equals(Buffer.from(canonicalFiles.get(relative)))) {
            throw new Error(`The bootstrap file ${relative} was modified or belongs to a different SuperSuite version. Review or move ${PROJECT_DIRECTORY} before initializing.`);
        }
    }
    return info;
}

/** Create without overwriting a pre-existing project, and resume only our exact files. */
async function createBootstrapProject(workspaceRoot, options, extensionRoot) {
    const normalized = validateBootstrapOptions(options);
    const existing = await readBootstrapProject(workspaceRoot, extensionRoot);
    if (existing) {
        if (['realm', 'rootDirectory', 'roleId'].some(key => existing[key] !== normalized[key])) {
            throw new Error('This bootstrap project belongs to a different account, root, or role. Use its original settings or a different workspace.');
        }
        await ensureConfigIgnored(workspaceRoot);
        return existing;
    }
    const restletSource = await fs.readFile(path.join(extensionRoot, 'netSuiteRestlet/vscodeExtensionRestlet.js'));
    const projectRoot = path.join(path.resolve(workspaceRoot), PROJECT_DIRECTORY);
    const instance = crypto.randomBytes(6).toString('hex');
    const info = descriptor(projectRoot, normalized, instance, true);
    const files = projectFiles(info, restletSource);
    await assertSafeLocalPath(workspaceRoot, projectRoot);
    await ensureConfigIgnored(workspaceRoot);
    await fs.mkdir(path.dirname(projectRoot), { recursive: true });
    await assertSafeLocalPath(workspaceRoot, projectRoot);
    await fs.mkdir(projectRoot); // Exclusive ownership; EEXIST never overwrites.
    const hashes = {};
    for (const [relative, content] of files) {
        const filename = path.join(projectRoot, relative);
        await assertSafeLocalPath(workspaceRoot, filename);
        await fs.mkdir(path.dirname(filename), { recursive: true });
        await assertSafeLocalPath(workspaceRoot, filename);
        await fs.writeFile(filename, content, { flag: 'wx', mode: 0o600 });
        hashes[relative] = digest(content);
    }
    await fs.writeFile(path.join(projectRoot, MARKER), JSON.stringify({
        version: 1, instance, ...normalized, files: hashes
    }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return info;
}

/** Argument vectors only: task runners must never interpolate these into a shell string. */
function suiteCloudCommands(authId) {
    if (authId !== undefined && (typeof authId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(authId))) {
        throw new Error('Use an authentication profile ID with letters, numbers, dots, underscores, or hyphens.');
    }
    return {
        authenticate: authId ? ['account:setup:ci', '--select', authId] : ['account:setup', '--interactive'],
        preview: ['project:deploy', '--dryrun'],
        deploy: ['project:deploy']
    };
}

module.exports = {
    PROJECT_DIRECTORY, GUIDE_URL, PREREQUISITES,
    validateBootstrapOptions, createBootstrapProject, readBootstrapProject, suiteCloudCommands, ensureConfigIgnored
};
