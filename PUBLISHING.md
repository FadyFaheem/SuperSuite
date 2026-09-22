# Publishing SuperSuite

The extension is published as **fadyfaheem.supersuite**. This is a new Marketplace identity; it does not upgrade the original `nsupload-org.netsuite-upload` listing.

## One-time Marketplace authorization

1. Create or verify ownership of the `fadyfaheem` publisher in [Visual Studio Marketplace publisher management](https://marketplace.visualstudio.com/manage).
2. Configure Marketplace trusted publishing for repository **FadyFaheem/SuperSuite** and workflow **.github/workflows/release.yml**. The publish job uses the GitHub environment **vscode-marketplace**; include that environment in the policy when requested.
3. Create the `vscode-marketplace` GitHub environment. Restrict its deployment branches/tags to the release tags you permit. Optional required reviewers belong here if your release policy needs them.
4. Ensure GitHub Actions can request an OIDC token (`id-token: write` is already limited to the publish job). No `VSCE_PAT` repository secret is needed for the included workflow.

The locked `@vscode/vsce` 4.x tool supports `vsce publish --oidc`: GitHub issues a token for the `marketplace.visualstudio.com` audience, which the CLI exchanges for a short-lived Marketplace credential. This setup follows Microsoft's [vsce trusted publishing instructions](https://github.com/microsoft/vscode-vsce#trusted-publishing). Authentication fails closed if the publisher policy does not match; it does not fall back to a PAT.

Publisher creation, Marketplace trust policy configuration, and GitHub environment settings are account operations. Adding these workflow files does not perform that setup, verify publisher ownership, or publish an extension.

If trusted publishing is not yet enabled for your publisher, Microsoft's documented [Microsoft Entra ID publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#secure-automated-publishing-to-visual-studio-marketplace) is an alternative requiring its own identity configuration and `--azure-credential`. Do not add a second authentication flag to `--oidc`. Global Azure DevOps PAT retirement is announced for December 1, 2026 in that guide; avoid designing a new release process around a long-lived PAT.

## Release a version

1. Deploy the matching RESTlet to a sandbox and complete [MANUAL_TESTS.md](MANUAL_TESTS.md), including new-workspace Init, deployment preview/account review, cancellation/resume, and selected business-record exports. Offline CI does not deploy to NetSuite or establish that the account's permissions and SDF configuration work.
2. Update `CHANGELOG.md`, `package.json`, and `package-lock.json`. For example, `npm version patch --no-git-tag-version` updates the two package files without creating a commit/tag.
3. Run `npm ci --ignore-scripts`, `npm run check`, `npm run test:integration`, and `npm run package` with Node 22.13+ or Node 24.
4. Commit the release and push it through your normal review process.
5. Create and push a matching tag, for example:

   ```sh
   git tag v2.2.0
   git push origin v2.2.0
   ```

Only stable `vX.Y.Z` tags exactly matching the package and lockfile versions are accepted. Invalid or prerelease tags fail validation. A release tag runs the reusable CI workflow: lint/unit tests on three operating systems and two Node versions; VS Code extension-host tests on the minimum version, stable and Insiders; then VSIX packaging. Publishing downloads that tested artifact and uploads it once using OIDC. Failed tests prevent publication.

The release workflow serializes publication and publishes only the tag's checked-out source. The packaged VSIX is retained as a GitHub Actions artifact named `supersuite-vsix`. It does not create a separate GitHub Release page. To retry a transient workflow failure, rerun the failed jobs; do not move a published tag or attempt to reuse a Marketplace version that is already published.

## Local package inspection

```sh
npm run package
npx --no-install vsce ls --tree
```

Install `supersuite.vsix` through **Extensions: Install from VSIX**. The bundle includes the RESTlet, Init/bootstrap/task code, access setup guide, editor assets, schema, documentation, and production dependencies. Tests, workflows, caches, workspace configuration, business-record snapshots, generated design files, and development tools must be excluded by `.vscodeignore`. Inspect the artifact for both `.config` and `.supersuite-data` before publishing; neither belongs in a release.

For a faulty release, publish a new patch version. Extension code and account-deployed RESTlet code have separate lifecycles; update each explicitly and retain a known-good account script copy for rollback. A Marketplace release never deploys or updates account RESTlets. Init's automatic deployment runs only in the user's chosen workspace after SuiteCloud authorization and deployment review; RESTlet 2.1 is required for the new record-export capability.
