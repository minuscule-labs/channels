import { ChannelClient } from "@minu/channels-core/client";
import {
  LocalRelayDirectory,
  type RelayBindingStore,
} from "@minu/channels-relay";
import type {
  LocalWorkspaceAgentConfigurationSummary,
  LocalWorkspaceConfigurationSummary,
} from "./contracts.ts";
import { LOCAL_CONTROL_PROTOCOL_VERSION } from "./contracts.ts";
import type { LocalControlAuditEvent } from "./session.ts";

const MAX_ROOT_URI_BYTES = 8 * 1024;
const MAX_NOTES_FOLDER_ID_BYTES = 255;
const MAX_PERSONA_PROMPT_BYTES = 64 * 1024;
const MAX_RUNTIME_ADAPTER_BYTES = 100;

export class LocalConfigurationRequestError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 413,
    readonly reason: "invalid" | "forbidden" | "unavailable",
  ) {
    super(message);
    this.name = "LocalConfigurationRequestError";
  }
}

export interface LocalAgentHostConfigurationOptions {
  client: ChannelClient;
  store: RelayBindingStore;
  now?: () => Date;
  onAudit?(event: LocalControlAuditEvent): void;
}

function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LocalConfigurationRequestError(`${label} must be a JSON object`, 400, "invalid");
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(input: Record<string, unknown>, allowed: readonly string[]): void {
  const hasUnknown = Object.keys(input).some((key) => !allowed.includes(key));
  if (hasUnknown) {
    throw new LocalConfigurationRequestError("Configuration contains unsupported fields", 400, "invalid");
  }
}

function requiredString(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new LocalConfigurationRequestError(`${label} is required`, 400, "invalid");
  }
  if (bytes(value) > maxBytes) {
    throw new LocalConfigurationRequestError(`${label} is too large`, 400, "invalid");
  }
  return value;
}

function optionalNullableString(
  value: unknown,
  label: string,
  maxBytes: number,
): string | null | undefined {
  if (value === undefined || value === null) return value;
  return requiredString(value, label, maxBytes);
}

export class LocalAgentHostConfiguration {
  private readonly directory: LocalRelayDirectory;
  private readonly now: () => Date;

  constructor(private readonly options: LocalAgentHostConfigurationOptions) {
    this.now = options.now ?? (() => new Date());
    this.directory = new LocalRelayDirectory(options.client, options.store, this.now);
  }

  async getWorkspaceConfiguration(
    workspaceId: string,
    actorIdentityId: string,
  ): Promise<LocalWorkspaceConfigurationSummary> {
    const members = await this.authorize(workspaceId, actorIdentityId);
    const [workspaceConfig, configs, bindings, identities] = await Promise.all([
      this.options.store.getWorkspaceConfig(workspaceId),
      this.options.store.listWorkspaceAgentConfigs(workspaceId),
      this.options.store.listWorkspaceBindings(workspaceId),
      this.options.client.listIdentities(),
    ]);
    const identityTypes = new Map(identities.map((identity) => [identity.id, identity.type]));
    const configsByIdentity = new Map(configs.map((config) => [config.agentIdentityId, config]));
    const agents: LocalWorkspaceAgentConfigurationSummary[] = members
      .filter((member) => {
        const type = identityTypes.get(member.identityId);
        return type === "agent" || type === "service";
      })
      .map((member) => {
        const config = configsByIdentity.get(member.identityId);
        const boundChannels = new Set(bindings
          .filter((binding) => binding.agentIdentityId === member.identityId && binding.state !== "disabled")
          .map((binding) => binding.channelId));
        return {
          identityId: member.identityId,
          configured: Boolean(config),
          personaConfigured: Boolean(config?.personaPrompt || config?.personaRef),
          runtimeConfigured: Boolean(config?.runtimeAdapter),
          status: config?.status ?? "unconfigured",
          boundChannelCount: boundChannels.size,
          changesApplyToNewSessions: true,
        };
      });
    return {
      protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION,
      workspaceId,
      rootConfigured: Boolean(workspaceConfig?.rootUri),
      notesFolderConfigured: Boolean(workspaceConfig?.notesFolderId),
      agents,
    };
  }

