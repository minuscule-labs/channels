import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import test from "node:test";
import { createV006RelayDatabase } from "./v006-fixture.ts";

test("v0.0.6 fixture creates the pre-Conversation Relay schema", async () => {
  const fixture = await createV006RelayDatabase();
  try {
    const client = createClient({ url: fixture.url });
    try {
      const tables = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('channel_agent_bindings', 'conversation_agent_bindings')");
      assert.deepEqual(tables.rows.map(({ name }) => name), ["channel_agent_bindings"]);
      const migrations = await client.execute("SELECT count(*) AS count FROM __drizzle_migrations");
      assert.equal(migrations.rows[0]?.count, 8);
    } finally {
      client.close();
    }
  } finally {
    await fixture.close();
  }
});
