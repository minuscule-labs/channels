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

# macOS background service
minu-channels start
minu-channels open

# Linux or explicit foreground operation
minu-channels run
```

The background lifecycle is currently supported on macOS. `start` installs or refreshes a data-directory-scoped user LaunchAgent and starts it without enabling login startup. `open` starts it if needed and obtains a fresh authenticated browser launch through owner-private state. Use `stop`, `restart`, and `status` for normal lifecycle. An ordinary `restart` refuses while an agent turn is active; `restart --when-idle` stops admitting new turns, waits for turns already active at the boundary, and leaves queued or newly arriving Channel work durable for processing after restart. It never silently stops or replaces Runtime sessions. Opt into login startup with `enable-login`, reverse it with `disable-login`, and unregister it with `remove-service`. Service removal preserves all product data. Use `minu-channels run` for explicit foreground operation; bare `minu-channels` remains a compatibility alias and Linux remains foreground-capable.

Choose the first Workspace source folder in browser onboarding. Passing an absolute Workspace path remains available as a non-interactive shortcut. Use `--no-open` to print the one-time browser URL instead of opening it automatically. The product advertises `http://minu-channels.localhost:47412/` while binding only to `127.0.0.1`; internal Channels and control ports default to `47410` and `47411`. Use the printed bootstrap URL rather than opening the web URL directly. Use `--data-dir` to create an independent installation.

Installing from a release tarball is supported. Installing directly from a Git branch or repository checkout is not a release installation because it may require source build tools and sibling repositories.

## Inspect the installation

```bash
minu-channels --version
minu-channels paths
minu-channels doctor
minu-channels status
minu-channels update --check
```

`paths` and `doctor` accept `--data-dir` and `--json`. The doctor checks the Node version, supported platform, and private data-directory permissions.

## Upgrade to 0.0.6 and start the macOS service

Version 0.0.6 keeps source and review-mode ports separate from the installed product. Stop any older foreground MinuChannels process, download `minu-channels-0.0.6.tgz` and `SHA256SUMS` from the GitHub Release, verify the checksum, then install and start it:

```bash
npm install -g ./minu-channels-0.0.6.tgz
minu-channels --version        # must print 0.0.6
minu-channels doctor
minu-channels start            # install/refresh and start the user LaunchAgent
minu-channels status
minu-channels open             # open a fresh authenticated browser session
```

`start` does **not** enable launch at login. Opt in only when wanted:

```bash
minu-channels enable-login
```

The service uses the existing default data at `~/.minu/channels`; passing `--data-dir` selects an independent instance. Do not run foreground `minu-channels run` against the same data directory while the service is active. Use `minu-channels stop` before returning to foreground operation.

## Later upgrades

The built-in updater supports writable global npm installations. It downloads the release tarball and `SHA256SUMS` with bounded requests, verifies the exact artifact checksum, installs with lifecycle scripts disabled, and verifies the installed version. A selected running macOS service is quiesced only after verification, stopped without terminating Runtime workers, and restarted only after the installed version is verified. A selected service that was already stopped remains stopped. Foreground processes, other data-directory services, legacy or unverified live markers, source checkouts, unsupported package-manager layouts, and concurrent updates are refused. Interrupted update locks are recovered only after their owner process is confirmed dead.

1. Stop any foreground MinuChannels process; a running selected macOS service may remain running.
2. Back up the data directory.
3. Run the updater and confirm installation.
4. If the selected service was running, require the updater to report that it restarted successfully.
5. Verify Channels, messages, agents, and configuration before removing the backup.

```bash
minu-channels update
# MinuChannels will verify the release and safely coordinate any running background service.
# Install this update? [y/N]

# Open a restarted macOS service
minu-channels open

# Linux/foreground alternative after update
minu-channels run

# Manual fallback:
npm install -g <new-github-release-tarball-url>
```

The confirmation defaults to **No**. Use `minu-channels update --yes` for intentional non-interactive automation; `--json` installation also requires `--yes`. Confirmation never bypasses installation-instance protection. If installation succeeds but service restart fails, the command reports the installed version and directs you to `minu-channels start`. Automatic rollback is not claimed; restore a compatible backup if a database migration makes downgrade unsafe.

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

Stop and unregister the background service (or stop the foreground process), then remove the global package:

```bash
# macOS service, when installed
minu-channels stop
minu-channels remove-service

npm uninstall -g @minu/channels
```

Uninstalling the package does not delete `~/.minu/channels`. Remove that directory separately only when its Channels, messages, agent configuration, and bindings are no longer needed.

## Verification

The release producer must provide a `SHA256SUMS` file beside the tarball. Verify the downloaded artifact before installation using the platform's SHA-256 utility. The release is not complete until the installed artifact has been tested from a clean account, reopened against its own persisted data, and used to receive a genuine Pi response.
