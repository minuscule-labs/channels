#!/usr/bin/env node
import { Command, Option } from "commander";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import {
  ChannelClient,
  ChannelService,
  createChannelHttpServer,
  InMemoryChannelStorage,
  type ChannelEvent,
  type Participant,
} from "@minu/channels-core";
import {
  DrizzleLibSqlChannelStorage,
  localLibSqlUrl,
} from "@minu/channels-storage-drizzle";
import { PiAgentRuntime } from "@minu/runtime-pi";
import { ChannelRuntimeRelay } from "@minu/channels-relay";

const BUILDER_PERSONA = `You are Agent A, the builder in a shared MinuChannel.
Implement or investigate the work you are explicitly addressed with. Inspect the actual project, use tools, and report concrete results rather than speculation. When another review is useful, use the Channel roster to identify the reviewer and mention that participant's exact id with a focused handoff. Do not speak for other participants.`;

const REVIEWER_PERSONA = `You are Agent B, the reviewer in a shared MinuChannel.
Independently inspect work you are explicitly addressed with. Prioritize correctness, security, regressions, and missing tests. Report concrete findings with file references when possible. Do not approve work you have not inspected, and do not modify it unless asked.`;

interface DemoOptions {
  cwd?: string;
  db?: string;
  dbUrl?: string;
  authToken?: string;
  memory?: boolean;
}

function controlCommand(line: string):
  | { type: "steer" | "interrupt"; participantId: string; input: string }
  | undefined {
  const match = line.match(/^\/(steer|interrupt)\s+@([a-zA-Z0-9_-]+)\s+(.+)$/);
  if (!match) return undefined;
  return {
    type: match[1] as "steer" | "interrupt",
    participantId: match[2]!,
    input: match[3]!.trim(),
  };
}

function formatParticipant(participant: Participant): string {
  const details: string[] = [participant.type];
  if (participant.displayName) details.push(participant.displayName);
  if (participant.role) details.push(`role: ${participant.role}`);
  return `@${participant.id} — ${details.join(" — ")}${
    participant.profile ? `\n    ${participant.profile}` : ""
  }`;
}

function formatEvent(event: ChannelEvent): string {
  const target = event.message.to.length ? ` → ${event.message.to.join(", ")}` : "";
  return `[${event.message.sequence}] ${event.message.participantId}${target}: ${event.message.body.replaceAll("\n", "\n    ")}`;
}

