# Installing a Local Alpha Release

**Status:** The package artifact, checksum-verified updater, and tag-triggered GitHub Release workflow are implemented. A release is not complete until its published artifact passes clean-account validation.

## Requirements

- macOS or Linux;
- Node.js 22 or newer;
- npm or pnpm; and
- the Pi executable installed, authenticated, and available as `pi` on `PATH` for live agent execution.

MinuChannels is a single-user, loopback-only local alpha. Do not expose its ports to another machine or an untrusted local user.

## Install

Download and install the immutable `.tgz` attached to the approved GitHub Release:

```bash
npm install -g <github-release-tarball-url>
minu-channels
```

Choose the first Workspace source folder in browser onboarding. Passing an absolute Workspace path remains available as a non-interactive shortcut. Use `--no-open` to print the one-time browser URL instead of opening it automatically. The product advertises `http://minu-channels.localhost:47412/` while binding only to `127.0.0.1`; internal Channels and control ports default to `47410` and `47411`. Use the printed bootstrap URL rather than opening the web URL directly. Use `--data-dir` to create an independent installation.

Installing from a release tarball is supported. Installing directly from a Git branch or repository checkout is not a release installation because it may require source build tools and sibling repositories.

## Inspect the installation

```bash
minu-channels --version
minu-channels paths
minu-channels doctor
minu-channels update --check
```

`paths` and `doctor` accept `--data-dir` and `--json`. The doctor checks the Node version, supported platform, and private data-directory permissions.

## Upgrade

The built-in updater supports writable global npm installations. It downloads the release tarball and `SHA256SUMS` with bounded requests, verifies the exact artifact checksum, installs with lifecycle scripts disabled, and verifies the installed version. It refuses source checkouts, unsupported package-manager layouts, concurrent updates, and updates while any registered process from the same installation is still running. Interrupted update locks are recovered only after their owner process is confirmed dead.

1. Stop MinuChannels with Ctrl-C.
2. Back up the data directory.
3. Run the updater and confirm that every MinuChannels process has stopped.
4. Start MinuChannels with the same data directory.
5. Verify Channels, messages, agents, and configuration before removing the backup.

```bash
minu-channels update
# MinuChannels must be stopped before updating.
# Have you stopped all running MinuChannels processes? [y/N]

minu-channels

# Manual fallback:
npm install -g <new-github-release-tarball-url>
```

The confirmation defaults to **No**. Use `minu-channels update --yes` only after intentionally stopping Channels, such as in controlled automation. Non-interactive and `--json` installation require `--yes`. Confirmation does not bypass active-instance protection: the updater still refuses if it detects a running process from the installation.

Database migrations run during startup. Downgrading an already-migrated data directory is unsupported; restore the pre-upgrade backup instead.

## Back up and restore

The default data directory is product-isolated from other Minu applications:

```text
~/.minu/channels/
```

Channels never writes shared state directly beneath `~/.minu/`. Resolution order is `--data-dir`, `MINU_CHANNELS_HOME`, `$MINU_HOME/channels`, then the default above. The directory and its `run/` directory use owner-only permissions. A private, atomically owned `run/instance.lock/` directory prevents multiple Channels servers from opening the same data directory and safely serializes stale-lock recovery; use a distinct `--data-dir` for an independent concurrent installation.

Stop MinuChannels before copying it so the collaboration and private execution databases represent one consistent checkpoint.

```bash
cp -a ~/.minu/channels ~/.minu/channels.backup
```

To restore, stop MinuChannels, move the current directory aside, and copy the complete backup into its original location. Do not restore only one database: collaboration data, private agent-host state, and the local profile belong together.

## Reset

Stop MinuChannels and move the data directory rather than deleting it immediately:

```bash
mv ~/.minu/channels ~/.minu/channels.previous
minu-channels
```

The next launch creates a fresh local identity and opens browser Workspace onboarding. Remove the previous directory only after confirming it is no longer needed.

## Uninstall

Stop the foreground process, then remove the global package:

```bash
npm uninstall -g @minu/channels
```

Uninstalling the package does not delete `~/.minu/channels`. Remove that directory separately only when its Channels, messages, agent configuration, and bindings are no longer needed.

## Verification

The release producer must provide a `SHA256SUMS` file beside the tarball. Verify the downloaded artifact before installation using the platform's SHA-256 utility. The release is not complete until the installed artifact has been tested from a clean account, reopened against its own persisted data, and used to receive a genuine Pi response.
