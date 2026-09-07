# MinuChannels Distribution and Startup

**Status:** The foreground product command, self-contained GitHub Release package, release automation, and a genuine Pi response from an isolated packaged installation are implemented. Clean-account macOS/Linux validation and publication remain.

## BLUF

The canonical product should be owned and distributed by a dedicated `@minu/channels` package. The simplest eventual startup is:

```bash
pnpm dlx @minu/channels .
# or
npx @minu/channels .
```

For MVP, publish a foreground command first. It should initialize or reopen local data, serve the bundled production web client, open the authenticated browser URL, print logs, and stop on Ctrl-C. A background service is a useful later option, not a prerequisite for local use or the first open-source release.

## Current source-workspace path

Today, on a development checkout with the sibling MinuRuntime repository available, run:

```bash
pnpm install
pnpm local -- --cwd /absolute/path/to/workspace
```

This provides persistent local collaboration data, restricted agent-host state, browser bootstrap, live Pi startup, terminal logs, and clean foreground supervision. The dedicated `minu-channels` entry point serves the production web build and proxies Channels, control, and SSE traffic through one loopback product URL; Vite is no longer part of persistent local startup.

The source-workspace command still builds and loads the adjacent Runtime checkout, but the release build now bundles Runtime core, the Pi adapter, and its owned worker into one product artifact. Release builds require clean Channels and Runtime repositories, enforce the immutable Runtime commit in `runtime-source.json`, record both commit hashes in the package, and support `MINU_RUNTIME_ROOT` when Runtime is not adjacent to the active checkout. The installed artifact has no sibling-repository lookup. `pnpm release:pack` builds both source workspaces, assembles the production web client and both migration trees, rejects common secret/local-data artifacts, creates an npm-compatible tarball, and emits `SHA256SUMS`. `pnpm release:smoke` installs that exact tarball in a temporary directory and proves both first launch and persistent reopen.

An isolated npm-prefix installation of the generated tarball has started the bundled Pi Runtime and returned the requested `PACKAGED_PI_OK` response through the authenticated local web gateway. The remaining external release gates are clean-account macOS/Linux validation, repository visibility confirmation, and cross-repository checkout access for the pinned Runtime commit. [`local-release.md`](local-release.md) documents installation, upgrades, backup, reset, and uninstall without inventing repository or release URLs before they exist.

## Recommended public package

```text
@minu/channels
├── bin/minu-channels.js
├── dist/server/
├── dist/client/
├── migrations/channels/
├── migrations/agent-host/
└── package.json
```

The package should expose one authoritative executable:

```json
{
  "name": "@minu/channels",
  "bin": {
    "minu-channels": "./dist/bin/minu-channels.js"
  },
  "files": ["dist", "migrations", "README.md", "LICENSE"]
}
```

The complete product implementation remains in the Channels repository. The optional umbrella `@minu/cli` may call the same exported startup function as `minu channels`, but it must not own a second supervisor implementation.

## Intended command experience

```bash
minu-channels                       # current directory
minu-channels /path/to/project
minu-channels --data-dir /path/to/data /path/to/project
minu-channels --no-open

pnpm dlx @minu/channels .
npx @minu/channels .
minu channels .                     # optional umbrella CLI
```

First launch creates a local human, one configured but unstarted Builder, one Workspace, and an empty General Channel. Later launches reopen the same data. Setup does not require a separate `init` command and must not execute a model automatically.

## Distribution choices

### 1. npm registry — recommended public path

After package-tarball verification:

```bash
npm publish --access public --tag next
pnpm dlx @minu/channels@next .
```

Promote a proven release to `latest` later. npm gives users the shortest cross-platform command, immutable versions, integrity metadata, normal dependency resolution, and straightforward updates.

Publishing to npm is required for the ordinary forms `pnpm dlx @minu/channels` and `npx @minu/channels`. Another npm-compatible registry can be used, but users must configure it first.

### 2. GitHub Release tarball — good pre-npm option

A GitHub Actions release can run `pnpm pack` and attach the resulting `.tgz`. Users can execute the immutable release asset directly without publishing to npm:

```bash
pnpm dlx https://github.com/OWNER/REPOSITORY/releases/download/v0.1.0/minu-channels-0.1.0.tgz .
```

Use real repository and asset names only after they exist. The tarball must already contain compiled server code, web assets, migrations, and normal registry dependencies. This is a useful prerelease path, but its URL is longer and discoverability/update behavior is worse than npm.

### 3. Direct GitHub dependency — possible, not recommended

