import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isLocalConversationsHostname } from "./local-host.ts";

const DEFAULT_LAUNCH_CODE_TTL_MS = 60_000;
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1_000;
const PERSISTENT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const SESSION_COOKIE = "minu_local_session";

export type LocalControlAuditAction =
  | "launch.created"
  | "launch.redeemed"
  | "launch.rejected"
  | "session.rejected"
  | "workspace.config.updated"
  | "conversation.working-folders.updated"
  | "runtime.models.updated"
  | "agent.config.updated"
  | "agent.session.started"
  | "agent.session.replaced"
  | "agent.session.stopped"
  | "agent.session.reconnected"
  | "agent.turn.cancel.requested"
  | "agent.diagnostic.opened"
  | "agent.session.bulk-started"
  | "agent.session.bulk-stopped"
  | "agents.bulk-started"
  | "agents.bulk-stopped";

export interface LocalControlAuditEvent {
  action: LocalControlAuditAction;
  outcome: "accepted" | "rejected";
  timestamp: string;
  reason?:
    | "missing"
    | "invalid"
    | "expired"
    | "reused"
    | "forbidden"
    | "unavailable"
    | "already_running"
    | "already_idle"
    | "unconfigured"
    | "offline"
    | "uncertain";
  actorIdentityId?: string;
  workspaceId?: string;
  conversationId?: string;
  targetIdentityId?: string;
}

export interface LocalControlBrowserSessionsOptions {
  browserUrl: string;
  currentHumanIdentityId: string;
  launchCodeTtlMs?: number;
  sessionTtlMs?: number;
  /** Owner-private installation key; when provided, sessions survive daemon restarts. */
  sessionKey?: Buffer;
  now?: () => Date;
  onAudit?(event: LocalControlAuditEvent): void;
}

interface LaunchCodeRecord {
  expiresAt: number;
  redirectUrl: string;
  used: boolean;
}

interface BrowserSessionRecord {
  expiresAt: number;
  identityId: string;
}

export interface LocalControlBrowserSession {
  identityId: string;
  /** Opaque server-only session scope for short-lived local action tokens. */
  scope: string;
  /** Sent only when a persistent session is halfway to its inactivity deadline. */
  renewalCookie?: string;
}

export interface LocalControlLaunchExchange {
  cookie: string;
  redirectUrl: string;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function secret(): string {
  return randomBytes(32).toString("base64url");
}

function loopbackBrowserUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:") {
    throw new Error("browserUrl must use loopback HTTP");
  }
  if (!isLocalConversationsHostname(url.hostname)) {
    throw new Error("browserUrl must use an approved local Conversations host");
  }
  if (url.username || url.password) throw new Error("browserUrl must not contain credentials");
  url.hash = "";
  return url;
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    if (pair.slice(0, separator).trim() === name) return pair.slice(separator + 1).trim();
  }
  return undefined;
}

export class LocalControlBrowserSessions {
  readonly browserOrigin: string;
  readonly launchCodeTtlMs: number;
  readonly sessionTtlMs: number;
  readonly currentHumanIdentityId: string;
  private readonly browserUrl: URL;
  private readonly now: () => Date;
  private readonly launchCodes = new Map<string, LaunchCodeRecord>();
  private readonly sessions = new Map<string, BrowserSessionRecord>();
  private readonly sessionKey?: Buffer;

  constructor(private readonly options: LocalControlBrowserSessionsOptions) {
    this.browserUrl = loopbackBrowserUrl(options.browserUrl);
    this.browserOrigin = this.browserUrl.origin;
    this.currentHumanIdentityId = options.currentHumanIdentityId.trim();
    if (!this.currentHumanIdentityId || this.currentHumanIdentityId.length > 255) {
      throw new Error("currentHumanIdentityId must be non-empty and at most 255 characters");
    }
    this.launchCodeTtlMs = positiveInteger(
      options.launchCodeTtlMs ?? DEFAULT_LAUNCH_CODE_TTL_MS,
      "launchCodeTtlMs",
    );
    this.sessionTtlMs = positiveInteger(
      options.sessionTtlMs ?? (options.sessionKey ? PERSISTENT_SESSION_TTL_MS : DEFAULT_SESSION_TTL_MS),
      "sessionTtlMs",
    );
    if (options.sessionKey && options.sessionKey.length !== 32) throw new Error("sessionKey must be 32 bytes");
    this.sessionKey = options.sessionKey;
    this.now = options.now ?? (() => new Date());
  }

