import type { ChannelMessage, Participant } from "@minu/channels-core/types";
import { Menu } from "lucide-react";
import { Fragment, useMemo } from "react";
import { shortId } from "../lib/messages";
import { participantHandle, participantLabel } from "../lib/participants";
import { projectTimeline, type TimelineRow } from "../lib/timeline";
import { MessageMarkdown } from "./message-markdown";

function bodyParts(body: string) {
  return body.split(/(https?:\/\/[^\s]+)/g).map((part, index) =>
    /^https?:\/\//.test(part) ? (
      <a
        key={`${part}-${index}`}
        href={part}
        target="_blank"
        rel="noreferrer noopener"
        className="text-[var(--accent)] underline"
      >
        {part}
      </a>
    ) : (
      <Fragment key={`${part}-${index}`}>{part}</Fragment>
    ),
  );
}

function MessageRow({
  message,
  participants,
  continuation,
}: {
  message: ChannelMessage;
  participants: Participant[];
  continuation: boolean;
}) {
  const author = participants.find(({ id }) => id === message.participantId);
  const targets = message.to.map((id) =>
    id === "@channel" ? "@channel" : `@${participantHandle(participants.find((participant) => participant.id === id), id)}`,
  );
  const timestamp = new Date(message.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

  return (
    <article
      className={`group px-4 sm:px-6 ${continuation ? "py-2" : "border-t border-[var(--border-subtle)] py-4 first:border-t-0"}`}
      aria-label={`Message ${message.sequence} from ${participantLabel(author, message.participantId)}`}
    >
      <div className="mx-auto flex max-w-3xl gap-3">
        {continuation ? (
          <time
            className="w-8 shrink-0 pt-1 text-center font-mono text-[9px] text-transparent group-hover:text-[var(--muted)] group-focus-within:text-[var(--muted)]"
            dateTime={message.createdAt}
            title={timestamp}
          >
            {new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </time>
        ) : (
          <span className="avatar mt-0.5 shrink-0" aria-hidden="true">
            {(author?.displayName ?? author?.handle ?? "?").slice(0, 1).toUpperCase()}
          </span>
        )}
        <div className="min-w-0 flex-1">
          {!continuation ? (
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <strong className="text-sm">{participantLabel(author, message.participantId)}</strong>
              <span className="font-mono text-[10px] text-[var(--muted)]">#{message.sequence}</span>
              <time className="text-[11px] text-[var(--muted)]" dateTime={message.createdAt}>{timestamp}</time>
            </div>
          ) : null}
          {targets.length ? <p className={`${continuation ? "" : "mt-1"} text-[11px] text-[var(--muted)]`}>to {targets.join(", ")}</p> : null}
          {author?.type === "agent" ? (
            <div className={continuation || targets.length ? "mt-1" : "mt-2"}>
              <MessageMarkdown body={message.body} />
            </div>
          ) : (
            <p className={`${continuation || targets.length ? "mt-1" : "mt-2"} whitespace-pre-wrap break-words text-sm leading-6`}>
              {bodyParts(message.body)}
            </p>
          )}
        </div>
      </div>
    </article>
  );
}

function TimelineRowView({ row, participants }: { row: TimelineRow; participants: Participant[] }) {
  if (row.kind === "day-divider") {
    return (
      <div className="relative mx-auto my-3 flex max-w-3xl items-center gap-3 px-4 sm:px-6" role="separator">
        <span className="h-px flex-1 bg-[var(--border-subtle)]" />
        <time className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--muted)]" dateTime={row.day}>
          {new Date(row.createdAt).toLocaleDateString([], { dateStyle: "medium" })}
        </time>
        <span className="h-px flex-1 bg-[var(--border-subtle)]" />
      </div>
    );
  }
  return <MessageRow message={row.message} participants={participants} continuation={row.continuation} />;
}

export function ChannelTimeline({ messages, participants }: { messages: ChannelMessage[]; participants: Participant[] }) {
  const rows = useMemo(() => projectTimeline(messages), [messages]);

  if (!rows.length) {
    return (
      <div className="grid min-h-full place-items-center p-6">
        <div className="empty-state max-w-md text-center">
          <Menu className="mx-auto h-5 w-5" />
          <h2 className="font-semibold">No messages yet</h2>
          <p>Mention an agent below to begin a focused collaboration.</p>
        </div>
      </div>
    );
  }

  return (
    <div role="log" aria-live="polite" aria-relevant="additions" aria-label="Channel messages">
      {rows.map((row) => <TimelineRowView key={row.id} row={row} participants={participants} />)}
    </div>
  );
}
