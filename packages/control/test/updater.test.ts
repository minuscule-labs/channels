import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkForUpdate, compareVersions, installUpdate } from "../src/updater.ts";

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
