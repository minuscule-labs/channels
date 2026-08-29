import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ChannelConflictError,
  ChannelNotFoundError,
  ChannelService,
  ChannelValidationError,
} from "./channel-service.ts";
import type {
  AddWorkspaceMemberInput,
  ChannelEvent,
  CreateChannelInput,
  CreateIdentityInput,
  CreateMessageInput,
  CreateResponseInput,
  CreateWorkspaceInput,
  UpdateWorkspaceMemberInput,
} from "./types.ts";

const MAX_REQUEST_BYTES = 1024 * 1024;

export interface ChannelHttpServerOptions {
  service?: ChannelService;
  host?: string;
  port?: number;
  heartbeatIntervalMs?: number;
}

export interface ChannelHttpServer {
  endpoint: string;
  service: ChannelService;
  close(): Promise<void>;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) throw new ChannelValidationError("request exceeds 1 MiB");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ChannelValidationError("request body must be valid JSON");
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body)}\n`);
}

function sendEvent(response: ServerResponse, event: ChannelEvent): void {
  response.write(`id: ${event.id}\n`);
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

export async function createChannelHttpServer(
  options: ChannelHttpServerOptions = {},
): Promise<ChannelHttpServer> {
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
  if (!Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 1) {
    throw new RangeError("heartbeatIntervalMs must be a positive integer");
  }
  const service = options.service ?? new ChannelService();
  const streams = new Set<ServerResponse>();

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://channels.local");

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
        const member = await service.updateWorkspaceMember(
          workspaceMemberMatch[1]!,
          workspaceMemberMatch[2]!,
          (await readJson(request)) as UpdateWorkspaceMemberInput,
        );
        json(response, 200, { member });
        return;
      }
      const workspaceChannelsMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/channels$/);
      if (workspaceChannelsMatch && request.method === "POST") {
        const input = (await readJson(request)) as CreateChannelInput;
        const channel = await service.createChannel({ ...input, workspaceId: workspaceChannelsMatch[1]! });
        json(response, 201, { channel });
        return;
      }
      if (workspaceChannelsMatch && request.method === "GET") {
        json(response, 200, { channels: await service.listWorkspaceChannels(workspaceChannelsMatch[1]!) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/channels") {
        const channel = await service.createChannel((await readJson(request)) as CreateChannelInput);
        json(response, 201, { channel });
        return;
      }

      const channelMatch = url.pathname.match(/^\/channels\/([^/]+)$/);
      if (channelMatch && request.method === "GET") {
        json(response, 200, { channel: await service.getChannelMetadata(channelMatch[1]!) });
        return;
      }

      const messagesMatch = url.pathname.match(/^\/channels\/([^/]+)\/messages$/);
      if (messagesMatch && request.method === "GET") {
        json(response, 200, { messages: await service.listMessages(messagesMatch[1]!) });
        return;
      }
      if (messagesMatch && request.method === "POST") {
        const idempotencyKey = request.headers["idempotency-key"];
        if (Array.isArray(idempotencyKey)) {
          throw new ChannelValidationError("idempotency key must be a single header value");
        }
        const message = await service.createMessage(
          messagesMatch[1]!,
          (await readJson(request)) as CreateMessageInput,
          idempotencyKey,
        );
        json(response, 201, { message });
        return;
      }

      const responseMatch = url.pathname.match(/^\/channels\/([^/]+)\/responses$/);
      if (responseMatch && request.method === "POST") {
        const result = await service.createResponse(
          responseMatch[1]!,
          (await readJson(request)) as CreateResponseInput,
        );
        json(response, result.created ? 201 : 200, result);
        return;
      }

      const eventsMatch = url.pathname.match(/^\/channels\/([^/]+)\/events$/);
      if (eventsMatch && request.method === "GET") {
        const channelId = eventsMatch[1]!;
        const unsubscribe = await service.subscribe(channelId, (event) => sendEvent(response, event));
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        streams.add(response);
        response.write(`event: ready\ndata: ${JSON.stringify({ channelId })}\n\n`);
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
        error instanceof ChannelNotFoundError
          ? 404
          : error instanceof ChannelConflictError
            ? 409
            : error instanceof ChannelValidationError
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
