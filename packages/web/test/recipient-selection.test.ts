import { describe, expect, it, vi, afterEach } from "vitest";
import type { Participant } from "@minu/channels-core/types";
import { createMessageSubmission, mentionQueryAt, submissionMatchesDraft } from "../src/lib/composer";
import { messageRecipients, readRecipient, readRecipientOverride, recipientStorageKey, writeRecipient, writeRecipientOverride } from "../src/lib/recipient-selection";

const participants: Participant[] = [
  { id: "human", handle: "owner", type: "human", status: "active" },
  { id: "a", handle: "alpha", type: "agent", status: "active" },
  { id: "b", handle: "beta", type: "agent", status: "active" },
  { id: "retired", handle: "retired", type: "agent", status: "disabled" },
];
afterEach(() => vi.unstubAllGlobals());

describe("per-person recipient selection", () => {
  it("isolates workspace, channel/thread and user preferences", () => {
    const keys = [recipientStorageKey("w", "main", "u"), recipientStorageKey("w", "thread", "u"),
      recipientStorageKey("w", "main", "v"), recipientStorageKey("other", "main", "u")];
    expect(new Set(keys).size).toBe(4);
  });
  it("retains the selection on ordinary followups and ignores code/quoted handles", () => {
    expect(messageRecipients("Follow up", participants, "a").targets).toEqual(["a"]);
    expect(messageRecipients('`@beta` and "@beta"', participants, "a").targets).toEqual(["a"]);
    expect(messageRecipients("@beta switch", participants, "a").targets).toEqual(["b"]);
  });
  it("shows message-only broadcast and multiple overrides without changing the input selection", () => {
    expect(messageRecipients("@channel update", participants, "a").targets).toEqual(["@conversation"]);
    expect(messageRecipients("@alpha @beta update", participants, "a").targets).toEqual(["a", "b"]);
    expect(messageRecipients("Next followup", participants, "a").targets).toEqual(["a"]);
  });
  it("honors the latest explicit control or Reply choice over older body text", () => {
    expect(messageRecipients("@alpha old text", participants, "a", ["b"]).targets).toEqual(["b"]);
    expect(messageRecipients("@alpha old text", participants, "a", []).targets).toEqual([]);
    expect(messageRecipients("@missing", participants, "a").invalid).toEqual(["missing"]);
    expect(messageRecipients("@retired", participants, "a").invalid).toEqual(["retired"]);
  });
  it("does not offer a recipient picker inside code or quotes", () => {
    for (const body of ['"@be', "`@be", "> @be", "```ts\n@be"]) expect(mentionQueryAt(body, body.length)).toBeUndefined();
    expect(mentionQueryAt("@be", 3)?.value).toBe("be");
  });
  it("pins retry recipients and reply context instead of recalculating from later selection", () => {
    const submission = createMessageSubmission("human", "Question", participants, () => "key", [], ["a"], "message");
    expect(submissionMatchesDraft(submission, "human", "Question", participants, [], ["a"], "message")).toBe(true);
    expect(submissionMatchesDraft(submission, "human", "Question", participants, [], ["b"], "message")).toBe(false);
    expect(submissionMatchesDraft(submission, "human", "Question", participants, [], ["a"])).toBe(false);
  });
  it("persists an explicit no-recipient choice and draft overrides across reloads", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
    expect(readRecipient("user")).toBeUndefined();
    writeRecipient("user", ""); expect(readRecipient("user")).toBe("");
    writeRecipientOverride("draft", "@alpha old text", ["b"]);
    expect(readRecipientOverride("draft", "@alpha still old text")).toEqual(["b"]);
    expect(readRecipientOverride("draft", "@beta new intent")).toBeUndefined();
    writeRecipientOverride("draft", "", undefined);
    expect(readRecipientOverride("draft", "")).toBeUndefined();
  });
});
