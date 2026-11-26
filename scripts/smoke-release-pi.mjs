// Installed release package + real Pi executable + local stand-in model.
// No login, provider credential or network model is used: Pi only sees a models.json pointing at this process.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const artifacts = resolve(root, "release/artifacts");
const requested = process.argv[2];
const tarball = requested
  ? resolve(requested)
  : join(artifacts, (await readdir(artifacts)).filter((name) => name.endsWith(".tgz")).sort().at(-1) ?? "");
if (!tarball.endsWith(".tgz")) throw new Error("Pass a release package tarball or run pnpm release:pack first");
const runtimeRoot = resolve(process.env.MINU_RUNTIME_ROOT ?? join(root, "../runtime"));
const piCommand = resolve(process.env.MINU_SMOKE_PI_COMMAND ?? join(runtimeRoot, "node_modules/.bin/pi"));
if (!existsSync(piCommand)) throw new Error(`Pi executable not found at ${piCommand}; install the pinned Runtime or set MINU_SMOKE_PI_COMMAND`);
// Idle sleep cannot be shortened below 15 minutes, so the sleep/wake step is opt-in.
const includeSleep = process.env.MINU_SMOKE_PI_SLEEP === "1";

const checksums = join(dirname(tarball), "SHA256SUMS");
if (existsSync(checksums)) {
  const expected = (await readFile(checksums, "utf8")).split("\n").find((line) => line.trim().endsWith(basename(tarball)))?.split(/\s+/)[0];
  assert.equal(createHash("sha256").update(await readFile(tarball)).digest("hex"), expected, "Tarball must match SHA256SUMS");
}

const temporary = await mkdtemp(join(tmpdir(), "minu-channels-pi-"));
const installRoot = join(temporary, "install");
const dataDirectory = join(temporary, "data");
const project = join(temporary, "project");
const agentDirectory = join(temporary, "pi-agent");
const skillsDirectory = join(agentDirectory, "skills");
const bin = join(temporary, "bin");
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function writeSkill(name) {
  await mkdir(join(skillsDirectory, name), { recursive: true });
  await writeFile(join(skillsDirectory, name, "SKILL.md"), `---\nname: ${name}\ndescription: Marker-${name}-skill for testing.\n---\nBody ${name}.\n`);
}
const deleteSkill = (name) => rm(join(skillsDirectory, name), { recursive: true });

// Each reply echoes the newest token in the prompt, so a reply proves which message reached the model.
const modelRequests = [];
const model = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    let parsed = {};
    try { parsed = JSON.parse(body); } catch {}
    const text = JSON.stringify(parsed.messages ?? []);
    const token = [...text.matchAll(/TOKEN-[a-z0-9]+/g)].at(-1)?.[0] ?? "NONE";
    modelRequests.push({ model: parsed.model, token, text });
    const reply = `pong ${token}`;
    const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
    if (!parsed.stream) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ id: "smoke", object: "chat.completion", model: parsed.model, usage,
        choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }] }));
      return;
    }
    response.setHeader("content-type", "text/event-stream");
    const chunk = (delta, finishReason = null, extra = {}) => response.write(`data: ${JSON.stringify({
      id: "smoke", object: "chat.completion.chunk", model: parsed.model, choices: [{ index: 0, delta, finish_reason: finishReason }], ...extra,
    })}\n\n`);
    chunk({ role: "assistant", content: reply.slice(0, 5) });
    chunk({ content: reply.slice(5) });
    chunk({}, "stop", { usage });
    response.end("data: [DONE]\n\n");
  });
});

const portBase = 47_000 + Math.floor(Math.random() * 1_000);
const endpoint = `http://127.0.0.1:${portBase + 2}`;
let child;
let cookie;
let failures = 0;

function check(name, passed, detail = "") {
  if (!passed) failures += 1;
  console.log(`${passed ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
}

function workerProcesses() {
  return execFileSync("ps", ["ax", "-o", "pid=,command="]).toString().split("\n")
    .filter((line) => line.includes(installRoot) && line.includes("owned-worker"))
    .map((line) => line.trim().split(/\s+/, 1)[0]);
}

async function start(environment) {
  let output = "";
  child = spawn(join(installRoot, "node_modules/.bin/minu-channels"), [
    "run", "--no-open", "--data-dir", dataDirectory,
    "--conversations-port", String(portBase), "--control-port", String(portBase + 1), "--web-port", String(portBase + 2), project,
  ], { env: environment, cwd: project });
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 120 && !output.includes("Press Ctrl-C to stop MinuChannels."); attempt += 1) await sleep(250);
  const launch = output.match(/http:\/\/[^\s]+\/local\/session\/bootstrap\?[^\s]+/)?.[0];
  assert.ok(launch, `Packaged app must issue a browser launch URL\n${output}`);
  const launchUrl = new URL(launch);
  launchUrl.hostname = "127.0.0.1";
  cookie = (await fetch(launchUrl, { redirect: "manual" })).headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  return output.match(/Setup:\s+(.*)/)?.[1] ?? "";
}

async function stop() {
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  child.kill("SIGINT");
  return await exited;
}

async function api(path, method = "GET", body, headers = {}) {
  const response = await fetch(`${endpoint}${path}`, {
    method,
    headers: { cookie, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body && JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} returned ${response.status}: ${text}`);
  return text ? JSON.parse(text) : undefined;
}

