import {
  ChannelClient,
  ChannelService,
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
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { LocalManagedRuntimePort } from "./agent-host.ts";
import { createLocalControlDaemon, type LocalControlDaemon } from "./daemon.ts";
import type { LocalControlAuditEvent } from "./session.ts";

const PROFILE_VERSION = 1;
const DEFAULT_PERSONA = "You are the implementation agent for this Workspace. Follow the human's Channel requests, inspect the configured repository carefully, make only requested changes, verify your work, and report concise concrete results. Never expose private Runtime configuration or credentials in Channel responses.";

interface LocalProfile {
  version: typeof PROFILE_VERSION;
  currentHumanIdentityId: string;
  workspaceId: string;
  channelId: string;
  builderIdentityId: string;
}

export interface LocalProductAppOptions {
  dataDirectory?: string;
  workspaceRoot?: string;
  channelsPort?: number;
  controlPort?: number;
  webUrl?: string;
  runtimeAdapter: string;
  runtime: LocalManagedRuntimePort;
  personaPrompt?: string;
  onAudit?(event: LocalControlAuditEvent): void;
}

export interface LocalProductApp {
  channelsEndpoint: string;
  controlEndpoint: string;
  dataDirectory: string;
  workspaceId: string;
  channelId: string;
  humanIdentityId: string;
  initialized: boolean;
  issueBrowserLaunchUrl(): string;
  close(): Promise<void>;
}

export function defaultLocalDataDirectory(): string {
  return join(homedir(), ".minu", "channels");
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
  const candidate = JSON.parse(value) as Partial<LocalProfile>;
  if (candidate.version !== PROFILE_VERSION
    || typeof candidate.currentHumanIdentityId !== "string"
    || typeof candidate.workspaceId !== "string"
    || typeof candidate.channelId !== "string"
    || typeof candidate.builderIdentityId !== "string") {
    throw new Error("Local MinuChannels profile is invalid or unsupported");
  }
  return candidate as LocalProfile;
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
  const [human, workspace, channel, builder] = await Promise.all([
    client.getIdentity(profile.currentHumanIdentityId),
    client.getWorkspace(profile.workspaceId),
    client.getChannel(profile.channelId),
    client.getIdentity(profile.builderIdentityId),
  ]);
  if (human.type !== "human" || builder.type !== "agent" || channel.workspaceId !== workspace.id) {
    throw new Error("Local MinuChannels profile does not match the collaboration database");
  }
}

async function initializeProfile(
  client: ChannelClient,
  profilePath: string,
  workspaceRoot: string,
  relayDatabasePath: string,
  runtimeAdapter: string,
  personaPrompt: string,
): Promise<LocalProfile> {
  if ((await client.listWorkspaces()).length > 0 || (await client.listIdentities()).length > 0) {
    throw new Error(
      `Local data exists without ${basename(profilePath)}. Move or remove the data directory before starting fresh.`,
    );
  }
  const workspaceName = basename(workspaceRoot) || "Local Workspace";
  const human = await client.createIdentity({ type: "human", displayName: "You" });
  const builder = await client.createIdentity({
    type: "agent",
    displayName: "Builder",
    publicProfile: "Implementation-focused local coding agent.",
  });
  const workspace = await client.createWorkspace({
    slug: workspaceSlug(workspaceName),
    name: workspaceName,
    description: "Local MinuChannels Workspace.",
  });
  await client.addWorkspaceMember(workspace.id, {
    identityId: human.id,
    mentionHandle: "you",
    accessRole: "owner",
    roleLabel: "owner",
  });
  await client.addWorkspaceMember(workspace.id, {
    identityId: builder.id,
    mentionHandle: "builder",
    roleLabel: "builder",
  });
  const channel = await client.createChannel({
    workspaceId: workspace.id,
    name: "General",
    participantIds: [human.id, builder.id],
  });

  const timestamp = new Date().toISOString();
  const relayStore = await DrizzleLibSqlRelayStorage.open({ url: localRelayLibSqlUrl(relayDatabasePath) });
  try {
    await relayStore.putWorkspaceConfig({
      workspaceId: workspace.id,
      rootUri: pathToFileURL(workspaceRoot).href,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await relayStore.putAgentConfig({
      id: `local-builder-${builder.id}`,
      workspaceId: workspace.id,
      agentIdentityId: builder.id,
      personaPrompt,
      runtimeAdapter,
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  } finally {
    await relayStore.close();
  }

  const profile: LocalProfile = {
    version: PROFILE_VERSION,
    currentHumanIdentityId: human.id,
    workspaceId: workspace.id,
    channelId: channel.id,
    builderIdentityId: builder.id,
  };
  await writeProfile(profilePath, profile);
  return profile;
}

export async function createLocalProductApp(
  options: LocalProductAppOptions,
): Promise<LocalProductApp> {
  const dataDirectory = resolve(options.dataDirectory ?? defaultLocalDataDirectory());
  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
  const channelsDatabasePath = join(dataDirectory, "channels.db");
  const relayDatabasePath = join(dataDirectory, "relay.db");
  const profilePath = join(dataDirectory, "local-profile.json");
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  await chmod(dataDirectory, 0o700);

  const storage = await DrizzleLibSqlChannelStorage.open({
    url: localChannelLibSqlUrl(channelsDatabasePath),
  });
  let channelsServer: ChannelHttpServer | undefined;
  let controlDaemon: LocalControlDaemon | undefined;
  try {
    await secureDatabaseFiles(channelsDatabasePath);
    channelsServer = await createChannelHttpServer({
      port: options.channelsPort ?? 4310,
      service: new ChannelService(storage),
    });
    const client = new ChannelClient(channelsServer.endpoint);
    let profile = await readProfile(profilePath);
    const initialized = profile === undefined;
    if (profile) {
      await validateProfile(client, profile);
    } else {
      profile = await initializeProfile(
        client,
        profilePath,
        workspaceRoot,
        relayDatabasePath,
        options.runtimeAdapter,
        options.personaPrompt ?? DEFAULT_PERSONA,
      );
    }
    await secureDatabaseFiles(relayDatabasePath);

    controlDaemon = await createLocalControlDaemon({
      currentHumanIdentityId: profile.currentHumanIdentityId,
      channelsEndpoint: channelsServer.endpoint,
      relayDatabasePath,
      webUrl: options.webUrl ?? "http://127.0.0.1:5174/",
      port: options.controlPort ?? 4311,
      runtimes: { [options.runtimeAdapter]: options.runtime },
      onAudit: options.onAudit,
    });

    let closed = false;
    return {
      channelsEndpoint: channelsServer.endpoint,
      controlEndpoint: controlDaemon.endpoint,
      dataDirectory,
      workspaceId: profile.workspaceId,
      channelId: profile.channelId,
      humanIdentityId: profile.currentHumanIdentityId,
      initialized,
      issueBrowserLaunchUrl: () => controlDaemon!.issueBrowserLaunchUrl(
        `/app/workspaces/${profile!.workspaceId}/channels/${profile!.channelId}`,
      ),
      async close() {
        if (closed) return;
        closed = true;
        await Promise.allSettled([controlDaemon!.close(), channelsServer!.close()]);
        await storage.close();
      },
    };
  } catch (error) {
    await Promise.allSettled([controlDaemon?.close(), channelsServer?.close()]);
    await storage.close();
    throw error;
  }
}
