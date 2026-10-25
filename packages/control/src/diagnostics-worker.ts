import { parentPort, workerData } from "node:worker_threads";
import { DiagnosticJournal, DiagnosticQueryError } from "@minu/channels-relay-storage-drizzle";
import { diagnosticRecord, deliveryRecord, type DeliveryScope, type DiagnosticScope, type DiagnosticTurnReference } from "@minu/channels-relay";

interface Request {
  type: "put" | "put_delivery" | "delivery_history" | "delivery_detail" | "history" | "detail" | "correlated" | "close";
  epoch: string;
  requestId?: number;
  scope?: DiagnosticScope;
  input?: string;
  record?: unknown;
  selection?: DeliveryScope;
  deliveryGap?: boolean;
  reference?: DiagnosticTurnReference;
  gap?: boolean;
}
const port = parentPort!;
const epoch: string = workerData.epoch;
let journal: DiagnosticJournal | undefined;
let stopped = false;
let deliveryOff = false;
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
  send({ type: "ready", gap: journal.recordingGap, deliveryGap: journal.delivery.recordingGap });
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
    if (request.type === "put_delivery") {
      const record = deliveryRecord(request.record);
      let recorded = false;
      try {
        if (!deliveryOff) {
          if (request.gap && !journal!.delivery.recordingGap) await journal!.delivery.markGap();
          recorded = await journal!.delivery.put(record);
        }
      } catch { deliveryOff = true; }
      send({ type: recorded ? "delivery_written" : "delivery_dropped", id: record.trailId, revision: record.revision });
    } else if (request.type === "put") {
      if (request.gap && !journal!.recordingGap) await journal!.markGap();
      const record = diagnosticRecord(request.record);
      const recorded = await journal!.put(record);
      if (!recorded) throw new Error("Diagnostic snapshot was not committed");
      send({ type: "written", id: record.operationId, revision: record.revision });
    } else if (request.type === "close") {
      if (request.gap && !journal!.recordingGap) await journal!.markGap();
      if (request.deliveryGap && !journal!.delivery.recordingGap) await journal!.delivery.markGap().catch(() => undefined);
      await journal!.close();
      stopped = true;
      clearInterval(prune);
      send({ type: "closed" });
      port.close();
    } else {
      try {
        if (deliveryOff && request.type.startsWith("delivery_")) throw new Error("Delivery diagnostics unavailable");
        const value = request.type === "delivery_history" ? await journal!.delivery.history(request.selection!, request.input)
          : request.type === "delivery_detail" ? await journal!.delivery.detail(request.selection!, request.input!)
          : request.type === "history"
          ? await journal!.history(request.scope!, request.input)
          : request.type === "correlated" ? await journal!.correlated(request.scope!, request.reference!)
          : await journal!.detail(request.scope!, request.input!);
        send({ type: "read", requestId: request.requestId, value });
      } catch (error) {
        if (!(error instanceof DiagnosticQueryError) && !request.type.startsWith("delivery_")) throw error;
        send({ type: "read_failed", requestId: request.requestId });
      }
    }
  }).catch(unavailable);
});
