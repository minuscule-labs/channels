import {
  ChannelClient,
  ChannelService,
  createResourceId,
  createChannelHttpServer,
  type ChannelHttpServer,
} from "@minu/channels-core";
import {
  DrizzleLibSqlChannelStorage,
  localLibSqlUrl as localChannelLibSqlUrl,
} from "@minu/channels-storage-drizzle";
import {
  DrizzleLibSqlRelayStorage,
  localRelayLibSqlUrl,
} from "@minu/channels-relay-storage-drizzle";
import { chmod, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { LocalManagedRuntimePort } from "./agent-host.ts";
import { createLocalControlDaemon, type LocalControlDaemon } from "./daemon.ts";
import { DEFAULT_CHANNELS_PORT, DEFAULT_CONTROL_PORT, DEFAULT_WEB_PORT, localChannelsUrl } from "./local-host.ts";
import {
  acquireChannelsDataDirectoryLock,
  prepareChannelsDataDirectory,
  resolveChannelsDataDirectory,
} from "./local-paths.ts";
import type { LocalControlAuditEvent } from "./session.ts";

const LEGACY_PROFILE_VERSION = 1;
const PROFILE_VERSION = 2;
const DEFAULT_PERSONA = "You are the implementation agent for this Workspace. Follow the human's Channel requests, inspect the configured repository carefully, make only requested changes, verify your work, and report concise concrete results. Never expose private Runtime configuration or credentials in Channel responses.";

interface BrowserFirstLocalProfile {
  version: typeof PROFILE_VERSION;
  currentHumanIdentityId: string;
}

interface LegacyLocalProfile {
  version: typeof LEGACY_PROFILE_VERSION;
  currentHumanIdentityId: string;
  workspaceId: string;
  channelId: string;
  builderIdentityId: string;
}

type LocalProfile = BrowserFirstLocalProfile | LegacyLocalProfile;

interface LocalInitializationState extends LegacyLocalProfile {
  workspaceName: string;
  workspaceSlug: string;
}

export interface LocalProductAppOptions {
  dataDirectory?: string;
  workspaceRoot?: string;
  workspaceName?: string;
  selectWorkspaceRoot?: boolean;
  channelsPort?: number;
  controlPort?: number;
  webUrl?: string;
  channelsMigrationsFolder?: string;
  relayMigrationsFolder?: string;
  runtimeAdapter: string;
  runtime: LocalManagedRuntimePort;
  personaPrompt?: string;
  onAudit?(event: LocalControlAuditEvent): void;
}

export interface LocalProductApp {
  channelsEndpoint: string;
  /** Process-private credential for the local web gateway and internal services. */
  channelsServiceToken: string;
  controlEndpoint: string;
  dataDirectory: string;
  workspaceId?: string;
  channelId?: string;
  humanIdentityId: string;
  initialized: boolean;
  issueBrowserLaunchUrl(): string;
  authenticateBrowser(cookieHeader: string | undefined): { identityId: string } | undefined;
  close(): Promise<void>;
}

export function defaultLocalDataDirectory(): string {
  return resolveChannelsDataDirectory();
}

function workspaceSlug(name: string): string {
  const slug = name.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
  return slug || "local-workspace";
}

async function secureDatabaseFiles(path: string): Promise<void> {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    await chmod(candidate, 0o600).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

function parseProfile(value: string): LocalProfile {
  const candidate = JSON.parse(value) as Record<string, unknown>;
  const browserFirst = candidate.version === PROFILE_VERSION
    && typeof candidate.currentHumanIdentityId === "string";
  const legacy = candidate.version === LEGACY_PROFILE_VERSION
    && typeof candidate.currentHumanIdentityId === "string"
    && typeof candidate.workspaceId === "string"
    && typeof candidate.channelId === "string"
    && typeof candidate.builderIdentityId === "string";
  if (!browserFirst && !legacy) {
    throw new Error("Local MinuChannels profile is invalid or unsupported");
  }
  return candidate as unknown as LocalProfile;
}

async function readProfile(path: string): Promise<LocalProfile | undefined> {
  try {
    return parseProfile(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeProfile(path: string, profile: LocalProfile): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
  await chmod(path, 0o600);
}

async function validateProfile(client: ChannelClient, profile: LocalProfile): Promise<void> {
  const human = await client.getIdentity(profile.currentHumanIdentityId);
  if (human.type !== "human") {
    throw new Error("Local MinuChannels profile does not match the collaboration database");
  }
  if (profile.version === PROFILE_VERSION) return;
  const [workspace, channel, builder] = await Promise.all([
    client.getWorkspace(profile.workspaceId),
    client.getChannel(profile.channelId),
    client.getIdentity(profile.builderIdentityId),
  ]);
  if (builder.type !== "agent" || channel.workspaceId !== workspace.id) {
    throw new Error("Local MinuChannels profile does not match the collaboration database");
  }
}

async function initializeBrowserFirstProfile(
  client: ChannelClient,
  profilePath: string,
): Promise<BrowserFirstLocalProfile> {
  const statePath = `${profilePath}.initializing`;
  let profile: BrowserFirstLocalProfile | undefined;
  try {
    const candidate = parseProfile(await readFile(statePath, "utf8"));
    if (candidate.version !== PROFILE_VERSION) throw new Error("Local initialization state is invalid");
    profile = candidate;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!profile) {
    if ((await client.listWorkspaces()).length > 0 || (await client.listIdentities()).length > 0) {
      throw new Error(
        `Local data exists without ${basename(profilePath)}. Move or remove the data directory before starting fresh.`,
      );
    }
    profile = {
      version: PROFILE_VERSION,
      currentHumanIdentityId: createResourceId("identity"),
    };
    await writeProfile(statePath, profile);
  }
  if (!(await client.listIdentities()).some(({ id }) => id === profile.currentHumanIdentityId)) {
    await client.createIdentity({
      id: profile.currentHumanIdentityId,
      type: "human",
      displayName: "You",
    });
  }
  await writeProfile(profilePath, profile);
  await rm(statePath, { force: true });
  return profile;
}

async function initializeProfile(
  client: ChannelClient,
  profilePath: string,
  workspaceRoot: string,
  workspaceName: string,
  relayDatabasePath: string,
  runtimeAdapter: string,
  personaPrompt: string,
  relayMigrationsFolder?: string,
): Promise<LocalProfile> {
  const statePath = `${profilePath}.initializing`;
  let state: LocalInitializationState | undefined;
  try {
    const candidate = JSON.parse(await readFile(statePath, "utf8")) as LocalInitializationState;
    parseProfile(JSON.stringify(candidate));
    if (typeof candidate.workspaceName !== "string" || typeof candidate.workspaceSlug !== "string") {
      throw new Error("Local initialization state is invalid");
    }
    state = candidate;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!state) {
    if ((await client.listWorkspaces()).length > 0 || (await client.listIdentities()).length > 0) {
      throw new Error(
        `Local data exists without ${basename(profilePath)}. Move or remove the data directory before starting fresh.`,
      );
    }
    state = {
      version: LEGACY_PROFILE_VERSION,
      currentHumanIdentityId: createResourceId("identity"),
      builderIdentityId: createResourceId("identity"),
      workspaceId: createResourceId("workspace"),
      channelId: createResourceId("channel"),
      workspaceName,
      workspaceSlug: workspaceSlug(workspaceName),
    };
    await writeProfile(statePath, state);
  }

  const identities = new Set((await client.listIdentities()).map(({ id }) => id));
  if (!identities.has(state.currentHumanIdentityId)) {
    await client.createIdentity({ id: state.currentHumanIdentityId, type: "human", displayName: "You" });
  }
  if (!identities.has(state.builderIdentityId)) {
    await client.createIdentity({
      id: state.builderIdentityId,
      type: "agent",
      displayName: "Builder",
      publicProfile: "Implementation-focused local coding agent.",
    });
  }
  if (!(await client.listWorkspaces()).some(({ id }) => id === state.workspaceId)) {
    await client.createWorkspace({
      id: state.workspaceId,
      slug: state.workspaceSlug,
      name: state.workspaceName,
      description: "Local MinuChannels Workspace.",
    });
  }
  const members = new Set((await client.listWorkspaceMembers(state.workspaceId)).map(({ identityId }) => identityId));
  if (!members.has(state.currentHumanIdentityId)) {
    await client.addWorkspaceMember(state.workspaceId, {
      identityId: state.currentHumanIdentityId,
      mentionHandle: "you",
      accessRole: "owner",
      roleLabel: "owner",
    });
  }
  if (!members.has(state.builderIdentityId)) {
    await client.addWorkspaceMember(state.workspaceId, {
      identityId: state.builderIdentityId,
      mentionHandle: "builder",
      roleLabel: "builder",
    });
  }
  if (!(await client.listWorkspaceChannels(state.workspaceId)).some(({ id }) => id === state.channelId)) {
    await client.createChannel({
      id: state.channelId,
      workspaceId: state.workspaceId,
      name: "General",
      participantIds: [state.currentHumanIdentityId, state.builderIdentityId],
    });
  }

  const timestamp = new Date().toISOString();
  const relayStore = await DrizzleLibSqlRelayStorage.open({
    url: localRelayLibSqlUrl(relayDatabasePath),
    migrationsFolder: relayMigrationsFolder,
  });
  try {
    await relayStore.putWorkspaceConfig({
      workspaceId: state.workspaceId,
      rootUri: pathToFileURL(workspaceRoot).href,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await relayStore.putAgentConfig({
      id: `local-builder-${state.builderIdentityId}`,
      workspaceId: state.workspaceId,
      agentIdentityId: state.builderIdentityId,
      personaPrompt,
      runtimeAdapter,
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  } finally {
    await relayStore.close();
  }

  const profile: LegacyLocalProfile = {
    version: LEGACY_PROFILE_VERSION,
    currentHumanIdentityId: state.currentHumanIdentityId,
    workspaceId: state.workspaceId,
    channelId: state.channelId,
    builderIdentityId: state.builderIdentityId,
  };
  await writeProfile(profilePath, profile);
  await rm(statePath, { force: true });
  return profile;
}

export async function createLocalProductApp(
  options: LocalProductAppOptions,
): Promise<LocalProductApp> {
  const dataDirectory = resolveChannelsDataDirectory({ explicit: options.dataDirectory });
  let workspaceRoot: string | undefined;
  if (options.workspaceRoot !== undefined) {
    const requestedWorkspaceRoot = resolve(options.workspaceRoot);
    try {
      workspaceRoot = await realpath(requestedWorkspaceRoot);
      if (!(await stat(workspaceRoot)).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new Error(`Workspace source folder is unavailable or is not a directory: ${requestedWorkspaceRoot}`);
    }
  }
  const workspaceName = options.workspaceName?.trim()
    || (workspaceRoot ? basename(workspaceRoot) || "Local Workspace" : undefined);
  if (workspaceName && workspaceName.length > 200) throw new Error("Workspace name must be at most 200 characters");
  const channelsDatabasePath = join(dataDirectory, "channels.db");
  const relayDatabasePath = join(dataDirectory, "relay.db");
  const profilePath = join(dataDirectory, "local-profile.json");
  await prepareChannelsDataDirectory(dataDirectory);
  const dataDirectoryLock = await acquireChannelsDataDirectoryLock(dataDirectory);

  let storage: DrizzleLibSqlChannelStorage;
  try {
    storage = await DrizzleLibSqlChannelStorage.open({
      url: localChannelLibSqlUrl(channelsDatabasePath),
      migrationsFolder: options.channelsMigrationsFolder,
    });
  } catch (error) {
    await dataDirectoryLock.release();
    throw error;
  }
  let channelsServer: ChannelHttpServer | undefined;
  let controlDaemon: LocalControlDaemon | undefined;
  try {
    await secureDatabaseFiles(channelsDatabasePath);
    channelsServer = await createChannelHttpServer({
      port: options.channelsPort ?? DEFAULT_CHANNELS_PORT,
      service: new ChannelService(storage),
    });
    const client = new ChannelClient(channelsServer.endpoint, { serviceToken: channelsServer.serviceToken });
    let profile = await readProfile(profilePath);
    const initialized = profile === undefined;
    if (profile) {
      await validateProfile(client, profile);
    } else if (workspaceRoot) {
      profile = await initializeProfile(
        client,
        profilePath,
        workspaceRoot,
        workspaceName ?? "Local Workspace",
        relayDatabasePath,
        options.runtimeAdapter,
        options.personaPrompt ?? DEFAULT_PERSONA,
        options.relayMigrationsFolder,
      );
    } else {
      profile = await initializeBrowserFirstProfile(client, profilePath);
    }
    await secureDatabaseFiles(relayDatabasePath);
    let selectedWorkspaceId = profile.version === LEGACY_PROFILE_VERSION ? profile.workspaceId : undefined;
    let selectedChannelId = profile.version === LEGACY_PROFILE_VERSION ? profile.channelId : undefined;
    if (!initialized && options.selectWorkspaceRoot && workspaceRoot) {
      const relayStore = await DrizzleLibSqlRelayStorage.open({
        url: localRelayLibSqlUrl(relayDatabasePath),
        migrationsFolder: options.relayMigrationsFolder,
      });
      try {
        const matches: string[] = [];
        for (const workspace of await client.listWorkspaces()) {
          const config = await relayStore.getWorkspaceConfig(workspace.id);
          if (!config?.rootUri) continue;
          try {
            if (await realpath(fileURLToPath(config.rootUri)) === workspaceRoot) matches.push(workspace.id);
          } catch {
            // Unavailable stored roots cannot match the requested canonical directory.
          }
        }
        if (matches.length === 0) {
          throw new Error(`No existing Workspace uses source folder: ${workspaceRoot}. Add it from the MinuChannels navigation instead.`);
        }
        if (matches.length > 1) {
          throw new Error(`More than one Workspace uses source folder: ${workspaceRoot}. Start without a directory and choose one in the app.`);
        }
        selectedWorkspaceId = matches[0]!;
        const channels = await client.listWorkspaceChannels(selectedWorkspaceId);
        if (!channels[0]) throw new Error("The selected Workspace has no Channels");
        selectedChannelId = channels[0].id;
      } finally {
        await relayStore.close();
      }
    }

    controlDaemon = await createLocalControlDaemon({
      currentHumanIdentityId: profile.currentHumanIdentityId,
      channelsEndpoint: channelsServer.endpoint,
      channelsServiceToken: channelsServer.serviceToken,
      relayDatabasePath,
      relayMigrationsFolder: options.relayMigrationsFolder,
      webUrl: options.webUrl ?? localChannelsUrl(DEFAULT_WEB_PORT),
      port: options.controlPort ?? DEFAULT_CONTROL_PORT,
      runtimes: { [options.runtimeAdapter]: options.runtime },
      onAudit: options.onAudit,
    });

    let closed = false;
    return {
      channelsEndpoint: channelsServer.endpoint,
      channelsServiceToken: channelsServer.serviceToken,
      controlEndpoint: controlDaemon.endpoint,
      dataDirectory,
      workspaceId: selectedWorkspaceId,
      channelId: selectedChannelId,
      humanIdentityId: profile.currentHumanIdentityId,
      initialized,
      issueBrowserLaunchUrl: () => controlDaemon!.issueBrowserLaunchUrl(
        selectedWorkspaceId && selectedChannelId
          ? `/app/workspaces/${selectedWorkspaceId}/channels/${selectedChannelId}`
          : "/",
      ),
      authenticateBrowser: (cookieHeader) => controlDaemon!.authenticateBrowser(cookieHeader),
      async close() {
        if (closed) return;
        closed = true;
        await Promise.allSettled([controlDaemon!.close(), channelsServer!.close()]);
        try {
          await storage.close();
        } finally {
          await dataDirectoryLock.release();
        }
      },
    };
  } catch (error) {
    await Promise.allSettled([controlDaemon?.close(), channelsServer?.close()]);
    try {
      await storage.close();
    } finally {
      await dataDirectoryLock.release();
    }
    throw error;
  }
}
