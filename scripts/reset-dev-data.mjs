#!/usr/bin/env node
import { resetDevelopmentData } from "../packages/control/dist/src/dev-data.js";

try {
  const result = await resetDevelopmentData();
  console.log(result === "removed"
    ? "Removed persistent MinuChannels development data."
    : "Persistent MinuChannels development data is already clear.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Development data reset failed");
  process.exitCode = 1;
}
