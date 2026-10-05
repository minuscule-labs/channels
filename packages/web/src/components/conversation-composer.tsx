import type { ConversationMessage, Participant } from "@minu/channels-core/types";
import { hasChannelMentionCollision } from "@minu/channels-core/mentions";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, RotateCcw, Send } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { conversations } from "../lib/api";
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
import { ErrorNotice } from "./ui/error-notice";

interface MentionSuggestion {
  id: string;
  handle: string;
  label: string;
}

function readDraft(workspaceId: string, conversationId: string, authorIdentityId: string): string {
  if (!authorIdentityId) return "";
  return localStorage.getItem(draftStorageKey(workspaceId, conversationId, authorIdentityId)) ?? "";
}

export function ConversationComposer({
  participants,
  workspaceId,
  conversationId,
  currentHumanIdentityId,
  identityStatus,
  activity,
  readOnlyReason,
}: {
  participants: Participant[];
  workspaceId: string;
  conversationId: string;
  currentHumanIdentityId?: string;
  identityStatus: "loading" | "ready" | "unavailable";
  activity?: ReactNode;
  readOnlyReason?: string;
}) {
  const queryClient = useQueryClient();
  const currentHuman = participants.find((participant) =>
    participant.id === currentHumanIdentityId
    && participant.type === "human"
    && participant.status !== "disabled");
  const activeAuthorId = currentHuman?.id ?? "";
  const authorReady = Boolean(currentHuman);
  const [body, setBody] = useState(() => readDraft(workspaceId, conversationId, activeAuthorId));
  const [cursor, setCursor] = useState(body.length);
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const [dismissedMention, setDismissedMention] = useState<string>();
  const [failedSubmission, setFailedSubmission] = useState<MessageSubmission>();
  const [errorDismissed, setErrorDismissed] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const pendingCursorRef = useRef<number | undefined>(undefined);
  const draftRef = useRef({ authorId: activeAuthorId, body });
  draftRef.current = { authorId: activeAuthorId, body };

  const resize = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const styles = window.getComputedStyle(textarea);
    const lineHeight = Number.parseFloat(styles.lineHeight) || 20;
    const verticalPadding = Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom);
    const maxHeight = Math.max(lineHeight + verticalPadding, Math.min(lineHeight * 16 + verticalPadding, window.innerHeight * 0.4));
    const minHeight = Math.min(lineHeight * 2 + verticalPadding, maxHeight);
    textarea.style.height = "auto";
    const height = Math.max(minHeight, Math.min(textarea.scrollHeight, maxHeight));
    textarea.style.height = `${height}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  };

  useLayoutEffect(() => {
    resize();
  }, [body]);
  useEffect(() => {
    const observer = new ResizeObserver(resize);
    if (textareaRef.current) observer.observe(textareaRef.current);
    window.addEventListener("resize", resize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, []);

  useEffect(() => {
    if (!activeAuthorId) return;
    const key = draftStorageKey(workspaceId, conversationId, activeAuthorId);
    if (body) localStorage.setItem(key, body);
    else localStorage.removeItem(key);
  }, [activeAuthorId, body, conversationId, workspaceId]);

  useLayoutEffect(() => {
    const pendingCursor = pendingCursorRef.current;
    if (pendingCursor === undefined) return;
    pendingCursorRef.current = undefined;
    textareaRef.current?.focus();
    textareaRef.current?.setSelectionRange(pendingCursor, pendingCursor);
  }, [body]);

  const bodyBytes = useMemo(() => messageByteLength(body), [body]);
  const bodyTooLarge = bodyBytes > MAX_MESSAGE_BYTES;
  const showByteCount = bodyBytes >= MAX_MESSAGE_BYTES * 0.8;
  const byteCountTone = bodyTooLarge ? "text-[var(--danger)]"
    : bodyBytes >= MAX_MESSAGE_BYTES * 0.9 ? "text-[var(--warning)]"
      : "text-[var(--muted)]";
  const mentionQuery = mentionQueryAt(body, cursor);
  const mentionIdentity = mentionQuery ? `${mentionQuery.start}:${mentionQuery.end}:${mentionQuery.value}` : undefined;
  const suggestions = useMemo<MentionSuggestion[]>(() => {
    if (!mentionQuery || dismissedMention === mentionIdentity) return [];
    return [
      {
        id: "@conversation",
        handle: hasChannelMentionCollision(participants) ? "conversation" : "channel",
        label: "Everyone allowed by wake policy",
      },
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
    mutationFn: (submission: MessageSubmission) => conversations.postMessage(conversationId, submission.input, {
      idempotencyKey: submission.idempotencyKey,
    }),
    onSuccess: (message, submission) => {
      queryClient.setQueryData<ConversationMessage[]>(
        queryKeys.conversationMessages(conversationId),
        (current) => mergeMessages(current, [message]),
      );
      localStorage.removeItem(draftStorageKey(workspaceId, conversationId, submission.input.participantId));
      setFailedSubmission(undefined);
      if (draftRef.current.authorId === submission.input.participantId && draftRef.current.body === submission.input.body) {
        setBody("");
        setCursor(0);
      }
    },
    onError: (_error, submission) => {
      setFailedSubmission(submission);
      setErrorDismissed(false);
    },
  });

  const canSubmit = Boolean(body.trim()) && !bodyTooLarge && Boolean(activeAuthorId) && authorReady && !readOnlyReason && !mutation.isPending;
  const submit = (submission?: MessageSubmission) => {
    if (!canSubmit) return;
    // Dismissing feedback must not discard the key of an ambiguously failed send.
    const matchingFailure = failedSubmission && submissionMatchesDraft(failedSubmission, activeAuthorId, body, participants)
      ? failedSubmission
      : undefined;
    mutation.mutate(submission ?? matchingFailure ?? createMessageSubmission(activeAuthorId, body, participants));
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
    if (!mentionQuery || mutation.isPending) return;
    const next = replaceMention(body, mentionQuery, suggestion.handle);
    pendingCursorRef.current = next.cursor;
    updateBody(next.body, next.cursor);
    setDismissedMention(`${next.cursor}:${next.cursor}:`);
  };

  const retryAvailable = canSubmit && failedSubmission
    && submissionMatchesDraft(failedSubmission, activeAuthorId, body, participants);

  return (
    <div className="bg-[var(--bg)] px-3 pt-3 pb-1 sm:px-6">
      <div className="relative mx-auto max-w-5xl">
        {suggestions.length ? (
          <div
            id="conversation-mention-suggestions"
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
              if (composingRef.current || event.nativeEvent.isComposing || mutation.isPending) return;
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
            rows={2}
            aria-label="Conversation message"
            aria-autocomplete="list"
            aria-controls={suggestions.length ? "conversation-mention-suggestions" : undefined}
            aria-expanded={suggestions.length > 0}
            aria-activedescendant={suggestions.length ? `mention-suggestion-${activeSuggestionIndex}` : undefined}
            role="combobox"
            placeholder={readOnlyReason ?? (authorReady
              ? "Message #Channel"
              : identityStatus === "loading"
                ? "Loading your browser identity…"
                : identityStatus === "unavailable"
                  ? "Relaunch MinuChannels to restore your browser identity."
                  : "You are not an active human participant in this Conversation.")}
            disabled={Boolean(readOnlyReason) || !activeAuthorId || !authorReady}
            readOnly={mutation.isPending}
            aria-busy={mutation.isPending}
            className="block w-full resize-none overflow-y-hidden bg-transparent px-3 py-2.5 text-sm leading-5 outline-none placeholder:text-[var(--muted)]"
          />
          <div className="flex flex-wrap items-center justify-end gap-3 px-2.5 py-2">
            <div className="flex items-center gap-2">
              {showByteCount ? (
                <span
                  className={`font-mono text-[10px] ${byteCountTone}`}
                  title={`${bodyBytes.toLocaleString()} of ${MAX_MESSAGE_BYTES.toLocaleString()} bytes`}
                >
                  {Math.ceil(bodyBytes / 1024)} KB of {MAX_MESSAGE_BYTES / 1024} KB
                </span>
              ) : null}
              <button
                className="button-primary composer-send-button"
                type="button"
                aria-label={mutation.isPending ? "Sending message" : "Send message"}
                title={mutation.isPending ? "Sending message" : "Send message"}
                disabled={!canSubmit}
                onClick={() => submit()}
              >
                {mutation.isPending
                  ? <LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
                  : <Send aria-hidden="true" className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>
        </div>
        <div className="min-h-5 pt-1">{activity}</div>
        {mutation.error && !errorDismissed ? (
          <ErrorNotice
            className="mt-2"
            dismissLabel="Dismiss send error"
            onDismiss={() => setErrorDismissed(true)}
          >
            {mutation.error.message}. Your draft was preserved.
          </ErrorNotice>
        ) : null}
        {retryAvailable ? (
          <button className="button-secondary mt-2" type="button" onClick={() => submit(failedSubmission)}>
            <RotateCcw className="h-3.5 w-3.5" /> Retry same message
          </button>
        ) : null}
      </div>
    </div>
  );
}
