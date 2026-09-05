import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";

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

async function startAndStop(expectedSetup, portBase) {
  const executable = join(installRoot, "node_modules/.bin/minu-channels");
  return await new Promise((resolveRun, reject) => {
    const child = spawn(executable, [
      "--no-open",
      "--data-dir", dataDirectory,
      "--channels-port", String(portBase),
      "--control-port", String(portBase + 1),
      "--web-port", String(portBase + 2),
      workspace,
    ], { env: { ...process.env, HOME: join(temporary, "home") } });
    let output = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Timed out waiting for packaged startup\n${output}`));
    }, 30_000);
    const capture = (chunk) => {
      output += chunk.toString();
      process.stdout.write(chunk);
      if (output.includes(expectedSetup)) setTimeout(() => child.kill("SIGINT"), 100);
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

try {
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(join(temporary, "home"), { recursive: true }),
  ]);
  console.log(`Installing ${basename(tarball)} into ${installRoot}`);
  await run("npm", ["install", "--prefix", installRoot, tarball]);
  const portBase = 46_000 + Math.floor(Math.random() * 1_000);
  await startAndStop("Setup:    created a fresh local Workspace", portBase);
  await startAndStop("Setup:    reopened existing local data", portBase);
  console.log("Release package smoke test passed");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
