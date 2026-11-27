import type { IncomingMessage, ServerResponse } from "node:http";
import { AgentCredentialError } from "./agent-credentials.ts";
import type { AgentStatusInspection } from "./agent-inspection-status.ts";

export const AGENT_INSPECTION_PATH = "/api/agent/v1/conversation/inspect";
export const AGENT_INSPECTION_REQUEST_BYTES = 1024;

function respond(response: ServerResponse, status: number, body: unknown, origin?: string): void {
  if (response.destroyed || response.writableEnded) return;
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  if (origin) { response.setHeader("access-control-allow-origin", origin); response.setHeader("vary", "Origin"); }
  response.end(JSON.stringify(body));
}

async function readInput(request: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new AgentCredentialError(400, "invalid_request");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    if (signal.aborted) throw new AgentCredentialError(503, "inspection_unavailable");
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > AGENT_INSPECTION_REQUEST_BYTES) {
      request.resume();
      throw new AgentCredentialError(400, "invalid_request");
    }
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new AgentCredentialError(400, "invalid_request"); }
}

/** Runs behind the existing loopback Host/Origin gate; never accepts human cookies or service tokens as API authority. */
export async function handleAgentInspectionHttp(request: IncomingMessage, response: ServerResponse,
  options: { inspection?: Pick<AgentStatusInspection, "inspectRequest">; origin?: string }): Promise<void> {
  const disconnected = new AbortController();
  const abortRequest = () => disconnected.abort();
  const closeResponse = () => { if (!response.writableFinished) disconnected.abort(); };
  request.once("aborted", abortRequest);
  response.once("close", closeResponse);
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== AGENT_INSPECTION_PATH) {
      respond(response, 404, { error: "unavailable" }, options.origin);
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      respond(response, 405, { error: "method_not_allowed" }, options.origin);
      return;
    }
    if (url.search) throw new AgentCredentialError(400, "invalid_request");
    if (!options.inspection) throw new AgentCredentialError(503, "inspection_unavailable");
    const authorizationFields = request.rawHeaders.filter((name, index) => index % 2 === 0 && name.toLowerCase() === "authorization");
    const match = typeof request.headers.authorization === "string"
      ? /^Bearer (chak_[a-f0-9]{32}_[A-Za-z0-9_-]{43})$/.exec(request.headers.authorization) : undefined;
    if (authorizationFields.length !== 1 || !match) throw new AgentCredentialError(401, "unauthenticated");
    await options.inspection.inspectRequest(match[1]!, signal => readInput(request, signal),
      snapshot => respond(response, 200, snapshot, options.origin), { signal: disconnected.signal });
  } catch (error) {
    // Close incomplete/slow bodies after the bounded error response; no lingering input wait is reused.
    if (!request.complete && !response.headersSent && !response.destroyed) response.setHeader("connection", "close");
    const known = error instanceof AgentCredentialError;
    const codes: Record<number, string[]> = { 400: ["invalid_request"], 401: ["unauthenticated"],
      404: ["target_unavailable"], 503: ["inspection_unavailable"] };
    const safe = known && codes[error.status]?.includes(error.code);
    respond(response, safe ? error.status : 503, { error: safe ? error.code : "inspection_unavailable" }, options.origin);
  } finally {
    request.removeListener("aborted", abortRequest);
    response.removeListener("close", closeResponse);
  }
}
