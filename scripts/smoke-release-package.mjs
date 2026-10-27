import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";

const root = resolve(import.meta.dirname, "..");
const artifacts = resolve(root, "release/artifacts");
const requested = process.argv[2];
const tarball = requested
  ? resolve(requested)
  : join(artifacts, (await readdir(artifacts)).filter((name) => name.endsWith(".tgz")).sort().at(-1) ?? "");
if (!tarball.endsWith(".tgz")) throw new Error("Pass a release package tarball or run pnpm release:pack first");

const temporary = await mkdtemp(join(tmpdir(), "minu-channels-package-"));
const installRoot = join(temporary, "install");
const dataDirectory = join(temporary, "data");
const workspace = join(temporary, "workspace");

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolveRun() : reject(new Error(`${command} exited with ${code}`)));
  });
}

function capture(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, options);
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolveRun(output) : reject(new Error(`${command} exited with ${code}: ${output}`)));
  });
}

async function startAndStop(expectedSetup, portBase, options = {}) {
  const executable = join(installRoot, "node_modules/.bin/minu-channels");
  const workspacePath = Object.hasOwn(options, "workspacePath") ? options.workspacePath : workspace;
  return await new Promise((resolveRun, reject) => {
    const child = spawn(executable, [
      ...(options.explicitRun ? ["run"] : []),
      "--no-open",
      "--data-dir", options.dataDirectory ?? dataDirectory,
      "--conversations-port", String(portBase),
      "--control-port", String(portBase + 1),
      "--web-port", String(portBase + 2),
      ...(workspacePath ? [workspacePath] : []),
    ], { env: { ...process.env, HOME: join(temporary, "home") } });
    let output = "";
    let stopping = false;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Timed out waiting for packaged startup\n${output}`));
    }, 30_000);
    const capture = (chunk) => {
      output += chunk.toString();
      process.stdout.write(chunk);
      if (output.includes(expectedSetup) && output.includes("Press Ctrl-C to stop MinuChannels.") && !stopping) {
        stopping = true;
        void fetch(`http://127.0.0.1:${portBase + 2}/`).then(async (response) => {
          const html = await response.text();
          if (!response.ok || !html.includes("<title>MinuChannels</title>")) {
            throw new Error("Packaged web application is unavailable");
          }
          await options.verify?.(output);
          child.kill("SIGINT");
        }).catch((error) => {
          child.kill("SIGTERM");
          reject(error);
        });
      }
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0 && output.includes(expectedSetup)) resolveRun();
      else reject(new Error(`Packaged startup exited with ${code}\n${output}`));
    });
  });
}

const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
let sharedImage;

