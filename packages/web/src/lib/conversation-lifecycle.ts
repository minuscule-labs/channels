import type { EffectiveConversationLifecycle } from "@minu/channels-core/types";

const MAX_SNOOZE_CHECK_MS = 24 * 60 * 60_000;

export function snoozeRefetchInterval(lifecycle: EffectiveConversationLifecycle | undefined, now = Date.now()): number | false {
  if (lifecycle?.state !== "snoozed") return false;
  const remaining = Date.parse(lifecycle.snoozedUntil!) - now;
  return Number.isFinite(remaining) ? Math.min(MAX_SNOOZE_CHECK_MS, Math.max(1_000, remaining)) : false;
}

function lifecycleChannel(identityId: string): BroadcastChannel | undefined {
  return typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel(`minu-channels:lifecycle:${identityId}`);
}

/** Notify only after a successful mutation; peers refetch rather than trust shared state. */
export function announceLifecycleChange(identityId: string | undefined, conversationId: string): void {
  if (!identityId) return;
  const channel = lifecycleChannel(identityId);
  channel?.postMessage(conversationId);
  channel?.close();
}

export function listenForLifecycleChanges(identityId: string, onChange: (conversationId: string) => void): () => void {
  const channel = lifecycleChannel(identityId);
  if (channel) channel.onmessage = ({ data }: MessageEvent<unknown>) => {
    if (typeof data === "string" && data.length > 0 && data.length <= 256 && !data.includes("\0")) onChange(data);
  };
  return () => channel?.close();
}
