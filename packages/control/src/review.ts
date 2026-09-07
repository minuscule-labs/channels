import {
  ChannelClient,
  ChannelService,
  createChannelHttpServer,
  InMemoryChannelStorage,
  type ChannelHttpServer,
} from "@minu/channels-core";
import {
  ChannelRuntimeRelay,
  type AgentRuntimePort,
  type RuntimePortMessage,
} from "@minu/channels-relay";
import {
  DrizzleLibSqlRelayStorage,
  localRelayLibSqlUrl,
} from "@minu/channels-relay-storage-drizzle";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { LocalManagedRuntimePort } from "./agent-host.ts";
import { createLocalControlDaemon, type LocalControlDaemon } from "./daemon.ts";
import { DEFAULT_CHANNELS_PORT, DEFAULT_CONTROL_PORT, DEFAULT_WEB_PORT, localChannelsUrl } from "./local-host.ts";
import type { LocalControlAuditEvent } from "./session.ts";

class SimulatedReviewRuntime implements AgentRuntimePort {
  private readonly transcript: RuntimePortMessage[] = [];
  private working = false;

  async send(sessionId: string, input: string): Promise<void> {
    if (sessionId !== "review-builder-session") throw new Error("Unknown review session");
    this.working = true;
    try {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      const trigger = input.split("\n")
        .find((line) => line.includes("← TRIGGER"))
        ?.replace(/^[^:]+:\s*/, "")
        .replace(/\s*← TRIGGER$/, "")
        .trim();
      const summary = (trigger && trigger.length > 160 ? `${trigger.slice(0, 157)}…` : trigger)
        ?.replace(/[.!?]+$/, "")
        .replaceAll("@", "＠");
      this.transcript.push(
        { role: "user", content: input },
        {
          role: "assistant",
          content: `[Simulated review agent] I received${summary ? ` “${summary}”` : " your message"}. This confirms mention routing, Relay delivery, and response posting are working. Live Pi execution is not enabled in review mode.`,
        },
      );
    } finally {
      this.working = false;
    }
  }

  async status(sessionId: string): Promise<"idle" | "working" | "offline"> {
    if (sessionId !== "review-builder-session") return "offline";
    return this.working ? "working" : "idle";
  }

  async messages(sessionId: string): Promise<RuntimePortMessage[]> {
    return sessionId === "review-builder-session" ? this.transcript.map((message) => ({ ...message })) : [];
  }
}

export interface LocalReviewManagedRuntime {
  adapter: string;
  runtime: LocalManagedRuntimePort;
  personaPrompt: string;
}

export interface LocalReviewAppOptions {
  channelsPort?: number;
  controlPort?: number;
  webUrl?: string;
  workspaceRoot?: string;
  managedRuntime?: LocalReviewManagedRuntime;
  onAudit?(event: LocalControlAuditEvent): void;
}

export interface LocalReviewApp {
  channelsEndpoint: string;
  channelsServiceToken: string;
  controlEndpoint: string;
  workspaceId: string;
  channelId: string;
  humanIdentityId: string;
  issueBrowserLaunchUrl(): string;
  authenticateBrowser(cookieHeader: string | undefined): { identityId: string } | undefined;
  close(): Promise<void>;
}

