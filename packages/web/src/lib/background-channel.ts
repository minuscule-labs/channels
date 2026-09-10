import type { ChannelEvent, ChannelMessage } from "@minu/channels-core/types";

export async function runBackgroundChannelConnection(input: {
  signal: AbortSignal;
  currentMessages: () => ChannelMessage[] | undefined;
  events: (options: { signal: AbortSignal; onReady: () => void }) => AsyncIterable<ChannelEvent>;
  listMessages: (options: { afterSequence: number; limit: number }) => Promise<ChannelMessage[]>;
  onLiveMessage: (message: ChannelMessage) => void;
  onCatchUpMessage: (message: ChannelMessage) => void;
  onRosterUpdated: () => void;
}) {
  // Fence catch-up before opening the stream. Live events may merge immediately, but they must
  // never move this connection's history cursor past older pages that are still in flight.
  let catchUpSequence = input.currentMessages()?.at(-1)?.sequence ?? 0;
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
    for await (const event of input.events({ signal: input.signal, onReady: resolveReady })) {
      if (event.type === "message.created") input.onLiveMessage(event.message);
      else if (event.type === "roster.updated") input.onRosterUpdated();
    }
  })();
  void stream.then(
    () => { if (!readySignaled) rejectReady(new Error("Channel event stream closed before readiness")); },
    (error) => rejectReady(error instanceof Error ? error : new Error(String(error))),
  );

  await ready;
  while (!input.signal.aborted) {
    const page = await input.listMessages({ afterSequence: catchUpSequence, limit: 100 });
    if (!page.length) break;
    for (const message of page) input.onCatchUpMessage(message);
    catchUpSequence = page.at(-1)!.sequence;
    if (page.length < 100) break;
  }
  await stream;
}
