import type { ConversationEvent, ConversationMessage } from "@minu/channels-core/types";
import type { SharedEventOptions } from "./shared-conversation-events";

export interface BackgroundConversationConnection {
  conversationId: string;
  currentMessages: () => ConversationMessage[] | undefined;
  listMessages: (options: { afterSequence: number; limit: number; signal: AbortSignal }) => Promise<ConversationMessage[]>;
  onLiveMessage: (message: ConversationMessage) => void;
  onCatchUpMessage: (message: ConversationMessage) => void;
  onRosterUpdated: () => void;
}

export async function runBackgroundConversationsConnection(input: {
  signal: AbortSignal;
  conversations: readonly BackgroundConversationConnection[];
  events: (options: SharedEventOptions) => AsyncIterable<ConversationEvent>;
}) {
  if (input.conversations.length === 0 || input.signal.aborted) return;
  const controller = new AbortController();
  const abortStream = () => controller.abort();
  input.signal.addEventListener("abort", abortStream, { once: true });
  const byId = new Map(input.conversations.map((conversation) => [conversation.conversationId, conversation]));
  let cursors = new Map<string, number>();
  let pending = 0;
  let ready = false;
  let catchUp = Promise.resolve();
  let fail!: (error: unknown) => void;
  const failure = new Promise<never>((_resolve, reject) => { fail = reject; });
  const fence = () => {
    // An in-flight catch-up may still have gaps below the highest live message.
    // Retain its older fence until it completes, including across worker reconnects.
    if (pending) return;
    cursors = new Map(input.conversations.map((conversation) => [
      conversation.conversationId, conversation.currentMessages()?.at(-1)?.sequence ?? 0,
    ]));
  };
  fence();
  const reconcile = () => {
    ready = true;
    const snapshot = new Map(cursors);
    pending++;
    catchUp = catchUp.then(async () => {
      for (const conversation of input.conversations) {
        let sequence = snapshot.get(conversation.conversationId) ?? 0;
        while (!controller.signal.aborted) {
          const page = await conversation.listMessages({ afterSequence: sequence, limit: 100, signal: controller.signal });
          if (controller.signal.aborted || !page.length) break;
          for (const message of page) conversation.onCatchUpMessage(message);
          sequence = page.at(-1)!.sequence;
          if (page.length < 100) break;
        }
      }
    }).catch((error) => { fail(error); controller.abort(); }).finally(() => { pending--; });
  };
  const stream = (async () => {
    for await (const event of input.events({ signal: controller.signal, onConnecting: fence, onReady: reconcile })) {
      if (controller.signal.aborted) break;
      const conversation = byId.get(event.conversationId);
      if (!conversation) continue;
      if (event.type === "message.created") conversation.onLiveMessage(event.message);
      else if (event.type === "roster.updated") conversation.onRosterUpdated();
    }
    if (!ready && !controller.signal.aborted) throw new Error("Conversation event stream closed before readiness");
    await catchUp;
  })();
  try {
    await Promise.race([stream, failure]);
  } finally {
    controller.abort();
    input.signal.removeEventListener("abort", abortStream);
    void stream.catch(() => undefined);
  }
}
