import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { request, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ConversationService, ConversationValidationError } from "../src/conversation-service.ts";
import { createConversationHttpServer } from "../src/http-server.ts";

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

for (const multiplexed of [false, true]) {
  const route = multiplexed ? "multiplexed" : "single";
  for (const terminal of ["disconnect", "shutdown", "reject-after-disconnect"] as const) {
    test(`${route}: ${terminal} during subscription setup disposes late resources`, { timeout: 5_000 }, async (t) => {
      const service = new ConversationService();
      const conversation = await service.createConversation({ name: "lifecycle", participants: [{ id: "agent", type: "agent", displayName: "Agent" }] });
      const entered = deferred();
      const release = deferred();
      const settled = deferred();
      let active = 0;
      let unsubscribed = 0;
      let callback: Parameters<ConversationService["subscribeMany"]>[1] | undefined;
      const subscribeMany = service.subscribeMany.bind(service);
      t.mock.method(service, "subscribeMany", async (...args: Parameters<typeof service.subscribeMany>) => {
        callback = args[1];
        const unsubscribe = await subscribeMany(...args);
        active += 1;
        entered.resolve();
        await release.promise;
        if (terminal === "reject-after-disconnect") {
          unsubscribe();
          active -= 1;
          settled.resolve();
          throw new ConversationValidationError("setup failed");
        }
        settled.resolve();
        return () => { unsubscribed += 1; active -= 1; unsubscribe(); };
      });
      // This file runs in its own Node test process; only this fixture creates intervals.
      const intervals = new Set<ReturnType<typeof setInterval>>();
      const realSetInterval = globalThis.setInterval;
      const realClearInterval = globalThis.clearInterval;
      let created = 0;
      t.mock.method(globalThis, "setInterval", (...args: Parameters<typeof setInterval>) => {
        const timer = realSetInterval(...args);
        intervals.add(timer);
        created += 1;
        return timer;
      });
      t.mock.method(globalThis, "clearInterval", (timer: ReturnType<typeof setInterval>) => {
        intervals.delete(timer);
        realClearInterval(timer);
      });
      const server = await createConversationHttpServer({ service });
      const requests = channel("http.server.request.start");
      const peerClosed = deferred();
      let peerResponse: ServerResponse | undefined;
      const observe = (message: unknown) => {
        const { request, response } = message as { request: IncomingMessage; response: ServerResponse };
        if (request.socket.localPort !== Number(new URL(server.endpoint).port)) return;
        peerResponse = response;
        response.once("close", () => peerClosed.resolve());
      };
      requests.subscribe(observe);
      const path = multiplexed ? `/conversations/events?conversationId=${conversation.id}` : `/conversations/${conversation.id}/events`;
      const client = request(`${server.endpoint}${path}`, {
        agent: false, headers: { authorization: `Bearer ${server.serviceToken}` },
      });
      client.on("error", () => {});
      client.end();
      let shutdown = false;
      try {
        await withinDeadline(entered.promise);
        if (terminal === "shutdown") {
          await server.close();
          shutdown = true;
        } else {
          const closed = new Promise<void>((resolve) => client.once("close", resolve));
          client.destroy();
          await closed;
        }
        // Client close is not a server-side close barrier; wait for the peer too.
        await withinDeadline(peerClosed.promise);
        // Even while setup is paused, a late service event must not write/enqueue after closure.
        callback?.({ id: "late", type: "conversation.updated", conversationId: conversation.id, createdAt: new Date().toISOString() });
        release.resolve();
        await withinDeadline(settled.promise);
        await until(() => active === 0);
        assert.equal(unsubscribed, terminal === "reject-after-disconnect" ? 0 : 1);
        assert.equal(created, 0, "must not create a heartbeat after disconnect/shutdown");
        assert.equal(intervals.size, 0);
        assert.equal(peerResponse?.headersSent, false, "must not write readiness or errors after closure");
      } finally {
        requests.unsubscribe(observe);
        release.resolve();
        client.destroy();
        if (!shutdown) await server.close();
        for (const timer of intervals) realClearInterval(timer);
      }
    });
  }

  test(`${route}: connected setup rejection preserves validation errors`, { timeout: 5_000 }, async (t) => {
    const service = new ConversationService();
    const conversation = await service.createConversation({
      name: "rejection", participants: [{ id: "agent", type: "agent", displayName: "Agent" }],
    });
    t.mock.method(service, "subscribeMany", async () => { throw new ConversationValidationError("invalid subscription"); });
    const server = await createConversationHttpServer({ service });
    try {
      const path = multiplexed ? `/conversations/events?conversationId=${conversation.id}` : `/conversations/${conversation.id}/events`;
      const response = await fetch(`${server.endpoint}${path}`, { headers: { authorization: `Bearer ${server.serviceToken}` } });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: "invalid subscription" });
    } finally {
      await server.close();
    }
  });

  test(`${route}: ready stream cleanup is exactly once on disconnect, response error and shutdown`, { timeout: 5_000 }, async (t) => {
    const service = new ConversationService();
    const conversation = await service.createConversation({ name: "lifecycle", participants: [{ id: "agent", type: "agent", displayName: "Agent" }] });
    let active = 0;
    let released = 0;
    const subscribeMany = service.subscribeMany.bind(service);
    t.mock.method(service, "subscribeMany", async (...args: Parameters<typeof service.subscribeMany>) => {
      const unsubscribe = await subscribeMany(...args);
      active += 1;
      return () => { active -= 1; released += 1; unsubscribe(); };
    });
    const timers = new Set<ReturnType<typeof setInterval>>();
    const realSet = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    t.mock.method(globalThis, "setInterval", (...args: Parameters<typeof setInterval>) => {
      const timer = realSet(...args);
      timers.add(timer);
      return timer;
    });
    t.mock.method(globalThis, "clearInterval", (timer: ReturnType<typeof setInterval>) => {
      timers.delete(timer);
      realClear(timer);
    });
    const server = await createConversationHttpServer({ service, heartbeatIntervalMs: 10 });
    const requests = channel("http.server.request.start");
    let peerResponse: ServerResponse | undefined;
    const observe = (message: unknown) => {
      const { request, response } = message as { request: IncomingMessage; response: ServerResponse };
      if (request.socket.localPort === Number(new URL(server.endpoint).port)) peerResponse = response;
    };
    requests.subscribe(observe);
    const clients: ReturnType<typeof request>[] = [];
    let closed = false;
    try {
      for (const terminal of ["disconnect", "error", "shutdown"]) {
        const ready = deferred<IncomingMessage>();
        const client = request(`${server.endpoint}${multiplexed ? `/conversations/events?conversationId=${conversation.id}` : `/conversations/${conversation.id}/events`}`, {
          agent: false, headers: { authorization: `Bearer ${server.serviceToken}` },
        }, (response) => {
          response.on("error", () => {});
          response.once("data", () => ready.resolve(response));
          response.resume();
        });
        clients.push(client);
        client.on("error", () => {});
        client.end();
        const response = await withinDeadline(ready.promise);
        assert.equal(active, 1);
        assert.equal(timers.size, 1);
        if (terminal === "shutdown") {
          await server.close();
          closed = true;
        } else if (terminal === "error") {
          peerResponse!.emit("error", new Error("fixture response failure"));
        } else {
          response.destroy();
          client.destroy();
        }
        await until(() => active === 0 && timers.size === 0);
      }
      assert.equal(released, 3);
    } finally {
      requests.unsubscribe(observe);
      for (const client of clients) client.destroy();
      if (!closed) await server.close();
      for (const timer of timers) realClear(timer);
    }
  });
}

test("multiplexed setup buffers live events until readiness and preserves order", { timeout: 5_000 }, async (t) => {
  const service = new ConversationService();
  const conversation = await service.createConversation({ name: "ordering", participants: [{ id: "agent", type: "agent", displayName: "Agent" }] });
  const subscribe = service.subscribeMany.bind(service);
  t.mock.method(service, "subscribeMany", async (...args: Parameters<typeof service.subscribeMany>) => {
    const unsubscribe = await subscribe(...args);
    args[1]({ id: "setup-event", type: "conversation.updated", conversationId: conversation.id, createdAt: new Date().toISOString() });
    return unsubscribe;
  });
  const server = await createConversationHttpServer({ service });
  const controller = new AbortController();
  try {
    const response = await fetch(`${server.endpoint}/conversations/events?conversationId=${conversation.id}`, {
      headers: { authorization: `Bearer ${server.serviceToken}` }, signal: controller.signal,
    });
    const reader = response.body!.getReader();
    let text = "";
    while (!text.includes("setup-event")) text += new TextDecoder().decode((await withinDeadline(reader.read())).value);
    assert.ok(text.indexOf("event: ready") < text.indexOf("setup-event"));
    await reader.cancel();
  } finally {
    controller.abort();
    await server.close();
  }
});
