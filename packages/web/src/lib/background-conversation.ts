import type { ConversationEvent, ConversationMessage } from "@minu/channels-core/types";

export interface BackgroundConversationConnection {
  conversationId: string;
  currentMessages: () => ConversationMessage[] | undefined;
  listMessages: (options: { afterSequence: number; limit: number }) => Promise<ConversationMessage[]>;
  onLiveMessage: (message: ConversationMessage) => void;
  onCatchUpMessage: (message: ConversationMessage) => void;
  onRosterUpdated: () => void;
}

export async function runBackgroundConversationsConnection(input: {
  signal: AbortSignal;
  conversations: readonly BackgroundConversationConnection[];
  events: (options: { signal: AbortSignal; onReady: () => void }) => AsyncIterable<ConversationEvent>;
}) {
  if (input.conversations.length === 0) return;
  const streamController = new AbortController();
  const abortStream = () => streamController.abort();
  if (input.signal.aborted) abortStream();
  else input.signal.addEventListener("abort", abortStream, { once: true });
  const byId = new Map(input.conversations.map((conversation) => [conversation.conversationId, conversation]));
  // Fence every catch-up cursor before opening the shared stream. Live events may merge
  // immediately, but they must not move a Conversation cursor past older pages still in flight.
  const catchUpSequences = new Map(input.conversations.map((conversation) => [
    conversation.conversationId,
    conversation.currentMessages()?.at(-1)?.sequence ?? 0,
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
      const conversation = byId.get(event.conversationId);
      if (!conversation) continue;
      if (event.type === "message.created") conversation.onLiveMessage(event.message);
      else if (event.type === "roster.updated") conversation.onRosterUpdated();
    }
  })();
  void stream.then(
    () => { if (!readySignaled) rejectReady(new Error("Conversation event stream closed before readiness")); },
    (error) => rejectReady(error instanceof Error ? error : new Error(String(error))),
  );

  try {
    await ready;
    for (const conversation of input.conversations) {
      let catchUpSequence = catchUpSequences.get(conversation.conversationId) ?? 0;
      while (!input.signal.aborted) {
        const page = await conversation.listMessages({ afterSequence: catchUpSequence, limit: 100 });
        if (!page.length) break;
        for (const message of page) conversation.onCatchUpMessage(message);
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
