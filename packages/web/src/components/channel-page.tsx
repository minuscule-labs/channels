import type { ChannelMessage, Participant } from "@minu/channels-core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { AlertCircle, Menu, RefreshCw, Send, Users, X } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { channels } from "../lib/api";
import { channelKeys, useLiveChannel } from "../lib/live-channel";
import { mergeMessages, shortId, structuredTargets } from "../lib/messages";

function participantLabel(participant: Participant | undefined, id: string): string {
  if (!participant) return shortId(id);
  return participant.displayName ?? `@${participant.handle ?? shortId(participant.id)}`;
}

function bodyParts(body: string) {
  return body.split(/(https?:\/\/[^\s]+)/g).map((part, index) =>
    /^https?:\/\//.test(part) ? (
      <a key={`${part}-${index}`} href={part} target="_blank" rel="noreferrer noopener" className="text-[var(--accent)] underline">
        {part}
      </a>
    ) : (
      <Fragment key={`${part}-${index}`}>{part}</Fragment>
    ),
  );
}

function MemberRoster({ participants, onClose }: { participants: Participant[]; onClose?(): void }) {
  return (
    <aside className="flex h-full min-h-0 w-full flex-col border-l border-[var(--border)] bg-[var(--panel)] lg:w-72">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--border)] px-4">
        <div>
          <h2 className="text-sm font-semibold">Participants</h2>
          <p className="text-xs text-[var(--muted)]">{participants.length} in this Channel</p>
        </div>
        {onClose ? (
          <button type="button" className="icon-button inline-flex lg:hidden" onClick={onClose} aria-label="Close participants">
            <X className="h-4 w-4" />
          </button>
        ) : null}
      </div>
      <ul className="minu-scroll min-h-0 flex-1 space-y-1 overflow-y-auto p-3">
        {participants.map((participant) => (
          <li key={participant.id} className="rounded-md px-2.5 py-2 hover:bg-[var(--hover)]">
            <div className="flex items-center gap-2">
              <span className="avatar">{(participant.displayName ?? participant.handle ?? "?").slice(0, 1).toUpperCase()}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{participantLabel(participant, participant.id)}</span>
                  <span className={`status-dot ${participant.status === "disabled" ? "opacity-40" : ""}`} />
                </div>
                <p className="truncate font-mono text-[11px] text-[var(--muted)]">
                  @{participant.handle ?? shortId(participant.id)} · {participant.type}
                </p>
              </div>
            </div>
            {participant.role || participant.profile ? (
              <p className="mt-2 line-clamp-3 pl-9 text-xs leading-5 text-[var(--muted)]">
                {participant.role ? `${participant.role}${participant.profile ? " — " : ""}` : ""}
                {participant.profile}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </aside>
  );
}

function MessageItem({ message, participants }: { message: ChannelMessage; participants: Participant[] }) {
  const author = participants.find(({ id }) => id === message.participantId);
  const targets = message.to.map((id) =>
    id === "@channel" ? "@channel" : `@${participants.find((participant) => participant.id === id)?.handle ?? shortId(id)}`,
  );
  return (
    <article className="group border-b border-[var(--border-subtle)] px-4 py-4 sm:px-6">
      <div className="mx-auto flex max-w-3xl gap-3">
        <span className="avatar mt-0.5 shrink-0">{(author?.displayName ?? author?.handle ?? "?").slice(0, 1).toUpperCase()}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <strong className="text-sm">{participantLabel(author, message.participantId)}</strong>
            <span className="font-mono text-[10px] text-[var(--muted)]">#{message.sequence}</span>
            <time className="text-[11px] text-[var(--muted)]" dateTime={message.createdAt}>
              {new Date(message.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
            </time>
          </div>
          {targets.length ? <p className="mt-1 text-[11px] text-[var(--muted)]">to {targets.join(", ")}</p> : null}
          <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">{bodyParts(message.body)}</p>
        </div>
      </div>
    </article>
  );
}

function Composer({ participants, workspaceId, channelId }: {
  participants: Participant[];
  workspaceId: string;
  channelId: string;
}) {
  const queryClient = useQueryClient();
  const humans = participants.filter((participant) => participant.type === "human" && participant.status !== "disabled");
  const storageKey = `minu.channels.author.${workspaceId}`;
  const [authorId, setAuthorId] = useState(() => localStorage.getItem(storageKey) ?? "");
  const [body, setBody] = useState("");
  const activeAuthorId = humans.some(({ id }) => id === authorId) ? authorId : humans[0]?.id ?? "";
  const bodyBytes = useMemo(() => new TextEncoder().encode(body).byteLength, [body]);
  const bodyTooLarge = bodyBytes > 64 * 1024;
  const mentionPrefix = body.match(/(?:^|\s)@([a-zA-Z0-9_-]*)$/)?.[1]?.toLowerCase();
  const suggestions = mentionPrefix === undefined
    ? []
    : [
        { id: "@channel", handle: "channel", label: "Everyone allowed by wake policy" },
        ...participants
          .filter((participant) => participant.status !== "disabled")
          .map((participant) => ({
            id: participant.id,
            handle: participant.handle ?? participant.id,
            label: participant.displayName ?? participant.type,
          })),
      ].filter(({ handle }) => handle.toLowerCase().startsWith(mentionPrefix)).slice(0, 6);
  const mutation = useMutation({
    mutationFn: () => channels.postMessage(channelId, {
      participantId: activeAuthorId,
      body,
      to: structuredTargets(body, participants),
    }),
    onSuccess: (message) => {
      queryClient.setQueryData<ChannelMessage[]>(
        channelKeys.messages(channelId),
        (current) => mergeMessages(current, [message]),
      );
      setBody("");
    },
  });
  const insertMention = (handle: string) => {
    setBody((current) => current.replace(/@([a-zA-Z0-9_-]*)$/, `@${handle} `));
  };

  return (
    <div className="border-t border-[var(--border)] bg-[var(--panel)] px-3 py-3 sm:px-6">
      <div className="relative mx-auto max-w-3xl">
        {suggestions.length ? (
          <div className="absolute right-0 bottom-[calc(100%+0.5rem)] left-0 z-20 rounded-md border border-[var(--border)] bg-[var(--panel-elevated)] p-1 shadow-xl">
            {suggestions.map((suggestion) => (
              <button
                key={suggestion.id}
                type="button"
                className="flex w-full items-center justify-between rounded px-2.5 py-2 text-left text-sm hover:bg-[var(--hover)]"
                onClick={() => insertMention(suggestion.handle)}
              >
                <span className="font-mono">@{suggestion.handle}</span>
                <span className="truncate pl-4 text-xs text-[var(--muted)]">{suggestion.label}</span>
              </button>
            ))}
          </div>
        ) : null}
        <div className="composer rounded-lg border border-[var(--border)] bg-[var(--bg)] focus-within:border-[var(--accent)]">
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)
                && body.trim() && !bodyTooLarge && activeAuthorId) {
                mutation.mutate();
              }
            }}
            rows={3}
            aria-label="Channel message"
            placeholder={activeAuthorId ? "Message this Channel… Use @ to mention an agent." : "Add a human participant to send messages."}
            disabled={!activeAuthorId || mutation.isPending}
            className="block w-full resize-none bg-transparent px-3 py-2.5 text-sm outline-none placeholder:text-[var(--muted)]"
          />
          <div className="flex items-center justify-between gap-3 border-t border-[var(--border-subtle)] px-2.5 py-2">
            <label className="flex min-w-0 items-center gap-2 text-xs text-[var(--muted)]">
              <span className="shrink-0">Send as</span>
              <select
                value={activeAuthorId}
                onChange={(event) => {
                  setAuthorId(event.target.value);
                  localStorage.setItem(storageKey, event.target.value);
                }}
                className="min-w-0 max-w-44 bg-transparent font-mono text-[var(--text)] outline-none"
              >
                {humans.map((participant) => (
                  <option key={participant.id} value={participant.id}>{participant.displayName ?? participant.handle ?? shortId(participant.id)}</option>
                ))}
              </select>
            </label>
            <div className="ml-auto flex items-center gap-2">
              <span className={`font-mono text-[10px] ${bodyTooLarge ? "text-[var(--danger)]" : "text-[var(--muted)]"}`}>
                {bodyBytes.toLocaleString()} / 65,536 B
              </span>
            <button
              className="button-primary"
              type="button"
              disabled={!body.trim() || bodyTooLarge || !activeAuthorId || mutation.isPending}
              onClick={() => mutation.mutate()}
            >
              <Send className="h-3.5 w-3.5" />
              {mutation.isPending ? "Sending…" : "Send"}
            </button>
            </div>
          </div>
        </div>
        {mutation.error ? <p className="mt-2 text-xs text-[var(--danger)]">{mutation.error.message}</p> : null}
      </div>
    </div>
  );
}

export function ChannelPage() {
  const { workspaceId, channelId } = useParams({ from: "/app/workspaces/$workspaceId/channels/$channelId" });
  const [rosterOpen, setRosterOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const metadata = useQuery({ queryKey: channelKeys.metadata(channelId), queryFn: () => channels.getChannel(channelId) });
  const messages = useQuery({ queryKey: channelKeys.messages(channelId), queryFn: () => channels.listMessages(channelId) });
  const { connection, retry } = useLiveChannel(channelId);
  const participants = metadata.data?.participants ?? [];

  useEffect(() => {
    if (!messages.data?.length) return;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.data?.length]);

  if (metadata.isLoading || messages.isLoading) {
    return <div className="grid h-full place-items-center text-sm text-[var(--muted)]">Loading Channel…</div>;
  }
  if (metadata.error || messages.error || !metadata.data) {
    const error = metadata.error ?? messages.error;
    return (
      <div className="grid h-full place-items-center p-6">
        <div className="empty-state max-w-lg">
          <AlertCircle className="h-5 w-5 text-[var(--danger)]" />
          <h1 className="font-semibold">Unable to open Channel</h1>
          <p>{error instanceof Error ? error.message : "Channel metadata is unavailable."}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-4 pl-14 md:pl-5">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate font-mono text-sm font-semibold">#{shortId(channelId)}</h1>
              <span className={`connection-pill ${connection}`}>
                <span className="status-dot" /> {connection}
              </span>
            </div>
            <p className="truncate text-[11px] text-[var(--muted)]">Workspace {shortId(workspaceId)} · roster {metadata.data.rosterRevision}</p>
          </div>
          {connection === "disconnected" ? (
            <button className="button-secondary" type="button" onClick={retry}>
              <RefreshCw className="h-3.5 w-3.5" /> Retry
            </button>
          ) : null}
          <button className="icon-button inline-flex lg:hidden" type="button" onClick={() => setRosterOpen(true)} aria-label="Show participants">
            <Users className="h-4 w-4" />
          </button>
        </header>
        <div ref={scrollRef} className="minu-scroll min-h-0 flex-1 overflow-y-auto bg-[var(--bg)]" aria-live="polite">
          {messages.data?.length ? (
            messages.data.map((message) => <MessageItem key={message.id} message={message} participants={participants} />)
          ) : (
            <div className="grid min-h-full place-items-center p-6">
              <div className="empty-state max-w-md text-center">
                <Menu className="mx-auto h-5 w-5" />
                <h2 className="font-semibold">No messages yet</h2>
                <p>Mention an agent below to begin a focused collaboration.</p>
              </div>
            </div>
          )}
        </div>
        <Composer participants={participants} workspaceId={workspaceId} channelId={channelId} />
      </section>
      <div className="hidden lg:block">
        <MemberRoster participants={participants} />
      </div>
      {rosterOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button type="button" className="absolute inset-0 bg-black/50" aria-label="Dismiss participants" onClick={() => setRosterOpen(false)} />
          <div className="relative ml-auto h-full w-[min(22rem,92vw)]">
            <MemberRoster participants={participants} onClose={() => setRosterOpen(false)} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
