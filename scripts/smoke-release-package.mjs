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
      "--no-open",
      "--data-dir", options.dataDirectory ?? dataDirectory,
      "--channels-port", String(portBase),
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
      if (output.includes(expectedSetup) && !stopping) {
        stopping = true;
        void fetch(`http://127.0.0.1:${portBase + 2}/`).then(async (response) => {
          const html = await response.text();
          if (!response.ok || !html.includes("<title>MinuChannels</title>")) {
            throw new Error("Packaged web application is unavailable");
          }
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

try {
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(join(temporary, "home"), { recursive: true }),
  ]);
  console.log(`Installing ${basename(tarball)} into ${installRoot}`);
  await run("npm", ["install", "--prefix", installRoot, tarball]);
  const executable = join(installRoot, "node_modules/.bin/minu-channels");
  const version = (await capture(executable, ["--version"])).trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Packaged CLI returned an invalid version: ${version}`);
  const paths = JSON.parse(await capture(executable, ["paths", "--data-dir", dataDirectory, "--json"]));
  if (paths.dataDirectory !== dataDirectory) throw new Error("Packaged paths command returned the wrong data directory");
  await capture(executable, ["doctor", "--data-dir", dataDirectory, "--json"]);
  const portBase = 46_000 + Math.floor(Math.random() * 1_000);
  await startAndStop("Setup:    created a fresh local Workspace", portBase);
  await startAndStop("Setup:    reopened existing local data", portBase);
  await startAndStop("Setup:    ready for browser Workspace setup", portBase + 10, {
    dataDirectory: join(temporary, "browser-first-data"),
    workspacePath: undefined,
  });
  console.log("Release package smoke test passed");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
