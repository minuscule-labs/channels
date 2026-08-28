import type { ChannelMetadata } from "@minu/channels-core/types";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { LocalControlBrowserSessions } from "./session.js";
export {
  LocalControlBrowserSessions,
  type LocalControlAuditAction,
  type LocalControlAuditEvent,
  type LocalControlBrowserSessionsOptions,
  type LocalControlLaunchExchange,
} from "./session.js";
import {
  LOCAL_CONTROL_PROTOCOL_VERSION,
  type LocalChannelAgent,
  type LocalChannelAgentsResponse,
  type LocalControlCapabilities,
  type LocalControlHealth,
  type LocalWakePolicy,
} from "./contracts.js";

export interface LocalControlChannelDirectory {
  getChannel(channelId: string): Promise<ChannelMetadata>;
}

export interface LocalControlBindingRecord {
  agentIdentityId: string;
  runtimeAdapter: string;
  runtimeSessionId: string;
  state: "connected" | "offline" | "replacing" | "disabled";
  wakePolicy: LocalWakePolicy;
  lastVerifiedAt?: string;
}

export interface LocalControlBindingDirectory {
  listChannelBindings(channelId: string): Promise<LocalControlBindingRecord[]>;
}

export interface LocalControlRuntimePort {
  status(sessionId: string): Promise<"idle" | "working" | "offline">;
}

export interface LocalControlServiceOptions {
  channels: LocalControlChannelDirectory;
  bindings: LocalControlBindingDirectory;
  runtimes: Readonly<Record<string, LocalControlRuntimePort>>;
  statusTimeoutMs?: number;
}

const disabledCapabilities = { steer: false, interrupt: false, reconnect: false } as const;

export class LocalControlService {
  private readonly statusTimeoutMs: number;

  constructor(private readonly options: LocalControlServiceOptions) {
    this.statusTimeoutMs = options.statusTimeoutMs ?? 2_000;
    if (!Number.isSafeInteger(this.statusTimeoutMs) || this.statusTimeoutMs < 1) {
      throw new RangeError("statusTimeoutMs must be a positive integer");
    }
  }

  health(): LocalControlHealth {
    return { status: "ok", protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION };
  }

  capabilities(): LocalControlCapabilities {
    return {
      protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION,
      features: {
        channelAgentStatus: true,
        workspaceConfigRead: false,
        workspaceConfigWrite: false,
        agentCreate: false,
        steer: false,
        interrupt: false,
        reconnect: false,
      },
    };
  }

  async listChannelAgents(channelId: string): Promise<LocalChannelAgentsResponse> {
    const [channel, records] = await Promise.all([
      this.options.channels.getChannel(channelId),
      this.options.bindings.listChannelBindings(channelId),
    ]);
    const agents = await Promise.all(channel.participants
      .filter(({ type }) => type === "agent" || type === "service")
      .map((participant) => this.presentAgent(channel, participant.id, participant.status, records)));
    return {
      protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION,
      channelId: channel.id,
      agents,
    };
  }

  private async presentAgent(
    channel: ChannelMetadata,
    identityId: string,
    membershipStatus: "active" | "disabled" | undefined,
    records: LocalControlBindingRecord[],
  ): Promise<LocalChannelAgent> {
    const matches = records.filter(({ agentIdentityId }) => agentIdentityId === identityId);
    const base = { workspaceId: channel.workspaceId, channelId: channel.id, identityId };
    if (membershipStatus === "disabled") {
      return { ...base, state: "disabled", capabilities: disabledCapabilities };
    }
    if (matches.length === 0) {
      return { ...base, state: "unbound", capabilities: disabledCapabilities };
    }
    if (matches.length > 1) {
      return { ...base, state: "uncertain", capabilities: disabledCapabilities };
    }
    const binding = matches[0]!;
    const details = { wakePolicy: binding.wakePolicy, lastVerifiedAt: binding.lastVerifiedAt };
    if (binding.state === "disabled") {
      return { ...base, ...details, state: "disabled", capabilities: disabledCapabilities };
    }
    if (binding.state === "replacing") {
      return { ...base, ...details, state: "uncertain", capabilities: disabledCapabilities };
    }
    const runtime = this.options.runtimes[binding.runtimeAdapter];
    if (!runtime) {
      return { ...base, ...details, state: "offline", capabilities: disabledCapabilities };
    }
    try {
      const status = await this.readRuntimeStatus(runtime, binding.runtimeSessionId);
      if (status === "working") {
        return { ...base, ...details, state: "running", capabilities: disabledCapabilities };
      }
      return {
        ...base,
        ...details,
        state: status === "idle" ? "idle" : "offline",
        capabilities: disabledCapabilities,
      };
    } catch {
      return { ...base, ...details, state: "offline", capabilities: disabledCapabilities };
    }
  }

