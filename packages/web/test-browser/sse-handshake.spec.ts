import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

test("topic changes during an SSE handshake do not retain abandoned backend subscriptions", async ({ page }) => {
  const subscriptions = new Set<object>();
  const server = createServer(async (request, response) => {
    if (!request.url?.startsWith("/conversations/events?")) {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>SSE handshake regression</title>");
      return;
    }
    const subscription = {};
    subscriptions.add(subscription);
    response.once("close", () => subscriptions.delete(subscription));
    // Exercise the real interval between acquiring a subscription and SSE readiness.
    await new Promise(resolve => setTimeout(resolve, 5));
    if (response.destroyed) return;
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    response.write("event: ready\ndata: {}\n\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    // Run the actual hub and client in Chromium, not a mock transport or copied hub.
    const { outputFiles } = await build({
      stdin: {
        contents: 'export { ConversationEventHub } from "./packages/web/src/lib/conversation-event-hub"; export { ConversationClient } from "./packages/core/src/client";',
        resolveDir: resolve(import.meta.dirname, "../../.."), loader: "ts",
      },
      bundle: true, write: false, platform: "browser", format: "esm", target: "es2022",
    });
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(outputFiles[0]!.contents).toString("base64")}`;
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    const earlyAborts = await page.evaluate(async (url) => {
      const { ConversationEventHub, ConversationClient } = await import(url);
      const client = new ConversationClient("");
      const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
      let earlyAborts = 0;
      for (let index = 0; index < 20; index++) {
        const hub = new ConversationEventHub((ids: string[], options: { signal: AbortSignal; onReady(): void }) => {
          let ready = false;
          options.signal.addEventListener("abort", () => { if (!ready) earlyAborts++; }, { once: true });
          return client.eventsMany(ids, { ...options, onReady: () => { ready = true; options.onReady(); } });
        });
        const channel = {}, thread = {};
        let ready!: () => void;
        const established = new Promise<void>(resolve => { ready = resolve; });
        try {
          hub.subscribe(channel, ["channel"], () => undefined);
          await pause(index % 10);
          hub.subscribe(thread, ["thread"], (message: { type: string }) => {
            if (message.type === "ready") ready();
          });
          await established;
        } finally {
          hub.unsubscribe(channel);
          hub.unsubscribe(thread);
        }
      }
      return earlyAborts;
    }, moduleUrl);
    expect(earlyAborts).toBe(0);
    await expect.poll(() => subscriptions.size, { timeout: 2_000 }).toBe(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
