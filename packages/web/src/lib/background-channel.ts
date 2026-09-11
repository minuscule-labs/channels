import type { ChannelEvent, ChannelMessage } from "@minu/channels-core/types";

export interface BackgroundChannelConnection {
  channelId: string;
  currentMessages: () => ChannelMessage[] | undefined;
  listMessages: (options: { afterSequence: number; limit: number }) => Promise<ChannelMessage[]>;
  onLiveMessage: (message: ChannelMessage) => void;
  onCatchUpMessage: (message: ChannelMessage) => void;
  onRosterUpdated: () => void;
}

export async function runBackgroundChannelsConnection(input: {
  signal: AbortSignal;
  channels: readonly BackgroundChannelConnection[];
  events: (options: { signal: AbortSignal; onReady: () => void }) => AsyncIterable<ChannelEvent>;
}) {
  if (input.channels.length === 0) return;
  const streamController = new AbortController();
  const abortStream = () => streamController.abort();
  if (input.signal.aborted) abortStream();
  else input.signal.addEventListener("abort", abortStream, { once: true });
  const byId = new Map(input.channels.map((channel) => [channel.channelId, channel]));
  // Fence every catch-up cursor before opening the shared stream. Live events may merge
  // immediately, but they must not move a Channel cursor past older pages still in flight.
  const catchUpSequences = new Map(input.channels.map((channel) => [
    channel.channelId,
    channel.currentMessages()?.at(-1)?.sequence ?? 0,
  ]));
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let readySignaled = false;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = () => {
      readySignaled = true;
      resolve();
    };
    rejectReady = reject;
  });
  const stream = (async () => {
    for await (const event of input.events({ signal: streamController.signal, onReady: resolveReady })) {
      const channel = byId.get(event.channelId);
      if (!channel) continue;
      if (event.type === "message.created") channel.onLiveMessage(event.message);
      else if (event.type === "roster.updated") channel.onRosterUpdated();
    }
  })();
  void stream.then(
    () => { if (!readySignaled) rejectReady(new Error("Channel event stream closed before readiness")); },
    (error) => rejectReady(error instanceof Error ? error : new Error(String(error))),
  );

  try {
    await ready;
    for (const channel of input.channels) {
      let catchUpSequence = catchUpSequences.get(channel.channelId) ?? 0;
      while (!input.signal.aborted) {
        const page = await channel.listMessages({ afterSequence: catchUpSequence, limit: 100 });
        if (!page.length) break;
        for (const message of page) channel.onCatchUpMessage(message);
        catchUpSequence = page.at(-1)!.sequence;
        if (page.length < 100) break;
      }
    }
    await stream;
  } finally {
    streamController.abort();
    input.signal.removeEventListener("abort", abortStream);
    void stream.catch(() => undefined);
  }
}
