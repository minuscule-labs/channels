import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import test from "node:test";
import { createV006ChannelsDatabase } from "./v006-fixture.ts";

test("v0.0.6 fixture creates the pre-Conversation collaboration schema", async () => {
  const fixture = await createV006ChannelsDatabase();
  try {
    const client = createClient({ url: fixture.url });
    try {
      const tables = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('channels', 'conversations')");
      assert.deepEqual(tables.rows.map(({ name }) => name), ["channels"]);
      const migrations = await client.execute("SELECT count(*) AS count FROM __drizzle_migrations");
      assert.equal(migrations.rows[0]?.count, 7);
    } finally {
      client.close();
    }
  } finally {
    await fixture.close();
  }
});
