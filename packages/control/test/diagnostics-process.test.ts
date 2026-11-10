import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DiagnosticRecorder } from "../src/diagnostics-recorder.ts";
import { createDiagnosticProcess } from "../src/diagnostics-process.ts";

async function until(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!check()) {
    assert.ok(performance.now() < deadline, "Diagnostic process fixture timed out");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

for (const mode of ["busy", "crash"] as const) {
  test(`diagnostic ${mode === "busy" ? "termination during native SQL" : "process crash"} cannot abort the host`, { timeout: 10_000 }, async () => {
    let pid: number | undefined;
    let nativeStarted = false;
    let exited = false;
    let signal: NodeJS.Signals | null = null;
    const recorder = new DiagnosticRecorder({
      path: mode,
      ioTimeoutMs: 2_000,
      workerFactory: (_url, options) => {
        const worker = createDiagnosticProcess(new URL("./fixtures/diagnostics-process.js", import.meta.url), options);
        worker.on("message", message => {
          if (message.type === "ready") pid = message.pid;
          if (message.type === "native_started") {
            nativeStarted = true;
            // Synchronize on dispatch, not a short scheduling window. Recorder
            // timeout-to-termination behavior is covered by the existing fault tests.
            if (mode === "busy") void worker.terminate();
          }
        });
        worker.on("exit", (_code, exitSignal) => { exited = true; signal = exitSignal; });
        return worker;
      },
    });
    try {
      await until(() => recorder.available);
      assert.ok(pid && pid !== process.pid, "Native diagnostics must have a separate process, not only a V8 worker isolate");
      const scope = { workspaceId: "workspace", conversationId: "conversation", participantIdentityId: "agent" };
      const operation = recorder.begin(scope, "stop");
      operation.finish("succeeded");
      const read = assert.rejects(recorder.history(scope), { message: "Diagnostic journal unavailable" });
      await until(() => !recorder.available && recorder.recordingGap && exited);
      await read;
      assert.equal(nativeStarted, true, "The native workload must have been dispatched before failure");
      assert.equal(signal, "SIGKILL");
      assert.equal(operation.recorded, false);
      assert.equal(recorder.begin(scope, "start").recorded, false, "Failure must not start a replacement process");
      const closingAt = performance.now();
      await recorder.close();
      assert.ok(performance.now() - closingAt < 1_500, "Diagnostic failure cannot hold host shutdown indefinitely");
    } finally { await recorder.close(); }
  });
}

test("a failed subprocess spawn remains optional without an unhandled IPC error", async () => {
  const executable = process.execPath;
  let recorder: DiagnosticRecorder;
  try {
    process.execPath = "/missing-diagnostic-process-fixture/node";
    recorder = new DiagnosticRecorder({ path: "/unused-fixture-path" });
  } finally { process.execPath = executable; }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(recorder.available, false);
  assert.equal(recorder.recordingGap, true);
  await recorder.close();
});

test("an idle diagnostic process does not keep its host alive and exits when IPC disconnects", { timeout: 10_000 }, async () => {
  const moduleUrl = new URL("../src/diagnostics-process.js", import.meta.url).href;
  const fixtureUrl = new URL("./fixtures/diagnostics-process.js", import.meta.url).href;
  const probe = `
    import { createDiagnosticProcess } from ${JSON.stringify(moduleUrl)};
    const worker = createDiagnosticProcess(new URL(${JSON.stringify(fixtureUrl)}), { workerData: { path: "idle", epoch: "unref-fixture" } });
    const pid = await new Promise((resolve, reject) => {
      worker.on("error", reject);
      worker.on("message", message => { if (message.type === "ready") resolve(message.pid); });
    });
    worker.unref();
    console.log(pid);
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", probe], { timeout: 5_000 });
  const pid = Number(stdout.trim());
  assert.ok(Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid);
  const stopped = () => {
    try { process.kill(pid, 0); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
  };
  try { await until(stopped); }
  finally { if (!stopped()) process.kill(pid, "SIGKILL"); }
});
