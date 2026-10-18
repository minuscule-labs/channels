import { ConversationClient } from "@minu/channels-core/client";
import { ConversationEventHub, type EventHubMessage } from "./conversation-event-hub";

const client = new ConversationClient((import.meta.env.VITE_CHANNELS_API_URL ?? "").replace(/\/$/, ""));
const hub = new ConversationEventHub((ids, options) => client.eventsMany(ids, options));
const ports = new Map<MessagePort, { lastSeen: number; inFlight: number; resync: boolean; state: EventHubMessage["type"] }>();
const MAX_IN_FLIGHT = 128;
const PORT_TTL_MS = 180_000;

function remove(port: MessagePort) {
  hub.unsubscribe(port);
  ports.delete(port);
  port.close();
}

// Closed/crashed tabs may not send an unsubscribe. Heartbeats bound their lifetime.
setInterval(() => {
  for (const [port, state] of ports) {
    if (Date.now() - state.lastSeen > PORT_TTL_MS) {
      port.postMessage({ type: "expired" });
      remove(port);
    }
  }
}, 30_000);

(self as unknown as { onconnect: (event: { ports: MessagePort[] }) => void }).onconnect = ({ ports: incoming }) => {
  const port = incoming[0]!;
  const state = { lastSeen: Date.now(), inFlight: 0, resync: false, state: "connecting" as EventHubMessage["type"] };
  ports.set(port, state);
  port.onmessage = ({ data }: MessageEvent) => {
    state.lastSeen = Date.now();
    if (data?.type === "close") return remove(port);
    if (data?.type === "ack") {
      state.inFlight = Math.max(0, state.inFlight - 1);
      if (state.resync && state.inFlight === 0 && state.state === "ready") {
        state.resync = false;
        // A suspended tab fell behind. Reconcile snapshots instead of buffering unbounded events.
        port.postMessage({ type: "connecting" });
        port.postMessage({ type: "ready" });
      }
      return;
    }
    if (data?.type !== "subscribe") return;
    const ids: unknown = data.ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > 1_000
      || !ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= 256 && !id.includes("\0"))) {
      port.postMessage({ type: "unavailable" });
      return remove(port);
    }
    hub.subscribe(port, ids, (message) => {
      if (message.type === "event") {
        if (state.inFlight >= MAX_IN_FLIGHT || state.resync) { state.resync = true; return; }
        state.inFlight++;
      } else {
        state.state = message.type;
        if (message.type === "ready" && state.inFlight === 0) state.resync = false;
      }
      port.postMessage(message);
    });
  };
  port.onmessageerror = () => remove(port);
  port.start();
};
