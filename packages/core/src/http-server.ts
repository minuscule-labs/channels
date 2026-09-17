import { timingSafeEqual, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ConversationConflictError,
  ConversationNotFoundError,
  ConversationService,
  ConversationValidationError,
} from "./conversation-service.ts";
import type {
  AddWorkspaceMemberInput,
  ConversationEvent,
  CreateConversationInput,
  CreateIdentityInput,
  CreateMessageInput,
  CreateResponseInput,
  CreateWorkspaceInput,
  UpdateConversationInput,
  UpdateConversationLifecycleInput,
  UpdateConversationParticipantsInput,
  UpdateIdentityInput,
  UpdateWorkspaceInput,
  UpdateWorkspaceMemberInput,
} from "./types.ts";

const MAX_REQUEST_BYTES = 1024 * 1024;

export interface ConversationHttpServerOptions {
  service?: ConversationService;
  host?: string;
  port?: number;
  heartbeatIntervalMs?: number;
  /** Private credential required by direct collaboration clients. Generated when omitted. */
  serviceToken?: string;
}

export interface ConversationHttpServer {
  endpoint: string;
  service: ConversationService;
  serviceToken: string;
  close(): Promise<void>;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    throw new ConversationValidationError("Content-Type must be application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) throw new ConversationValidationError("request exceeds 1 MiB");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ConversationValidationError("request body must be valid JSON");
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body)}\n`);
}

function sendEvent(response: ServerResponse, event: ConversationEvent): void {
  response.write(`id: ${event.id}\n`);
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function authorized(request: IncomingMessage, token: string): boolean {
  const value = request.headers.authorization;
  if (typeof value !== "string" || !value.startsWith("Bearer ")) return false;
  const candidate = Buffer.from(value.slice(7));
  const expected = Buffer.from(token);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function loopbackHost(request: IncomingMessage): boolean {
  try {
    const hostname = new URL(`http://${request.headers.host ?? ""}`).hostname;
    return hostname === "minu-channels.localhost" || hostname === "127.0.0.1"
      || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
  } catch { return false; }
}

function authenticatedActor(request: IncomingMessage): string | undefined {
  const value = request.headers["x-minu-actor-id"];
  if (Array.isArray(value)) throw new ConversationValidationError("actor identity must be a single header value");
  return value;
}

function requireActor(input: Record<string, unknown>, actor: string | undefined, field: string): void {
  if (actor !== undefined && input[field] !== actor) {
    throw new ConversationValidationError(`${field} must match the authenticated browser identity`);
  }
}