  private async readRuntimeStatus(
    runtime: LocalControlRuntimePort,
    sessionId: string,
  ): Promise<"idle" | "working" | "offline"> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        runtime.status(sessionId),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Runtime status timed out")), this.statusTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export interface LocalControlHttpServerOptions {
  service: LocalControlService;
  host?: "127.0.0.1" | "::1";
  port?: number;
  allowedOrigins?: readonly string[];
  /** Required by the real daemon; optional for isolated read-only fixtures. */
  browserSessions?: LocalControlBrowserSessions;
}

export interface LocalControlHttpServer {
  endpoint: string;
  close(): Promise<void>;
}

function json(response: ServerResponse, status: number, body: unknown, origin?: string): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  if (origin) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-credentials", "true");
    response.setHeader("vary", "Origin");
  }
  response.end(JSON.stringify(body));
}

function requestHostname(request: IncomingMessage): string | undefined {
  const host = request.headers.host;
  if (!host) return undefined;
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return undefined;
  }
}

function isAllowedHost(hostname: string | undefined): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
}

export async function createLocalControlHttpServer(
  options: LocalControlHttpServerOptions,
): Promise<LocalControlHttpServer> {
  const host = options.host ?? "127.0.0.1";
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const server = createServer((request, response) => {
    const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
    if (!isAllowedHost(requestHostname(request))) {
      json(response, 403, { error: "Forbidden host" });
      return;
    }
    if (origin && !allowedOrigins.has(origin)) {
      json(response, 403, { error: "Forbidden origin" });
      return;
    }
    if (request.method !== "GET") {
      response.setHeader("allow", "GET");
      json(response, 405, { error: "Method not allowed" }, origin);
      return;
    }

    void (async () => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
      const path = url.pathname;
      if (path === "/local/session/bootstrap" && options.browserSessions) {
        const exchange = options.browserSessions.exchangeLaunchCode(url.searchParams.get("code") ?? undefined);
        response.setHeader("cache-control", "no-store");
        response.setHeader("referrer-policy", "no-referrer");
        if (!exchange) {
          json(response, 401, { error: "Invalid or expired launch code" }, origin);
          return;
        }
        response.statusCode = 303;
        response.setHeader("set-cookie", exchange.cookie);
        response.setHeader("location", exchange.redirectUrl);
        response.end();
        return;
      }
      if (options.browserSessions && !options.browserSessions.authorize(request.headers.cookie)) {
        json(response, 401, { error: "Local browser session required" }, origin);
        return;
      }
      if (path === "/local/health") {
        json(response, 200, options.service.health(), origin);
        return;
      }
      if (path === "/local/capabilities") {
        json(response, 200, options.service.capabilities(), origin);
        return;
      }
      const match = path.match(/^\/local\/channels\/([^/]+)\/agents$/);
      if (match) {
        const result = await options.service.listChannelAgents(decodeURIComponent(match[1]!));
        json(response, 200, result, origin);
        return;
      }
      json(response, 404, { error: "Not found" }, origin);
    })().catch(() => {
      if (!response.headersSent) json(response, 502, { error: "Local control status unavailable" }, origin);
      else response.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 4311, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const endpointHost = host === "::1" ? "[::1]" : host;
  return {
    endpoint: `http://${endpointHost}:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeIdleConnections();
    }),
  };
}
