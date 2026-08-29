#!/usr/bin/env node
import { Command, Option } from "commander";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
import {
  ChannelRuntimeRelay,
  InMemoryRelayBindingStore,
  LocalRelayDirectory,
  restoreChannelBindings,
} from "@minu/channels-relay";
import {
  DrizzleLibSqlRelayStorage,
  localRelayLibSqlUrl,
} from "@minu/channels-relay-storage-drizzle";

const BUILDER_PERSONA = `You are Agent A, the builder in a shared MinuChannel.
Implement or investigate the work you are explicitly addressed with. Inspect the actual project, use tools, and report concrete results rather than speculation. When another review is useful, use the Channel roster to identify the reviewer and mention that participant's exact id with a focused handoff. Do not speak for other participants.`;

const REVIEWER_PERSONA = `You are Agent B, the reviewer in a shared MinuChannel.
Independently inspect work you are explicitly addressed with. Prioritize correctness, security, regressions, and missing tests. Report concrete findings with file references when possible. Do not approve work you have not inspected, and do not modify it unless asked.`;

interface DemoOptions {
  cwd?: string;
  db?: string;
  dbUrl?: string;
  authToken?: string;
  relayDb?: string;
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
  if (participant.status === "disabled") details.push("disabled");
  return `@${participant.handle ?? participant.id} — ${details.join(" — ")}${
    participant.profile ? `\n    ${participant.profile}` : ""
  }`;
}

function formatEvent(event: ChannelEvent, participants: Participant[]): string {
  if (event.type === "roster.updated") {
    return `[roster revision ${event.rosterRevision}] Workspace membership metadata changed`;
  }
  const label = (identityId: string) => {
    if (identityId === "@channel") return identityId;
    const participant = participants.find((candidate) => candidate.id === identityId);
    return participant ? `@${participant.handle ?? participant.id}` : identityId;
  };
  const target = event.message.to.length ? ` → ${event.message.to.map(label).join(", ")}` : "";
  return `[${event.message.sequence}] ${label(event.message.participantId)}${target}: ${event.message.body.replaceAll("\n", "\n    ")}`;
}

