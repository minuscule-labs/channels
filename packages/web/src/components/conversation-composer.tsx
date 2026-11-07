import type { ConversationMessage, Participant } from "@minu/channels-core/types";
import { hasChannelMentionCollision, mentionHandles } from "@minu/channels-core/mentions";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ImagePlus, LoaderCircle, RotateCcw, Send, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { localControl } from "../lib/api";
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
import { messageRecipients, readRecipient, readRecipientOverride, recipientStorageKey, writeRecipient, writeRecipientOverride } from "../lib/recipient-selection";
import { ErrorNotice } from "./ui/error-notice";
import { SkillPicker } from "./skill-picker";
import { createSkillRequest, inspectSkillRequest, publishSkillRequest, readSkillChoice, readSkillRequest, skillAvailability, skillsCommand, submitSkillRequest, type SkillChoice, type SkillRequest } from "../lib/skills";

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
  agents,
  activity,
  readOnlyReason,
  thread = false,
  defaultRecipientId,
}: {
  participants: Participant[];
  workspaceId: string;
  conversationId: string;
  currentHumanIdentityId?: string;
  identityStatus: "loading" | "ready" | "unavailable";
  agents?: ReadonlyArray<{ identityId: string; state: string }>;
  activity?: ReactNode;
  readOnlyReason?: string;
  thread?: boolean;
  defaultRecipientId?: string;
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
  const skillKey = `${storageKey}.skill`;
  const skillRequestKey = `${storageKey}.skill-request`;
  const [skill, setSkill] = useState(() => readSkillChoice(localStorage.getItem(skillKey)));
  const [skillRequest, setSkillRequest] = useState(() => readSkillRequest(localStorage.getItem(skillRequestKey), activeAuthorId));
  const [pickerOpen, setPickerOpen] = useState(() => Boolean(skillsCommand(body)));
  const [skillError, setSkillError] = useState<string>();
  const skillBusy = useRef(false);
  const currentSkillKey = useRef(skillRequestKey);
  currentSkillKey.current = skillRequestKey;
  useEffect(() => {
    currentSkillKey.current = skillRequestKey;
    return () => { currentSkillKey.current = ""; };
  }, [skillRequestKey]);
  useEffect(() => {
    setSkill(readSkillChoice(localStorage.getItem(skillKey)));
    setSkillRequest(readSkillRequest(localStorage.getItem(skillRequestKey), activeAuthorId));
    setSkillError(undefined);
  }, [skillKey, skillRequestKey, activeAuthorId]);
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

  const recipientKey = recipientStorageKey(workspaceId, conversationId, activeAuthorId);
  const [storedRecipient, setStoredRecipient] = useState(() => readRecipient(recipientKey));
  const initialFailure = failedSubmission?.input.participantId === activeAuthorId && failedSubmission.input.body === body ? failedSubmission : undefined;
  const [manualTargets, setManualTargets] = useState<string[] | undefined>(() => initialFailure?.input.to
    ?? readRecipientOverride(`${storageKey}.recipients`, body)
    ?? (skill && skillRequest?.input.arguments === body ? skillRequest.input.to : undefined));
  const [replyTo, setReplyTo] = useState<string | undefined>(() => initialFailure?.input.replyTo);
  const selectedRecipient = storedRecipient ?? defaultRecipientId ?? "";
  const skillCommand = skillsCommand(body);
  const skillMode = Boolean(skill || skillCommand);
  const recipients = messageRecipients(body, participants, selectedRecipient,
    skillMode ? manualTargets ?? (selectedRecipient ? [selectedRecipient] : []) : manualTargets);
  const targets = recipients.targets;
  const skillDraft = useRef({ actor: activeAuthorId, body, skill, targets });
  skillDraft.current = { actor: activeAuthorId, body, skill, targets };
  const catalog = useQuery({ queryKey: ["skill-catalog", workspaceId, conversationId, activeAuthorId],
    queryFn: () => localControl.getConversationAuthoredSkillCatalog(conversationId),
    enabled: authorReady && (pickerOpen || Boolean(skill)), retry: false, gcTime: 0, refetchInterval: 5_000 });
  const capabilities = useQuery({ queryKey: queryKeys.localCapabilities(), queryFn: () => localControl.capabilities(), enabled: authorReady, retry: false });
  const currentCatalog = catalog.isError ? undefined : catalog.data;
  const skillStatus = skill ? skillAvailability(skill, targets, participants, currentCatalog, agents) : "Unavailable";
  const publicationEnabled = capabilities.data?.features.authoredSkillPublication === true;
  const recipientInvalid = recipients.invalid.length > 0 || targets.some((id) => id !== "@conversation"
    && !participants.some((participant) => participant.id === id && participant.status !== "disabled"));
  const persistRecipient = (id: string) => {
    if (!activeAuthorId) return;
    writeRecipient(recipientKey, id);
    setStoredRecipient(id);
  };
  const targetLabel = (id: string) => id === "@conversation"
    ? hasChannelMentionCollision(participants) ? "@conversation" : "@channel"
    : `@${participants.find((participant) => participant.id === id)?.handle ?? id}`;
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
  const mentionQuery = skillMode ? undefined : mentionQueryAt(body, cursor);
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
    mutationFn: (submission: MessageSubmission) => localControl.postConversationMessage(conversationId, submission.input, { idempotencyKey: submission.idempotencyKey }),
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
        setManualTargets(undefined);
        writeRecipientOverride(`${storageKey}.recipients`, "");
        setReplyTo(undefined);
      }
    },
    onError: (_error, submission) => {
      setFailedSubmission(submission);
      setErrorDismissed(false);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.localConversationAgents(conversationId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceConfiguration(workspaceId) });
    },
  });

  const persistSkillRequest = (request: SkillRequest, key: string) => {
    localStorage.setItem(key, JSON.stringify(request));
    if (currentSkillKey.current === key) setSkillRequest(request);
  };
  const requestMatchesDraft = (request: SkillRequest) => {
    const draft = skillDraft.current;
    return draft.actor === request.actorIdentityId && draft.body === request.input.arguments
      && draft.skill?.documentId === request.input.documentId && draft.skill.source === request.input.source && draft.skill.revision === request.input.revision
      && JSON.stringify([...draft.targets].sort()) === JSON.stringify(request.input.to);
  };
  const settleSkill = (request: SkillRequest, key: string) => {
    persistSkillRequest(request, key);
    if (currentSkillKey.current !== key) return;
    setSkillError(undefined);
    if (request.publication?.status === "observed" && requestMatchesDraft(request)) {
      setBody(""); setCursor(0);
      writeRecipientOverride(`${storageKey}.recipients`, "", request.input.to);
      localStorage.removeItem(draftStorageKey(workspaceId, conversationId, request.actorIdentityId));
    }
    void queryClient.invalidateQueries({ queryKey: queryKeys.conversationMessages(conversationId) });
  };
  const skillMutation = useMutation({
    mutationFn: ({ request, key, publishOnly = false }: { request: SkillRequest; key: string; publishOnly?: boolean }) => {
      const persist = (value: SkillRequest) => persistSkillRequest(value, key);
      return publishOnly ? publishSkillRequest(localControl, conversationId, request, persist)
        : submitSkillRequest(localControl, conversationId, request, persist);
    },
    onSuccess: (request, variables) => settleSkill(request, variables.key),
    onError: (_error, variables) => { if (currentSkillKey.current === variables.key) setSkillError("Submission unconfirmed"); },
    onSettled: () => { skillBusy.current = false; },
  });
  const inspectSkill = useMutation({
    mutationFn: ({ request }: { request: SkillRequest; key: string }) => inspectSkillRequest(localControl, conversationId, request),
    onSuccess: (request, variables) => settleSkill(request, variables.key),
    onError: (_error, variables) => { if (currentSkillKey.current === variables.key) setSkillError("Receipt unavailable"); },
  });
  const selectSkill = (choice: SkillChoice) => {
    const nextBody = skillsCommand(body)?.arguments ?? body;
    setSkill(choice); localStorage.setItem(skillKey, JSON.stringify(choice));
    setBody(nextBody); setCursor(nextBody.length);
    setManualTargets([...targets]); writeRecipientOverride(`${storageKey}.recipients`, nextBody, targets);
    pendingCursorRef.current = nextBody.length;
  };


  const canAttach = Boolean(activeAuthorId) && authorReady && !readOnlyReason && !mutation.isPending && !skillMutation.isPending && !inspectSkill.isPending;
  const unresolvedSkill = Boolean(skillRequest && skillRequest.publication?.status !== "observed");
  const canSubmit = (Boolean(skill) || Boolean(body.trim()) || imageDraft.ids.length > 0) && imageDraft.ready && !bodyTooLarge && !recipientInvalid && canAttach
    && !skillCommand && (!skill || (skillStatus === "Ready" && publicationEnabled && !unresolvedSkill && !imageDraft.ids.length && !replyTo));
  const canPublishAccepted = canAttach && imageDraft.ready && !bodyTooLarge && !recipientInvalid && !skillCommand
    && skillStatus === "Ready" && publicationEnabled && !imageDraft.ids.length && !replyTo && skillRequest && requestMatchesDraft(skillRequest);
  const submit = (submission?: MessageSubmission) => {
    if (!canSubmit) return;
    if (skill) {
      if (skillBusy.current) return;
      const request = createSkillRequest(activeAuthorId, skill, body, targets);
      persistSkillRequest(request, skillRequestKey);
      skillBusy.current = true; setSkillError(undefined);
      skillMutation.mutate({ request, key: skillRequestKey });
      return;
    }
    // Dismissing feedback must not discard the key of an ambiguously failed send.
    const matchingFailure = failedSubmission && submissionMatchesDraft(failedSubmission, activeAuthorId, body, participants, imageDraft.ids, targets, replyTo)
      ? failedSubmission
      : undefined;
    const next = submission ?? matchingFailure ?? createMessageSubmission(activeAuthorId, body, participants, undefined, imageDraft.ids, targets, replyTo);
    if (next.input.to?.length === 1 && next.input.to[0] !== "@conversation") persistRecipient(next.input.to[0]!);
    // Persist before the request: a lost response or navigation must retain the same retry key.
    localStorage.setItem(`${storageKey}.submission`, JSON.stringify(next));
    setFailedSubmission(next);
    mutation.mutate(next);
  };

  const updateBody = (nextBody: string, nextCursor: number) => {
    setBody(nextBody);
    setCursor(nextCursor);
    setDismissedMention(undefined);
    const nextCommand = skillsCommand(nextBody);
    if (nextCommand) setPickerOpen(true);
    const enteringSkillMode = !skillMode && Boolean(nextCommand);
    const leavingSkillCommand = !skill && Boolean(skillCommand) && !nextCommand;
    const override = leavingSkillCommand ? undefined : enteringSkillMode ? [...targets]
      : skillMode || mentionHandles(nextBody).join("\0") === mentionHandles(body).join("\0") ? manualTargets : undefined;
    if (override !== manualTargets) setManualTargets(override);
    if (override !== manualTargets || skillMode) writeRecipientOverride(`${storageKey}.recipients`, nextBody, override);
    const nextTargets = messageRecipients(nextBody, participants, selectedRecipient, override).targets;
    if (failedSubmission && !submissionMatchesDraft(failedSubmission, activeAuthorId, nextBody, participants, imageDraft.ids, nextTargets, replyTo)) {
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
    && submissionMatchesDraft(failedSubmission, activeAuthorId, body, participants, imageDraft.ids, targets, replyTo);

  return (
    <div className="bg-[var(--bg)] px-3 pt-3 pb-1 sm:px-6">
      <div className="relative mx-auto max-w-5xl">
        <SkillPicker open={pickerOpen && authorReady} onOpenChange={setPickerOpen} initialQuery={skillCommand?.query ?? ""}
          catalog={currentCatalog} loading={catalog.isPending} error={catalog.isError} targets={targets} participants={participants} agents={agents} onSelect={selectSkill} />
        {skill && authorReady ? <div aria-label="Selected skill" className="mb-2 flex items-center gap-2 text-xs">
          <span>{skill.name} · {skill.source === "channel" ? "Channel" : "Workspace"} · r{skill.revision}</span>
          <span role="status">{!publicationEnabled ? "Unavailable" : imageDraft.ids.length || replyTo ? "Unsupported draft" : skillStatus}</span>
          <button type="button" className="icon-button" aria-label="Remove skill" disabled={!canAttach}
            onClick={() => {
              setSkill(undefined); localStorage.removeItem(skillKey);
              setManualTargets(undefined); writeRecipientOverride(`${storageKey}.recipients`, body);
            }}><X className="h-3 w-3" /></button>
        </div> : null}
        {skillRequest && authorReady ? <div aria-label="Skill receipt" className="mb-2 flex flex-wrap items-center gap-2 text-xs">
          <span role="status">{skillRequest.publication?.status === "observed" ? "Published" : skillRequest.publication?.status === "not_observed" ? "Unresolved"
            : skillRequest.publication?.status === "not_linked" ? "Not linked" : skillRequest.accepted ? "Accepted" : "Unconfirmed"}</span>
          <button className="button-secondary" type="button" disabled={!canAttach}
            onClick={() => inspectSkill.mutate({ request: skillRequest, key: skillRequestKey })}>Inspect receipt</button>
          {skillRequest.accepted && !skillRequest.publicationAttempted ? <button className="button-secondary" type="button"
            disabled={!canPublishAccepted} onClick={() => {
              if (!canPublishAccepted || skillBusy.current) return; skillBusy.current = true;
              skillMutation.mutate({ request: skillRequest, key: skillRequestKey, publishOnly: true });
            }}>Publish accepted</button> : null}
          <button className="button-secondary" type="button" disabled={!canAttach || (skillRequest.publicationAttempted && skillRequest.publication?.status !== "observed")}
            onClick={() => {
              localStorage.setItem(`${skillRequestKey}.previous`, JSON.stringify(skillRequest));
              localStorage.removeItem(skillRequestKey); setSkillRequest(undefined); setSkillError(undefined);
            }}>New request</button>
        </div> : null}
        {skillError ? <span role="alert" className="mb-2 block text-xs text-[var(--danger)]">{skillError}</span> : null}
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
            readOnly={mutation.isPending || skillMutation.isPending}
            aria-busy={mutation.isPending || skillMutation.isPending}
            className="block w-full resize-none overflow-y-hidden bg-transparent px-3 py-2.5 text-sm leading-5 outline-none placeholder:text-[var(--muted)]"
          />
          <div className="flex flex-wrap items-center justify-between gap-3 px-2.5 py-2">
            {skillMode && authorReady ? <select
              aria-label="Skill recipients"
              className="button-secondary min-w-0 max-w-64"
              disabled={!canAttach}
              value={recipients.invalid.length ? "__invalid__" : targets.length > 1 ? "__multiple__" : targets[0] ?? ""}
              onChange={(event) => {
                const id = event.target.value;
                if (id !== "@conversation") persistRecipient(id);
                setManualTargets(id ? [id] : []);
                writeRecipientOverride(`${storageKey}.recipients`, body, id ? [id] : []);
                setReplyTo(undefined);
                setFailedSubmission(undefined);
                mutation.reset();
                textareaRef.current?.focus();
              }}
            >
              <option value="">No recipient</option>
              <option value="@conversation">{targetLabel("@conversation")}</option>
              {participants.filter(({ status }) => status !== "disabled").map(({ id }) => <option key={id} value={id}>{targetLabel(id)}</option>)}
              {targets.length > 1 ? <option value="__multiple__" disabled>{targets.map(targetLabel).join(", ")}</option> : null}
              {recipients.invalid.length ? <option value="__invalid__" disabled>{recipients.invalid.map((handle) => `@${handle}`).join(", ")}</option> : null}
              {targets.length === 1 && targets[0] !== "@conversation" && !participants.some(({ id, status }) => id === targets[0] && status !== "disabled")
                ? <option value={targets[0]} disabled>{targetLabel(targets[0]!)}</option> : null}
            </select> : null}
            <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden aria-label="Choose images"
              onChange={(event) => { imageDraft.add(Array.from(event.target.files ?? [])); event.target.value = ""; }} disabled={!canAttach} />
            <button type="button" className="button-secondary" aria-label="Attach images" title="Attach images" disabled={!canAttach}
              onClick={() => fileInputRef.current?.click()}><ImagePlus className="h-3.5 w-3.5" /></button>
            <div className="flex items-center gap-2">
              <button type="button" className="button-secondary" disabled={!canAttach} onClick={() => setPickerOpen(true)}>Skills</button>
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
                aria-label={skill ? skillMutation.isPending ? "Submitting skill" : "Send skill" : mutation.isPending ? "Sending message" : "Send message"}
                title={skill ? "Send skill" : mutation.isPending ? "Sending message" : "Send message"}
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
        {!skillMode && retryAvailable ? (
          <button className="button-secondary mt-2" type="button" onClick={() => submit(failedSubmission)}>
            <RotateCcw className="h-3.5 w-3.5" /> Retry same message
          </button>
        ) : null}
      </div>
    </div>
  );
}
