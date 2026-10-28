# Releasing MinuChannels

Releases use an annotated `v<version>` Git tag. No local GitHub CLI session is required: pushing the tag triggers `.github/workflows/release.yml`, which tests the pinned Runtime, builds, smoke-tests, checksums, and prepares a draft GitHub Release. Publication as latest is a separate step after exact-artifact acceptance. Pull-request CI runs the same package and smoke path on Ubuntu so release-only failures are caught before tagging.

## Prepare

1. Prepare the release version and notes in a pull request. Merge only after required checks pass, then tag from a clean `main` that exactly matches the freshly fetched `origin/main`.
2. Set the release version in the root `package.json`.
3. Add the matching `## <version>` section to `CHANGELOG.md`.
4. Confirm `LICENSE` exists and package metadata names it.
5. Confirm the Runtime commit pinned in `runtime-source.json` is intentional and publicly readable or available to Actions. The local packager and GitHub Actions both consume this file and reject another Runtime checkout.

## Validate without tagging

```bash
pnpm release:tag:dry-run
```

This runs type checks, workspace and web tests, release packaging, checksum generation, and packaged install/reopen diagnostics. It refuses a dirty tree, duplicate tag, missing license, missing changelog entry, or a Runtime checkout that differs from `runtime-source.json`. After validation it fetches `origin/main` again and refuses moving source input.

`release:pack` recreates the ignored `release/artifacts/` directory. Archive accepted artifacts and their evidence before running validation.

## Create and push the release tag

```bash
pnpm release:tag:push
```

The command creates and pushes the annotated tag only after validation. GitHub Actions verifies that the tag matches `package.json`, checks out and tests the pinned Runtime commit, rebuilds from source, smoke-tests the artifact, and uploads the `.tgz` plus `SHA256SUMS` to a draft release.

If you create the tag without `--push`, publish it later with:

```bash
git push origin v<version>
```

## Accept and publish the draft

Require the PR, post-merge, and tag-workflow checks to pass. Download the exact uploaded tarball and checksum, verify its checksum and source pins, then install it in a clean account, reopen its persisted data, and receive a genuine Pi response. Record that acceptance separately from source-checkout and controlled/fake-Pi checks. See [local release acceptance](local-release.md#verification).

Only after those checks pass, publish the existing draft as the latest release. Publishing does not install the package or restart existing installations.

Do not move or reuse a published release tag or replace its assets to incorporate a fix. Fix forward with a new patch version.
