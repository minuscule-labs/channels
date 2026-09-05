import type { ChannelEvent, ChannelMessage, Participant } from "@minu/channels-core/types";
import { describe, expect, it } from "vitest";
import { channelCacheAction } from "../src/lib/channel-events";
import {
  createMessageSubmission,
  draftStorageKey,
  mentionQueryAt,
  messageByteLength,
  replaceMention,
  submissionMatchesDraft,
} from "../src/lib/composer";
import { queryKeys } from "../src/lib/query-keys";
import { isNearTimelineEnd, projectTimeline } from "../src/lib/timeline";

const participants: Participant[] = [
  { id: "human-id", handle: "david", type: "human", status: "active" },
  { id: "agent-id", handle: "builder", type: "agent", status: "active" },
  { id: "disabled-id", handle: "retired", type: "agent", status: "disabled" },
];

function message(id: string, sequence: number, overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id,
    channelId: "channel",
    sequence,
    participantId: "human-id",
    to: [],
    body: id,
    createdAt: new Date(`2026-08-28T12:0${sequence}:00.000Z`).toISOString(),
    ...overrides,
  };
}

describe("query keys", () => {
  it("keeps Channel metadata and messages in one key hierarchy", () => {
    expect(queryKeys.localCurrentSession()).toEqual(["local", "session"]);
    expect(queryKeys.channel("one")).toEqual(["channel", "one"]);
    expect(queryKeys.channelMessages("one")).toEqual(["channel", "one", "messages"]);
    expect(queryKeys.workspaceChannels("workspace")).toEqual(["workspace", "workspace", "channels"]);
    expect(queryKeys.workspaceConfiguration("workspace")).toEqual(["workspace", "workspace", "configuration"]);
    expect(queryKeys.localChannelAgents("one")).toEqual(["local", "channel", "one", "agents"]);
  });
});

describe("Channel event reduction", () => {
  it("merges messages and refreshes only for newer roster revisions", () => {
    const created: ChannelEvent = {
      id: "event-1",
      type: "message.created",
      channelId: "channel",
      message: message("one", 1),
      createdAt: "2026-08-28T12:01:00.000Z",
    };
    expect(channelCacheAction(created, 3)).toMatchObject({ type: "merge-message", message: { id: "one" } });

    const roster = (rosterRevision: number): ChannelEvent => ({
      id: `event-${rosterRevision}`,
      type: "roster.updated",
      channelId: "channel",
      rosterRevision,
      createdAt: "2026-08-28T12:01:00.000Z",
    });
    expect(channelCacheAction(roster(3), 3)).toEqual({ type: "ignore" });
    expect(channelCacheAction(roster(4), 3)).toEqual({ type: "refresh-metadata", rosterRevision: 4 });
    expect(channelCacheAction(roster(1), undefined)).toEqual({ type: "refresh-metadata", rosterRevision: 1 });
    expect(channelCacheAction({
      id: "event-name",
      type: "channel.updated",
      channelId: "channel",
      createdAt: "2026-08-28T12:01:00.000Z",
    }, 4)).toEqual({ type: "refresh-metadata" });
  });
});

describe("composer primitives", () => {
  it("finds and replaces a mention at the cursor without changing later text", () => {
    const body = "Please ask @buil tomorrow";
    const cursor = body.indexOf(" tomorrow");
    const query = mentionQueryAt(body, cursor);
    expect(query).toEqual({ start: 11, end: 16, value: "buil" });
    expect(replaceMention(body, query!, "builder")).toEqual({
      body: "Please ask @builder tomorrow",
      cursor: 20,
    });
    expect(mentionQueryAt("email@example.com", 17)).toBeUndefined();
  });

  it("measures UTF-8 bytes and isolates drafts by Workspace, Channel, and author", () => {
    expect(messageByteLength("a😀")).toBe(5);
    expect(draftStorageKey("workspace", "channel", "human")).toBe(
      "minu.channels.draft.workspace.channel.human",
    );
  });

  it("creates one retryable submission with stable targets and detects draft changes", () => {
    const submission = createMessageSubmission("human-id", "@builder please review", participants, () => "key-1");
    expect(submission).toEqual({
      idempotencyKey: "key-1",
      input: { participantId: "human-id", body: "@builder please review", to: ["agent-id"] },
    });
    expect(submissionMatchesDraft(submission, "human-id", "@builder please review", participants)).toBe(true);
    expect(submissionMatchesDraft(submission, "human-id", "@builder changed", participants)).toBe(false);
    expect(submissionMatchesDraft(submission, "agent-id", "@builder please review", participants)).toBe(false);
  });
});

describe("timeline projection", () => {
  it("detects whether new messages should preserve end anchoring", () => {
    expect(isNearTimelineEnd({ scrollTop: 780, scrollHeight: 1_000, clientHeight: 200 })).toBe(true);
    expect(isNearTimelineEnd({ scrollTop: 500, scrollHeight: 1_000, clientHeight: 200 })).toBe(false);
  });

  it("orders rows, adds day boundaries, and groups only compatible nearby messages", () => {
    const rows = projectTimeline([
      message("two", 2),
      message("one", 1),
      message("three", 3, { to: ["agent-id"] }),
      message("next-day", 4, { createdAt: "2026-08-29T12:00:00.000Z" }),
    ]);
    expect(rows.map(({ id }) => id)).toEqual([
      "day:2026-08-28",
      "message:one",
      "message:two",
      "message:three",
      "day:2026-08-29",
      "message:next-day",
    ]);
    expect(rows.find((row) => row.id === "message:two")).toMatchObject({ continuation: true });
    expect(rows.find((row) => row.id === "message:three")).toMatchObject({ continuation: false });
    expect(rows.find((row) => row.id === "message:next-day")).toMatchObject({ continuation: false });
  });
});
