import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireChannelsDataDirectoryLock, prepareChannelsDataDirectory } from "../src/local-paths.ts";
import { LocalServiceLifecycle, type ServiceCommandRunner } from "../src/service-lifecycle.ts";
import { BoundedServiceLog } from "../src/service-log.ts";
import { requestServiceBrowserLaunchUrl, startServiceOpenBroker } from "../src/service-open.ts";
import { requestServiceRestart, startServiceRestartBroker } from "../src/service-restart.ts";

async function fixture(options: { ready?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "minu-channels-service-"));
  const home = join(root, "home");
  const data = join(root, "data & private");
  const node = join(root, "node");
  const cli = join(root, "minu-channels.js");
  await Promise.all([mkdir(home), mkdir(data), writeFile(node, "node"), writeFile(cli, "cli")]);
  await chmod(node, 0o700);
  let loaded = false;
  let running = false;
  let pid = 123;
  const calls: string[][] = [];
  const runCommand: ServiceCommandRunner = async (command, args) => {
    assert.equal(command, "/bin/launchctl");
    calls.push(args);
    if (args[0] === "print") {
      if (!loaded) throw new Error("not loaded");
      return { stdout: running ? `state = running\npid = ${pid}\n` : "state = exited\n", stderr: "" };
    }
    if (args[0] === "bootstrap") { loaded = true; return { stdout: "", stderr: "" }; }
    if (args[0] === "kickstart") {
      loaded = true;
      running = true;
      if (options.ready !== false) {
        await mkdir(join(data, "run", "open"), { recursive: true });
        await writeFile(join(data, "run", "open", "ready.json"), JSON.stringify({ pid }));
      }
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "kill") { running = false; await rm(join(data, "run", "open", "ready.json"), { force: true }); return { stdout: "", stderr: "" }; }
    if (args[0] === "bootout") { loaded = false; running = false; await rm(join(data, "run", "open", "ready.json"), { force: true }); return { stdout: "", stderr: "" }; }
    throw new Error("unexpected launchctl command");
  };
  const service = new LocalServiceLifecycle({
    dataDirectory: data,
    nodeExecutable: node,
    cliEntryPoint: cli,
    homeDirectory: home,
    uid: 501,
    platform: "darwin",
    runCommand,
    environmentPath: "/opt/homebrew/bin:/usr/bin:/bin & tools",
    lifecycleTimeoutMs: 25,
    pollIntervalMs: 1,
  });
  return {
    root,
    data,
    service,
    calls,
    async replaceProcess(nextPid: number) {
      pid = nextPid;
      running = true;
      await mkdir(join(data, "run", "open"), { recursive: true });
      await writeFile(join(data, "run", "open", "ready.json"), JSON.stringify({ pid }));
    },
  };
}

