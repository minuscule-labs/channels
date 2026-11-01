import type { ConversationMessage, Participant } from "@minu/channels-core/types";
import { hasChannelMentionCollision } from "@minu/channels-core/mentions";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ImagePlus, LoaderCircle, RotateCcw, Send, X } from "lucide-react";
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
import { imageContentUrl, useImageDraft } from "../lib/image-draft";
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
  thread = false,
}: {
  participants: Participant[];
  workspaceId: string;
  conversationId: string;
  currentHumanIdentityId?: string;
  identityStatus: "loading" | "ready" | "unavailable";
  activity?: ReactNode;
  readOnlyReason?: string;
  thread?: boolean;
}) {
  const queryClient = useQueryClient();
  const mentionListId = `${conversationId}-mention-suggestions`;
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
  const storageKey = draftStorageKey(workspaceId, conversationId, activeAuthorId);
  const imageDraft = useImageDraft(`${storageKey}.images`, conversationId, activeAuthorId);
  const [failedSubmission, setFailedSubmission] = useState<MessageSubmission | undefined>(() => {
    try {
      const value = JSON.parse(localStorage.getItem(`${storageKey}.submission`) ?? "null");
      return value && typeof value.idempotencyKey === "string" && value.input
        && typeof value.input.body === "string" && typeof value.input.participantId === "string"
        && Array.isArray(value.input.to)
        && (value.input.attachmentIds === undefined || (Array.isArray(value.input.attachmentIds)
          && value.input.attachmentIds.every((id: unknown) => typeof id === "string"))) ? value : undefined;
    } catch { return undefined; }
  });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [errorDismissed, setErrorDismissed] = useState(false);
  useEffect(() => {
    if (failedSubmission) localStorage.setItem(`${storageKey}.submission`, JSON.stringify(failedSubmission));
    else localStorage.removeItem(`${storageKey}.submission`);
  }, [failedSubmission, storageKey]);
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
      imageDraft.clear();
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

  const canAttach = Boolean(activeAuthorId) && authorReady && !readOnlyReason && !mutation.isPending;
  const canSubmit = (Boolean(body.trim()) || imageDraft.ids.length > 0) && imageDraft.ready && !bodyTooLarge && canAttach;
  const submit = (submission?: MessageSubmission) => {
    if (!canSubmit) return;
    // Dismissing feedback must not discard the key of an ambiguously failed send.
    const matchingFailure = failedSubmission && submissionMatchesDraft(failedSubmission, activeAuthorId, body, participants, imageDraft.ids)
      ? failedSubmission
      : undefined;
    const next = submission ?? matchingFailure ?? createMessageSubmission(activeAuthorId, body, participants, undefined, imageDraft.ids);
    // Persist before the request: a lost response or navigation must retain the same retry key.
    localStorage.setItem(`${storageKey}.submission`, JSON.stringify(next));
    setFailedSubmission(next);
    mutation.mutate(next);
  };

  const updateBody = (nextBody: string, nextCursor: number) => {
    setBody(nextBody);
    setCursor(nextCursor);
    setDismissedMention(undefined);
    if (failedSubmission && !submissionMatchesDraft(failedSubmission, activeAuthorId, nextBody, participants, imageDraft.ids)) {
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
    && submissionMatchesDraft(failedSubmission, activeAuthorId, body, participants, imageDraft.ids);

  return (
    <div className="bg-[var(--bg)] px-3 pt-3 pb-1 sm:px-6">
      <div className="relative mx-auto max-w-5xl">
        {suggestions.length ? (
          <div
            id={mentionListId}
            role="listbox"
            aria-label="Mention suggestions"
            className="absolute right-0 bottom-[calc(100%+0.5rem)] left-0 z-20 rounded-md border border-[var(--border)] bg-[var(--panel-elevated)] p-1 shadow-xl"
          >
            {suggestions.map((suggestion, index) => (
              <button
                id={`${mentionListId}-${index}`}
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
        <div className="composer rounded-lg border border-[var(--border)] bg-[var(--bg)] focus-within:border-[var(--accent)]"
          onDragOver={(event) => { if (canAttach && event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
          onDrop={(event) => {
            if (!event.dataTransfer.files.length) return;
            event.preventDefault();
            if (canAttach) imageDraft.add(Array.from(event.dataTransfer.files));
          }}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files);
            if (files.length) { event.preventDefault(); if (canAttach) imageDraft.add(files); }
          }}
        >
          {imageDraft.images.length ? <ul aria-label="Message images" className="flex flex-wrap gap-2 px-3 pt-3">
            {imageDraft.images.map((image) => <li key={image.key} className="relative w-28 rounded border border-[var(--border)] p-1">
              {image.preview || image.attachment ? <img
                src={image.preview ?? imageContentUrl(conversationId, image.attachment!.id)}
                alt={image.filename} className="h-16 w-full rounded object-contain" /> : null}
              <span className="block truncate text-[10px]" title={image.filename}>{image.filename}</span>
              {!image.attachment && !image.error ? <LoaderCircle role="status" aria-label={`Uploading ${image.filename}`} className="h-4 w-4 animate-spin" /> : null}
              {image.error ? <span role="alert" className="text-xs text-[var(--danger)]">{image.error}</span> : null}
              <button type="button" aria-label={`Remove ${image.filename}`} disabled={!canAttach}
                className="absolute top-0 right-0 rounded bg-[var(--panel)] p-1" onClick={() => imageDraft.remove(image.key)}><X className="h-3 w-3" /></button>
            </li>)}
          </ul> : null}
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
            aria-label={thread ? "Thread reply" : "Conversation message"}
            aria-autocomplete="list"
            aria-controls={suggestions.length ? mentionListId : undefined}
            aria-expanded={suggestions.length > 0}
            aria-activedescendant={suggestions.length ? `${mentionListId}-${activeSuggestionIndex}` : undefined}
            role="combobox"
            placeholder={readOnlyReason ?? (authorReady
              ? thread ? "Reply in thread" : "Message #Channel"
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
          <div className="flex flex-wrap items-center justify-between gap-3 px-2.5 py-2">
            <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden aria-label="Choose images"
              onChange={(event) => { imageDraft.add(Array.from(event.target.files ?? [])); event.target.value = ""; }} disabled={!canAttach} />
            <button type="button" className="button-secondary" aria-label="Attach images" title="Attach images" disabled={!canAttach}
              onClick={() => fileInputRef.current?.click()}><ImagePlus className="h-3.5 w-3.5" /></button>
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
        {imageDraft.error ? <ErrorNotice className="mt-2" dismissLabel="Dismiss image error" onDismiss={imageDraft.dismissError}>{imageDraft.error}</ErrorNotice> : null}
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
