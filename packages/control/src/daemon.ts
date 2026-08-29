import { ChannelClient } from "@minu/channels-core/client";
import {
  DrizzleLibSqlRelayStorage,
  localRelayLibSqlUrl,
} from "@minu/channels-relay-storage-drizzle";
import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  createLocalControlHttpServer,
  LocalControlService,
  type LocalControlHttpServer,
  type LocalControlRuntimePort,
} from "./server.ts";
import {
  LocalControlBrowserSessions,
  type LocalControlAuditEvent,
} from "./session.ts";

export interface LocalControlDaemonOptions {
  currentHumanIdentityId: string;
  channelsEndpoint?: string;
  relayDatabasePath?: string;
  webUrl?: string;
  host?: "127.0.0.1" | "::1";
  port?: number;
  runtimes?: Readonly<Record<string, LocalControlRuntimePort>>;
  statusTimeoutMs?: number;
  launchCodeTtlMs?: number;
  sessionTtlMs?: number;
  now?: () => Date;
  onAudit?(event: LocalControlAuditEvent): void;
}

export interface LocalControlDaemon {
  endpoint: string;
  issueBrowserLaunchUrl(destinationPath?: string): string;
  close(): Promise<void>;
}

export function defaultRelayDatabasePath(): string {
  return join(homedir(), ".minu", "channels", "relay.db");
}

export async function createLocalControlDaemon(
  options: LocalControlDaemonOptions,
): Promise<LocalControlDaemon> {
  const usesDefaultDatabase = options.relayDatabasePath === undefined;
  const databasePath = resolve(options.relayDatabasePath ?? defaultRelayDatabasePath());
  await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 });
  if (usesDefaultDatabase) await chmod(dirname(databasePath), 0o700);
  const store = await DrizzleLibSqlRelayStorage.open({ url: localRelayLibSqlUrl(databasePath) });
  let server: LocalControlHttpServer | undefined;
  try {
    for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      await chmod(path, 0o600).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    const browserSessions = new LocalControlBrowserSessions({
      browserUrl: options.webUrl ?? "http://127.0.0.1:5174/",
      currentHumanIdentityId: options.currentHumanIdentityId,
      launchCodeTtlMs: options.launchCodeTtlMs,
      sessionTtlMs: options.sessionTtlMs,
      now: options.now,
      onAudit: options.onAudit,
    });
    const service = new LocalControlService({
      channels: new ChannelClient(options.channelsEndpoint ?? "http://127.0.0.1:4310"),
      bindings: store,
      runtimes: options.runtimes ?? {},
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
      async close() {
        await server!.close();
        await store.close();
      },
    };
  } catch (error) {
    await server?.close().catch(() => undefined);
    await store.close();
    throw error;
  }
}
