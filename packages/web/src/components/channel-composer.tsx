import type { ChannelMessage, Participant } from "@minu/channels-core/types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RotateCcw, Send } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { channels } from "../lib/api";
import {
  createMessageSubmission,
  draftStorageKey,
  MAX_MESSAGE_BYTES,
  mentionQueryAt,
  messageByteLength,
  replaceMention,
  submissionMatchesDraft,
  type MessageSubmission,
} from "../lib/composer";
import { mergeMessages } from "../lib/messages";
import { queryKeys } from "../lib/query-keys";

interface MentionSuggestion {
  id: string;
  handle: string;
  label: string;
}

function readDraft(workspaceId: string, channelId: string, authorIdentityId: string): string {
  if (!authorIdentityId) return "";
  return localStorage.getItem(draftStorageKey(workspaceId, channelId, authorIdentityId)) ?? "";
}

export function ChannelComposer({
  participants,
  workspaceId,
  channelId,
  currentHumanIdentityId,
  identityStatus,
}: {
  participants: Participant[];
  workspaceId: string;
  channelId: string;
  currentHumanIdentityId?: string;
  identityStatus: "loading" | "ready" | "unavailable";
}) {
  const queryClient = useQueryClient();
  const currentHuman = participants.find((participant) =>
    participant.id === currentHumanIdentityId
    && participant.type === "human"
    && participant.status !== "disabled");
  const activeAuthorId = currentHuman?.id ?? "";
  const authorReady = Boolean(currentHuman);
  const [body, setBody] = useState(() => readDraft(workspaceId, channelId, activeAuthorId));
  const [cursor, setCursor] = useState(body.length);
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const [dismissedMention, setDismissedMention] = useState<string>();
  const [failedSubmission, setFailedSubmission] = useState<MessageSubmission>();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const pendingCursorRef = useRef<number | undefined>(undefined);
  const draftRef = useRef({ authorId: activeAuthorId, body });
  draftRef.current = { authorId: activeAuthorId, body };

  useEffect(() => {
    if (!activeAuthorId) return;
    const key = draftStorageKey(workspaceId, channelId, activeAuthorId);
    if (body) localStorage.setItem(key, body);
    else localStorage.removeItem(key);
  }, [activeAuthorId, body, channelId, workspaceId]);

  useLayoutEffect(() => {
    const pendingCursor = pendingCursorRef.current;
    if (pendingCursor === undefined) return;
    pendingCursorRef.current = undefined;
    textareaRef.current?.focus();
    textareaRef.current?.setSelectionRange(pendingCursor, pendingCursor);
  }, [body]);

  const bodyBytes = useMemo(() => messageByteLength(body), [body]);
  const bodyTooLarge = bodyBytes > MAX_MESSAGE_BYTES;
  const mentionQuery = mentionQueryAt(body, cursor);
  const mentionIdentity = mentionQuery ? `${mentionQuery.start}:${mentionQuery.end}:${mentionQuery.value}` : undefined;
  const suggestions = useMemo<MentionSuggestion[]>(() => {
    if (!mentionQuery || dismissedMention === mentionIdentity) return [];
    return [
      { id: "@channel", handle: "channel", label: "Everyone allowed by wake policy" },
      ...participants
        .filter((participant) => participant.status !== "disabled")
        .map((participant) => ({
          id: participant.id,
          handle: participant.handle ?? participant.id,
          label: `${participant.displayName ?? participant.type} · ${participant.type}`,
        })),
    ].filter(({ handle }) => handle.toLowerCase().startsWith(mentionQuery.value)).slice(0, 6);
  }, [dismissedMention, mentionIdentity, mentionQuery, participants]);

  useEffect(() => setSelectedSuggestion(0), [mentionIdentity, suggestions.length]);
  const activeSuggestionIndex = Math.min(selectedSuggestion, Math.max(0, suggestions.length - 1));

  const mutation = useMutation({
    mutationFn: (submission: MessageSubmission) => channels.postMessage(channelId, submission.input, {
      idempotencyKey: submission.idempotencyKey,
    }),
    onSuccess: (message, submission) => {
      queryClient.setQueryData<ChannelMessage[]>(
        queryKeys.channelMessages(channelId),
        (current) => mergeMessages(current, [message]),
      );
      localStorage.removeItem(draftStorageKey(workspaceId, channelId, submission.input.participantId));
      setFailedSubmission(undefined);
      if (draftRef.current.authorId === submission.input.participantId && draftRef.current.body === submission.input.body) {
        setBody("");
        setCursor(0);
      }
    },
    onError: (_error, submission) => setFailedSubmission(submission),
  });

  const canSubmit = Boolean(body.trim()) && !bodyTooLarge && Boolean(activeAuthorId) && authorReady && !mutation.isPending;
  const submit = (submission?: MessageSubmission) => {
    if (!canSubmit && !submission) return;
    mutation.mutate(submission ?? createMessageSubmission(activeAuthorId, body, participants));
  };

  const updateBody = (nextBody: string, nextCursor: number) => {
    setBody(nextBody);
    setCursor(nextCursor);
    setDismissedMention(undefined);
    if (failedSubmission && !submissionMatchesDraft(failedSubmission, activeAuthorId, nextBody, participants)) {
      setFailedSubmission(undefined);
      mutation.reset();
    }
  };

  const insertLineBreak = () => {
    const start = textareaRef.current?.selectionStart ?? cursor;
    const end = textareaRef.current?.selectionEnd ?? start;
    const nextBody = `${body.slice(0, start)}\n${body.slice(end)}`;
    const nextCursor = start + 1;
    pendingCursorRef.current = nextCursor;
    updateBody(nextBody, nextCursor);
  };

  const insertMention = (suggestion: MentionSuggestion) => {
    if (!mentionQuery) return;
    const next = replaceMention(body, mentionQuery, suggestion.handle);
    pendingCursorRef.current = next.cursor;
    updateBody(next.body, next.cursor);
    setDismissedMention(`${next.cursor}:${next.cursor}:`);
  };

  const retryAvailable = failedSubmission
    && submissionMatchesDraft(failedSubmission, activeAuthorId, body, participants)
    && !mutation.isPending;

  return (
    <div className="border-t border-[var(--border)] bg-[var(--panel)] px-3 py-3 sm:px-6">
      <div className="relative mx-auto max-w-3xl">
        {suggestions.length ? (
          <div
            id="channel-mention-suggestions"
            role="listbox"
            aria-label="Mention suggestions"
            className="absolute right-0 bottom-[calc(100%+0.5rem)] left-0 z-20 rounded-md border border-[var(--border)] bg-[var(--panel-elevated)] p-1 shadow-xl"
          >
            {suggestions.map((suggestion, index) => (
              <button
                id={`mention-suggestion-${index}`}
                key={suggestion.id}
                type="button"
                role="option"
                aria-selected={index === activeSuggestionIndex}
                className={`flex w-full items-center justify-between rounded px-2.5 py-2 text-left text-sm ${
                  index === activeSuggestionIndex ? "bg-[var(--selected)]" : "hover:bg-[var(--hover)]"
                }`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => insertMention(suggestion)}
              >
                <span className="font-mono">@{suggestion.handle}</span>
                <span className="truncate pl-4 text-xs text-[var(--muted)]">{suggestion.label}</span>
              </button>
            ))}
          </div>
        ) : null}
        <div className="composer rounded-lg border border-[var(--border)] bg-[var(--bg)] focus-within:border-[var(--accent)]">
          <textarea
            ref={textareaRef}
            value={body}
            onChange={(event) => updateBody(event.target.value, event.target.selectionStart)}
            onSelect={(event) => {
              setCursor(event.currentTarget.selectionStart);
              setDismissedMention(undefined);
            }}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={(event) => {
              composingRef.current = false;
              setCursor(event.currentTarget.selectionStart);
            }}
            onKeyDown={(event) => {
              if (composingRef.current || event.nativeEvent.isComposing) return;
              if (suggestions.length && mentionQuery) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const direction = event.key === "ArrowDown" ? 1 : -1;
                  setSelectedSuggestion((current) => (current + direction + suggestions.length) % suggestions.length);
                  return;
                }
                if (event.key === "Tab" || (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.shiftKey)) {
                  event.preventDefault();
                  insertMention(suggestions[activeSuggestionIndex]!);
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setDismissedMention(mentionIdentity);
                  return;
                }
              }
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                insertLineBreak();
                return;
              }
              if (event.key === "Enter" && !event.shiftKey && canSubmit) {
                event.preventDefault();
                submit();
              }
            }}
            rows={3}
            aria-label="Channel message"
            aria-autocomplete="list"
            aria-controls={suggestions.length ? "channel-mention-suggestions" : undefined}
            aria-expanded={suggestions.length > 0}
            aria-activedescendant={suggestions.length ? `mention-suggestion-${activeSuggestionIndex}` : undefined}
            role="combobox"
            placeholder={authorReady
              ? "Message this Channel… Use @ to mention an agent."
              : identityStatus === "loading"
                ? "Loading your browser identity…"
                : identityStatus === "unavailable"
                  ? "Relaunch MinuChannels to restore your browser identity."
                  : "You are not an active human participant in this Channel."}
            disabled={!activeAuthorId || !authorReady || mutation.isPending}
            className="block w-full resize-none bg-transparent px-3 py-2.5 text-sm outline-none placeholder:text-[var(--muted)]"
          />
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border-subtle)] px-2.5 py-2">
            <span className="min-w-0 text-xs text-[var(--muted)]">
              {currentHuman
                ? <>Sending as <strong className="font-mono font-medium text-[var(--text)]">@{currentHuman.handle ?? currentHuman.id}</strong></>
                : identityStatus === "loading"
                  ? "Loading your identity…"
                  : identityStatus === "unavailable"
                    ? "Browser identity unavailable"
                    : "Current human is not an active Channel participant"}
            </span>
            <span className="text-[10px] text-[var(--muted)]">Enter sends · Shift or ⌘/Ctrl + Enter adds a line · @mention wakes an agent</span>
            <div className="ml-auto flex items-center gap-2">
              <span className={`font-mono text-[10px] ${bodyTooLarge ? "text-[var(--danger)]" : "text-[var(--muted)]"}`}>
                {bodyBytes.toLocaleString()} / {MAX_MESSAGE_BYTES.toLocaleString()} B
              </span>
              <button
                className="button-primary"
                type="button"
                disabled={!canSubmit}
                onClick={() => submit()}
              >
                <Send className="h-3.5 w-3.5" />
                {mutation.isPending ? "Sending…" : "Send"}
              </button>
            </div>
          </div>
        </div>
        {mutation.error ? (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--danger)]" role="alert">
            <span>{mutation.error.message}. Your draft was preserved.</span>
            {retryAvailable ? (
              <button className="button-secondary" type="button" onClick={() => submit(failedSubmission)}>
                <RotateCcw className="h-3.5 w-3.5" /> Retry same message
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
