import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFile = promisify(execFileCallback);

test("launchers use default Runtime construction, preserve environment, and reject the retired Pi config flag", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "channels-runtime-launch-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const capture = join(directory, "constructor.json");
  const runtimeModule = join(directory, "runtime.mjs");
  const retiredConfig = join(directory, "pi-runtime.json");
  await writeFile(retiredConfig, "obsolete invalid configuration", { mode: 0o600 });
  await writeFile(runtimeModule, `import { writeFileSync } from "node:fs";
export class PiAgentRuntime {
  constructor(...args) {
    writeFileSync(process.env.RUNTIME_LAUNCH_CAPTURE, JSON.stringify({
      args, credentialPresent: process.env.RUNTIME_LAUNCH_API_KEY === "fixture-only-api-key",
    }));
    throw new Error("constructor probe complete");
  }
}
`);
  const localCli = fileURLToPath(new URL("../src/local-cli.js", import.meta.url));
  const reviewCli = fileURLToPath(new URL("../src/review-cli.js", import.meta.url));
  const invoke = async (entry: string, args: string[]) => {
    await rm(capture, { force: true });
    try {
      const result = await execFile(process.execPath, [entry, ...args], {
        env: {
          ...process.env,
          MINU_CHANNELS_HOME: directory,
          RUNTIME_LAUNCH_CAPTURE: capture,
          RUNTIME_LAUNCH_API_KEY: "fixture-only-api-key",
        },
        timeout: 10_000,
      });
      return { ...result, code: 0 };
    } catch (error) {
      const failure = error as Error & { code?: unknown; signal?: string; stdout: string; stderr: string };
      if (typeof failure.code !== "number" || failure.signal) throw error;
      return { stdout: failure.stdout, stderr: failure.stderr, code: failure.code };
    }
  };
  for (const { entry, args } of [
    { entry: localCli, args: ["run", "--runtime-module", runtimeModule, "--no-open"] },
    { entry: localCli, args: ["run", "--data-dir", directory, "--runtime-module", runtimeModule, "--service-mode"] },
    { entry: reviewCli, args: ["--local", "--data-dir", directory, "--pi-module", runtimeModule, "--no-open"] },
    { entry: reviewCli, args: ["--live-pi", "--pi-module", runtimeModule, "--no-open"] },
  ]) {
    const result = await invoke(entry, args);
    // Service startup failures exit successfully to avoid launchd restart loops.
    assert.equal(result.code, args.includes("--service-mode") ? 0 : 1);
    assert.deepEqual(JSON.parse(await readFile(capture, "utf8")), { args: [], credentialPresent: true });
    assert.doesNotMatch(result.stdout + result.stderr, /fixture-only-api-key|obsolete invalid configuration/);
  }
  for (const { entry, args } of [
    { entry: localCli, args: ["run", "--runtime-module", runtimeModule] },
    { entry: reviewCli, args: ["--live-pi", "--pi-module", runtimeModule] },
  ]) {
    const result = await invoke(entry, [...args, "--pi-config", retiredConfig]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /unknown (?:option|argument)/i);
    await assert.rejects(readFile(capture), { code: "ENOENT" });
  }
  assert.equal(await readFile(retiredConfig, "utf8"), "obsolete invalid configuration");
});