export async function createLocalReviewApp(
  options: LocalReviewAppOptions = {},
): Promise<LocalReviewApp> {
  const directory = await mkdtemp(join(tmpdir(), "minu-channels-review-"));
  const relayDatabasePath = join(directory, "relay.db");
  let channelsServer: ChannelHttpServer | undefined;
  let controlDaemon: LocalControlDaemon | undefined;
  let relay: ChannelRuntimeRelay | undefined;
  try {
    channelsServer = await createChannelHttpServer({
      port: options.channelsPort ?? DEFAULT_CHANNELS_PORT,
      service: new ChannelService(new InMemoryChannelStorage()),
    });
    const client = new ChannelClient(channelsServer.endpoint, { serviceToken: channelsServer.serviceToken });
    const [human, builder, reviewer] = await Promise.all([
      client.createIdentity({
        type: "human",
        displayName: "You",
        publicProfile: "Coordinates work and reviews agent output.",
      }),
      client.createIdentity({
        type: "agent",
        displayName: "Builder Agent",
        publicProfile: "Implementation-focused coding agent.",
      }),
      client.createIdentity({
        type: "agent",
        displayName: "Reviewer Agent",
        publicProfile: "Independent correctness and security reviewer.",
      }),
    ]);
    const workspace = await client.createWorkspace({
      slug: "review-workspace",
      name: "MinuChannels Review",
      description: "Disposable seeded Workspace for reviewing the local application.",
    });
    await Promise.all([
      client.addWorkspaceMember(workspace.id, {
        identityId: human.id,
        mentionHandle: "you",
        accessRole: "owner",
        roleLabel: "coordinator",
        profileOverride: "Sets priorities and approves consequential decisions.",
      }),
      client.addWorkspaceMember(workspace.id, {
        identityId: builder.id,
        mentionHandle: "builder",
        roleLabel: "builder",
        profileOverride: "Implements scoped work and reports concrete results.",
      }),
      client.addWorkspaceMember(workspace.id, {
        identityId: reviewer.id,
        mentionHandle: "reviewer",
        roleLabel: "reviewer",
        profileOverride: "Reviews correctness, security, regressions, and missing tests.",
      }),
    ]);
    const channel = await client.createChannel({
      workspaceId: workspace.id,
      name: "product-review",
      participantIds: [human.id, builder.id, reviewer.id],
    });
    await client.postMessage(channel.id, {
      participantId: human.id,
      to: [builder.id],
      body: "@builder Please prepare the first implementation pass and hand it to @reviewer.",
    });
    await client.postMessage(channel.id, {
      participantId: builder.id,
      to: [human.id, reviewer.id],
      body: "Review mode is ready. Send @builder a message to test the simulated Relay response. Unaddressed messages remain shared context and do not wake agents.",
    });
    await client.postMessage(channel.id, {
      participantId: reviewer.id,
      to: [human.id],
      body: "I’ll independently review the result and report concrete findings here.",
    });

    const timestamp = new Date().toISOString();
    const store = await DrizzleLibSqlRelayStorage.open({ url: localRelayLibSqlUrl(relayDatabasePath) });
    try {
      await store.putWorkspaceConfig({
        workspaceId: workspace.id,
        rootUri: pathToFileURL(resolve(options.workspaceRoot ?? process.cwd())).href,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      await store.putAgentConfig({
        id: "review-builder-config",
        workspaceId: workspace.id,
        agentIdentityId: builder.id,
        personaRef: options.managedRuntime ? undefined : "review-mode:builder",
        personaPrompt: options.managedRuntime?.personaPrompt,
        runtimeAdapter: options.managedRuntime?.adapter,
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      if (!options.managedRuntime) {
        await store.putBinding({
          id: "review-builder-binding",
          workspaceAgentConfigId: "review-builder-config",
          workspaceId: workspace.id,
          channelId: channel.id,
          agentIdentityId: builder.id,
          runtimeAdapter: "review-mode",
          runtimeSessionId: "review-builder-session",
          generation: 1,
          state: "connected",
          wakePolicy: "mentions",
          lastVerifiedAt: timestamp,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      }
    } finally {
      await store.close();
    }

    const simulatedRuntime = options.managedRuntime ? undefined : new SimulatedReviewRuntime();
    const runtime = options.managedRuntime?.runtime ?? simulatedRuntime!;
    const runtimeAdapter = options.managedRuntime?.adapter ?? "review-mode";
    controlDaemon = await createLocalControlDaemon({
      currentHumanIdentityId: human.id,
      channelsEndpoint: channelsServer.endpoint,
      channelsServiceToken: channelsServer.serviceToken,
      relayDatabasePath,
      webUrl: options.webUrl ?? localChannelsUrl(DEFAULT_WEB_PORT),
      port: options.controlPort ?? DEFAULT_CONTROL_PORT,
      runtimes: { [runtimeAdapter]: runtime },
      stopStartedSessionsOnClose: Boolean(options.managedRuntime),
      onAudit: options.onAudit,
    });
    if (!options.managedRuntime) {
      relay = new ChannelRuntimeRelay({
        client,
        channelId: channel.id,
        bindings: [{
          participantId: builder.id,
          sessionId: "review-builder-session",
          runtime: simulatedRuntime!,
          wakePolicy: "mentions",
        }],
      });
      await relay.start();
      await relay.waitForIdle();
    }

    let closed = false;
    return {
      channelsEndpoint: channelsServer.endpoint,
      channelsServiceToken: channelsServer.serviceToken,
      controlEndpoint: controlDaemon.endpoint,
      workspaceId: workspace.id,
      channelId: channel.id,
      humanIdentityId: human.id,
      issueBrowserLaunchUrl: () => controlDaemon!.issueBrowserLaunchUrl(
        `/app/workspaces/${workspace.id}/channels/${channel.id}`,
      ),
      authenticateBrowser: (cookieHeader) => controlDaemon!.authenticateBrowser(cookieHeader),
      async close() {
        if (closed) return;
        closed = true;
        await relay?.stop().catch(() => undefined);
        await Promise.allSettled([controlDaemon!.close(), channelsServer!.close()]);
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await relay?.stop().catch(() => undefined);
    await Promise.allSettled([controlDaemon?.close(), channelsServer?.close()]);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
