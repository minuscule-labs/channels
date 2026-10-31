import type { ConversationEvent, ConversationMessage, ConversationMetadata } from "@minu/channels-core/types";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { conversations } from "./api";
import { conversationCacheAction } from "./conversation-events";
import { mergeMessages } from "./messages";
import { queryKeys } from "./query-keys";
import { sharedConversationEvents } from "./shared-conversation-events";

export type ConnectionState = "connecting" | "live" | "disconnected" | "polling";

const MAX_RECONNECT_DELAY_MS = 10_000;

export function useLiveConversation(conversationId: string, identityId: string | undefined) {
  const queryClient = useQueryClient();
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [attempt, setAttempt] = useState(0);
  const reconnectStreak = useRef(0);

  useEffect(() => {
    if (!identityId) return;
    const controller = new AbortController();
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let highestRosterRevisionSeen = 0;
    let generation = 0;
    let polling = false;
    let requested = false;
    let reconciling = false;
    const failed = () => {
      if (controller.signal.aborted) return;
      controller.abort();
      setConnection("disconnected");
      const delay = Math.min(1_000 * (2 ** reconnectStreak.current), MAX_RECONNECT_DELAY_MS);
      reconnectStreak.current += 1;
      retryTimer = setTimeout(() => setAttempt((current) => current + 1), delay);
    };
    const reconcile = () => {
      requested = true;
      if (reconciling) return;
      reconciling = true;
      void (async () => {
        try {
          while (requested && !controller.signal.aborted) {
            requested = false;
            const currentGeneration = generation;
            const [metadata, messages] = await Promise.all([
              conversations.getConversation(conversationId),
              conversations.listMessages(conversationId, { signal: controller.signal }),
            ]);
            if (controller.signal.aborted) return;
            queryClient.setQueryData(queryKeys.conversation(conversationId), metadata);
            void queryClient.invalidateQueries({ queryKey: queryKeys.conversationThreads(conversationId), exact: true });
            void queryClient.invalidateQueries({ queryKey: queryKeys.localConversationLifecycle(conversationId), exact: true });
            queryClient.setQueryData<ConversationMessage[]>(
              queryKeys.conversationMessages(conversationId),
              (current) => mergeMessages(current, messages),
            );
            if (highestRosterRevisionSeen > metadata.rosterRevision) {
              await queryClient.invalidateQueries({ queryKey: queryKeys.conversation(conversationId), exact: true });
            }
            if (controller.signal.aborted) return;
            if (currentGeneration === generation) {
              reconnectStreak.current = 0;
              setConnection(polling ? "polling" : "live");
            }
          }
        } catch { failed(); }
        finally { reconciling = false; }
      })();
    };

    const apply = (event: ConversationEvent) => {
      const current = queryClient.getQueryData<ConversationMetadata>(queryKeys.conversation(conversationId));
      const action = conversationCacheAction(event, current?.rosterRevision);
      if (action.type === "merge-message") {
        queryClient.setQueryData<ConversationMessage[]>(
          queryKeys.conversationMessages(conversationId),
          (messages) => mergeMessages(messages, [action.message]),
        );
        if (current) {
          window.dispatchEvent(new CustomEvent("minu-live-message", {
            detail: { conversation: current, message: action.message },
          }));
        }
      } else if (action.type === "refresh-metadata") {
        void queryClient.invalidateQueries({ queryKey: queryKeys.conversationThreads(conversationId), exact: true });
        void queryClient.invalidateQueries({ queryKey: queryKeys.localConversationLifecycle(conversationId), exact: true });
        if (action.rosterRevision !== undefined) {
          highestRosterRevisionSeen = Math.max(highestRosterRevisionSeen, action.rosterRevision);
        }
        void queryClient.invalidateQueries({ queryKey: queryKeys.conversation(conversationId), exact: true });
        if (current) {
          void queryClient.invalidateQueries({
            queryKey: queryKeys.workspaceConversations(current.workspaceId),
            exact: true,
          });
        }
      }
    };

    const stream = (async () => {
      for await (const event of sharedConversationEvents(identityId, [conversationId], {
        signal: controller.signal,
        onConnecting: () => { generation++; setConnection(polling ? "polling" : "connecting"); },
        onDisconnected: () => { generation++; setConnection("disconnected"); },
        onPolling: () => { polling = true; },
        onReady: reconcile,
      })) {
        apply(event);
      }
      if (!controller.signal.aborted) throw new Error("Conversation event stream closed");
    })();
    void stream.catch(failed);
    setConnection("connecting");

    return () => {
      controller.abort();
      if (retryTimer) clearTimeout(retryTimer);
      void stream.catch(() => undefined);
    };
  }, [attempt, conversationId, identityId, queryClient]);

  return {
    connection,
    retry: () => {
      reconnectStreak.current = 0;
      setAttempt((current) => current + 1);
    },
  };
}
