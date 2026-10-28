import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import { readPiRuntimeHostConfig } from "../src/pi-runtime-config.ts";

const execFile = promisify(execFileCallback);

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "channels-pi-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "pi-runtime.json");
  const save = (value: unknown) => writeFile(path, JSON.stringify(value), { mode: 0o600 });
  return { directory, path, save };
}

test("Pi host configuration is opt-in, installation-scoped, and supports an explicit override", async (t) => {
  const { directory, path, save } = await fixture(t);
  assert.deepEqual(await readPiRuntimeHostConfig({}), { extensionPaths: [] });
  assert.deepEqual(await readPiRuntimeHostConfig({ dataDirectory: directory }), { extensionPaths: [] });
  await assert.rejects(readPiRuntimeHostConfig({ filePath: path }), /could not be read/);
  for (const config of [{}, { extensionPaths: [] }]) {
    await save(config);
    assert.deepEqual(await readPiRuntimeHostConfig({ dataDirectory: directory }), { extensionPaths: [] });
  }
  const extensionPaths = [join(directory, "integration with spaces.ts"), "builtin:codemode"];
  await save({ extensionPaths });
  assert.deepEqual(await readPiRuntimeHostConfig({ dataDirectory: directory }), { extensionPaths });
  const override = join(directory, "override.json");
  await writeFile(override, '{"extensionPaths":["builtin:mcp"]}', { mode: 0o600 });
  assert.deepEqual(await readPiRuntimeHostConfig({ dataDirectory: directory, filePath: override }), {
    extensionPaths: ["builtin:mcp"],
  });
});

test("invalid Pi configuration fails closed without echoing contents or changing permissions", async (t) => {
  const { directory, path, save } = await fixture(t);
  const privateValue = "private-config-value-must-not-be-echoed";
  const invalid = [null, [], 1, { apiKey: privateValue }, { extensionPaths: null }, { extensionPaths: privateValue },
    { extensionPaths: [null] }, { extensionPaths: ["relative.ts"] }, { extensionPaths: ["~/integration.ts"] },
    { extensionPaths: ["builtin:"] }, { extensionPaths: ["builtin:mcp "] }, { extensionPaths: ["/path\0.ts"] },
    { extensionPaths: ["/" + "x".repeat(4_096)] }, { extensionPaths: Array.from({ length: 101 }, (_, i) => `/ext-${i}.ts`) },
    { extensionPaths: [join(directory, "integration.ts"), join(directory, "sub", "..", "integration.ts")] }];
  for (const config of invalid) {
    await save(config);
    await assert.rejects(readPiRuntimeHostConfig({ filePath: path }), (error: Error) => {
      assert.match(error.message, /Invalid Pi Runtime host configuration/);
      assert.ok(!error.message.includes(privateValue));
      return true;
    });
  }
  await writeFile(path, `{"extensionPaths": [${privateValue}`);
  await assert.rejects(readPiRuntimeHostConfig({ filePath: path }), (error: Error) => {
    assert.ok(!error.message.includes(privateValue));
    return true;
  });
  await writeFile(path, " ".repeat(64 * 1024 + 1));
  await assert.rejects(readPiRuntimeHostConfig({ filePath: path }), /exceeds 64 KiB/);
  await assert.rejects(readPiRuntimeHostConfig({ filePath: "" }), /Invalid Pi Runtime host configuration/);
  await save({ extensionPaths: [] });
  if (process.platform !== "win32") {
    await chmod(path, 0o644);
    await assert.rejects(readPiRuntimeHostConfig({ filePath: path }), /owner-only regular file/);
    assert.equal((await stat(path)).mode & 0o777, 0o644);
    await chmod(path, 0o600);
    const redirect = join(directory, "redirect.json");
    await symlink(path, redirect);
    await assert.rejects(readPiRuntimeHostConfig({ filePath: redirect }), /could not be read/);
  }
  const notAFile = join(directory, "not-a-file");
  await mkdir(notAFile);
  await assert.rejects(readPiRuntimeHostConfig({ filePath: notAFile }), /owner-only regular file/);
});

test("production, service, and live-development entrypoints pass the private allowlist to the Pi adapter", async (t) => {
  const { directory, path, save } = await fixture(t);
  const capture = join(directory, "constructor.json");
  const runtimeModule = join(directory, "runtime.mjs");
  await writeFile(runtimeModule, `import { writeFileSync } from "node:fs";
export class PiAgentRuntime {
  constructor(options) {
    writeFileSync(process.env.PI_CONFIG_TEST_CAPTURE, JSON.stringify(options));
    throw new Error("constructor probe complete");
  }
}
`);
  const extensionPaths = [join(directory, "integration.ts"), "builtin:codemode"];
  await save({ extensionPaths });
  const localCli = fileURLToPath(new URL("../src/local-cli.js", import.meta.url));
  const reviewCli = fileURLToPath(new URL("../src/review-cli.js", import.meta.url));
  const invoke = async (entry: string, args: string[]) => {
    await rm(capture, { force: true });
    try {
      return await execFile(process.execPath, [entry, ...args], {
        env: { ...process.env, PI_CONFIG_TEST_CAPTURE: capture, MINU_CHANNELS_HOME: directory },
        timeout: 10_000,
      });
    } catch (error) {
      const failure = error as Error & { code?: unknown; signal?: string; stdout: string; stderr: string };
      if (typeof failure.code !== "number" || failure.signal) throw error;
      return { stdout: failure.stdout, stderr: failure.stderr };
    }
  };
  const invocations = [
    { entry: localCli, args: ["run", "--runtime-module", runtimeModule, "--no-open"] },
    { entry: localCli, args: ["run", "--data-dir", directory, "--runtime-module", runtimeModule, "--service-mode"] },
    { entry: reviewCli, args: ["--local", "--data-dir", directory, "--pi-module", runtimeModule, "--no-open"] },
    { entry: reviewCli, args: ["--live-pi", "--pi-config", path, "--pi-module", runtimeModule, "--no-open"] },
    { entry: localCli, args: ["run", "--data-dir", join(directory, "other"), "--pi-config", path, "--runtime-module", runtimeModule] },
  ];
  for (const { entry, args } of invocations) {
    const output = await invoke(entry, args);
    assert.deepEqual(JSON.parse(await readFile(capture, "utf8")), { extensionPaths });
    assert.ok(!output.stdout.includes(extensionPaths[0]!) && !output.stderr.includes(extensionPaths[0]!));
  }
  // Disposable review must not inherit the installed product's integrations by default.
  await invoke(reviewCli, ["--live-pi", "--pi-module", runtimeModule, "--no-open"]);
  assert.deepEqual(JSON.parse(await readFile(capture, "utf8")), { extensionPaths: [] });
  await rm(path);
  await invoke(localCli, ["run", "--data-dir", directory, "--runtime-module", runtimeModule]);
  assert.deepEqual(JSON.parse(await readFile(capture, "utf8")), { extensionPaths: [] });
  const missing = await invoke(localCli, ["run", "--pi-config", path, "--runtime-module", runtimeModule]);
  assert.match(missing.stderr, /could not be read/);
  await assert.rejects(readFile(capture), { code: "ENOENT" });
  const simulated = await invoke(reviewCli, ["--pi-config", path]);
  assert.match(simulated.stderr, /requires --local or --live-pi/);
  await assert.rejects(readFile(capture), { code: "ENOENT" });
});
