import type {
  EffectiveConversationLifecycle,
  ConversationLifecycleState,
} from "@minu/channels-core/types";
import type {
  LocalAgentRuntimeOptions,
  LocalBulkAgentLifecycleResponse,
  LocalConversationAgent,
  LocalConversationAgentsResponse,
  LocalConversationWorkingFolders,
  LocalConversationWorkingFolderPreview,
  LocalControlCapabilities,
  LocalControlHealth,
  LocalCurrentSession,
  LocalOpenDiagnosticResponse,
  LocalRuntimeOptions,
  LocalWorkspaceAgentConfiguration,
  LocalWorkspaceConfigurationSummary,
  ProvisionLocalWorkspaceInput,
  ProvisionLocalWorkspaceResult,
  UpdateLocalConversationWorkingFoldersInput,
  UpdateLocalRuntimeModelPolicyInput,
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
  readonly lifecycleTimeoutMs: number;

  constructor(readonly endpoint: string, options: { timeoutMs?: number; lifecycleTimeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? 3_000;
    this.lifecycleTimeoutMs = options.lifecycleTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new RangeError("timeoutMs must be a positive integer");
    }
    if (!Number.isSafeInteger(this.lifecycleTimeoutMs) || this.lifecycleTimeoutMs < 1) {
      throw new RangeError("lifecycleTimeoutMs must be a positive integer");
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

  async selectLocalFolder(): Promise<string | undefined> {
    const result = await this.request<{ path: string } | undefined>(
      "/local/folders/select",
      { method: "POST" },
      120_000,
    );
    return result?.path;
  }

  async provisionWorkspace(input: ProvisionLocalWorkspaceInput): Promise<ProvisionLocalWorkspaceResult> {
    return this.request<ProvisionLocalWorkspaceResult>("/local/workspaces", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async listConversationAgents(conversationId: string): Promise<LocalConversationAgentsResponse> {
    return this.get<LocalConversationAgentsResponse>(`/local/conversations/${encodeURIComponent(conversationId)}/agents`);
  }

  async getConversationLifecycle(conversationId: string): Promise<EffectiveConversationLifecycle> {
    return (await this.get<{ lifecycle: EffectiveConversationLifecycle }>(
      `/local/conversations/${encodeURIComponent(conversationId)}/lifecycle`,
    )).lifecycle;
  }

  async updateConversationLifecycle(
    conversationId: string,
    input: { state: ConversationLifecycleState; snoozedUntil?: string },
  ): Promise<EffectiveConversationLifecycle> {
    return (await this.request<{ lifecycle: EffectiveConversationLifecycle }>(
      `/local/conversations/${encodeURIComponent(conversationId)}/lifecycle`,
      { method: "PATCH", body: JSON.stringify(input) },
      this.lifecycleTimeoutMs,
    )).lifecycle;
  }

  async getConversationWorkingFolders(conversationId: string): Promise<LocalConversationWorkingFolders> {
    return this.get<LocalConversationWorkingFolders>(
      `/local/conversations/${encodeURIComponent(conversationId)}/working-folders`,
    );
  }

  async previewConversationWorkingFolder(
    conversationId: string,
    path: string,
  ): Promise<LocalConversationWorkingFolderPreview> {
    return this.request<LocalConversationWorkingFolderPreview>(
      `/local/conversations/${encodeURIComponent(conversationId)}/working-folders/preview`,
      { method: "POST", body: JSON.stringify({ path, primary: false }) },
    );
  }

  async updateConversationWorkingFolders(
    conversationId: string,
    input: UpdateLocalConversationWorkingFoldersInput,
  ): Promise<LocalConversationWorkingFolders> {
    return this.request<LocalConversationWorkingFolders>(
      `/local/conversations/${encodeURIComponent(conversationId)}/working-folders`,
      { method: "PUT", body: JSON.stringify(input) },
    );
  }

  async startAllConversationAgents(conversationId: string): Promise<LocalBulkAgentLifecycleResponse> {
    return this.request<LocalBulkAgentLifecycleResponse>(
      `/local/conversations/${encodeURIComponent(conversationId)}/agents/start-all`,
      { method: "POST" },
      this.lifecycleTimeoutMs,
    );
  }

  async stopAllConversationAgents(conversationId: string): Promise<LocalBulkAgentLifecycleResponse> {
    return this.request<LocalBulkAgentLifecycleResponse>(
      `/local/conversations/${encodeURIComponent(conversationId)}/agents/stop-all`,
      { method: "POST" },
      this.lifecycleTimeoutMs,
    );
  }

  async startConversationAgent(conversationId: string, identityId: string): Promise<LocalConversationAgent> {
    const response = await this.request<{ agent: LocalConversationAgent }>(
      `/local/conversations/${encodeURIComponent(conversationId)}/agents/${encodeURIComponent(identityId)}/start`,
      { method: "POST" },
      this.lifecycleTimeoutMs,
    );
    return response.agent;
  }

  async reconnectConversationAgent(conversationId: string, identityId: string): Promise<LocalConversationAgent> {
    const response = await this.request<{ agent: LocalConversationAgent }>(
      `/local/conversations/${encodeURIComponent(conversationId)}/agents/${encodeURIComponent(identityId)}/reconnect`,
      { method: "POST" },
      this.lifecycleTimeoutMs,
    );
    return response.agent;
  }

  async replaceConversationAgent(conversationId: string, identityId: string): Promise<LocalConversationAgent> {
    const response = await this.request<{ agent: LocalConversationAgent }>(
      `/local/conversations/${encodeURIComponent(conversationId)}/agents/${encodeURIComponent(identityId)}/replace`,
      { method: "POST" },
      this.lifecycleTimeoutMs,
    );
    return response.agent;
  }

  async stopConversationAgent(conversationId: string, identityId: string): Promise<LocalConversationAgent> {
    const response = await this.request<{ agent: LocalConversationAgent }>(
      `/local/conversations/${encodeURIComponent(conversationId)}/agents/${encodeURIComponent(identityId)}/stop`,
      { method: "POST" },
      this.lifecycleTimeoutMs,
    );
    return response.agent;
  }

  async cancelCurrentConversationAgent(conversationId: string, identityId: string): Promise<LocalConversationAgent> {
    const response = await this.request<{ agent: LocalConversationAgent }>(
      `/local/conversations/${encodeURIComponent(conversationId)}/agents/${encodeURIComponent(identityId)}/cancel-current`,
      { method: "POST" },
      this.lifecycleTimeoutMs,
    );
    return response.agent;
  }

  async openConversationAgentDiagnostic(
    conversationId: string,
    identityId: string,
  ): Promise<LocalOpenDiagnosticResponse> {
    return this.request<LocalOpenDiagnosticResponse>(
      `/local/conversations/${encodeURIComponent(conversationId)}/agents/${encodeURIComponent(identityId)}/open-diagnostic`,
      { method: "POST" },
      this.lifecycleTimeoutMs,
    );
  }

  async getWorkspaceConfiguration(workspaceId: string): Promise<LocalWorkspaceConfigurationSummary> {
    return this.get<LocalWorkspaceConfigurationSummary>(
      `/local/workspaces/${encodeURIComponent(workspaceId)}/config`,
    );
  }

  async getWorkspaceAgentConfiguration(
    workspaceId: string,
    agentIdentityId: string,
  ): Promise<LocalWorkspaceAgentConfiguration> {
    return this.get<LocalWorkspaceAgentConfiguration>(
      `/local/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentIdentityId)}/config`,
    );
  }

  async getWorkspaceRuntimeOptions(
    workspaceId: string,
    runtimeAdapter: string,
  ): Promise<LocalRuntimeOptions> {
    return this.get<LocalRuntimeOptions>(
      `/local/workspaces/${encodeURIComponent(workspaceId)}/runtime-options?adapter=${encodeURIComponent(runtimeAdapter)}`,
    );
  }

  async getAgentRuntimeOptions(
    workspaceId: string,
    agentIdentityId: string,
  ): Promise<LocalAgentRuntimeOptions> {
    return this.get<LocalAgentRuntimeOptions>(
      `/local/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentIdentityId)}/runtime-options`,
    );
  }

  async updateAgentRuntimeModelPolicy(
    workspaceId: string,
    agentIdentityId: string,
    input: UpdateLocalRuntimeModelPolicyInput,
  ): Promise<LocalAgentRuntimeOptions> {
    return this.request<LocalAgentRuntimeOptions>(
      `/local/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentIdentityId)}/runtime-options`,
      { method: "PUT", body: JSON.stringify(input) },
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

  private async request<T>(
    path: string,
    init: RequestInit = {},
    timeoutMs = this.timeoutMs,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
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
      if (response.status === 204) return undefined as T;
      return response.json() as Promise<T>;
    } finally {
      clearTimeout(timer);
    }
  }
}