try {
  await Promise.all([installRoot, project, bin, join(temporary, "home"), join(temporary, "tmp"), join(temporary, "sessions")]
    .map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })));
  await Promise.all(["alpha", "beta", "gamma"].map(writeSkill));
  await new Promise((resolveListen) => model.listen(0, "127.0.0.1", resolveListen));
  await writeFile(join(agentDirectory, "models.json"), JSON.stringify({ providers: { smoke: {
    baseUrl: `http://127.0.0.1:${model.address().port}/v1`, api: "openai-completions", apiKey: "not-a-credential",
    models: [{ id: "smoke-model" }],
  } } }));
  await writeFile(join(agentDirectory, "settings.json"), JSON.stringify({ defaultProvider: "smoke", defaultModel: "smoke-model" }));
  // A minimal PATH keeps installed Codex/Claude Code and any signed-in Pi out of reach.
  execFileSync("ln", ["-s", process.execPath, join(bin, "node")]);
  // A wrapper, not a symlink: package-manager shims locate their package relative to their own path.
  await writeFile(join(bin, "pi"), `#!/bin/sh\nexec ${JSON.stringify(piCommand)} "$@"\n`, { mode: 0o755 });
  const environment = {
    HOME: join(temporary, "home"), PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, TMPDIR: join(temporary, "tmp"), LANG: "C.UTF-8",
    PI_CODING_AGENT_DIR: agentDirectory, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1",
    MINU_RUNTIME_DIR: join(temporary, "sessions"), MINU_HOME: join(temporary, "minu"),
  };
  console.log(`Installing ${basename(tarball)} with Pi ${execFileSync(piCommand, ["--version"]).toString().trim()}`);
  execFileSync("npm", ["install", "--silent", "--no-audit", "--no-fund", "--prefix", installRoot, tarball], { stdio: "inherit" });

  const setup = await start(environment);
  check("fresh start", /created a fresh local Workspace/.test(setup), setup);
  const humanId = (await api("/local/session")).identityId;
  const workspaceId = (await api("/workspaces")).workspaces[0].id;
  const agentId = (await api("/identities")).identities.find((identity) => identity.displayName === "Builder").id;
  const optionsPath = `/local/workspaces/${workspaceId}/agents/${agentId}/runtime-options`;
  const configPath = `/local/workspaces/${workspaceId}/agents/${agentId}/config`;
  const options = await api(optionsPath);
  check("only the stand-in model is available", options.models.length === 1 && JSON.stringify(options.models[0]).includes("smoke-model"),
    JSON.stringify(options.models));
  const skillId = (name) => options.skills.find((skill) => skill.id.endsWith(`:${name}`))?.id;
  assert.ok(skillId("alpha") && skillId("beta") && skillId("gamma"), "Pi must report the three test skills");
  await api(configPath, "PATCH", { skillIds: [skillId("alpha"), skillId("beta")] });

  const conversation = async (name) => (await api("/conversations", "POST", { workspaceId, participantIds: [humanId, agentId], name })).conversation.id;
  let sent = 0;
  async function ask(conversationId, label, expectedSkills) {
    const token = `TOKEN-${++sent}${randomUUID().slice(0, 8)}`;
    await api(`/local/conversations/${conversationId}/messages`, "POST",
      { participantId: humanId, to: [agentId], body: `Reply with ${token}` }, { "idempotency-key": randomUUID() });
    let reply;
    for (let attempt = 0; attempt < 120 && !reply; attempt += 1) {
      await sleep(500);
      reply = (await api(`/conversations/${conversationId}/messages`)).messages
        .find((message) => message.participantId === agentId && message.body.includes(`pong ${token}`));
    }
    const request = modelRequests.filter((entry) => entry.token === token).at(-1);
    const seen = request ? ["alpha", "beta", "gamma"].filter((name) => request.text.includes(`Marker-${name}-skill`)) : undefined;
    check(`${label}: reply posted`, Boolean(reply));
    check(`${label}: model saw only the expected skills`, JSON.stringify(seen) === JSON.stringify(expectedSkills),
      `saw ${JSON.stringify(seen)}, expected ${JSON.stringify(expectedSkills)}`);
    if (!reply) {
      console.log(JSON.stringify((await api(`/local/conversations/${conversationId}/agents`)).agents));
      console.log(JSON.stringify(await api(`/local/conversations/${conversationId}/turn-failures`)));
    }
  }
  async function agentAction(conversationId, action) {
    const requestId = randomUUID();
    await api(`/local/conversations/${conversationId}/agent-actions`, "POST", { requestId, action, identityId: agentId });
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const receipt = await api(`/local/conversations/${conversationId}/agent-actions/${requestId}`);
      if (receipt.state !== "pending") return receipt;
      await sleep(500);
    }
    return { state: "pending" };
  }

  const first = await conversation("Pi smoke");
  await ask(first, "first message", ["alpha", "beta"]);
  await ask(first, "same session", ["alpha", "beta"]);

  // Stop pauses delivery but keeps the Pi process, so its loaded skills stay until Pi itself restarts.
  await deleteSkill("beta");
  await api(`/local/conversations/${first}/agents/${agentId}/stop`, "POST");
  await api(`/local/conversations/${first}/agents/${agentId}/start`, "POST");
  await ask(first, "Stop then Start", ["alpha", "beta"]);
  const workersBefore = workerProcesses();
  const restart = await agentAction(first, "restart-runtime");
  check("Pi restarts with a selected skill missing", restart.state === "succeeded" && !workerProcesses().some((pid) => workersBefore.includes(pid)),
    `${restart.state} ${restart.error ?? ""}`);
  await ask(first, "after Pi restart", ["alpha"]);
  await ask(await conversation("Missing skill"), "new conversation with a missing skill", ["alpha"]);

  await sleep(6_000); // Runtime options are cached for 5 seconds.
  const missing = await api(optionsPath);
  check("settings report the missing skill", missing.selectedSkillIds.includes(skillId("beta")) && !missing.skills.some((skill) => skill.id === skillId("beta")));

  check("clean shutdown", await stop() === 0);
  const reopened = await start(environment);
  check("reopen existing data", /reopened existing local data/.test(reopened), reopened);
  check("messages kept after reopen", (await api(`/conversations/${first}/messages`)).messages.length >= 8);
  await ask(first, "after reopen", ["alpha"]);

  await deleteSkill("alpha");
  await ask(await conversation("No skills"), "every selected skill missing", []);
  await api(configPath, "PATCH", { skillIds: [] });
  check("missing skills can be removed", (await api(configPath)).skillIds?.length === 0);

  if (includeSleep) {
    await Promise.all(["alpha", "beta"].map(writeSkill));
    await sleep(6_000);
    await api(configPath, "PATCH", { skillIds: [skillId("alpha"), skillId("beta")] });
    await api(`/local/workspaces/${workspaceId}/config`, "PATCH", { idleSleepTimeoutMs: 15 * 60_000 });
    const sleeper = await conversation("Sleep");
    await ask(sleeper, "before sleep", ["alpha", "beta"]);
    await deleteSkill("beta");
    // The agent list reports a sleeping agent as idle, so wait for its worker to exit instead.
    const awake = workerProcesses();
    const started = Date.now();
    while (workerProcesses().some((pid) => awake.includes(pid)) && Date.now() - started < 20 * 60_000) await sleep(10_000);
    check("agent sleeps by itself", !workerProcesses().some((pid) => awake.includes(pid)), `${Math.round((Date.now() - started) / 1000)}s`);
    await ask(sleeper, "woken with a skill deleted while asleep", ["alpha"]);
  }

  check("final clean shutdown", await stop() === 0);
  check("only the stand-in model was called", modelRequests.length > 0 && modelRequests.every((entry) => entry.model === "smoke-model"));
} finally {
  if (child && child.exitCode === null && child.signalCode === null) await stop().catch(() => undefined);
  // Owned workers outlive the app by design; stop the ones this run started.
  for (const pid of workerProcesses()) {
    try { process.kill(Number(pid), "SIGTERM"); } catch {}
  }
  model.closeAllConnections();
  model.close();
  await sleep(1_000);
  await rm(temporary, { recursive: true, force: true });
}

if (failures) {
  console.log(`Pi release package smoke test failed: ${failures} check(s)`);
  process.exitCode = 1;
} else console.log("Pi release package smoke test passed");
