# Installing a Local Alpha Release

**Status:** The package artifact is implemented and locally smoke-tested. Substitute the actual private GitHub Release asset URL after a release exists.

## Requirements

- macOS or Linux;
- Node.js 22 or newer;
- npm or pnpm; and
- the Pi executable installed, authenticated, and available as `pi` on `PATH` for live agent execution.

MinuChannels is a single-user, loopback-only local alpha. Do not expose its ports to another machine or an untrusted local user.

## Install

Download and install the immutable `.tgz` attached to the approved private GitHub Release:

```bash
npm install -g <private-github-release-tarball-url>
minu-channels /absolute/path/to/workspace
```

Use `--no-open` to print the one-time browser URL instead of opening it automatically. Use `--data-dir` to create an independent installation.

Installing from a release tarball is supported. Installing directly from a Git branch or repository checkout is not a release installation because it may require source build tools and sibling repositories.

## Upgrade

1. Stop MinuChannels with Ctrl-C.
2. Back up the data directory.
3. Install the newer immutable release artifact over the existing global package.
4. Start MinuChannels with the same data directory and Workspace path.
5. Verify Channels, messages, agents, and configuration before removing the backup.

```bash
npm install -g <new-private-github-release-tarball-url>
minu-channels /absolute/path/to/workspace
```

Database migrations run during startup. Downgrading an already-migrated data directory is unsupported; restore the pre-upgrade backup instead.

## Back up and restore

The default data directory is product-isolated from other Minu applications:

```text
~/.minu/channels/
```

Channels never writes shared state directly beneath `~/.minu/`. Resolution order is `--data-dir`, `MINU_CHANNELS_HOME`, `$MINU_HOME/channels`, then the default above. The directory and its `run/` directory use owner-only permissions. A private `run/instance.lock` prevents multiple Channels servers from opening the same data directory; use a distinct `--data-dir` for an independent concurrent installation.

Stop MinuChannels before copying it so the collaboration and private execution databases represent one consistent checkpoint.

```bash
cp -a ~/.minu/channels ~/.minu/channels.backup
```

To restore, stop MinuChannels, move the current directory aside, and copy the complete backup into its original location. Do not restore only one database: collaboration data, private agent-host state, and the local profile belong together.

## Reset

Stop MinuChannels and move the data directory rather than deleting it immediately:

```bash
mv ~/.minu/channels ~/.minu/channels.previous
minu-channels /absolute/path/to/workspace
```

The next launch creates a fresh local identity, Workspace, Builder agent, and General Channel. Remove the previous directory only after confirming it is no longer needed.

## Uninstall

Stop the foreground process, then remove the global package:

```bash
npm uninstall -g @minu/channels
```

Uninstalling the package does not delete `~/.minu/channels`. Remove that directory separately only when its Channels, messages, agent configuration, and bindings are no longer needed.

## Verification

The release producer must provide a `SHA256SUMS` file beside the tarball. Verify the downloaded artifact before installation using the platform's SHA-256 utility. The release is not complete until the installed artifact has been tested from a clean account, reopened against its own persisted data, and used to receive a genuine Pi response.
