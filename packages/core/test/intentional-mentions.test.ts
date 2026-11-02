import assert from "node:assert/strict";
import test from "node:test";
import { mentionHandles, recipientText, threadDefaultRecipient } from "../src/mentions.ts";
import { resolveMessageTargets } from "../src/conversation-service.ts";
import type { Participant } from "../src/types.ts";

const participants: Participant[] = [
  { id: "owner", type: "human", handle: "owner", status: "active" },
  { id: "alpha", type: "agent", handle: "alpha", status: "active" },
  { id: "beta", type: "agent", handle: "beta", status: "active" },
];

test("intentional mentions preserve complete handles and ignore email addresses", () => {
  assert.deepEqual(mentionHandles("@alpha, ask @beta and @alpha--. email@beta.example"), ["alpha", "beta", "alpha--"]);
});

for (const quoted of [
  "`@beta`", "`` @beta ` code ``", "```ts\n@beta\n```", "~~~\n@beta\n~~~",
  "> @beta\nlazy quote continuation @beta", "- > @beta", '"quote\n@beta"', '*"quoted @beta"*', "    @beta", "\t@beta", '"@beta"', "'@beta'", "“@beta”", "‘@beta’", "\\@beta",
]) {
  test(`non-addressing text is ignored: ${JSON.stringify(quoted)}`, () => {
    const body = `${quoted}\n\n@alpha actual recipient`;
    assert.deepEqual(mentionHandles(body), ["alpha"]);
    assert.equal(recipientText(body).length, body.length);
  });
}

test("structured recipients, including no recipient, override body references", () => {
  const input = { participantId: "owner", body: "@beta old text" };
  assert.deepEqual(resolveMessageTargets({ participants }, input), ["beta"]);
  assert.deepEqual(resolveMessageTargets({ participants }, { ...input, to: ["alpha"] }), ["alpha"]);
  assert.deepEqual(resolveMessageTargets({ participants }, { ...input, to: [] }), []);
});

test("generated agent content never becomes routing; explicit tool recipients remain explicit", () => {
  const input = { participantId: "alpha", body: "@beta @missing @channel generated" };
  assert.deepEqual(resolveMessageTargets({ participants }, input), []);
  assert.deepEqual(resolveMessageTargets({ participants }, { ...input, to: ["beta"] }), ["beta"]);
});

test("a root without thread metadata never invents an initial recipient", () => {
  assert.equal(threadDefaultRecipient({ participants }), undefined);
});
