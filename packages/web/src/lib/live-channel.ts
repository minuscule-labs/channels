import type { ChannelEvent, ChannelMessage, ChannelMetadata } from "@minu/channels-core/types";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { channels } from "./api";
import { channelCacheAction } from "./channel-events";
import { mergeMessages } from "./messages";
import { queryKeys } from "./query-keys";

export type ConnectionState = "connecting" | "live" | "disconnected";

const MAX_RECONNECT_DELAY_MS = 10_000;

export function useLiveChannel(channelId: string) {
  const queryClient = useQueryClient();
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [attempt, setAttempt] = useState(0);
  const reconnectStreak = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let highestRosterRevisionSeen = 0;
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    const apply = (event: ChannelEvent) => {
      const current = queryClient.getQueryData<ChannelMetadata>(queryKeys.channel(channelId));
      const action = channelCacheAction(event, current?.rosterRevision);
      if (action.type === "merge-message") {
        queryClient.setQueryData<ChannelMessage[]>(
          queryKeys.channelMessages(channelId),
          (messages) => mergeMessages(messages, [action.message]),
        );
      } else if (action.type === "refresh-metadata") {
        highestRosterRevisionSeen = Math.max(highestRosterRevisionSeen, action.rosterRevision);
        void queryClient.invalidateQueries({ queryKey: queryKeys.channel(channelId), exact: true });
      }
    };

    const stream = (async () => {
      for await (const event of channels.events(channelId, {
        signal: controller.signal,
        onReady: resolveReady,
      })) {
        apply(event);
      }
      if (!controller.signal.aborted) throw new Error("Channel event stream closed");
    })();
    void stream.catch((error) => {
      if (!controller.signal.aborted) rejectReady(error instanceof Error ? error : new Error(String(error)));
    });

    setConnection("connecting");
    void (async () => {
      try {
        await ready;
        const [metadata, messages] = await Promise.all([
          channels.getChannel(channelId),
          channels.listMessages(channelId),
        ]);
        if (controller.signal.aborted) return;
        queryClient.setQueryData(queryKeys.channel(channelId), metadata);
        queryClient.setQueryData<ChannelMessage[]>(
          queryKeys.channelMessages(channelId),
          (current) => mergeMessages(current, messages),
        );
        if (highestRosterRevisionSeen > metadata.rosterRevision) {
          await queryClient.invalidateQueries({ queryKey: queryKeys.channel(channelId), exact: true });
        }
        reconnectStreak.current = 0;
        setConnection("live");
        await stream;
      } catch {
        if (controller.signal.aborted) return;
        setConnection("disconnected");
        const delay = Math.min(1_000 * (2 ** reconnectStreak.current), MAX_RECONNECT_DELAY_MS);
        reconnectStreak.current += 1;
        retryTimer = setTimeout(() => setAttempt((current) => current + 1), delay);
      }
    })();

    return () => {
      controller.abort();
      if (retryTimer) clearTimeout(retryTimer);
      rejectReady(new Error("Channel changed"));
      void stream.catch(() => undefined);
    };
  }, [attempt, channelId, queryClient]);

  return {
    connection,
    retry: () => {
      reconnectStreak.current = 0;
      setAttempt((current) => current + 1);
    },
  };
}