async function main(): Promise<void> {
  const program = new Command()
    .name("minu-channel-demo")
    .description("Run an interactive Channel with builder and reviewer Pi agents")
    .option("--cwd <path>", "agent working directory")
    .addOption(new Option("--db <path>", "local libSQL database path").conflicts("dbUrl"))
    .addOption(new Option("--db-url <url>", "libSQL or Turso database URL").conflicts("db"))
    .option("--auth-token <token>", "Turso authentication token")
    .addOption(
      new Option("--memory", "use disposable in-memory storage").conflicts([
        "db",
        "dbUrl",
        "authToken",
      ]),
    )
    .showHelpAfterError();
  program.parse(process.argv);
  const options = program.opts<DemoOptions>();

  const cwd = resolve(options.cwd ?? process.cwd());
  const defaultDatabasePath = join(homedir(), ".minu", "channels", "channels.db");
  const databaseUrl = options.dbUrl
    ?? (options.db ? localLibSqlUrl(options.db) : process.env.TURSO_DATABASE_URL)
    ?? localLibSqlUrl(defaultDatabasePath);
  const authToken = options.authToken ?? process.env.TURSO_AUTH_TOKEN;
  const storage = options.memory
    ? new InMemoryChannelStorage()
    : await DrizzleLibSqlChannelStorage.open({ url: databaseUrl, authToken });
  const server = await createChannelHttpServer({ service: new ChannelService(storage) });
  const client = new ChannelClient(server.endpoint);
  const runtime = new PiAgentRuntime();
  const sessions = await Promise.all([
    runtime.start({ cwd, appendSystemPrompt: BUILDER_PERSONA }),
    runtime.start({ cwd, appendSystemPrompt: REVIEWER_PERSONA }),
  ]);
  const channel = await client.createChannel({
    participants: [
      {
        id: "user",
        type: "human",
        displayName: "You",
        role: "coordinator",
        profile: "Sets priorities, provides clarification, and approves consequential decisions.",
      },
      {
        id: "agent-a",
        type: "agent",
        displayName: "Agent A",
        role: "builder",
        profile: "Implements features, investigates the project, and hands completed work to reviewers.",
      },
      {
        id: "agent-b",
        type: "agent",
        displayName: "Agent B",
        role: "reviewer",
        profile: "Independently reviews correctness, security, regressions, and missing tests.",
      },
    ],
  });

  const relay = new ChannelRuntimeRelay({
    client,
    channelId: channel.id,
    bindings: [
      { participantId: "agent-a", sessionId: sessions[0]!.id, runtime },
      { participantId: "agent-b", sessionId: sessions[1]!.id, runtime },
    ],
    cursorStore: storage,
    onError(binding, error) {
      console.error(`\n[relay${binding ? `:${binding.participantId}` : ""}] ${error.message}`);
    },
  });
  await relay.start();

  const viewerController = new AbortController();
  let input: ReturnType<typeof createInterface> | undefined;
  let viewerReady!: () => void;
  const ready = new Promise<void>((resolveReady) => (viewerReady = resolveReady));
  const viewer = (async () => {
    try {
      for await (const event of client.events(channel.id, {
        signal: viewerController.signal,
        onReady: viewerReady,
      })) {
        console.log(`\n${formatEvent(event)}`);
        input?.prompt(true);
      }
    } catch (error) {
      if (!viewerController.signal.aborted) throw error;
    }
  })();
  await ready;

  console.log(`Local MinuChannel: ${channel.id}`);
  console.log(`Endpoint: ${server.endpoint}`);
  console.log(options.memory ? "Storage: memory" : `Storage: ${databaseUrl}`);
  console.log(`agent-a (builder): ${sessions[0]!.id}`);
  console.log(`agent-b (reviewer): ${sessions[1]!.id}`);
  console.log("\nMention @agent-a, @agent-b, or @channel to wake agents.");
  console.log("Unaddressed messages are stored without waking agents.");
  console.log("Commands: /members, /messages, /status, /quit");
  console.log("Controls: /steer @agent-id <message>, /interrupt @agent-id <replacement>\n");

  input = createInterface({ input: process.stdin, output: process.stdout, prompt: "you> " });
  const requestClose = () => input.close();
  process.once("SIGINT", requestClose);
  process.once("SIGTERM", requestClose);
  input.prompt();

  try {
    for await (const raw of input) {
      const line = raw.trim();
      if (!line) {
        input.prompt();
        continue;
      }
      if (line === "/quit") break;
      const control = controlCommand(line);
      if (control) {
        try {
          if (control.type === "steer") {
            await relay.steer(control.participantId, "user", control.input);
            console.log(`Steering message accepted by @${control.participantId}.`);
          } else {
            await relay.interrupt(control.participantId, "user", control.input);
            console.log(`@${control.participantId} interrupted; replacement queued.`);
          }
        } catch (error) {
          console.error(error instanceof Error ? error.message : String(error));
        }
      } else if (line.startsWith("/steer") || line.startsWith("/interrupt")) {
        console.error("Usage: /steer @agent-id <message> or /interrupt @agent-id <replacement>");
      } else if (line === "/members") {
        for (const participant of (await client.getChannel(channel.id)).participants) {
          console.log(formatParticipant(participant));
        }
      } else if (line === "/messages") {
        for (const message of await client.listMessages(channel.id)) {
          console.log(formatEvent({
            id: message.id,
            type: "message.created",
            channelId: channel.id,
            message,
            createdAt: message.createdAt,
          }));
        }
      } else if (line === "/status") {
        console.log(`agent-a: ${await runtime.status(sessions[0]!.id)}`);
        console.log(`agent-b: ${await runtime.status(sessions[1]!.id)}`);
      } else {
        await client.postMessage(channel.id, { participantId: "user", body: line });
      }
      input.prompt();
    }
  } finally {
    process.removeListener("SIGINT", requestClose);
    process.removeListener("SIGTERM", requestClose);
    console.log("\nWaiting for active agent turns to settle...");
    await relay.waitForIdle();
    await relay.stop();
    viewerController.abort();
    await viewer.catch(() => {});
    await Promise.all(sessions.map((session) => runtime.stop(session.id).catch(() => {})));
    await server.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
