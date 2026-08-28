import type { ChannelEvent, ChannelMessage, ChannelMetadata } from "@minu/channels-core";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { channels } from "./api";
import { mergeMessages } from "./messages";

export type ConnectionState = "connecting" | "live" | "disconnected";

export const channelKeys = {
  metadata: (channelId: string) => ["channel", channelId] as const,
  messages: (channelId: string) => ["channel-messages", channelId] as const,
};

export function useLiveChannel(channelId: string) {
  const queryClient = useQueryClient();
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let settled = false;
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    const apply = (event: ChannelEvent) => {
      if (event.type === "message.created") {
        queryClient.setQueryData<ChannelMessage[]>(
          channelKeys.messages(channelId),
          (current) => mergeMessages(current, [event.message]),
        );
      } else {
        const current = queryClient.getQueryData<ChannelMetadata>(channelKeys.metadata(channelId));
        if (!current || event.rosterRevision > current.rosterRevision) {
          void queryClient.invalidateQueries({ queryKey: channelKeys.metadata(channelId) });
        }
      }
    };

    const stream = (async () => {
      try {
        for await (const event of channels.events(channelId, {
          signal: controller.signal,
          onReady: resolveReady,
        })) {
          apply(event);
        }
        if (!controller.signal.aborted) throw new Error("Channel event stream closed");
      } catch (error) {
        if (controller.signal.aborted) return;
        const normalized = error instanceof Error ? error : new Error(String(error));
        rejectReady(normalized);
      }
    })();

    void (async () => {
      try {
        await ready;
        const [metadata, messages] = await Promise.all([
          channels.getChannel(channelId),
          channels.listMessages(channelId),
        ]);
        if (controller.signal.aborted) return;
        queryClient.setQueryData(channelKeys.metadata(channelId), metadata);
        queryClient.setQueryData<ChannelMessage[]>(
          channelKeys.messages(channelId),
          (current) => mergeMessages(current, messages),
        );
        settled = true;
        setConnection("live");
        await stream;
        if (!controller.signal.aborted) setConnection("disconnected");
      } catch {
        if (!controller.signal.aborted) setConnection("disconnected");
      }
    })();

    setConnection("connecting");
    return () => {
      controller.abort();
      if (!settled) rejectReady(new Error("Channel changed"));
      void stream.catch(() => undefined);
    };
  }, [attempt, channelId, queryClient]);

  return {
    connection,
    retry: () => setAttempt((current) => current + 1),
  };
}
