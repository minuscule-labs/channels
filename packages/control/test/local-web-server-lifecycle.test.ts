import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { Agent, createServer, request, type ClientRequest, type IncomingMessage, type RequestListener, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ConversationService, createConversationHttpServer } from "@minu/channels-core";
import { createLocalWebServer } from "../src/local-web-server.ts";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function withinDeadline<T>(promise: Promise<T>): Promise<T> {
  const controller = new AbortController();
  try {
    return await Promise.race([
      promise,
      delay(2_000, undefined, { signal: controller.signal }).then(() => { throw new Error("fixture event exceeded two seconds"); }),
    ]);
  } finally {
    controller.abort();
  }
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "resource cleanup exceeded two seconds");
    await delay(5);
  }
}

async function webFixture(endpoint: string, serviceToken = "test") {
  const directory = await mkdtemp(join(tmpdir(), "channels-proxy-lifecycle-"));
  await writeFile(join(directory, "index.html"), "<main>test</main>");
  const web = await createLocalWebServer({
    conversationsEndpoint: endpoint, controlEndpoint: endpoint, webDirectory: directory,
    port: 0, conversationsServiceToken: serviceToken,
    authenticateBrowser: () => ({ identityId: "agent" }),
  });
  return { ...web, async cleanup() { await web.close(); await rm(directory, { recursive: true, force: true }); } };
}

async function backendFixture(handler: RequestListener) {
  const sockets = new Set<Socket>();
  const server = createServer(handler);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    sockets,
    async close() {
      const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await closed;
    },
  };
}

function connect(url: string) {
  const ready = deferred<IncomingMessage>();
  const closed = deferred();
  const client = request(url, { agent: false }, (response) => {
    response.on("error", () => {});
    response.once("data", () => ready.resolve(response));
    response.once("close", () => closed.resolve());
    response.resume();
  });
  client.on("error", () => {});
  client.end();
  return { client, ready: ready.promise, closed: closed.promise };
}

for (const multiplexed of [false, true]) {
  test(`real proxy releases ${multiplexed ? "multiplexed" : "single"} SSE over 100 cycles and web-only shutdown`, { timeout: 15_000 }, async (t) => {
    const service = new ConversationService();
    const conversation = await service.createConversation({
      name: "proxy lifecycle", participants: [{ id: "agent", type: "agent", displayName: "Agent" }],
    });
    let active = 0;
    const sockets = new Set<Socket>();
    const subscribe = service.subscribeMany.bind(service);
    t.mock.method(service, "subscribeMany", async (...args: Parameters<typeof service.subscribeMany>) => {
      const unsubscribe = await subscribe(...args);
      active += 1;
      return () => { active -= 1; unsubscribe(); };
    });
    const backend = await createConversationHttpServer({ service, heartbeatIntervalMs: 10 });
    const web = await webFixture(backend.endpoint, backend.serviceToken);
    const path = multiplexed ? `/conversations/events?conversationId=${conversation.id}` : `/conversations/${conversation.id}/events`;
    const requests = channel("http.server.request.start");
    const observe = (message: unknown) => {
      const { request } = message as { request: IncomingMessage };
      if (request.socket.localPort !== Number(new URL(backend.endpoint).port)) return;
      const socket = request.socket;
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    };
    requests.subscribe(observe);
    const clients: ReturnType<typeof connect>[] = [];
    try {
      for (let cycle = 0; cycle < 101; cycle += 1) {
        const stream = connect(`${web.endpoint}${path}`);
        clients.push(stream);
        const response = await withinDeadline(stream.ready);
        assert.equal(active, 1);
        if (cycle === 100) await web.close();
        else { response.destroy(); stream.client.destroy(); }
        await until(() => active === 0 && sockets.size === 0);
      }
      assert.equal(active, 0);
    } finally {
      requests.unsubscribe(observe);
      for (const stream of clients) stream.client.destroy();
      await web.cleanup();
      await backend.close();
    }
  });
}

test("proxy propagates cancellation before headers and during upload", { timeout: 8_000 }, async () => {
  for (const upload of [false, true]) {
    const entered = deferred<{ request: IncomingMessage; response: ServerResponse }>();
    const backend = await backendFixture((request, response) => {
      request.on("error", () => {});
      request.resume();
      entered.resolve({ request, response });
    });
    const web = await webFixture(backend.endpoint);
    const client = request(`${web.endpoint}/conversations/delayed`, {
      method: upload ? "POST" : "GET", agent: false,
      headers: upload ? { "content-length": "100000" } : {},
    });
    client.on("error", () => {});
    if (upload) client.write("partial upload");
    else client.end();
    try {
      const incoming = await withinDeadline(entered.promise);
      client.destroy();
      await until(() => backend.sockets.size === 0);
      // Resolve delayed work after cancellation; there must be no live upstream exchange.
      incoming.response.end("late response");
      assert.equal(incoming.response.destroyed, true);
    } finally {
      client.destroy();
      await web.cleanup();
      await backend.close();
    }
  }
});

