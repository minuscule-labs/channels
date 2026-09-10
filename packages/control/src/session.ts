import { createHash, randomBytes } from "node:crypto";
import { isLocalChannelsHostname } from "./local-host.ts";

const DEFAULT_LAUNCH_CODE_TTL_MS = 60_000;
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1_000;
const SESSION_COOKIE = "minu_local_session";

export type LocalControlAuditAction =
  | "launch.created"
  | "launch.redeemed"
  | "launch.rejected"
  | "session.rejected"
  | "workspace.config.updated"
  | "runtime.models.updated"
  | "agent.config.updated"
  | "agent.session.started"
  | "agent.session.replaced"
  | "agent.session.stopped"
  | "agent.turn.cancel.requested"
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
  channelId?: string;
  targetIdentityId?: string;
}

export interface LocalControlBrowserSessionsOptions {
  browserUrl: string;
  currentHumanIdentityId: string;
  launchCodeTtlMs?: number;
  sessionTtlMs?: number;
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
  if (!isLocalChannelsHostname(url.hostname)) {
    throw new Error("browserUrl must use an approved local Channels host");
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
    this.sessionTtlMs = positiveInteger(options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS, "sessionTtlMs");
    this.now = options.now ?? (() => new Date());
  }

  issueLaunchUrl(controlEndpoint: string, destinationPath?: string): string {
    const endpoint = new URL(controlEndpoint);
    if (endpoint.protocol !== "http:" || !isLocalChannelsHostname(endpoint.hostname)) {
      throw new Error("controlEndpoint must use approved local Channels HTTP");
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
    const sessionToken = secret();
    this.sessions.set(hash(sessionToken), {
      expiresAt: this.now().getTime() + this.sessionTtlMs,
      identityId: this.currentHumanIdentityId,
    });
    this.audit({ action: "launch.redeemed", outcome: "accepted" });
    return {
      cookie: `${SESSION_COOKIE}=${sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.ceil(this.sessionTtlMs / 1_000)}`,
      redirectUrl: record.redirectUrl,
    };
  }

  authenticate(cookieHeader: string | undefined): LocalControlBrowserSession | undefined {
    const token = cookieValue(cookieHeader, SESSION_COOKIE);
    if (!token) {
      this.audit({ action: "session.rejected", outcome: "rejected", reason: "missing" });
      return undefined;
    }
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
    return { identityId: record.identityId };
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