Package managers can install a tag or commit directly from GitHub, for example:

```bash
pnpm dlx github:OWNER/REPOSITORY#v0.1.0
```

This is slower and more fragile because it may require repository build tooling, lifecycle scripts, workspace dependencies, and more source files. It should not be the primary onboarding path.

### 4. Clone and run — contributor path

A public contributor should eventually be able to run:

```bash
git clone <repository-url>
cd channels
corepack enable
pnpm install
pnpm local -- --cwd .
```

That path becomes honest only after the sibling Runtime lookup is removed or the repository documents and automates the Runtime checkout. A clone should not require users to discover internal process commands.

### 5. GitHub Packages — not preferred for public onboarding

GitHub Packages is npm-compatible but commonly requires registry configuration and authentication. It is reasonable for private prereleases, not the simplest public MVP experience.

### 6. Standalone native downloads — future option

GitHub Releases could later contain signed platform executables or installers. This removes the Node prerequisite but introduces per-platform builds, signing/notarization, native dependency testing, updates, and substantially more release engineering. Defer until npm distribution proves demand.

## Local package proof before publishing

Never use the public registry as the first packaging test. Build and smoke-test the exact artifact:

```bash
pnpm release:pack
pnpm release:smoke
```

The generated tarball and checksum are written beneath the ignored `release/artifacts/` directory. To test the installation manually:

```bash
npm install -g ./release/artifacts/minu-channels-<version>.tgz
minu-channels --data-dir "$(mktemp -d)" --no-open .
```

The release check must prove:

- no sibling repository lookup;
- no TypeScript compilation or Vite server at startup;
- production web assets and all migrations are present;
- first launch and reopen both work;
- live Runtime execution works only after explicit Start;
- Ctrl-C shuts down foreground product services;
- package contents contain no credentials, local paths, prompts, Runtime ids, or test fixtures;
- macOS and Linux work with the documented Node versions;
- the package can run from a directory unrelated to the source repository.

## Optional background service: documented long-term pattern

T3 Code demonstrates a sound optional pattern:

```bash
npx t3 service install
npx t3 service status
npx t3@latest service update
npx t3 service uninstall
```

Its installer does not point a boot service at the ephemeral npx cache. It installs the exact application version into persistent application storage, writes a stable launcher, configures a per-user macOS `launchd` agent or Linux `systemd` service, records logs, and activates the service. Updates stage and verify another pinned version before switching.

A future MinuChannels equivalent could be:

```bash
pnpm dlx @minu/channels service install
pnpm dlx @minu/channels service status
pnpm dlx @minu/channels@latest service update
pnpm dlx @minu/channels service uninstall
```

That feature requires:

- launchd and systemd installation/removal;
- exact-version copies outside the package-manager cache;
- stable launchers and owner-only configuration;
- log location and rotation policy;
- update staging, verification, rollback, and repair;
- stale-service and stale-version recovery;
- port and browser behavior for an already-running service;
- clear Runtime shutdown/restoration semantics.

Do not implement this for the foreground MVP. Add it only when users need agents reachable after closing the terminal, remote access, login/boot startup, or managed background updates.

## Database distribution boundary

One user on one machine should use local libSQL by default. No hosted database is required to install or run MinuChannels.

Collaboration persistence is behind a storage interface and may use local libSQL, the existing Turso adapter, or future PostgreSQL/other adapters. Restricted agent-host state remains local for the local product unless a future authenticated host supplies an equivalent private store. Database portability must not complicate the first-run command.

## Open-source and release checklist

Before the first public release:

1. Add an explicit license and package `license` metadata.
2. Add contribution and security-reporting guidance.
3. Confirm repository history and release artifacts contain no secrets or machine-local values.
4. Review dependency licenses and supported Node/platform requirements.
5. Remove `private: true` only from intentionally published packages.
6. Add repository, homepage, bugs, engines, files, and publish configuration metadata.
7. Build the production client and package migrations during release.
8. Test `pnpm pack` from a clean checkout and execute the tarball with a temporary home.
9. Use CI trusted publishing/provenance where available.
10. Publish a prerelease tag before `latest`.

## MVP decision

Use an npm-compatible tarball attached to a private GitHub Release as the initial distribution, matching the established Minu product pattern. The artifact bundles private Channels internals and the required MinuRuntime Pi implementation; source package boundaries do not become public product boundaries. Keep npm publication, direct repository execution, the optional umbrella CLI, database adapters, native releases, and T3-style background services deferred until the foreground artifact is proven in use.
