import type { ConversationMetadata, Participant } from "./types.ts";

/** Mask non-addressing Markdown without changing offsets used by the composer. */
export function recipientText(body: string): string {
  let fence: { character: string; length: number } | undefined;
  let quoted = false;
  const blank = (text: string) => text.replace(/[^\n]/g, " ");
  const lines = body.split("\n").map((line) => {
    const delimiter = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (delimiter?.[0] === fence.character && delimiter.length >= fence.length
        && line.trim() === delimiter) fence = undefined;
      return blank(line);
    }
    if (delimiter) { fence = { character: delimiter[0]!, length: delimiter.length }; return blank(line); }
    if (!line.trim()) quoted = false;
    if (/^ {0,3}(?:(?:[-+*]|\d+[.)])\s+)*>/.test(line)) quoted = true;
    if (quoted || /^(?: {4}|\t)/.test(line)) return blank(line);
    return line;
  }).join("\n");
  let result = "";
  for (let i = 0; i < lines.length;) {
    const character = lines[i]!;
    if (character === "\\") { result += blank(lines.slice(i, i + 2)); i += 2; continue; }
    if (character === "`") {
      const run = /^`+/.exec(lines.slice(i))![0];
      let end = i + run.length;
      while (end < lines.length) {
        if (lines[end] !== "`") { end++; continue; }
        const closing = /^`+/.exec(lines.slice(end))![0];
        end += closing.length;
        if (closing.length === run.length) break;
      }
      result += blank(lines.slice(i, end)); i = end; continue;
    }
    const closingQuote = character === "“" ? "”" : character === "‘" ? "’" : character;
    if (character === '"' || character === "“" || character === "‘"
      || (character === "'" && (i === 0 || /[\s([{:=,*]/.test(lines[i - 1]!)))) {
      let end = i + 1;
      while (end < lines.length && lines[end] !== closingQuote) {
        end += lines[end] === "\\" ? 2 : 1;
      }
      if (lines[end] === closingQuote) end++;
      result += blank(lines.slice(i, end)); i = end; continue;
    }
    result += character; i++;
  }
  return result;
}

/** Read the whole permitted handle; a word boundary would truncate trailing hyphens. */
export function mentionHandles(body: string): string[] {
  return [...recipientText(body).matchAll(/(?:^|\s)@([a-zA-Z0-9_-]+)/g)].map((match) => match[1]!);
}

/** Both the visible broadcast name and its legacy spelling are protected. */
export function isReservedMentionHandle(handle: string): boolean {
  const normalized = handle.toLowerCase();
  return normalized === "channel" || normalized === "conversation";
}

/** Existing handles retain direct routing until an administrator renames them. */
export function hasChannelMentionCollision(participants: readonly Pick<Participant, "id" | "handle">[]): boolean {
  return participants.some((participant) => participant.id.toLowerCase() === "channel"
    || participant.handle?.toLowerCase() === "channel");
}

export function threadDefaultRecipient(conversation: Pick<ConversationMetadata, "participants" | "thread">): string | undefined {
  const root = conversation.thread?.context.find(({ id }) => id === conversation.thread!.rootMessageId);
  const author = conversation.participants.find(({ id }) => id === root?.participantId);
  const targets = author?.type === "human" ? root?.to ?? [] : author ? [author.id] : [];
  if (targets.length !== 1) return undefined;
  return conversation.participants.find(({ id, type, status }) => id === targets[0]
    && (type === "agent" || type === "service") && status === "active")?.id;
}
