import { ConversationClient } from "@minu/channels-core";
import { DrizzleLibSqlRelayStorage } from "@minu/channels-relay-storage-drizzle";
import { LocalAgentHost, type LocalManagedRuntimePort } from "../../src/agent-host.ts";
import { LocalAgentHostConfiguration } from "../../src/configuration.ts";
import { LocalControlBrowserSessions, LocalControlService, createLocalControlHttpServer } from "../../src/server.ts";

export interface HostWorkerInit {
  type: "initialize";
  endpoint: string;
  serviceToken: string;
  relayUrl: string;
  conversationId: string;
  agentId: string;
  ownerId: string;
  memberId: string;
  now: string;
}
export type HostWorkerMessage =
  | { type: "ready" }
  | { type: "started"; pid: number; endpoint: string; launchUrl: string }
  | { type: "failed"; message: string }
  | { type: "runtime"; id: number; method: string; args: unknown[] };
type RuntimeReply = { type: "runtime_result"; id: number; value?: unknown; error?: string };

let nextId = 0;
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
function rpc<T>(method: string, args: unknown[]): Promise<T> {
  const id = ++nextId;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: value => resolve(value as T), reject });
    process.send!({ type: "runtime", id, method, args } satisfies HostWorkerMessage);
  });
}

async function initialize(input: HostWorkerInit) {
  const client = new ConversationClient(input.endpoint, { serviceToken: input.serviceToken });
  const store = await DrizzleLibSqlRelayStorage.open({ url: input.relayUrl });
  const runtime: LocalManagedRuntimePort = {
    start: config => rpc("start", [config]),
    startManaged: (config, owner) => rpc("startManaged", [config, owner]),
    getManagedSession: (id, owner) => rpc("getManagedSession", [id, owner]),
    listManagedSessions: owner => rpc("listManagedSessions", [owner]),
    resume: (id, owner) => rpc("resume", [id, owner]),
    suspend: (id, owner) => rpc("suspend", [id, owner]),
    interrupt: id => rpc("interrupt", [id]),
    status: id => rpc("status", [id]),
    messages: id => rpc("messages", [id]),
    send: (id, prompt) => rpc("send", [id, prompt]),
    startTurn: (id, turnId, prompt) => rpc("startTurn", [id, turnId, prompt]),
    turn: (id, turnId) => rpc("turn", [id, turnId]),
  };
  const host = new LocalAgentHost({ client, store, runtimes: { retained: runtime }, now: () => new Date(input.now),
    leaseOwner: `crash-child:${process.pid}`, bindingLeaseDurationMs: 30_000, stopStartedSessionsOnClose: false,
    autoResumeOfflineAgents: false });
  await host.startConversationAgent(input.conversationId, input.agentId, input.ownerId);
  const configuration = new LocalAgentHostConfiguration({ client, store });
  // No producer opt-in, cleanup command or signal handler: the test kills this process with its lease held.
  const service = new LocalControlService({ conversations: client, bindings: store, runtimes: { retained: runtime }, configuration, lifecycle: host });
  const sessions = new LocalControlBrowserSessions({ browserUrl: "http://127.0.0.1:5174/", currentHumanIdentityId: input.memberId });
  const server = await createLocalControlHttpServer({ service, browserSessions: sessions, allowedOrigins: [sessions.browserOrigin], port: 0 });
  process.send!({ type: "started", pid: process.pid, endpoint: server.endpoint, launchUrl: sessions.issueLaunchUrl(server.endpoint) } satisfies HostWorkerMessage);
}

process.on("message", (message: HostWorkerInit | RuntimeReply) => {
  if (message.type === "runtime_result") {
    const call = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) call?.reject(new Error(message.error));
    else call?.resolve(message.value);
  } else if (message.type === "initialize") {
    void initialize(message).catch(error => process.send!({ type: "failed", message: (error as Error).stack ?? String(error) } satisfies HostWorkerMessage));
  }
});
process.send!({ type: "ready" } satisfies HostWorkerMessage);