  async updateWorkspaceConfiguration(
    workspaceId: string,
    actorIdentityId: string,
    value: unknown,
  ): Promise<LocalWorkspaceConfigurationSummary> {
    try {
      await this.authorize(workspaceId, actorIdentityId);
      const input = object(value, "Workspace configuration");
      rejectUnknown(input, ["rootUri", "notesFolderId"]);
      const rootUri = requiredString(input.rootUri, "rootUri", MAX_ROOT_URI_BYTES);
      const notesFolderId = optionalNullableString(
        input.notesFolderId,
        "notesFolderId",
        MAX_NOTES_FOLDER_ID_BYTES,
      );
      await this.directory.configureWorkspace({
        workspaceId,
        rootUri,
        notesFolderId,
      });
      this.audit({
        action: "workspace.config.updated",
        outcome: "accepted",
        actorIdentityId,
        workspaceId,
      });
      return this.getWorkspaceConfiguration(workspaceId, actorIdentityId);
    } catch (error) {
      this.auditFailure("workspace.config.updated", actorIdentityId, workspaceId, undefined, error);
      throw error;
    }
  }

  async updateWorkspaceAgentConfiguration(
    workspaceId: string,
    agentIdentityId: string,
    actorIdentityId: string,
    value: unknown,
  ): Promise<LocalWorkspaceConfigurationSummary> {
    try {
      await this.authorize(workspaceId, actorIdentityId);
      const input = object(value, "Agent configuration");
      rejectUnknown(input, ["personaPrompt", "runtimeAdapter", "status"]);
      if (Object.keys(input).length === 0) {
        throw new LocalConfigurationRequestError("Agent configuration update is empty", 400, "invalid");
      }
      const personaPrompt = optionalNullableString(
        input.personaPrompt,
        "personaPrompt",
        MAX_PERSONA_PROMPT_BYTES,
      );
      const runtimeAdapter = optionalNullableString(
        input.runtimeAdapter,
        "runtimeAdapter",
        MAX_RUNTIME_ADAPTER_BYTES,
      );
      if (runtimeAdapter && !/^[a-zA-Z0-9._-]+$/.test(runtimeAdapter)) {
        throw new LocalConfigurationRequestError("runtimeAdapter has invalid characters", 400, "invalid");
      }
      const status = input.status;
      if (status !== undefined && status !== "active" && status !== "disabled") {
        throw new LocalConfigurationRequestError("status must be active or disabled", 400, "invalid");
      }
      await this.directory.configureAgent({
        workspaceId,
        agentIdentityId,
        personaPrompt,
        runtimeAdapter,
        status,
      });
      this.audit({
        action: "agent.config.updated",
        outcome: "accepted",
        actorIdentityId,
        workspaceId,
        targetIdentityId: agentIdentityId,
      });
      return this.getWorkspaceConfiguration(workspaceId, actorIdentityId);
    } catch (error) {
      this.auditFailure("agent.config.updated", actorIdentityId, workspaceId, agentIdentityId, error);
      throw error;
    }
  }

  private async authorize(workspaceId: string, actorIdentityId: string) {
    let members;
    let actor;
    try {
      const result = await Promise.all([
        this.options.client.getWorkspace(workspaceId),
        this.options.client.listWorkspaceMembers(workspaceId),
        this.options.client.getIdentity(actorIdentityId),
      ]);
      if (result[0].status !== "active") {
        throw new LocalConfigurationRequestError("Workspace is unavailable", 409, "unavailable");
      }
      members = result[1];
      actor = result[2];
    } catch (error) {
      if (error instanceof LocalConfigurationRequestError) throw error;
      throw new LocalConfigurationRequestError("Workspace is unavailable", 404, "unavailable");
    }
    const membership = members.find((member) => member.identityId === actorIdentityId);
    if (actor.type !== "human" || actor.status !== "active" || membership?.status !== "active"
      || (membership.accessRole !== "owner" && membership.accessRole !== "admin")) {
      throw new LocalConfigurationRequestError("Workspace owner or admin required", 403, "forbidden");
    }
    return members;
  }

  private auditFailure(
    action: "workspace.config.updated" | "agent.config.updated",
    actorIdentityId: string,
    workspaceId: string,
    targetIdentityId: string | undefined,
    error: unknown,
  ): void {
    this.audit({
      action,
      outcome: "rejected",
      reason: error instanceof LocalConfigurationRequestError ? error.reason : "unavailable",
      actorIdentityId,
      workspaceId,
      targetIdentityId,
    });
  }

  private audit(event: Omit<LocalControlAuditEvent, "timestamp">): void {
    try {
      this.options.onAudit?.({ ...event, timestamp: this.now().toISOString() });
    } catch {
      // Audit sinks must not make private configuration unavailable.
    }
  }
}
