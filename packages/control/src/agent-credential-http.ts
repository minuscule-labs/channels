import type { IncomingMessage, ServerResponse } from "node:http";
import { AgentCredentialError, type AgentCredentialService } from "./agent-credentials.ts";
import type { LocalControlBrowserSessions } from "./session.ts";

function respond(response: ServerResponse, status: number, body: unknown, origin?: string): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  if (origin) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-credentials", "true");
    response.setHeader("vary", "Origin");
  }
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new AgentCredentialError(400, "invalid_request");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 64 * 1024) {
      request.resume();
      throw new AgentCredentialError(400, "invalid_request");
    }
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new AgentCredentialError(400, "invalid_request"); }
}

/** Called only after the control server's loopback Host/Origin checks. No bearer-key fallback. */
export async function handleAgentCredentialAdmin(
  request: IncomingMessage, response: ServerResponse,
  options: { service?: AgentCredentialService; sessions?: LocalControlBrowserSessions; origin?: string },
): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    const match = /^\/local\/workspaces\/([^/]+)\/agent-credentials(?:\/([a-f0-9]{32})(?:\/(rotate|revoke))?)?$/.exec(url.pathname);
    if (!match || url.search) throw new AgentCredentialError(400, "invalid_request");
    if (!options.service || !options.sessions) throw new AgentCredentialError(404, "unavailable");
    const session = options.sessions.authenticate(request.headers.cookie);
    if (!session) throw new AgentCredentialError(401, "unauthenticated");
    // Supplying a key must never change the browser principal or authorize admin routes.
    if (request.headers.authorization) throw new AgentCredentialError(401, "unauthenticated");
    const workspaceId = decodeURIComponent(match[1]!);
    const id = match[2];
    const action = match[3];
    let result: unknown;
    let status = 200;
    if (!id && request.method === "GET") {
      result = { credentials: await options.service.list(workspaceId, session.identityId) };
    } else if (!id && request.method === "POST") {
      result = await options.service.create(workspaceId, session.identityId, await readBody(request));
      status = 201;
    } else if (id && !action && request.method === "GET") {
      result = { credential: await options.service.get(workspaceId, session.identityId, id) };
    } else if (id && !action && request.method === "PATCH") {
      result = await options.service.mutate(workspaceId, session.identityId, id, "update", await readBody(request));
    } else if (id && (action === "rotate" || action === "revoke") && request.method === "POST") {
      result = await options.service.mutate(workspaceId, session.identityId, id, action, await readBody(request));
    } else {
      respond(response, 405, { error: "method_not_allowed" }, options.origin);
      return;
    }
    const fresh = options.sessions.authenticate(request.headers.cookie);
    if (!fresh || fresh.scope !== session.scope || fresh.identityId !== session.identityId) {
      throw new AgentCredentialError(401, "unauthenticated");
    }
    await options.service.authorizeAdministrator(workspaceId, fresh.identityId);
    // The authority lookup can outlive the browser session. No await may follow this check.
    const finalSession = options.sessions.authenticate(request.headers.cookie);
    if (!finalSession || finalSession.scope !== session.scope || finalSession.identityId !== session.identityId) {
      throw new AgentCredentialError(401, "unauthenticated");
    }
    if (finalSession.renewalCookie) response.setHeader("set-cookie", finalSession.renewalCookie);
    respond(response, status, result, options.origin);
  } catch (error) {
    const known = error instanceof AgentCredentialError;
    respond(response, known ? error.status : 503, { error: known ? error.code : "credential_admin_unavailable" }, options.origin);
  }
}
