import assert from "node:assert/strict";
import test from "node:test";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { safeSessionIntegrations } from "../src/agent-session-integrations.ts";

const pinned = process.env.PI_INTEGRATIONS_TEST_COMMAND;
const root = pinned ? join(dirname(pinned), "node_modules/@earendil-works/pi-coding-agent") : "";

test("packaged native registration failures survive cleanup without masking later disconnects", { skip: !pinned }, async () => {
  const { McpServerConnection, McpOAuthCredentialStore } = await import(pathToFileURL(join(root, "dist/extensions/mcp/runtime.js")).href);
  const { InMemoryAuthStorageBackend } = await import(pathToFileURL(join(root, "dist/core/auth-storage.js")).href);
  const { createInMemoryTransportPair } = await import(pathToFileURL(join(root, "../pi-mcp/dist/testing/index.js")).href);
  const servers: Array<{ close(): Promise<void> }> = [];
  let fail = true;
  const connection = new McpServerConnection({
    entry: { name: "registration", config: { command: "unused" }, source: "fixture" }, cwd: process.cwd(),
    credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
    createTransport: () => {
      const pair = createInMemoryTransportPair(); servers.push(pair.server);
      pair.server.onMessage((message: { id?: string | number; method?: string; params?: { protocolVersion?: string } }) => {
        if (message.id === undefined || !message.method) return;
        const result = message.method === "initialize" ? { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } : { tools: [] };
        queueMicrotask(() => { void pair.server.send({ jsonrpc: "2.0", id: message.id, result }); });
      });
      void pair.server.start(); return pair.client;
    },
    onTools: () => { if (fail) throw new Error("Controlled registration failure"); },
  });
  try {
    await assert.rejects(connection.getClient(), /Controlled registration failure/);
    assert.equal(connection.state, "failed"); assert.equal(connection.issue, "registration_failed");
    fail = false; await connection.getClient(); assert.equal(connection.issue, undefined);
    await servers.at(-1)!.close();
    for (let i = 0; connection.state !== "disconnected" && i < 20; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(connection.issue, "connection_failed");
  } finally { await connection.close(); await Promise.all(servers.map(server => server.close())); }
});

test("packaged native truncation and failure attribution survive Runtime and Channels boundaries", { skip: !pinned }, async () => {
  const { readSessionIntegrations } = await import(pathToFileURL(join(root, "dist/index.js")).href);
  const { projectPiIntegrations } = await import(new URL("../../../../../runtime/packages/pi/dist/src/session-integrations.js", import.meta.url).href);
  const notes = { id: "mcp.notes", name: "notes", kind: "mcp", source: "extension", enabled: true, connection: "connected", offeredCount: 1, toolCoverage: "complete" };
  const noteTool = { name: "mcp__notes__read", exposure: "direct", declared: true, callable: true };
  const owner = { name: noteTool.name, integrationId: notes.id };
  const prefix = Array.from({ length: 512 }, (_, i) => ({ ...noteTool, name: `native_${i}` }));
  for (const mode of ["registry", "owners"] as const) {
    const evidence = { configuration: "complete", integrations: [notes], owners: mode === "owners" ? [...prefix.map(tool => ({ name: tool.name, integrationId: notes.id })), owner] : [owner], issues: [] };
    const native = readSessionIntegrations([evidence], mode === "registry" ? [...prefix, noteTool] : [noteTool]);
    const normalized = projectPiIntegrations(native);
    const channels = safeSessionIntegrations(normalized)!;
    for (const value of [native, normalized, channels]) {
      assert.equal(value.integrations[0].offeredCount, 1);
      for (const key of ["registeredCount", "callableCount", "reachableCount"]) assert.equal(value.integrations[0][key], undefined, `${mode}/${key}`);
    }
  }
  const native = readSessionIntegrations([{ configuration: "complete", integrations: [
    { ...notes, offeredCount: 0, connection: "failed", failureCode: "registration_failed" },
    { ...notes, id: "mcp.discovery", name: "discovery", connection: "failed", failureCode: "discovery_failed" },
  ], owners: [], issues: ["configuration_invalid"] }], []);
  const normalized = projectPiIntegrations(native), channels = safeSessionIntegrations(normalized)!;
  for (const value of [native, normalized, channels]) {
    assert.equal(value.integrations[0].registeredCount, 0);
    assert.equal(value.integrations[0].callableCount, 0);
    assert.deepEqual(value.integrations.map((entry: { id: string; failureCode: string }) => [entry.id, entry.failureCode]), [["mcp.notes", "registration_failed"], ["mcp.discovery", "discovery_failed"]]);
    assert.deepEqual(value.issues, ["configuration_invalid"]);
  }
});
