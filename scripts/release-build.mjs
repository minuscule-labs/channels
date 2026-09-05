import { execFile as execFileCallback } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function runtimeDirectory() {
  if (process.env.MINU_RUNTIME_ROOT) return resolve(process.env.MINU_RUNTIME_ROOT);
  const adjacent = resolve(root, "../runtime");
  if (await exists(resolve(adjacent, "package.json"))) return adjacent;
  const commonGitDirectory = (await execFile(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: root, encoding: "utf8" },
  )).stdout.trim();
  const besidePrimaryCheckout = resolve(commonGitDirectory, "../..", "runtime");
  if (await exists(resolve(besidePrimaryCheckout, "package.json"))) return besidePrimaryCheckout;
  throw new Error("MinuRuntime checkout not found. Set MINU_RUNTIME_ROOT to its absolute path.");
}

function run(command, args, cwd, env = process.env) {
  return new Promise((resolveRun, reject) => {
    const child = execFileCallback(command, args, { cwd, env }, (error) => {
      if (error) reject(error);
      else resolveRun();
    });
    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);
  });
}

const runtimeRoot = await runtimeDirectory();
await run("pnpm", ["build"], runtimeRoot);
await run("pnpm", ["build"], root);
await run("pnpm", ["web:build"], root);
await run(process.execPath, [resolve(root, "scripts/build-release-package.mjs")], root, {
  ...process.env,
  MINU_RUNTIME_ROOT: runtimeRoot,
});
