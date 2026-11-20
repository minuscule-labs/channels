import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { conversations } from "./api";
import { sharedConversationEvents } from "./shared-conversation-events";

export const inboxKey = (identityId?: string) => ["inbox", identityId] as const;
export const activityKey = (identityId?: string) => ["activity", identityId] as const;

export function useInbox(identityId?: string) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: inboxKey(identityId), queryFn: () => conversations.listInbox(), enabled: Boolean(identityId),
    refetchOnWindowFocus: "always", refetchOnReconnect: "always", refetchInterval: 30_000, retry: false,
  });
  useEffect(() => {
    if (!identityId) return;
    const controller = new AbortController();
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      if (controller.signal.aborted) return;
      void client.invalidateQueries({ queryKey: inboxKey(identityId) });
      void client.invalidateQueries({ queryKey: activityKey(identityId) });
    };
    const changed = () => {
      if (refreshTimer !== undefined) return;
      refreshTimer = setTimeout(() => { refreshTimer = undefined; refresh(); }, 50);
    };
    void (async () => {
      while (!controller.signal.aborted) {
        try {
          for await (const _event of sharedConversationEvents(identityId, [], {
            inbox: true, mode: "observe", signal: controller.signal, onReady: refresh, onInboxChange: changed,
          })) { /* Inbox updates carry no message bodies or conversation subscriptions. */ }
        } catch { /* Reconnect and reconcile from persisted state. */ }
        if (!controller.signal.aborted) await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", done); resolve(); };
          const timer = setTimeout(done, 1_000);
          controller.signal.addEventListener("abort", done, { once: true });
        });
      }
    })();
    return () => { controller.abort(); clearTimeout(refreshTimer); };
  }, [client, identityId]);
  return query;
}
