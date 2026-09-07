import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkForUpdate, compareVersions, installUpdate, registerInstallationInstance } from "../src/updater.ts";

const release = {
  tag_name: "v1.2.3",
  html_url: "https://github.com/minuscule-labs/channels/releases/tag/v1.2.3",
  assets: [
    { name: "minu-channels-1.2.3.tgz", browser_download_url: "https://github.com/minuscule-labs/channels/releases/download/v1.2.3/minu-channels-1.2.3.tgz" },
    { name: "SHA256SUMS", browser_download_url: "https://github.com/minuscule-labs/channels/releases/download/v1.2.3/SHA256SUMS" },
  ],
};

test("discovers the latest checksum-addressed Channels release", async () => {
  const update = await checkForUpdate({
    currentVersion: "1.2.2",
    fetch: async () => new Response(JSON.stringify(release), { status: 200 }),
  });
  assert.equal(update.updateAvailable, true);
  assert.equal(update.latestVersion, "1.2.3");
  assert.equal(update.artifactName, "minu-channels-1.2.3.tgz");
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  assert.equal(compareVersions("2.0.0", "1.9.9"), 1);
});

test("installs only a checksum-verified writable global npm package", async () => {
  const root = await mkdtemp(join(tmpdir(), "minu-channels-updater-"));
  const globalRoot = join(root, "lib", "node_modules");
  const packageRoot = join(globalRoot, "@minu", "channels");
  await mkdir(packageRoot, { recursive: true });
  const artifact = Buffer.from("verified release artifact");
  const checksum = createHash("sha256").update(artifact).digest("hex");
  const commands: string[][] = [];
  try {
    const installed = await installUpdate({
      currentVersion: "1.2.2",
      latestVersion: "1.2.3",
      updateAvailable: true,
      releaseUrl: release.html_url,
      artifactName: "minu-channels-1.2.3.tgz",
      artifactUrl: release.assets[0]!.browser_download_url,
      checksumUrl: release.assets[1]!.browser_download_url,
    }, {
      packageRoot,
      temporaryDirectory: root,
      fetch: async (input) => String(input).endsWith("SHA256SUMS")
        ? new Response(`${checksum}  minu-channels-1.2.3.tgz\n`)
        : new Response(artifact),
      runCommand: async (command, args) => {
        commands.push([command, ...args]);
        if (args.join(" ") === "root -g") return { stdout: `${globalRoot}\n`, stderr: "" };
        if (command === process.execPath) return { stdout: "1.2.3\n", stderr: "" };
        return { stdout: "", stderr: "" };
      },
    });
    assert.deepEqual(installed, { previousVersion: "1.2.2", version: "1.2.3" });
    assert.ok(commands.some((command) => command.includes("--ignore-scripts")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses self-update while the same installation has a running instance", async () => {
  const root = await mkdtemp(join(tmpdir(), "minu-channels-updater-active-"));
  const globalRoot = join(root, "node_modules");
  const packageRoot = join(globalRoot, "@minu", "channels");
  await mkdir(packageRoot, { recursive: true });
  const instance = await registerInstallationInstance(packageRoot);
  try {
    await assert.rejects(installUpdate({
      currentVersion: "1.2.2", latestVersion: "1.2.3", updateAvailable: true,
      releaseUrl: release.html_url, artifactName: "minu-channels-1.2.3.tgz",
      artifactUrl: release.assets[0]!.browser_download_url,
      checksumUrl: release.assets[1]!.browser_download_url,
    }, {
      packageRoot,
      runCommand: async (_command, args) => args.join(" ") === "root -g"
        ? { stdout: globalRoot, stderr: "" }
        : { stdout: "", stderr: "" },
    }), /still running/);
  } finally {
    await instance.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("serializes concurrent self-updates for one installation", async () => {
  const root = await mkdtemp(join(tmpdir(), "minu-channels-updater-concurrent-"));
  const globalRoot = join(root, "node_modules");
  const packageRoot = join(globalRoot, "@minu", "channels");
  await mkdir(packageRoot, { recursive: true });
  const artifact = Buffer.from("concurrent verified artifact");
  const checksum = createHash("sha256").update(artifact).digest("hex");
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
  let fetchStarted!: () => void;
  const started = new Promise<void>((resolve) => { fetchStarted = resolve; });
  const update = {
    currentVersion: "1.2.2", latestVersion: "1.2.3", updateAvailable: true,
    releaseUrl: release.html_url, artifactName: "minu-channels-1.2.3.tgz",
    artifactUrl: release.assets[0]!.browser_download_url,
    checksumUrl: release.assets[1]!.browser_download_url,
  };
  const runCommand = async (command: string, args: string[]) => {
    if (args.join(" ") === "root -g") return { stdout: globalRoot, stderr: "" };
    if (command === process.execPath) return { stdout: "1.2.3\n", stderr: "" };
    return { stdout: "", stderr: "" };
  };
  try {
    const first = installUpdate(update, {
      packageRoot, temporaryDirectory: root, runCommand,
      fetch: async (input) => {
        fetchStarted();
        await gate;
        return String(input).endsWith("SHA256SUMS")
          ? new Response(`${checksum}  minu-channels-1.2.3.tgz\n`)
          : new Response(artifact);
      },
    });
    await started;
    await assert.rejects(installUpdate(update, { packageRoot, runCommand }), /update is already in progress/);
    releaseGate();
    await first;
  } finally { releaseGate(); await rm(root, { recursive: true, force: true }); }
});

test("recovers an interrupted update lock owned by a dead process", async () => {
  const root = await mkdtemp(join(tmpdir(), "minu-channels-updater-recovery-"));
  const globalRoot = join(root, "node_modules");
  const packageRoot = join(globalRoot, "@minu", "channels");
  await mkdir(packageRoot, { recursive: true });
  const key = createHash("sha256").update(packageRoot).digest("hex").slice(0, 24);
  const coordination = join(tmpdir(), `minu-channels-install-${key}`);
  const lock = join(coordination, "update.lock");
  await rm(coordination, { recursive: true, force: true });
  await mkdir(lock, { recursive: true });
  await writeFile(join(lock, "owner.json"), '{"pid":999999}\n');
  const artifact = Buffer.from("recovered update");
  const checksum = createHash("sha256").update(artifact).digest("hex");
  try {
    await installUpdate({
      currentVersion: "1.2.2", latestVersion: "1.2.3", updateAvailable: true,
      releaseUrl: release.html_url, artifactName: "minu-channels-1.2.3.tgz",
      artifactUrl: release.assets[0]!.browser_download_url,
      checksumUrl: release.assets[1]!.browser_download_url,
    }, {
      packageRoot,
      temporaryDirectory: root,
      fetch: async (input) => String(input).endsWith("SHA256SUMS")
        ? new Response(`${checksum}  minu-channels-1.2.3.tgz\n`)
        : new Response(artifact),
      runCommand: async (command, args) => {
        if (args.join(" ") === "root -g") return { stdout: globalRoot, stderr: "" };
        if (command === process.execPath) return { stdout: "1.2.3\n", stderr: "" };
        return { stdout: "", stderr: "" };
      },
    });
  } finally {
    await Promise.all([rm(coordination, { recursive: true, force: true }), rm(root, { recursive: true, force: true })]);
  }
});

test("rejects release artifacts whose checksum does not match", async () => {
  const root = await mkdtemp(join(tmpdir(), "minu-channels-updater-bad-"));
  const globalRoot = join(root, "node_modules");
  const packageRoot = join(globalRoot, "@minu", "channels");
  await mkdir(packageRoot, { recursive: true });
  try {
    await assert.rejects(installUpdate({
      currentVersion: "1.2.2", latestVersion: "1.2.3", updateAvailable: true,
      releaseUrl: release.html_url, artifactName: "minu-channels-1.2.3.tgz",
      artifactUrl: release.assets[0]!.browser_download_url,
      checksumUrl: release.assets[1]!.browser_download_url,
    }, {
      packageRoot,
      temporaryDirectory: root,
      fetch: async (input) => String(input).endsWith("SHA256SUMS")
        ? new Response(`${"0".repeat(64)}  minu-channels-1.2.3.tgz\n`)
        : new Response("tampered"),
      runCommand: async (_command, args) => args.join(" ") === "root -g"
        ? { stdout: globalRoot, stderr: "" }
        : { stdout: "", stderr: "" },
    }), /checksum mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
