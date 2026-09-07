#!/usr/bin/env node
import { Command, InvalidArgumentError, Option } from "commander";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ChannelService,
  createChannelHttpServer,
  InMemoryChannelStorage,
} from "@minu/channels-core";
import { DrizzleLibSqlChannelStorage, localLibSqlUrl } from "./storage.ts";

interface CliOptions {
  port: number;
  db?: string;
  dbUrl?: string;
  authToken?: string;
  serviceToken: string;
  memory?: boolean;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new InvalidArgumentError("must be an integer from 0 to 65535");
  }
  return port;
}

async function main(): Promise<void> {
  const program = new Command()
    .name("minu-channels-server")
    .description("Run the MinuChannels HTTP and SSE service")
    .option("--port <number>", "HTTP port", parsePort, 4310)
    .addOption(new Option("--db <path>", "local libSQL database path").conflicts("dbUrl"))
    .addOption(new Option("--db-url <url>", "libSQL or Turso database URL").conflicts("db"))
    .option("--auth-token <token>", "Turso authentication token")
    .requiredOption("--service-token <token>", "private HTTP service credential", process.env.MINU_CHANNELS_SERVICE_TOKEN)
    .addOption(
      new Option("--memory", "use disposable in-memory storage").conflicts([
        "db",
        "dbUrl",
        "authToken",
      ]),
    )
    .showHelpAfterError();
  program.parse(process.argv);
  const options = program.opts<CliOptions>();

  const defaultPath = join(homedir(), ".minu", "channels", "channels.db");
  const databaseUrl = options.dbUrl
    ?? (options.db ? localLibSqlUrl(options.db) : process.env.TURSO_DATABASE_URL)
    ?? localLibSqlUrl(defaultPath);
  const authToken = options.authToken ?? process.env.TURSO_AUTH_TOKEN;
  const storage = options.memory
    ? new InMemoryChannelStorage()
    : await DrizzleLibSqlChannelStorage.open({ url: databaseUrl, authToken });
  const server = await createChannelHttpServer({
    port: options.port,
    service: new ChannelService(storage),
    serviceToken: options.serviceToken,
  });
  console.log(`MinuChannels listening on ${server.endpoint}`);
  console.log(options.memory ? "Storage: memory" : `Storage: ${databaseUrl}`);

  let closing = false;
  async function close(): Promise<void> {
    if (closing) return;
    closing = true;
    await server.close();
  }

  process.on("SIGINT", () => void close().then(() => process.exit(0)));
  process.on("SIGTERM", () => void close().then(() => process.exit(0)));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
