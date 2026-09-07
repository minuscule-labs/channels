# Releasing MinuChannels

Releases use an annotated `v<version>` Git tag. No local GitHub CLI session is required: pushing the tag triggers `.github/workflows/release.yml`, which builds, smoke-tests, checksums, and publishes the GitHub Release.

## Prepare

1. Work from a clean `main` that exactly matches `origin/main`.
2. Set the release version in the root `package.json`.
3. Add the matching `## <version>` section to `CHANGELOG.md`.
4. Confirm `LICENSE` exists and package metadata names it.
5. Confirm the Runtime commit pinned in `runtime-source.json` is intentional and publicly readable or available to Actions. The local packager and GitHub Actions both consume this file and reject another Runtime checkout.

## Validate without tagging

```bash
pnpm release:tag:dry-run
```

This runs type checks, workspace and web tests, release packaging, checksum generation, and packaged install/reopen diagnostics. It refuses a dirty tree, duplicate tag, missing license, missing changelog entry, or a Runtime checkout that differs from `runtime-source.json`. After validation it fetches `origin/main` again and refuses moving source input.

## Create and push the release tag

```bash
pnpm release:tag:push
```

The command creates and pushes the annotated tag only after validation. GitHub Actions verifies that the tag matches `package.json`, checks out the pinned Runtime commit, rebuilds from source, smoke-tests the artifact, and publishes the `.tgz` plus `SHA256SUMS`.

If you create the tag without `--push`, publish it later with:

```bash
git push origin v<version>
```

Do not move or reuse a published release tag. Fix forward with a new patch version.
