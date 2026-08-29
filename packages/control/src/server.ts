import type { ChannelMetadata } from "@minu/channels-core/types";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { LocalConfigurationRequestError } from "./configuration.ts";
import { LocalControlBrowserSessions, type LocalControlBrowserSession } from "./session.ts";
export {
  LocalControlBrowserSessions,
  type LocalControlAuditAction,
  type LocalControlAuditEvent,
  type LocalControlBrowserSession,
  type LocalControlBrowserSessionsOptions,
  type LocalControlLaunchExchange,
} from "./session.ts";
import {
  LOCAL_CONTROL_PROTOCOL_VERSION,
  type LocalChannelAgent,
  type LocalChannelAgentsResponse,
  type LocalControlCapabilities,
  type LocalControlHealth,
  type LocalWakePolicy,
  type LocalWorkspaceConfigurationSummary,
} from "./contracts.ts";

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

export interface LocalControlAgentLifecyclePort {
  readonly available: boolean;
  startChannelAgent(
    channelId: string,
    agentIdentityId: string,
    actorIdentityId: string,
  ): Promise<void>;
  replaceChannelAgent(
    channelId: string,
    agentIdentityId: string,
    actorIdentityId: string,
  ): Promise<void>;
  stopChannelAgent(
    channelId: string,
    agentIdentityId: string,
    actorIdentityId: string,
  ): Promise<void>;
}

export interface LocalControlConfigurationPort {
  getWorkspaceConfiguration(
    workspaceId: string,
    actorIdentityId: string,
  ): Promise<LocalWorkspaceConfigurationSummary>;
  updateWorkspaceConfiguration(
    workspaceId: string,
    actorIdentityId: string,
    input: unknown,
  ): Promise<LocalWorkspaceConfigurationSummary>;
  updateWorkspaceAgentConfiguration(
    workspaceId: string,
    agentIdentityId: string,
    actorIdentityId: string,
    input: unknown,
  ): Promise<LocalWorkspaceConfigurationSummary>;
}

export interface LocalControlServiceOptions {
  channels: LocalControlChannelDirectory;
  bindings: LocalControlBindingDirectory;
  runtimes: Readonly<Record<string, LocalControlRuntimePort>>;
  configuration?: LocalControlConfigurationPort;
  lifecycle?: LocalControlAgentLifecyclePort;
  statusTimeoutMs?: number;
}

