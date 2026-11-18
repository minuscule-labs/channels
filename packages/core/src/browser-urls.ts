// Browser presentation only: stored IDs and API paths must never use these adapters.
const UUID_PAYLOAD = /^[0-9a-f]{32}$/;
type BrowserIdKind = "workspace" | "conversation";

export function encodeBrowserId(id: string, kind: BrowserIdKind): string {
  const prefix = `${kind}_`;
  if (id.startsWith(prefix) && UUID_PAYLOAD.test(id.slice(prefix.length))) return id.slice(prefix.length);
  // An explicit escape distinguishes literal bare UUID IDs (and escape-prefixed IDs)
  // from compact representations. Legacy channel_ and non-UUID IDs stay intact.
  return UUID_PAYLOAD.test(id) || id.startsWith("~") ? `~${id}` : id;
}

export function decodeBrowserId(value: string, kind: BrowserIdKind): string {
  if (value.startsWith("~")) return value.slice(1);
  return UUID_PAYLOAD.test(value) ? `${kind}_${value}` : value;
}

function mapPath(pathname: string, direction: "input" | "output"): string {
  const legacy = pathname.startsWith("/app/workspaces/");
  const path = legacy ? pathname.slice(4) : pathname;
  const parts = path.split("/");
  if (parts[1] !== "workspaces" || !parts[2]) return pathname;
  try {
    const transform = (value: string, kind: BrowserIdKind) => {
      const decoded = decodeURIComponent(value);
      return encodeURIComponent(direction === "output"
        ? encodeBrowserId(decoded, kind)
        : legacy ? decoded : decodeBrowserId(decoded, kind));
    };
    parts[2] = transform(parts[2], "workspace");
    if (parts[3] === "channels") parts[3] = "conversations";
    if (parts[3] === "conversations" && parts[4] && parts[4] !== "new") {
      parts[4] = transform(parts[4], "conversation");
    }
    return `${direction === "input" ? "/app" : ""}${parts.join("/")}`;
  } catch {
    // Malformed URI escapes are not IDs and must not be repaired into another record.
    return pathname;
  }
}

/** Logical router paths retain full IDs; only the browser-facing path is compact. */
export function toInternalBrowserPath(pathname: string): string {
  return mapPath(pathname, "input");
}

export function toPublicBrowserPath(pathname: string): string {
  return mapPath(pathname, "output");
}

export function canonicalBrowserPath(pathname: string): string {
  return toPublicBrowserPath(toInternalBrowserPath(pathname));
}

export function conversationBrowserPath(workspaceId: string, conversationId: string): string {
  return toPublicBrowserPath(`/app/workspaces/${encodeURIComponent(workspaceId)}/conversations/${encodeURIComponent(conversationId)}`);
}

/** Only explicit HTML navigation to known page shapes wins over an overlapping API prefix. */
export function isBrowserNavigation(pathname: string, method: string | undefined, accept: string | undefined, destination?: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  if (destination && destination !== "document" && destination !== "iframe") return false;
  const html = accept?.split(",").some(entry => {
    const [type, ...parameters] = entry.trim().split(";");
    return type?.trim().toLowerCase() === "text/html"
      && !parameters.some(parameter => /^\s*q\s*=\s*0(?:\.0*)?\s*$/i.test(parameter));
  });
  if (!html) return false;
  return /^\/(?:app\/)?workspaces\/[^/]+\/(?:agents(?:\/(?:new|[^/]+))?|settings(?:\/(?:people|defaults|instructions|skills(?:\/[^/]+)?|presets(?:\/[^/]+)?))?|(?:conversations|channels)\/[^/]+(?:\/settings|\/participants\/[^/]+\/diagnostics)?)\/?$/.test(pathname);
}
