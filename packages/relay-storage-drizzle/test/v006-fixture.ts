import { createClient } from "@libsql/client";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { defaultRelayMigrationsFolder, localRelayLibSqlUrl } from "../src/storage.ts";

const V006_LAST_MIGRATION_INDEX = 7;

/** Creates a real v0.0.6 private Relay database without loading current storage code. */
export async function createV006RelayDatabase(): Promise<{
  directory: string;
  databasePath: string;
  url: string;
  close(): Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "minu-relay-v006-"));
  const migrationsFolder = join(directory, "v0.0.6-migrations");
  const databasePath = join(directory, "relay.db");
  try {
    await cp(defaultRelayMigrationsFolder(), migrationsFolder, { recursive: true });
    const journalPath = join(migrationsFolder, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: Array<{ idx: number }> };
    journal.entries = journal.entries.filter(({ idx }) => idx <= V006_LAST_MIGRATION_INDEX);
    await writeFile(journalPath, JSON.stringify(journal));

    const migrations = readMigrationFiles({ migrationsFolder });
    const client = createClient({ url: localRelayLibSqlUrl(databasePath) });
    try {
      for (const migration of migrations) {
        for (const statement of migration.sql) await client.execute(statement);
      }
      await client.execute("CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC)");
      for (const migration of migrations) {
        await client.execute({ sql: "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)", args: [migration.hash, migration.folderMillis] });
      }
    } finally {
      client.close();
    }
    return { directory, databasePath, url: localRelayLibSqlUrl(databasePath), close: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
