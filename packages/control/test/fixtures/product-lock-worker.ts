import {
  acquireConversationsDataDirectoryLock,
  prepareConversationsDataDirectory,
  type ProductDirectoryLock,
} from "../../src/local-paths.ts";

const directory = process.argv[2]!;
await prepareConversationsDataDirectory(directory);
let lock: ProductDirectoryLock | undefined;
process.on("message", async (message) => {
  try {
    if (message === "acquire") {
      lock = await acquireConversationsDataDirectoryLock(directory);
      process.send!({ type: "held" });
    } else if (message === "release") {
      await lock?.release();
      lock = undefined;
      process.send!({ type: "released" });
    }
  } catch (error) {
    process.send!({ type: "rejected", message: (error as Error).message });
  }
});
process.send!({ type: "ready" });
