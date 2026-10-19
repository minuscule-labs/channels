import { parentPort, workerData } from "node:worker_threads";
import { DiagnosticJournal, DiagnosticQueryError } from "@minu/channels-relay-storage-drizzle";
import type { DiagnosticRecord, DiagnosticScope, DiagnosticTurnReference } from "@minu/channels-relay";

interface Request {
  type: "put" | "history" | "detail" | "correlated" | "close";
  epoch: string;
  requestId?: number;
  scope?: DiagnosticScope;
  input?: string;
  record?: DiagnosticRecord;
  reference?: DiagnosticTurnReference;
  gap?: boolean;
}
const port = parentPort!;
const epoch: string = workerData.epoch;
let journal: DiagnosticJournal | undefined;
let stopped = false;
let pruning = false;
let queue = Promise.resolve();
const send = (message: object) => port.postMessage({ ...message, epoch });
const unavailable = () => {
  if (stopped) return;
  stopped = true;
  // No native error strings, file paths, or credentials cross the worker boundary.
  send({ type: "unavailable" });
};

try {
  journal = await DiagnosticJournal.open(workerData.path, epoch);
  send({ type: "ready", gap: journal.recordingGap });
} catch { unavailable(); }

const prune = setInterval(() => {
  if (stopped || pruning || !journal) return;
  pruning = true;
  queue = queue.then(async () => { if (!stopped) await journal!.prune(new Date().toISOString()); })
    .catch(unavailable).finally(() => { pruning = false; });
}, 60_000);
prune.unref();

port.on("message", (request: Request) => {
  if (stopped || request.epoch !== epoch || !journal) return;
  queue = queue.then(async () => {
    if (stopped) return;
    if (request.type === "put") {
      if (request.gap && !journal!.recordingGap) await journal!.markGap();
      const recorded = await journal!.put(request.record);
      if (!recorded) throw new Error("Diagnostic snapshot was not committed");
      send({ type: "written", id: request.record!.operationId, revision: request.record!.revision });
    } else if (request.type === "close") {
      if (request.gap && !journal!.recordingGap) await journal!.markGap();
      await journal!.close();
      stopped = true;
      clearInterval(prune);
      send({ type: "closed" });
      port.close();
    } else {
      try {
        const value = request.type === "history"
          ? await journal!.history(request.scope!, request.input)
          : request.type === "correlated" ? await journal!.correlated(request.scope!, request.reference!)
          : await journal!.detail(request.scope!, request.input!);
        send({ type: "read", requestId: request.requestId, value });
      } catch (error) {
        if (!(error instanceof DiagnosticQueryError)) throw error;
        send({ type: "read_failed", requestId: request.requestId });
      }
    }
  }).catch(unavailable);
});
