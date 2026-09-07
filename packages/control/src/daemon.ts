import { ChannelClient } from "@minu/channels-core/client";
import {
  DrizzleLibSqlRelayStorage,
  localRelayLibSqlUrl,
} from "@minu/channels-relay-storage-drizzle";
import { chmod, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { LocalAgentHost, type LocalManagedRuntimePort } from "./agent-host.ts";
import { LocalAgentHostConfiguration } from "./configuration.ts";
import { DEFAULT_CHANNELS_PORT, DEFAULT_WEB_PORT, localChannelsUrl } from "./local-host.ts";
import { resolveChannelsDataDirectory } from "./local-paths.ts";
import {
  createLocalControlHttpServer,
  LocalControlService,
  type LocalControlHttpServer,
} from "./server.ts";
import {
  LocalControlBrowserSessions,
  type LocalControlAuditEvent,
} from "./session.ts";

export interface LocalControlDaemonOptions {
  currentHumanIdentityId: string;
  channelsEndpoint?: string;
  channelsServiceToken?: string;
  relayDatabasePath?: string;
  relayMigrationsFolder?: string;
  webUrl?: string;
  host?: "127.0.0.1" | "::1";
  port?: number;
  runtimes?: Readonly<Record<string, LocalManagedRuntimePort>>;
  statusTimeoutMs?: number;
  stopStartedSessionsOnClose?: boolean;
  launchCodeTtlMs?: number;
  sessionTtlMs?: number;
  now?: () => Date;
  onAudit?(event: LocalControlAuditEvent): void;
}

export interface LocalControlDaemon {
  endpoint: string;
  issueBrowserLaunchUrl(destinationPath?: string): string;
  authenticateBrowser(cookieHeader: string | undefined): { identityId: string } | undefined;
  close(): Promise<void>;
}

export function defaultRelayDatabasePath(): string {
  return join(resolveChannelsDataDirectory(), "relay.db");
}

export async function createLocalControlDaemon(
  options: LocalControlDaemonOptions,
): Promise<LocalControlDaemon> {
  const usesDefaultDatabase = options.relayDatabasePath === undefined;
  const databasePath = resolve(options.relayDatabasePath ?? defaultRelayDatabasePath());
  await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 });
  if (usesDefaultDatabase) await chmod(dirname(databasePath), 0o700);
  const store = await DrizzleLibSqlRelayStorage.open({
    url: localRelayLibSqlUrl(databasePath),
    migrationsFolder: options.relayMigrationsFolder,
  });
  let server: LocalControlHttpServer | undefined;
  let agentHost: LocalAgentHost | undefined;
  try {
    for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      await chmod(path, 0o600).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    const browserSessions = new LocalControlBrowserSessions({
      browserUrl: options.webUrl ?? localChannelsUrl(DEFAULT_WEB_PORT),
      currentHumanIdentityId: options.currentHumanIdentityId,
      launchCodeTtlMs: options.launchCodeTtlMs,
      sessionTtlMs: options.sessionTtlMs,
      now: options.now,
      onAudit: options.onAudit,
    });
    const client = new ChannelClient(options.channelsEndpoint ?? `http://127.0.0.1:${DEFAULT_CHANNELS_PORT}`, {
      serviceToken: options.channelsServiceToken,
    });
    agentHost = new LocalAgentHost({
      client,
      store,
      runtimes: options.runtimes ?? {},
      now: options.now,
      stopStartedSessionsOnClose: options.stopStartedSessionsOnClose,
      onAudit: options.onAudit,
    });
    await agentHost.restore();
    const service = new LocalControlService({
      channels: client,
      bindings: store,
      runtimes: options.runtimes ?? {},
      lifecycle: agentHost,
      configuration: new LocalAgentHostConfiguration({
        client,
        store,
        runtimes: options.runtimes ?? {},
        now: options.now,
        onAudit: options.onAudit,
      }),
      statusTimeoutMs: options.statusTimeoutMs,
    });
    server = await createLocalControlHttpServer({
      service,
      host: options.host,
      port: options.port,
      allowedOrigins: [browserSessions.browserOrigin],
      browserSessions,
    });
    return {
      endpoint: server.endpoint,
      issueBrowserLaunchUrl: (destinationPath) =>
        browserSessions.issueLaunchUrl(server!.endpoint, destinationPath),
      authenticateBrowser: (cookieHeader) => browserSessions.authenticate(cookieHeader),
      async close() {
        await server!.close();
        await agentHost!.close();
        await store.close();
      },
    };
  } catch (error) {
    await server?.close().catch(() => undefined);
    await agentHost?.close().catch(() => undefined);
    await store.close();
    throw error;
  }
}