export async function createConversationHttpServer(
  options: ConversationHttpServerOptions = {},
): Promise<ConversationHttpServer> {
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
  if (!Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 1) {
    throw new RangeError("heartbeatIntervalMs must be a positive integer");
  }
  const service = options.service ?? new ConversationService();
  const serviceToken = options.serviceToken ?? randomBytes(32).toString("base64url");
  const streams = new Set<ServerResponse>();

  const server = createServer(async (request, response) => {
    try {
      if (!loopbackHost(request)) {
        json(response, 403, { error: "Forbidden host" });
        return;
      }
      if (request.headers.origin !== undefined) {
        json(response, 403, { error: "Direct browser origins are forbidden" });
        return;
      }
      if (!authorized(request, serviceToken)) {
        json(response, 401, { error: "Unauthorized" });
        return;
      }
      const actor = authenticatedActor(request);
      const url = new URL(request.url ?? "/", "http://conversations.local");

      if (url.pathname === "/identities" && request.method === "POST") {
        const identity = await service.createIdentity((await readJson(request)) as CreateIdentityInput);
        json(response, 201, { identity });
        return;
      }
      if (url.pathname === "/identities" && request.method === "GET") {
        json(response, 200, { identities: await service.listIdentities() });
        return;
      }
      const identityMatch = url.pathname.match(/^\/identities\/([^/]+)$/);
      if (identityMatch && request.method === "GET") {
        json(response, 200, { identity: await service.getIdentity(identityMatch[1]!) });
        return;
      }
      if (identityMatch && request.method === "PATCH") {
        const input = (await readJson(request)) as UpdateIdentityInput;
        requireActor(input as unknown as Record<string, unknown>, actor, "actorIdentityId");
        json(response, 200, { identity: await service.updateIdentity(
          identityMatch[1]!,
          input,
        ) });
        return;
      }

      if (url.pathname === "/workspaces" && request.method === "POST") {
        const workspace = await service.createWorkspace((await readJson(request)) as CreateWorkspaceInput);
        json(response, 201, { workspace });
        return;
      }
      if (url.pathname === "/workspaces" && request.method === "GET") {
        json(response, 200, { workspaces: await service.listWorkspaces() });
        return;
      }
      const workspaceMatch = url.pathname.match(/^\/workspaces\/([^/]+)$/);
      if (workspaceMatch && request.method === "GET") {
        json(response, 200, { workspace: await service.getWorkspace(workspaceMatch[1]!) });
        return;
      }
      if (workspaceMatch && request.method === "PATCH") {
        const input = (await readJson(request)) as UpdateWorkspaceInput;
        requireActor(input as unknown as Record<string, unknown>, actor, "actorIdentityId");
        json(response, 200, { workspace: await service.updateWorkspace(
          workspaceMatch[1]!,
          input,
        ) });
        return;
      }
      const workspaceMembersMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/members$/);
      if (workspaceMembersMatch && request.method === "POST") {
        const member = await service.addWorkspaceMember(
          workspaceMembersMatch[1]!,
          (await readJson(request)) as AddWorkspaceMemberInput,
        );
        json(response, 201, { member });
        return;
      }
      if (workspaceMembersMatch && request.method === "GET") {
        json(response, 200, { members: await service.listWorkspaceMembers(workspaceMembersMatch[1]!) });
        return;
      }
      const workspaceMemberMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/members\/([^/]+)$/);
      if (workspaceMemberMatch && request.method === "PATCH") {
        const input = (await readJson(request)) as UpdateWorkspaceMemberInput;
        requireActor(input as unknown as Record<string, unknown>, actor, "actorIdentityId");
        const member = await service.updateWorkspaceMember(
          workspaceMemberMatch[1]!,
          workspaceMemberMatch[2]!,
          input,
        );
        json(response, 200, { member });
        return;
      }
      const workspaceConversationsMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/conversations$/);
      if (workspaceConversationsMatch && request.method === "POST") {
        const input = (await readJson(request)) as CreateConversationInput;
        if (actor !== undefined && input.actorIdentityId !== undefined && input.actorIdentityId !== actor) {
          throw new ConversationValidationError("actorIdentityId must match the authenticated browser identity");
        }
        const conversation = await service.createConversation({
          ...input,
          workspaceId: workspaceConversationsMatch[1]!,
          ...(actor === undefined ? {} : { actorIdentityId: actor }),
        });
        json(response, 201, { conversation });
        return;
      }
      if (workspaceConversationsMatch && request.method === "GET") {
        json(response, 200, { conversations: await service.listWorkspaceConversations(workspaceConversationsMatch[1]!) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/conversations") {
        const input = (await readJson(request)) as CreateConversationInput;
        if (actor !== undefined && input.actorIdentityId !== undefined && input.actorIdentityId !== actor) {
          throw new ConversationValidationError("actorIdentityId must match the authenticated browser identity");
        }
        const conversation = await service.createConversation(actor === undefined ? input : { ...input, actorIdentityId: actor });
        json(response, 201, { conversation });
        return;
      }

      if (url.pathname === "/conversations/events" && request.method === "GET") {
        const conversationIds = [...new Set(url.searchParams.getAll("conversationId"))];
        if (conversationIds.length === 0 || conversationIds.length > 100 || conversationIds.some((conversationId) => !conversationId)) {
          throw new ConversationValidationError("conversationId must identify between 1 and 100 Conversations");
        }
        const pending: ConversationEvent[] = [];
        let ready = false;
        const unsubscribe = await service.subscribeMany(conversationIds, (event) => {
          if (ready) sendEvent(response, event);
          else pending.push(event);
        });
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        streams.add(response);
        response.write(`event: ready\ndata: ${JSON.stringify({ conversationIds })}\n\n`);
        ready = true;
        for (const event of pending) sendEvent(response, event);
        const heartbeat = setInterval(
          () => response.write(": keepalive\n\n"),
          heartbeatIntervalMs,
        );
        heartbeat.unref();
        request.on("close", () => {
          clearInterval(heartbeat);
          streams.delete(response);
          unsubscribe();
        });
        return;
      }

      const lifecycleMatch = url.pathname.match(/^\/conversations\/([^/]+)\/lifecycle$/);
      if (lifecycleMatch && request.method === "GET") {
        json(response, 200, { lifecycle: await service.getConversationLifecycle(lifecycleMatch[1]!) });
        return;
      }
      if (lifecycleMatch && request.method === "PATCH") {
        const input = (await readJson(request)) as UpdateConversationLifecycleInput;
        requireActor(input as unknown as Record<string, unknown>, actor, "actorIdentityId");
        json(response, 200, {
          lifecycle: await service.updateConversationLifecycle(lifecycleMatch[1]!, input),
        });
        return;
      }

      const conversationMatch = url.pathname.match(/^\/conversations\/([^/]+)$/);
      if (conversationMatch && request.method === "GET") {
        json(response, 200, { conversation: await service.getConversationMetadata(conversationMatch[1]!) });
        return;
      }
      if (conversationMatch && request.method === "PATCH") {
        const input = (await readJson(request)) as UpdateConversationInput;
        requireActor(input as unknown as Record<string, unknown>, actor, "actorIdentityId");
        const conversation = await service.updateConversation(
          conversationMatch[1]!,
          input,
        );
        json(response, 200, { conversation });
        return;
      }

      const participantsMatch = url.pathname.match(/^\/conversations\/([^/]+)\/participants$/);
      if (participantsMatch && request.method === "PATCH") {
        const input = (await readJson(request)) as UpdateConversationParticipantsInput;
        requireActor(input as unknown as Record<string, unknown>, actor, "actorIdentityId");
        const conversation = await service.updateConversationParticipants(
          participantsMatch[1]!,
          input,
        );
        json(response, 200, { conversation });
        return;
      }

      const messagesMatch = url.pathname.match(/^\/conversations\/([^/]+)\/messages$/);
      if (messagesMatch && request.method === "GET") {
        const integerQuery = (name: string): number | undefined => {
          const value = url.searchParams.get(name);
          if (value === null) return undefined;
          if (!/^\d+$/.test(value)) throw new ConversationValidationError(`${name} must be an integer`);
          return Number(value);
        };
        json(response, 200, { messages: await service.listMessages(messagesMatch[1]!, {
          afterSequence: integerQuery("afterSequence"),
          beforeSequence: integerQuery("beforeSequence"),
          limit: integerQuery("limit"),
        }) });
        return;
      }
      if (messagesMatch && request.method === "POST") {
        const idempotencyKey = request.headers["idempotency-key"];
        if (Array.isArray(idempotencyKey)) {
          throw new ConversationValidationError("idempotency key must be a single header value");
        }
        const input = (await readJson(request)) as CreateMessageInput;
        requireActor(input as unknown as Record<string, unknown>, actor, "participantId");
        const message = await service.createMessage(
          messagesMatch[1]!,
          input,
          idempotencyKey,
        );
        json(response, 201, { message });
        return;
      }

      const responseMatch = url.pathname.match(/^\/conversations\/([^/]+)\/responses$/);
      if (responseMatch && request.method === "POST") {
        const input = (await readJson(request)) as CreateResponseInput;
        requireActor(input as unknown as Record<string, unknown>, actor, "participantId");
        const result = await service.createResponse(
          responseMatch[1]!,
          input,
        );
        json(response, result.created ? 201 : 200, result);
        return;
      }

      const eventsMatch = url.pathname.match(/^\/conversations\/([^/]+)\/events$/);
      if (eventsMatch && request.method === "GET") {
        const conversationId = eventsMatch[1]!;
        const unsubscribe = await service.subscribe(conversationId, (event) => sendEvent(response, event));
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        streams.add(response);
        response.write(`event: ready\ndata: ${JSON.stringify({ conversationId })}\n\n`);
        const heartbeat = setInterval(
          () => response.write(": keepalive\n\n"),
          heartbeatIntervalMs,
        );
        heartbeat.unref();
        request.on("close", () => {
          clearInterval(heartbeat);
          streams.delete(response);
          unsubscribe();
        });
        return;
      }

      json(response, 404, { error: "Not found" });
    } catch (error) {
      if (response.headersSent) {
        response.end();
        return;
      }
      const status =
        error instanceof ConversationNotFoundError
          ? 404
          : error instanceof ConversationConflictError
            ? 409
            : error instanceof ConversationValidationError
              ? 400
              : 500;
      json(response, status, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;

  return {
    endpoint: `http://${host}:${address.port}`,
    service,
    serviceToken,
    async close() {
      for (const stream of streams) stream.end();
      streams.clear();
      try {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        });
      } finally {
        await service.close();
      }
    },
  };
}
