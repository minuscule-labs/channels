import type {
  LocalChannelAgentsResponse,
  LocalControlCapabilities,
  LocalControlHealth,
} from "./contracts.ts";

export class LocalControlClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "LocalControlClientError";
  }
}

export class LocalControlClient {
  readonly timeoutMs: number;

  constructor(readonly endpoint: string, options: { timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? 3_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new RangeError("timeoutMs must be a positive integer");
    }
  }

  async health(): Promise<LocalControlHealth> {
    return this.get<LocalControlHealth>("/local/health");
  }

  async capabilities(): Promise<LocalControlCapabilities> {
    return this.get<LocalControlCapabilities>("/local/capabilities");
  }

  async listChannelAgents(channelId: string): Promise<LocalChannelAgentsResponse> {
    return this.get<LocalChannelAgentsResponse>(`/local/channels/${encodeURIComponent(channelId)}/agents`);
  }

  private async get<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.endpoint}${path}`, {
        headers: { accept: "application/json" },
        credentials: "include",
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new LocalControlClientError(body.error ?? `Local control request failed (${response.status})`, response.status);
      }
      return response.json() as Promise<T>;
    } finally {
      clearTimeout(timer);
    }
  }
}