async function main(): Promise<void> {
  const program = new Command()
    .name("minu-channel-demo")
    .description("Run an interactive Channel with builder and reviewer Pi agents")
    .option("--cwd <path>", "agent working directory")
    .addOption(new Option("--db <path>", "local libSQL database path").conflicts("dbUrl"))
    .addOption(new Option("--db-url <url>", "libSQL or Turso database URL").conflicts("db"))
    .option("--auth-token <token>", "Turso authentication token")
    .option("--relay-db <path>", "private local Relay configuration database")
    .addOption(
      new Option("--memory", "use disposable in-memory storage").conflicts([
        "db",
        "dbUrl",
        "authToken",
        "relayDb",
      ]),
    )
    .showHelpAfterError();
  program.parse(process.argv);
  const options = program.opts<DemoOptions>();

  const cwd = resolve(options.cwd ?? process.cwd());
  const defaultDatabasePath = join(homedir(), ".minu", "channels", "channels.db");
  const defaultRelayDatabasePath = join(homedir(), ".minu", "channels", "relay.db");
  const databaseUrl = options.dbUrl
    ?? (options.db ? localLibSqlUrl(options.db) : process.env.TURSO_DATABASE_URL)
    ?? localLibSqlUrl(defaultDatabasePath);
  const authToken = options.authToken ?? process.env.TURSO_AUTH_TOKEN;
  const storage = options.memory
    ? new InMemoryChannelStorage()
    : await DrizzleLibSqlChannelStorage.open({ url: databaseUrl, authToken });
  const relayStorage = options.memory
    ? new InMemoryRelayBindingStore()
    : await DrizzleLibSqlRelayStorage.open({
      url: localRelayLibSqlUrl(options.relayDb ?? defaultRelayDatabasePath),
    });
  const server = await createChannelHttpServer({ service: new ChannelService(storage) });
  const client = new ChannelClient(server.endpoint);
  const runtime = new PiAgentRuntime();
  const [sessions, identities] = await Promise.all([
    Promise.all([
      runtime.start({ cwd, appendSystemPrompt: BUILDER_PERSONA }),
      runtime.start({ cwd, appendSystemPrompt: REVIEWER_PERSONA }),
    ]),
    Promise.all([
      client.createIdentity({ type: "human", displayName: "You" }),
      client.createIdentity({ type: "agent", displayName: "Agent A" }),
      client.createIdentity({ type: "agent", displayName: "Agent B" }),
    ]),
  ]);
  const [human, agentA, agentB] = identities;
  const workspace = await client.createWorkspace({
    slug: `pi-demo-${Date.now().toString(36)}`,
    name: "Pi Collaboration Demo",
  });
  await Promise.all([
    client.addWorkspaceMember(workspace.id, {
      identityId: human!.id,
      mentionHandle: "you",
      accessRole: "owner",
      roleLabel: "coordinator",
      profileOverride: "Sets priorities, provides clarification, and approves consequential decisions.",
    }),
    client.addWorkspaceMember(workspace.id, {
      identityId: agentA!.id,
      mentionHandle: "agent-a",
      roleLabel: "builder",
      profileOverride: "Implements features, investigates the project, and hands completed work to reviewers.",
    }),
    client.addWorkspaceMember(workspace.id, {
      identityId: agentB!.id,
      mentionHandle: "agent-b",
      roleLabel: "reviewer",
      profileOverride: "Independently reviews correctness, security, regressions, and missing tests.",
    }),
  ]);
  const channel = await client.createChannel({
    workspaceId: workspace.id,
    name: "pi-collaboration",
    participantIds: [human!.id, agentA!.id, agentB!.id],
  });
  const relayDirectory = new LocalRelayDirectory(client, relayStorage);
  await relayDirectory.configureWorkspace({
    workspaceId: workspace.id,
    rootUri: pathToFileURL(cwd).href,
  });
  await Promise.all([
    relayDirectory.configureAgent({
      workspaceId: workspace.id,
      agentIdentityId: agentA!.id,
      personaRef: "pi-demo:builder:v1",
    }),
    relayDirectory.configureAgent({
      workspaceId: workspace.id,
      agentIdentityId: agentB!.id,
      personaRef: "pi-demo:reviewer:v1",
    }),
  ]);
  await Promise.all([
    relayDirectory.bindAgent({
      channelId: channel.id,
      agentIdentityId: agentA!.id,
      runtimeAdapter: "pi",
      runtimeSessionId: sessions[0]!.id,
    }),
    relayDirectory.bindAgent({
      channelId: channel.id,
      agentIdentityId: agentB!.id,
      runtimeAdapter: "pi",
      runtimeSessionId: sessions[1]!.id,
    }),
  ]);
  const restoredBindings = await restoreChannelBindings({
    client,
    store: relayStorage,
    channelId: channel.id,
    leaseOwner: `pi-demo:${randomUUID()}`,
    runtimes: { pi: runtime },
  });

  const relay = new ChannelRuntimeRelay({
    client,
    channelId: channel.id,
    bindings: restoredBindings.bindings,
    cursorStore: storage,
    onError(binding, error) {
      console.error(`\n[relay${binding ? `:${binding.participantId}` : ""}] ${error.message}`);
    },
  });
  restoredBindings.startAutoRenew(() => relay.stop());
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
        console.log(`\n${formatEvent(event, channel.participants)}`);
        input?.prompt(true);
      }
    } catch (error) {
      if (!viewerController.signal.aborted) throw error;
    }
  })();
  await ready;

  console.log(`Local MinuChannel: ${channel.id}`);
  console.log(`Endpoint: ${server.endpoint}`);
  console.log(options.memory ? "Storage: memory" : `Channel storage: ${databaseUrl}`);
  if (!options.memory) {
    console.log(`Private Relay storage: ${localRelayLibSqlUrl(options.relayDb ?? defaultRelayDatabasePath)}`);
  }
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
          const target = channel.participants.find(
            (participant) => (participant.handle ?? participant.id) === control.participantId,
          );
          if (!target) throw new Error(`Unknown participant: @${control.participantId}`);
          if (control.type === "steer") {
            await relay.steer(target.id, human!.id, control.input);
            console.log(`Steering message accepted by @${control.participantId}.`);
          } else {
            await relay.interrupt(target.id, human!.id, control.input);
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
          }, channel.participants));
        }
      } else if (line === "/status") {
        console.log(`agent-a: ${await runtime.status(sessions[0]!.id)}`);
        console.log(`agent-b: ${await runtime.status(sessions[1]!.id)}`);
      } else {
        await client.postMessage(channel.id, { participantId: human!.id, body: line });
      }
      input.prompt();
    }
  } finally {
    process.removeListener("SIGINT", requestClose);
    process.removeListener("SIGTERM", requestClose);
    console.log("\nWaiting for active agent turns to settle...");
    await relay.waitForIdle();
    await relay.stop();
    await restoredBindings.close();
    viewerController.abort();
    await viewer.catch(() => {});
    await Promise.all(sessions.map((session) => runtime.stop(session.id).catch(() => {})));
    await relayStorage.close?.();
    await server.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