async function imageSharingSmoke(portBase, output) {
  const launch = output.match(/http:\/\/[^\s]+\/local\/session\/bootstrap\?[^\s]+/)?.[0];
  assert.ok(launch, "Packaged app must issue a browser launch URL");
  const launchUrl = new URL(launch);
  launchUrl.hostname = "127.0.0.1";
  const bootstrap = await fetch(launchUrl, { redirect: "manual" });
  assert.equal(bootstrap.status, 303);
  const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  const endpoint = `http://127.0.0.1:${portBase + 2}`;
  async function request(path, init = {}, expectedStatus = 200) {
    const response = await fetch(`${endpoint}${path}`, { ...init, headers: { cookie, ...init.headers } });
    assert.equal(response.status, expectedStatus, `Packaged image request: ${path}`);
    return response;
  }
  const { identityId } = await (await request("/local/session")).json();
  if (!sharedImage) {
    const { workspaces } = await (await request("/workspaces")).json();
    // A human-only Conversation prevents this packaging check from waking a real agent.
    const { conversation } = await (await request("/conversations", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: workspaces[0].id, participantIds: [identityId], name: "Package images" }),
    }, 201)).json();
    const { attachment } = await (await request(`/conversations/${conversation.id}/attachments?filename=package.png`, {
      method: "POST", headers: { "content-type": "image/png" }, body: imageBytes,
    }, 201)).json();
    sharedImage = { conversationId: conversation.id, attachment, input: { participantId: identityId, body: "", attachmentIds: [attachment.id] } };
  }
  const messagesPath = `/conversations/${sharedImage.conversationId}/messages`;
  for (let retry = 0; retry < 2; retry += 1) {
    const { message } = await (await request(messagesPath, {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": "package-image-send" },
      body: JSON.stringify(sharedImage.input),
    }, 201)).json();
    sharedImage.message ??= message;
    assert.deepEqual(message, sharedImage.message);
    assert.equal(message.body, "");
    assert.equal(message.attachments[0].id, sharedImage.attachment.id);
  }
  const { messages } = await (await request(messagesPath)).json();
  assert.deepEqual(messages, [sharedImage.message]);
  const contentUrl = `${endpoint}${sharedImage.attachment.contentUrl}`;
  assert.equal((await fetch(contentUrl)).status, 401, "Image bytes require the browser session");
  const content = await request(sharedImage.attachment.contentUrl);
  assert.equal(content.headers.get("content-type"), "image/png");
  assert.equal(content.headers.get("x-content-type-options"), "nosniff");
  assert.equal(content.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(Buffer.from(await content.arrayBuffer()), imageBytes);
  assert.deepEqual(await readFile(join(dataDirectory, "attachments", sharedImage.attachment.id)), imageBytes);
}

async function diagnosticWorkerSmoke() {
  const epoch = "release-smoke-epoch";
  const worker = new Worker(join(installRoot, "node_modules/@minu/channels/dist/bin/diagnostics-worker.js"), {
    workerData: { path: join(temporary, "diagnostic-smoke.db"), epoch },
  });
  await new Promise((resolveSmoke, reject) => {
    let closed = false;
    const fail = (error) => { clearTimeout(timeout); void worker.terminate().catch(() => {}); reject(error); };
    const timeout = setTimeout(() => fail(new Error("Packaged diagnostic worker timed out")), 5_000);
    worker.on("error", fail);
    worker.on("message", (message) => {
      if (message.epoch !== epoch) return fail(new Error("Packaged diagnostic worker epoch mismatch"));
      if (message.type === "ready") worker.postMessage({ type: "history", epoch, requestId: 1,
        scope: { workspaceId: "smoke-workspace", conversationId: "smoke-conversation", participantIdentityId: "smoke-agent" } });
      else if (message.type === "read") {
        if (message.requestId === 2) {
          const trails = message.value?.trails;
          if (!Array.isArray(trails) || trails.length !== 1 || trails[0].trailId !== "trail_smoke" || trails[0].triggerSequence !== 1
            || trails[0].outcome !== "delivered" || /smoke-private|bindingId|sessionId|ownerId|triggerId/.test(JSON.stringify(message.value))) {
            return fail(new Error("Packaged message-delivery journal projection failed"));
          }
          worker.postMessage({ type: "close", epoch });
          return;
        }
        if (message.requestId !== 1 || message.value?.coverage !== "available" || !Array.isArray(message.value.operations) || message.value.operations.length !== 0) {
          return fail(new Error("Packaged diagnostic journal read failed"));
        }
        const now = new Date().toISOString();
        worker.postMessage({ type: "put_delivery", epoch, record: {
          workspaceId: "smoke-workspace", conversationId: "smoke-conversation", participantIdentityId: "smoke-agent",
          bindingId: "smoke-private-binding", generation: 1, adapter: "pi", sessionId: "smoke-private-session", ownerId: "smoke-private-owner",
          trailId: "trail_smoke", triggerId: "smoke-private-trigger", triggerSequence: 1, epoch, revision: 1, lastSequence: 1,
          startedAt: now, observedAt: now, closedAt: now, outcome: "delivered", eventsDropped: 0, recordingGap: false,
          events: [{ sequence: 1, stage: "response_committed", observedAt: now, elapsedMs: 0, kind: "reply", responseSequence: 2 }],
        } });
      } else if (message.type === "delivery_written") {
        if (message.id !== "trail_smoke" || message.revision !== 1) return fail(new Error("Packaged message-delivery acknowledgment mismatch"));
        worker.postMessage({ type: "delivery_history", epoch, requestId: 2, selection: {
          workspaceId: "smoke-workspace", conversationId: "smoke-conversation", participantIdentityId: "smoke-agent",
          bindingId: "smoke-private-binding", generation: 1, adapter: "pi", sessionId: "smoke-private-session", ownerId: "smoke-private-owner",
        } });
      } else if (message.type === "closed") closed = true;
      else fail(new Error("Packaged diagnostic journal unavailable"));
    });
    worker.on("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0 && closed) resolveSmoke();
      else reject(new Error("Packaged diagnostic worker did not close cleanly"));
    });
  });
}