const disabledCapabilities = {
  start: false,
  replace: false,
  stop: false,
  steer: false,
  interrupt: false,
  reconnect: false,
} as const;

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
        currentSession: true,
        channelAgentStatus: true,
        workspaceConfigRead: Boolean(this.options.configuration),
        workspaceConfigWrite: Boolean(this.options.configuration),
        agentCreate: false,
        agentStart: Boolean(this.options.lifecycle?.available),
        agentReplace: Boolean(this.options.lifecycle?.available),
        agentStop: Boolean(this.options.lifecycle?.available),
        steer: false,
        interrupt: false,
        reconnect: false,
      },
    };
  }

  async getWorkspaceConfiguration(
    workspaceId: string,
    actorIdentityId: string,
  ): Promise<LocalWorkspaceConfigurationSummary> {
    if (!this.options.configuration) {
      throw new LocalConfigurationRequestError("Workspace configuration unavailable", 404, "unavailable");
    }
    return this.options.configuration.getWorkspaceConfiguration(workspaceId, actorIdentityId);
  }

  async updateWorkspaceConfiguration(
    workspaceId: string,
    actorIdentityId: string,
    input: unknown,
  ): Promise<LocalWorkspaceConfigurationSummary> {
    if (!this.options.configuration) {
      throw new LocalConfigurationRequestError("Workspace configuration unavailable", 404, "unavailable");
    }
    return this.options.configuration.updateWorkspaceConfiguration(workspaceId, actorIdentityId, input);
  }

  async updateWorkspaceAgentConfiguration(
    workspaceId: string,
    agentIdentityId: string,
    actorIdentityId: string,
    input: unknown,
  ): Promise<LocalWorkspaceConfigurationSummary> {
    if (!this.options.configuration) {
      throw new LocalConfigurationRequestError("Workspace configuration unavailable", 404, "unavailable");
    }
    return this.options.configuration.updateWorkspaceAgentConfiguration(
      workspaceId,
      agentIdentityId,
      actorIdentityId,
      input,
    );
  }

  async startChannelAgent(
    channelId: string,
    identityId: string,
    actorIdentityId: string,
  ): Promise<LocalChannelAgent> {
    if (!this.options.lifecycle?.available) {
      throw new LocalConfigurationRequestError("Agent lifecycle unavailable", 404, "unavailable");
    }
    await this.options.lifecycle.startChannelAgent(channelId, identityId, actorIdentityId);
    return this.channelAgent(channelId, identityId);
  }

  async replaceChannelAgent(
    channelId: string,
    identityId: string,
    actorIdentityId: string,
  ): Promise<LocalChannelAgent> {
    if (!this.options.lifecycle?.available) {
      throw new LocalConfigurationRequestError("Agent lifecycle unavailable", 404, "unavailable");
    }
    await this.options.lifecycle.replaceChannelAgent(channelId, identityId, actorIdentityId);
    return this.channelAgent(channelId, identityId);
  }

  async stopChannelAgent(
    channelId: string,
    identityId: string,
    actorIdentityId: string,
  ): Promise<LocalChannelAgent> {
    if (!this.options.lifecycle?.available) {
      throw new LocalConfigurationRequestError("Agent lifecycle unavailable", 404, "unavailable");
    }
    await this.options.lifecycle.stopChannelAgent(channelId, identityId, actorIdentityId);
    return this.channelAgent(channelId, identityId);
  }

  private async channelAgent(channelId: string, identityId: string): Promise<LocalChannelAgent> {
    const response = await this.listChannelAgents(channelId);
    const agent = response.agents.find((candidate) => candidate.identityId === identityId);
    if (!agent) throw new LocalConfigurationRequestError("Channel agent unavailable", 404, "unavailable");
    return agent;
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
      return {
        ...base,
        state: "unbound",
        capabilities: {
          ...disabledCapabilities,
          start: Boolean(this.options.lifecycle?.available),
        },
      };
    }
    if (matches.length > 1) {
      return { ...base, state: "uncertain", capabilities: disabledCapabilities };
    }
    const binding = matches[0]!;
    const details = { wakePolicy: binding.wakePolicy, lastVerifiedAt: binding.lastVerifiedAt };
    if (binding.state === "disabled") {
      return {
        ...base,
        ...details,
        state: "disabled",
        capabilities: {
          ...disabledCapabilities,
          replace: Boolean(this.options.lifecycle?.available),
        },
      };
    }
    if (binding.state === "replacing") {
      return { ...base, ...details, state: "uncertain", capabilities: disabledCapabilities };
    }
    const runtime = this.options.runtimes[binding.runtimeAdapter];
    if (!runtime) {
      return {
        ...base,
        ...details,
        state: "offline",
        capabilities: {
          ...disabledCapabilities,
          replace: Boolean(this.options.lifecycle?.available),
          stop: Boolean(this.options.lifecycle?.available),
        },
      };
    }
    try {
      const status = await this.readRuntimeStatus(runtime, binding.runtimeSessionId);
      if (status === "working") {
        return {
          ...base,
          ...details,
          state: "running",
          capabilities: {
            ...disabledCapabilities,
            stop: Boolean(this.options.lifecycle?.available),
          },
        };
      }
      return {
        ...base,
        ...details,
        state: status === "idle" ? "idle" : "offline",
        capabilities: {
          ...disabledCapabilities,
          replace: Boolean(this.options.lifecycle?.available),
          stop: Boolean(this.options.lifecycle?.available),
        },
      };
    } catch {
      return {
        ...base,
        ...details,
        state: "offline",
        capabilities: {
          ...disabledCapabilities,
          replace: Boolean(this.options.lifecycle?.available),
          stop: Boolean(this.options.lifecycle?.available),
        },
      };
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

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    throw new LocalConfigurationRequestError("Content-Type must be application/json", 400, "invalid");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 128 * 1024) {
      throw new LocalConfigurationRequestError("Configuration request is too large", 413, "invalid");
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new LocalConfigurationRequestError("Invalid JSON", 400, "invalid");
  }
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
    const requestPath = new URL(request.url ?? "/", `http://${request.headers.host}`).pathname;
    const isAgentLifecycle = request.method === "POST"
      && /^\/local\/channels\/[^/]+\/agents\/[^/]+\/(start|replace|stop)$/.test(requestPath);
    if (request.method !== "GET" && request.method !== "PATCH" && !isAgentLifecycle) {
      response.setHeader("allow", "GET, PATCH");
      json(response, 405, { error: "Method not allowed" }, origin);
      return;
    }

    void (async () => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
      const path = url.pathname;
      if (path === "/local/session/bootstrap" && options.browserSessions) {
        if (request.method !== "GET") {
          response.setHeader("allow", "GET");
          json(response, 405, { error: "Method not allowed" }, origin);
          return;
        }
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
      const browserSession: LocalControlBrowserSession | undefined =
        options.browserSessions?.authenticate(request.headers.cookie);
      if (options.browserSessions && !browserSession) {
        json(response, 401, { error: "Local browser session required" }, origin);
        return;
      }
      if (path === "/local/session" && request.method === "GET") {
        if (!browserSession) {
          json(response, 404, { error: "Browser session binding unavailable" }, origin);
          return;
        }
        json(response, 200, {
          protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION,
          identityId: browserSession.identityId,
        }, origin);
        return;
      }
      if (path === "/local/health" && request.method === "GET") {
        json(response, 200, options.service.health(), origin);
        return;
      }
      if (path === "/local/capabilities" && request.method === "GET") {
        json(response, 200, options.service.capabilities(), origin);
        return;
      }
      const workspaceConfigMatch = path.match(/^\/local\/workspaces\/([^/]+)\/config$/);
      if (workspaceConfigMatch && browserSession) {
        const workspaceId = decodeURIComponent(workspaceConfigMatch[1]!);
        const result = request.method === "GET"
          ? await options.service.getWorkspaceConfiguration(workspaceId, browserSession.identityId)
          : await options.service.updateWorkspaceConfiguration(
            workspaceId,
            browserSession.identityId,
            await readJson(request),
          );
        json(response, 200, result, origin);
        return;
      }
      const agentConfigMatch = path.match(/^\/local\/workspaces\/([^/]+)\/agents\/([^/]+)\/config$/);
      if (agentConfigMatch && browserSession && request.method === "PATCH") {
        const result = await options.service.updateWorkspaceAgentConfiguration(
          decodeURIComponent(agentConfigMatch[1]!),
          decodeURIComponent(agentConfigMatch[2]!),
          browserSession.identityId,
          await readJson(request),
        );
        json(response, 200, result, origin);
        return;
      }
      const agentStartMatch = path.match(/^\/local\/channels\/([^/]+)\/agents\/([^/]+)\/start$/);
      if (agentStartMatch && browserSession && request.method === "POST") {
        const agent = await options.service.startChannelAgent(
          decodeURIComponent(agentStartMatch[1]!),
          decodeURIComponent(agentStartMatch[2]!),
          browserSession.identityId,
        );
        json(response, 201, { agent }, origin);
        return;
      }
      const agentReplaceMatch = path.match(/^\/local\/channels\/([^/]+)\/agents\/([^/]+)\/replace$/);
      if (agentReplaceMatch && browserSession && request.method === "POST") {
        const agent = await options.service.replaceChannelAgent(
          decodeURIComponent(agentReplaceMatch[1]!),
          decodeURIComponent(agentReplaceMatch[2]!),
          browserSession.identityId,
        );
        json(response, 200, { agent }, origin);
        return;
      }
      const agentStopMatch = path.match(/^\/local\/channels\/([^/]+)\/agents\/([^/]+)\/stop$/);
      if (agentStopMatch && browserSession && request.method === "POST") {
        const agent = await options.service.stopChannelAgent(
          decodeURIComponent(agentStopMatch[1]!),
          decodeURIComponent(agentStopMatch[2]!),
          browserSession.identityId,
        );
        json(response, 200, { agent }, origin);
        return;
      }
      const match = path.match(/^\/local\/channels\/([^/]+)\/agents$/);
      if (match && request.method === "GET") {
        const result = await options.service.listChannelAgents(decodeURIComponent(match[1]!));
        json(response, 200, result, origin);
        return;
      }
      json(response, 404, { error: "Not found" }, origin);
    })().catch((error: unknown) => {
      if (!response.headersSent && error instanceof LocalConfigurationRequestError) {
        json(response, error.status, { error: error.message }, origin);
      } else if (!response.headersSent) {
        json(response, 502, { error: "Local control status unavailable" }, origin);
      } else {
        response.destroy();
      }
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