test("proxy terminates downstream on premature upstream response closure but preserves normal SSE end", { timeout: 8_000 }, async () => {
  for (const abrupt of [true, false]) {
    const upstream = deferred<ServerResponse>();
    const backend = await backendFixture((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("event: ready\ndata: {}\n\n");
      upstream.resolve(response);
    });
    const web = await webFixture(backend.endpoint);
    const stream = connect(`${web.endpoint}/conversations/events`);
    try {
      const response = await withinDeadline(stream.ready);
      const finished = deferred();
      response.once("end", () => finished.resolve());
      const source = await withinDeadline(upstream.promise);
      if (abrupt) source.destroy();
      else source.end();
      await withinDeadline(stream.closed);
      if (abrupt) assert.equal(response.complete, false);
      else { await withinDeadline(finished.promise); assert.equal(response.complete, true); }
    } finally {
      stream.client.destroy();
      await web.cleanup();
      await backend.close();
    }
  }
});

test("proxy cancellation disposes a fully parsed but unread response under backpressure", { timeout: 8_000 }, async () => {
  const source = deferred<ServerResponse>();
  const paused = deferred<IncomingMessage>();
  const backend = await backendFixture((_request, response) => {
    response.writeHead(200, { "content-type": "application/octet-stream" });
    // Fill the corked downstream writable buffer, then finish only after pipe pauses.
    response.write(Buffer.alloc(64 * 1024));
    source.resolve(response);
  });
  const web = await webFixture(backend.endpoint);
  const agent = new Agent({ keepAlive: true });
  const serverRequests = channel("http.server.request.start");
  const clientRequests = channel("http.client.request.start");
  let upstreamResponse: IncomingMessage | undefined;
  let downstreamResponse: ServerResponse | undefined;
  const observeServer = (message: unknown) => {
    const { request, response } = message as { request: IncomingMessage; response: ServerResponse };
    if (request.socket.localPort !== Number(new URL(web.endpoint).port)) return;
    downstreamResponse = response;
    // Fixture-only corking creates actual writable backpressure without relying on
    // platform-specific TCP receive-window sizes or a payload-size search.
    request.socket.cork();
  };
  const observeClient = (message: unknown) => {
    const { request } = message as { request: ClientRequest };
    if (request.getHeader("host") !== new URL(backend.endpoint).host) return;
    request.once("response", (response) => {
      upstreamResponse = response;
      response.once("pause", () => paused.resolve(response));
    });
  };
  serverRequests.subscribe(observeServer);
  clientRequests.subscribe(observeClient);
  const client = request(`${web.endpoint}/conversations/backpressure`, { agent });
  client.on("error", () => {});
  client.end();
  try {
    const response = await withinDeadline(paused.promise);
    const backendResponse = await withinDeadline(source.promise);
    backendResponse.end(Buffer.alloc(1001));
    await until(() => response.complete);
    assert.equal(response.readableEnded, false);
    assert.ok(response.readableLength > 0, "the fully parsed response must still contain unread bytes");
    assert.equal(backend.sockets.size, 1);
    client.destroy();
    await until(() => response.destroyed && backend.sockets.size === 0);
  } finally {
    serverRequests.unsubscribe(observeServer);
    clientRequests.unsubscribe(observeClient);
    client.destroy();
    agent.destroy();
    downstreamResponse?.destroy();
    upstreamResponse?.destroy();
    await web.cleanup();
    await backend.close();
  }
});

test("proxy preserves bodies, delayed/chunked/binary responses, HEAD and upstream keep-alive reuse", { timeout: 8_000 }, async () => {
  const seenSockets = new Set<Socket>();
  const payload = Buffer.from([0, 255, 128, 13, 10, 1]);
  const backend = await backendFixture((request, response) => {
    seenSockets.add(request.socket);
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      // IncomingMessage's ordinary close occurs before this delayed response.
      setImmediate(() => {
        if (request.url === "/conversations/json") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ method: request.method, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null }));
          return;
        }
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.write(payload.subarray(0, 2));
        setImmediate(() => response.end(Buffer.concat([payload.subarray(2), ...chunks])));
      });
    });
  });
  const web = await webFixture(backend.endpoint);
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  try {
    for (const method of ["GET", "POST", "GET", "HEAD"]) {
      const result = await new Promise<Buffer>((resolve, reject) => {
        const client = request(`${web.endpoint}/conversations/finite`, { method, agent }, (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("error", reject);
          response.on("end", () => resolve(Buffer.concat(chunks)));
        });
        client.on("error", reject);
        client.end(method === "POST" ? "request-body" : undefined);
      });
      assert.deepEqual(result, method === "HEAD" ? Buffer.alloc(0) : Buffer.concat([payload, ...(method === "POST" ? [Buffer.from("request-body")] : [])]));
    }
    assert.equal(seenSockets.size, 1, "finite responses must reuse the upstream socket");
    for (const method of ["GET", "POST"]) {
      const response = await fetch(`${web.endpoint}/conversations/json`, {
        method, ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ hello: "world" }) } : {}),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { method, body: method === "POST" ? { hello: "world" } : null });
    }
  } finally {
    agent.destroy();
    await web.cleanup();
    await backend.close();
  }
});

test("proxy preserves generic 502 and safely handles failure after browser cancellation", { timeout: 5_000 }, async () => {
  const backend = await backendFixture((_request, response) => response.end());
  const endpoint = backend.endpoint;
  await backend.close();
  const web = await webFixture(endpoint);
  try {
    const response = await fetch(`${web.endpoint}/conversations`);
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "Local product service unavailable" });
    const client = request(`${web.endpoint}/conversations`, { agent: false });
    client.on("error", () => {});
    client.end();
    client.destroy();
  } finally {
    await web.cleanup();
  }
});
