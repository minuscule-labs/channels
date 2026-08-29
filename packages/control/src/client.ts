import type {
  LocalChannelAgentsResponse,
  LocalControlCapabilities,
  LocalControlHealth,
  LocalCurrentSession,
  LocalWorkspaceConfigurationSummary,
  UpdateLocalWorkspaceAgentConfigurationInput,
  UpdateLocalWorkspaceConfigurationInput,
} from "./contracts.ts";

export class LocalControlClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "LocalControlClientError";
  }
}

export class LocalControlClient {
  readonly timeoutMs: number;

  constructor(readonly endpoint: string, options: { timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? 3_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new RangeError("timeoutMs must be a positive integer");
    }
  }

  async health(): Promise<LocalControlHealth> {
    return this.get<LocalControlHealth>("/local/health");
  }

  async currentSession(): Promise<LocalCurrentSession> {
    return this.get<LocalCurrentSession>("/local/session");
  }

  async capabilities(): Promise<LocalControlCapabilities> {
    return this.get<LocalControlCapabilities>("/local/capabilities");
  }

  async listChannelAgents(channelId: string): Promise<LocalChannelAgentsResponse> {
    return this.get<LocalChannelAgentsResponse>(`/local/channels/${encodeURIComponent(channelId)}/agents`);
  }

  async getWorkspaceConfiguration(workspaceId: string): Promise<LocalWorkspaceConfigurationSummary> {
    return this.get<LocalWorkspaceConfigurationSummary>(
      `/local/workspaces/${encodeURIComponent(workspaceId)}/config`,
    );
  }

  async updateWorkspaceConfiguration(
    workspaceId: string,
    input: UpdateLocalWorkspaceConfigurationInput,
  ): Promise<LocalWorkspaceConfigurationSummary> {
    return this.request<LocalWorkspaceConfigurationSummary>(
      `/local/workspaces/${encodeURIComponent(workspaceId)}/config`,
      { method: "PATCH", body: JSON.stringify(input) },
    );
  }

  async updateWorkspaceAgentConfiguration(
    workspaceId: string,
    agentIdentityId: string,
    input: UpdateLocalWorkspaceAgentConfigurationInput,
  ): Promise<LocalWorkspaceConfigurationSummary> {
    return this.request<LocalWorkspaceConfigurationSummary>(
      `/local/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentIdentityId)}/config`,
      { method: "PATCH", body: JSON.stringify(input) },
    );
  }

  private async get<T>(path: string): Promise<T> {
    return this.request<T>(path);
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.endpoint}${path}`, {
        ...init,
        headers: {
          accept: "application/json",
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
        credentials: "include",
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new LocalControlClientError(body.error ?? `Local control request failed (${response.status})`, response.status);
      }
      return response.json() as Promise<T>;
    } finally {
      clearTimeout(timer);
    }
  }
}