test("starts an owner-scoped launch agent without enabling login", async () => {
  const { root, data, service, calls } = await fixture();
  try {
    const status = await service.start();
    assert.deepEqual(status, { installed: true, loaded: true, running: true, ready: true, loginEnabled: false });
    assert.deepEqual(calls.filter(([command]) => command !== "print"), [
      ["bootstrap", "gui/501", service.plistPath],
      ["kickstart", service.target],
    ]);
    const plist = await readFile(service.plistPath, "utf8");
    assert.match(plist, /<key>RunAtLoad<\/key>\n  <false\/>/);
    assert.match(plist, /<key>SuccessfulExit<\/key>\n    <false\/>/);
    assert.match(plist, /<integer>10<\/integer>/);
    assert.match(plist, /data &amp; private/);
    assert.match(plist, /\/opt\/homebrew\/bin:\/usr\/bin:\/bin &amp; tools/);
    assert.doesNotMatch(plist, /shell|sh -c/);
    assert.equal((await stat(service.plistPath)).mode & 0o777, 0o600);
    assert.equal((await stat(join(data, "logs"))).mode & 0o777, 0o700);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("lifecycle commands are idempotent and removal preserves product data", async () => {
  const { root, data, service, calls } = await fixture();
  try {
    await writeFile(join(data, "channels.db"), "preserve");
    await service.start();
    assert.equal((await service.status()).running, true);
    const mutationsAfterStart = calls.filter(([command]) => command !== "print").length;
    await service.start();
    assert.equal(calls.filter(([command]) => command !== "print").length, mutationsAfterStart);
    assert.equal((await service.stop()).running, false);
    assert.equal((await service.stop()).running, false);
    assert.equal((await service.restart()).running, true);
    assert.equal((await service.setLoginEnabled(true)).loginEnabled, true);
    const disabled = await service.setLoginEnabled(false);
    assert.equal(disabled.loginEnabled, false);
    assert.equal(disabled.running, true);
    assert.deepEqual(await service.remove(), {
      installed: false, loaded: false, running: false, ready: false, loginEnabled: false,
    });
    assert.equal(await readFile(join(data, "channels.db"), "utf8"), "preserve");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("waits for a different ready launchd process after service-owned restart", async () => {
  const { root, service, replaceProcess } = await fixture();
  try {
    await service.start();
    assert.equal(await service.processId(), 123);
    const waiting = service.waitForRestart(123);
    await replaceProcess(456);
    assert.deepEqual(await waiting, {
      installed: true, loaded: true, running: true, ready: true, loginEnabled: false,
    });
    assert.equal(await service.processId(), 456);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("does not report a launchd process as started before product readiness", async () => {
  const { root, service } = await fixture({ ready: false });
  try {
    await assert.rejects(service.start(), /did not start in time/);
    const status = await service.status();
    assert.equal(status.running, true);
    assert.equal(status.ready, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("refuses to start beside a foreground owner instead of creating a crash loop", async () => {
  const { root, data, service, calls } = await fixture();
  try {
    await prepareChannelsDataDirectory(data);
    const lock = await acquireChannelsDataDirectoryLock(data);
    try {
      await assert.rejects(service.start(), /already running/);
      assert.equal(calls.some(([command]) => command === "bootstrap" || command === "kickstart"), false);
    } finally { await lock.release(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects unsupported service hosts before touching platform tools", async () => {
  assert.throws(() => new LocalServiceLifecycle({
    dataDirectory: "/tmp/data", nodeExecutable: "/tmp/node", cliEntryPoint: "/tmp/cli",
    platform: "linux", uid: 1,
  }), /macOS only/);
});

test("background logs remain serialized, private, and bounded", async () => {
  const root = await mkdtemp(join(tmpdir(), "minu-channels-service-log-"));
  try {
    const path = join(root, "private", "service.log");
    const log = new BoundedServiceLog(path, 64);
    await Promise.all(Array.from({ length: 20 }, (_, index) => log.append(`entry-${index}`)));
    await log.close();
    const contents = await readFile(path, "utf8");
    const previous = await readFile(`${path}.previous`, "utf8");
    assert.ok(Buffer.byteLength(contents) + Buffer.byteLength(previous) <= 64);
    assert.match(contents, /entry-19/);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(`${path}.previous`)).mode & 0o777, 0o600);
    assert.equal((await stat(join(root, "private"))).mode & 0o777, 0o700);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("private service output rejects symlink destinations", async () => {
  const root = await mkdtemp(join(tmpdir(), "minu-channels-service-symlink-"));
  try {
    const outside = join(root, "outside");
    const data = join(root, "data");
    await Promise.all([mkdir(outside), mkdir(data)]);
    await symlink(outside, join(data, "logs"));
    const log = new BoundedServiceLog(join(data, "logs", "service.log"));
    await assert.rejects(log.append("private"), /private local directory/);
    await mkdir(join(data, "run"));
    await symlink(outside, join(data, "run", "open"));
    await assert.rejects(startServiceOpenBroker(data, () => "http://minu-channels.localhost:47412/"), /private local directory/);
    await symlink(outside, join(data, "run", "restart"));
    await assert.rejects(
      startServiceRestartBroker(data, () => ({
        state: "running", activeTurns: 0, queuedTurns: 0, queuedTurnsExact: true, pendingLifecycle: 0,
      }), async () => ({
        state: "quiesced", activeTurns: 0, queuedTurns: 0, queuedTurnsExact: true, pendingLifecycle: 0,
      })),
      /private local directory/,
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("service restart exchange refuses active work or quiesces and waits when requested", async () => {
  const root = await mkdtemp(join(tmpdir(), "minu-channels-service-restart-"));
  try {
    let activeTurns = 1;
    let quiesceCalls = 0;
    let restartReadyCalls = 0;
    const broker = await startServiceRestartBroker(
      root,
      () => ({
        state: "running",
        activeTurns,
        queuedTurns: 3,
        queuedTurnsExact: false,
        pendingLifecycle: 0,
      }),
      async () => {
        quiesceCalls += 1;
        activeTurns = 0;
        return {
          state: "quiesced",
          activeTurns: 0,
          queuedTurns: 3,
          queuedTurnsExact: false,
          pendingLifecycle: 0,
        };
      },
      { intervalMs: 5, onRestartReady: () => { restartReadyCalls += 1; } },
    );
    const busy = await requestServiceRestart(root, {
      waitForIdle: false,
      timeoutMs: 1_000,
      intervalMs: 5,
    });
    assert.deepEqual(busy, {
      status: "busy",
      activeTurns: 1,
      queuedTurns: 3,
      queuedTurnsExact: false,
      pendingLifecycle: 0,
    });
    assert.equal(quiesceCalls, 0);

    const ready = await requestServiceRestart(root, {
      waitForIdle: true,
      timeoutMs: 1_000,
      intervalMs: 5,
    });
    assert.deepEqual(ready, {
      status: "ready",
      activeTurns: 0,
      queuedTurns: 3,
      queuedTurnsExact: false,
      pendingLifecycle: 0,
    });
    assert.equal(quiesceCalls, 1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(restartReadyCalls, 1);
    assert.equal((await stat(join(root, "run", "restart"))).mode & 0o777, 0o700);
    await broker.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("service open exchanges a bootstrap URL only through owner-private files", async () => {
  const root = await mkdtemp(join(tmpdir(), "minu-channels-service-open-"));
  try {
    const broker = await startServiceOpenBroker(root, () => "http://minu-channels.localhost:47412/local/session/bootstrap?code=private");
    const url = await requestServiceBrowserLaunchUrl(root, { timeoutMs: 2_000 });
    assert.equal(url, "http://minu-channels.localhost:47412/local/session/bootstrap?code=private");
    assert.equal((await stat(join(root, "run", "open"))).mode & 0o777, 0o700);
    assert.deepEqual(await import("node:fs/promises").then(({ readdir }) => readdir(join(root, "run", "open"))), ["ready.json"]);
    await broker.close();
    assert.deepEqual(await import("node:fs/promises").then(({ readdir }) => readdir(join(root, "run", "open"))), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
