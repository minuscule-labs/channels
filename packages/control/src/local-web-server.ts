import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, request as proxyRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { extname, resolve, sep } from "node:path";
import { DEFAULT_WEB_PORT, isLocalChannelsHostname } from "./local-host.ts";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export interface LocalWebServerOptions {
  channelsEndpoint: string;
  controlEndpoint: string;
  webDirectory: string;
  host?: "127.0.0.1" | "::1";
  port?: number;
  channelsServiceToken: string;
  authenticateBrowser(cookieHeader: string | undefined): { identityId: string } | undefined;
}

export interface LocalWebServer {
  endpoint: string;
  close(): Promise<void>;
}

function targetFor(pathname: string, options: LocalWebServerOptions): string | undefined {
  if (["/channels", "/workspaces", "/identities"].some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  )) return options.channelsEndpoint;
  if (pathname === "/local" || pathname.startsWith("/local/")) return options.controlEndpoint;
  return undefined;
}

function proxy(
  request: IncomingMessage,
  response: ServerResponse,
  target: string,
  headers: Record<string, string> = {},
): void {
  const incoming = new URL(request.url ?? "/", "http://minu.local");
  const destination = new URL(target);
  destination.pathname = incoming.pathname;
  destination.search = incoming.search;
  const { origin: _origin, cookie: _cookie, ...forwardedHeaders } = request.headers;
  const upstream = proxyRequest(destination, {
    method: request.method,
    headers: {
      ...forwardedHeaders,
      host: destination.host,
      ...headers,
    },
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.once("error", (error) => {
    if (response.headersSent) response.destroy(error);
    else {
      response.writeHead(502, { "content-type": "application/json; charset=utf-8" });
      response.end(`${JSON.stringify({ error: "Local product service unavailable" })}\n`);
    }
  });
  request.pipe(upstream);
}

function safeStaticPath(webDirectory: string, pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  const relative = decoded.replace(/^\/+/, "");
  const candidate = resolve(webDirectory, relative || "index.html");
  const root = resolve(webDirectory);
  return candidate === root || candidate.startsWith(`${root}${sep}`) ? candidate : undefined;
}

async function regularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
  webDirectory: string,
  pathname: string,
): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD" });
    response.end();
    return;
  }
  const requested = safeStaticPath(webDirectory, pathname);
  if (!requested) {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    response.end("Invalid path\n");
    return;
  }
  const path = await regularFile(requested) ? requested : resolve(webDirectory, "index.html");
  if (!(await regularFile(path))) {
    response.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    response.end("MinuChannels web assets are not built.\n");
    return;
  }
  const file = await stat(path);
  response.writeHead(200, {
    "content-length": file.size,
    "content-type": CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
    "cache-control": path.includes(`${sep}assets${sep}`)
      ? "public, max-age=31536000, immutable"
      : "no-cache",
  });
  if (request.method === "HEAD") response.end();
  else createReadStream(path).pipe(response);
}

function loopbackRequestHost(request: IncomingMessage): boolean {
  try {
    const hostname = new URL(`http://${request.headers.host ?? ""}`).hostname;
    return isLocalChannelsHostname(hostname);
  } catch { return false; }
}

function sameRequestOrigin(request: IncomingMessage): boolean {
  if (typeof request.headers.origin !== "string") return true;
  try {
    return new URL(request.headers.origin).host === request.headers.host;
  } catch { return false; }
}

export async function createLocalWebServer(
  options: LocalWebServerOptions,
): Promise<LocalWebServer> {
  const webDirectory = resolve(options.webDirectory);
  const indexPath = resolve(webDirectory, "index.html");
  if (!(await regularFile(indexPath))) {
    throw new Error(`MinuChannels production web assets are missing: ${indexPath}`);
  }
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    void (async () => {
      if (!loopbackRequestHost(request)) {
        response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        response.end("Forbidden host\n");
        return;
      }
      if (!sameRequestOrigin(request)) {
        response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        response.end("Forbidden origin\n");
        return;
      }
      const url = new URL(request.url ?? "/", "http://minu.local");
      const target = targetFor(url.pathname, options);
      if (target === options.channelsEndpoint) {
        const session = options.authenticateBrowser(request.headers.cookie);
        if (!session) {
          response.writeHead(401, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          response.end(`${JSON.stringify({ error: "Local browser session required" })}\n`);
          return;
        }
        proxy(request, response, target, {
          authorization: `Bearer ${options.channelsServiceToken}`,
          "x-minu-actor-id": session.identityId,
        });
      } else if (target) proxy(request, response, target);
      else await serveStatic(request, response, webDirectory, url.pathname);
    })().catch((error) => {
      if (response.headersSent) response.destroy(error as Error);
      else {
        response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        response.end("Local web server error\n");
      }
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? DEFAULT_WEB_PORT, options.host ?? "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolveListen();
    });
  });
  const address = server.address() as AddressInfo;
  let closed = false;
  return {
    endpoint: `http://${address.family === "IPv6" ? `[${address.address}]` : address.address}:${address.port}`,
    async close() {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => error ? reject(error) : resolveClose());
        for (const socket of sockets) socket.destroy();
      });
    },
  };
}
