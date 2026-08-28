import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./packages/relay-storage-drizzle/src/schema.ts",
  out: "./packages/relay-storage-drizzle/drizzle",
});