  issueLaunchUrl(controlEndpoint: string, destinationPath?: string): string {
    const endpoint = new URL(controlEndpoint);
    if (endpoint.protocol !== "http:" || !isLocalConversationsHostname(endpoint.hostname)) {
      throw new Error("controlEndpoint must use approved local Conversations HTTP");
    }
    const redirectUrl = destinationPath === undefined
      ? this.browserUrl.href
      : new URL(destinationPath, this.browserUrl).href;
    if (new URL(redirectUrl).origin !== this.browserOrigin) {
      throw new Error("Browser destination must remain on the configured origin");
    }
    const code = secret();
    this.launchCodes.set(hash(code), {
      expiresAt: this.now().getTime() + this.launchCodeTtlMs,
      redirectUrl,
      used: false,
    });
    this.audit({ action: "launch.created", outcome: "accepted" });
    const launchUrl = new URL("/local/session/bootstrap", endpoint);
    launchUrl.hostname = this.browserUrl.hostname;
    launchUrl.searchParams.set("code", code);
    return launchUrl.href;
  }

  exchangeLaunchCode(code: string | undefined): LocalControlLaunchExchange | undefined {
    if (!code) {
      this.audit({ action: "launch.rejected", outcome: "rejected", reason: "missing" });
      return undefined;
    }
    const key = hash(code);
    const record = this.launchCodes.get(key);
    if (!record) {
      this.audit({ action: "launch.rejected", outcome: "rejected", reason: "invalid" });
      return undefined;
    }
    if (record.used) {
      this.audit({ action: "launch.rejected", outcome: "rejected", reason: "reused" });
      return undefined;
    }
    record.used = true;
    if (record.expiresAt <= this.now().getTime()) {
      this.audit({ action: "launch.rejected", outcome: "rejected", reason: "expired" });
      return undefined;
    }
    const sessionToken = this.sessionKey
      ? this.signedToken(secret(), this.now().getTime() + this.sessionTtlMs)
      : secret();
    if (!this.sessionKey) this.sessions.set(hash(sessionToken), {
      expiresAt: this.now().getTime() + this.sessionTtlMs,
      identityId: this.currentHumanIdentityId,
    });
    this.audit({ action: "launch.redeemed", outcome: "accepted" });
    return {
      cookie: this.cookie(sessionToken),
      redirectUrl: record.redirectUrl,
    };
  }

  authenticate(cookieHeader: string | undefined): LocalControlBrowserSession | undefined {
    const token = cookieValue(cookieHeader, SESSION_COOKIE);
    if (!token) {
      this.audit({ action: "session.rejected", outcome: "rejected", reason: "missing" });
      return undefined;
    }
    if (this.sessionKey) return this.authenticateSigned(token);
    const key = hash(token);
    const record = this.sessions.get(key);
    if (!record) {
      this.audit({ action: "session.rejected", outcome: "rejected", reason: "invalid" });
      return undefined;
    }
    if (record.expiresAt <= this.now().getTime()) {
      this.sessions.delete(key);
      this.audit({ action: "session.rejected", outcome: "rejected", reason: "expired" });
      return undefined;
    }
    return { identityId: record.identityId, scope: key };
  }

  private cookie(token: string): string {
    return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.ceil(this.sessionTtlMs / 1_000)}`;
  }

  private signedToken(scope: string, expiresAt: number): string {
    const payload = Buffer.from(JSON.stringify({ identityId: this.currentHumanIdentityId, scope, expiresAt })).toString("base64url");
    const signature = createHmac("sha256", this.sessionKey!).update(`v1.${payload}`).digest("base64url");
    return `v1.${payload}.${signature}`;
  }

  private authenticateSigned(token: string): LocalControlBrowserSession | undefined {
    const reject = (reason: "invalid" | "expired"): undefined => {
      this.audit({ action: "session.rejected", outcome: "rejected", reason });
      return undefined;
    };
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== "v1" || !parts[1] || !parts[2] || parts[1].length > 1024) return reject("invalid");
    const expected = createHmac("sha256", this.sessionKey!).update(`v1.${parts[1]}`).digest();
    const signature = Buffer.from(parts[2], "base64url");
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return reject("invalid");
    let payload: unknown;
    try { payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")); }
    catch { return reject("invalid"); }
    if (!payload || typeof payload !== "object") return reject("invalid");
    const { identityId, scope, expiresAt } = payload as Record<string, unknown>;
    if (identityId !== this.currentHumanIdentityId || typeof scope !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(scope)
      || typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt)) return reject("invalid");
    const now = this.now().getTime();
    if (expiresAt <= now) return reject("expired");
    return {
      identityId,
      scope: hash(scope),
      ...(expiresAt - now <= this.sessionTtlMs / 2
        ? { renewalCookie: this.cookie(this.signedToken(scope, now + this.sessionTtlMs)) }
        : {}),
    };
  }

  authorize(cookieHeader: string | undefined): boolean {
    return this.authenticate(cookieHeader) !== undefined;
  }

  private audit(event: Omit<LocalControlAuditEvent, "timestamp">): void {
    try {
      this.options.onAudit?.({ ...event, timestamp: this.now().toISOString() });
    } catch {
      // Audit sinks must not make the local control service unavailable.
    }
  }
}