try {
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(join(temporary, "home"), { recursive: true }),
  ]);
  console.log(`Installing ${basename(tarball)} into ${installRoot}`);
  await run("npm", ["install", "--prefix", installRoot, tarball]);
  const manifest = JSON.parse(await readFile(join(installRoot, "node_modules/@minu/channels/package.json"), "utf8"));
  assert.equal(manifest.engines.node, ">=22.5.0");
  await diagnosticWorkerSmoke();
  const executable = join(installRoot, "node_modules/.bin/minu-channels");
  const version = (await capture(executable, ["--version"])).trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Packaged CLI returned an invalid version: ${version}`);
  const help = await capture(executable, ["--help"]);
  for (const command of ["start", "stop", "restart", "status", "open", "enable-login", "disable-login", "remove-service", "run"]) {
    if (!help.includes(command)) throw new Error(`Packaged CLI help is missing ${command}`);
  }
  const restartHelp = await capture(executable, ["restart", "--help"]);
  if (!restartHelp.includes("--when-idle")) throw new Error("Packaged restart help is missing --when-idle");
  const updateHelp = await capture(executable, ["update", "--help"]);
  if (!updateHelp.includes("--check") || !updateHelp.includes("--yes")) {
    throw new Error("Packaged update help is missing safe update controls");
  }
  const paths = JSON.parse(await capture(executable, ["paths", "--data-dir", dataDirectory, "--json"]));
  if (paths.dataDirectory !== dataDirectory) throw new Error("Packaged paths command returned the wrong data directory");
  assert.equal(paths.attachments, join(dataDirectory, "attachments"));
  await capture(executable, ["doctor", "--data-dir", dataDirectory, "--json"]);
  const portBase = 46_000 + Math.floor(Math.random() * 1_000);
  const verifyImages = async (output) => {
    await imageSharingSmoke(portBase, output);
    await assert.rejects(capture(executable, [
      "run", "--no-open", "--data-dir", dataDirectory,
      "--conversations-port", String(portBase + 20),
      "--control-port", String(portBase + 21),
      "--web-port", String(portBase + 22),
    ], { timeout: 5_000, env: { ...process.env, HOME: join(temporary, "home") } }), /already using data directory/);
  };
  await startAndStop("Setup:    created a fresh local Workspace", portBase, { explicitRun: true, verify: verifyImages });
  const lockDatabasePath = join(dataDirectory, "run", "instance-lock.sqlite");
  const lockDatabase = await stat(lockDatabasePath);
  assert.equal(lockDatabase.mode & 0o777, 0o600);
  await startAndStop("Setup:    reopened existing local data", portBase, { verify: verifyImages });
  const reopenedLockDatabase = await stat(lockDatabasePath);
  assert.equal(reopenedLockDatabase.dev, lockDatabase.dev);
  assert.equal(reopenedLockDatabase.ino, lockDatabase.ino);
  await startAndStop("Setup:    ready for browser Workspace setup", portBase + 10, {
    dataDirectory: join(temporary, "browser-first-data"),
    workspacePath: undefined,
  });
  console.log("Release package smoke test passed");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
