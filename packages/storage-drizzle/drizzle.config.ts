import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./packages/storage-drizzle/src/schema.ts",
  out: "./packages/storage-drizzle/drizzle",
});
