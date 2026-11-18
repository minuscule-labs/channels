import assert from "node:assert/strict";
import test from "node:test";
import { createResourceId, isResourceId, RESOURCE_ID_PREFIXES } from "../src/ids.ts";

test("creates distinct typed UUIDv7 ids with Unix millisecond timestamps", (context) => {
  let now = Date.UTC(2040, 0, 1);
  context.mock.method(Date, "now", () => now);

  for (const prefix of RESOURCE_ID_PREFIXES) {
    const first = createResourceId(prefix);
    const second = createResourceId(prefix);
    const payload = first.slice(prefix.length + 1);
    assert.match(payload, /^[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$/);
    assert.equal(Number.parseInt(payload.slice(0, 12), 16), now);
    assert.equal(isResourceId(first, prefix), true);
    assert.equal(isResourceId(first), true);
    assert.notEqual(first, second);
  }

  const earlier = createResourceId("message");
  now += 1;
  const later = createResourceId("message");
  assert.ok(earlier < later);
  assert.equal(Number.parseInt(later.slice("message_".length, "message_".length + 12), 16), now);
});

test("accepts existing UUIDv4 ids alongside UUIDv7 ids without changing prefixes", () => {
  const payloads = ["550e8400e29b41d4a716446655440000", "01900000000070008000000000000001"];
  for (const payload of payloads) {
    for (const prefix of RESOURCE_ID_PREFIXES) {
      const id = `${prefix}_${payload}`;
      assert.equal(isResourceId(id, prefix), true);
      assert.equal(isResourceId(id), true);
    }
    assert.equal(isResourceId(`channel_${payload}`, "conversation"), true);
    assert.equal(isResourceId(`channel_${payload}`), true);
    assert.equal(isResourceId(`identity_${payload}`, "conversation"), false);
    assert.equal(isResourceId(`conversation_${payload}`, "identity"), false);
  }
});

test("rejects malformed resource ids and unknown prefixes", () => {
  for (const value of [
    undefined,
    null,
    123,
    "",
    "550e8400-e29b-41d4-a716-446655440000",
    "conversation_not-random",
    "conversation_01900000-0000-7000-8000-000000000001",
    "conversation_0190000000007000800000000000000",
    "conversation_019000000000700080000000000000011",
    "conversation_0190000000007000800000000000000g",
    "unknown_01900000000070008000000000000001",
  ]) {
    assert.equal(isResourceId(value), false);
  }
});
