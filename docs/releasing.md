# Releasing MinuChannels

Releases use an annotated `v<version>` Git tag. No local GitHub CLI session is required: pushing the tag triggers `.github/workflows/release.yml`, which requires successful main CI for that exact commit, then builds, smoke-tests, checksums, and prepares a draft GitHub Release. Publication as latest is a separate step after exact-artifact acceptance. Non-draft pull-request CI runs the same package and smoke path on Ubuntu so release-only failures are caught before tagging.

## Prepare

1. Prepare the release version and notes in a pull request. Merge only after required checks pass, wait for successful post-merge CI, then tag from a clean `main` that exactly matches the freshly fetched `origin/main`.
2. Set the release version in the root `package.json`.
3. Add the matching `## <version>` section to `CHANGELOG.md`.
4. Confirm `LICENSE` exists and package metadata names it.
5. Confirm the Runtime commit pinned in `runtime-source.json` is intentional and publicly readable or available to Actions. The local tag command validates the source definition. CI and release packaging check out and enforce the exact Runtime pin; a local Runtime checkout is not needed just to tag.

## Validate without tagging

```bash
pnpm release:tag:dry-run
```

This is a lightweight metadata/source check, not a test or packaging run. It refuses a dirty tree, duplicate tag, missing license, missing changelog entry, invalid Runtime source pin, or source that differs from freshly fetched `origin/main`. It does not query GitHub CI locally or require a GitHub CLI login. A successful dry run does not claim tests passed or authorize publication.

Full type, backend, web, browser and pinned Runtime verification remains in required ready-for-review PR/post-merge CI. Draft PRs skip all CI runner jobs; marking a PR ready triggers full verification. Do not repeat `release:check` locally just to tag an already CI-verified commit; it remains available for diagnosing packaging or integration problems when needed.

`release:pack` recreates the ignored `release/artifacts/` directory. Archive accepted artifacts and their evidence before running validation.

## Create and push the release tag

```bash
pnpm release:tag:push
```

The command creates and pushes the annotated tag after the metadata/source checks above. GitHub Actions verifies that the tag matches `package.json` and requires the latest main push run of `.github/workflows/ci.yml` for the **exact tagged commit** to have completed successfully in this repository. Missing, pending, failed, cancelled, wrong-commit, pull-request, fork or other-workflow results do not authorize a release. Wait for or fix CI before rerunning a blocked release workflow; never substitute another commit's green result.

The workflow uses its own Actions token with `actions: read`; no new local credentials or GitHub CLI requirement is added. After that gate, it builds from the tag and pinned Runtime, runs the package/privacy/checksum and installed-package smoke path, and uploads the `.tgz` plus `SHA256SUMS` to a draft. It reuses the exact-commit CI source-test result rather than rerunning Runtime/Channels source suites. Required PR/post-merge coverage is unchanged.

If you create the tag without `--push`, publish it later with:

```bash
git push origin v<version>
```

## Accept and publish the draft

Require the PR, post-merge, and tag-workflow checks to pass. Download the exact uploaded tarball and checksum, verify its checksum and source pins, then install it in a clean account, reopen its persisted data, and receive a genuine Pi response. Record that acceptance separately from source-checkout and controlled/fake-Pi checks. See [local release acceptance](local-release.md#verification).

Only after those checks pass, publish the existing draft as the latest release. Publishing does not install the package or restart existing installations.

Do not move or reuse a published release tag or replace its assets to incorporate a fix. Fix forward with a new patch version.
