import { createRequire } from "node:module";

// Real native work in a sacrificial process; never terminate libSQL inside the test host.
const require = createRequire(import.meta.resolve("@minu/channels-relay-storage-drizzle"));
const { createClient } = require("@libsql/client");
const client = createClient({ url: "file::memory:" });
const sql = `SELECT 1 WHERE 1 IN (${Array.from({ length: 1_000_000 }, (_, index) => index).join(",")})`;
let epoch = "";
let mode = "";
process.once("disconnect", () => process.exit(0));
process.on("message", async (message: any) => {
  if (message.type === "initialize") {
    epoch = message.epoch;
    mode = message.path;
    process.send!({ type: "ready", epoch, pid: process.pid });
  } else if (message.type === "put") {
    process.send!({ type: "native_started", epoch });
    if (mode === "crash") process.kill(process.pid, "SIGKILL");
    await client.execute(sql);
    process.send!({ type: "written", epoch, id: message.record.operationId, revision: message.record.revision });
  } else if (message.type === "close") {
    client.close();
    process.send!({ type: "closed", epoch }, () => process.disconnect());
  }
});
