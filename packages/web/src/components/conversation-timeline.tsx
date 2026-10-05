import type { LocalTurnFailureNotice } from "@minu/channels-control/contracts";
import type { ConversationMessage, Participant } from "@minu/channels-core/types";
import { hasChannelMentionCollision } from "@minu/channels-core/mentions";
import { AlertCircle, Menu } from "lucide-react";
import { useMemo } from "react";
import { shortId } from "../lib/messages";
import { participantHandle, participantLabel } from "../lib/participants";
import { projectTimeline, type TimelineRow } from "../lib/timeline";
import { MessageMarkdown } from "./message-markdown";

type BroadcastTargetLabel = "@channel" | "@conversation";

function MessageRow({
  message,
  participants,
  continuation,
  broadcastTargetLabel,
}: {
  message: ConversationMessage;
  participants: Participant[];
  continuation: boolean;
  broadcastTargetLabel: BroadcastTargetLabel;
}) {
  const author = participants.find(({ id }) => id === message.participantId);
  const targets = message.to.map((id) =>
    id === "@conversation" ? broadcastTargetLabel
      : `@${participantHandle(participants.find((participant) => participant.id === id), id)}`,
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
          <div className={continuation || targets.length ? "mt-1" : "mt-2"}>
            <MessageMarkdown body={message.body} />
          </div>
        </div>
      </div>
    </article>
  );
}

function TimelineRowView({ row, participants, broadcastTargetLabel }: {
  row: TimelineRow;
  participants: Participant[];
  broadcastTargetLabel: BroadcastTargetLabel;
}) {
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
  return <MessageRow message={row.message} participants={participants} continuation={row.continuation} broadcastTargetLabel={broadcastTargetLabel} />;
}

function TurnFailureNoticeRow({ notice, canOpenDetails, onViewDetails }: {
  notice: LocalTurnFailureNotice;
  canOpenDetails: boolean;
  onViewDetails?(identityId: string, trigger: HTMLButtonElement): void;
}) {
  const name = notice.participant.displayLabel;
  const timestamp = new Date(notice.failedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  const content = <>
    <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-[var(--danger)]" />
    <span className="min-w-0 flex-1">
      <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <strong className="text-xs text-[var(--danger)]">Something went wrong with {name}</strong>
        <time className="text-[10px] text-[var(--muted)]" dateTime={notice.failedAt}>{timestamp}</time>
      </span>
      <span className="mt-1 block text-[11px] text-[var(--muted)]">A Runtime turn failed. {canOpenDetails ? <span className="font-medium text-[var(--text)] underline underline-offset-2">View details</span> : "An owner or admin can review the details."}</span>
    </span>
  </>;
  const box = "mx-auto flex w-full max-w-3xl items-start gap-3 rounded-lg border border-[var(--danger)]/30 bg-[var(--panel)] px-3 py-2.5";
  return <div className="px-4 sm:px-6">
    {canOpenDetails && onViewDetails ? <button
      type="button"
      className={`${box} my-2 text-left hover:bg-[var(--hover)]`}
      aria-label={`View Runtime issue details for ${name}`}
      onClick={(event) => onViewDetails(notice.participant.identityId, event.currentTarget)}
    >{content}</button> : <article className={`${box} my-2`} role="status" aria-label={`Issue notice for ${name}`}>{content}</article>}
  </div>;
}

export function ConversationTimeline({
  messages,
  participants,
  attributionParticipants = participants,
  turnFailureNotices = [],
  canOpenIssueDetails = false,
  onViewIssueDetails,
}: {
  messages: ConversationMessage[];
  participants: Participant[];
  attributionParticipants?: Participant[];
  turnFailureNotices?: LocalTurnFailureNotice[];
  canOpenIssueDetails?: boolean;
  onViewIssueDetails?(identityId: string, trigger: HTMLButtonElement): void;
}) {
  const rows = useMemo(() => projectTimeline(messages), [messages]);
  // Broadcast names follow the live roster; historical identities only label authors/recipients.
  const broadcastTargetLabel = hasChannelMentionCollision(participants) ? "@conversation" : "@channel";
  const notices = useMemo(() => [...turnFailureNotices].sort((left, right) =>
    left.failedAt.localeCompare(right.failedAt) || left.triggerSequence - right.triggerSequence), [turnFailureNotices]);
  const timelineItems = useMemo(() => {
    const byTriggerSequence = new Map<number, LocalTurnFailureNotice[]>();
    for (const notice of notices) {
      const group = byTriggerSequence.get(notice.triggerSequence) ?? [];
      group.push(notice);
      byTriggerSequence.set(notice.triggerSequence, group);
    }
    const inserted = new Set<LocalTurnFailureNotice>();
    const items: Array<{ kind: "row"; row: TimelineRow } | { kind: "issue"; notice: LocalTurnFailureNotice }> = [];
    for (const row of rows) {
      items.push({ kind: "row", row });
      if (row.kind !== "message") continue;
      for (const notice of byTriggerSequence.get(row.message.sequence) ?? []) {
        items.push({ kind: "issue", notice });
        inserted.add(notice);
      }
    }
    for (const notice of notices) {
      if (!inserted.has(notice)) items.push({ kind: "issue", notice });
    }
    return items;
  }, [notices, rows]);

  if (!rows.length && !notices.length) {
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
    <div role="log" aria-live="polite" aria-relevant="additions" aria-label="Conversation messages">
      {timelineItems.map((item) => item.kind === "row"
        ? <TimelineRowView key={item.row.id} row={item.row} participants={attributionParticipants} broadcastTargetLabel={broadcastTargetLabel} />
        : <TurnFailureNoticeRow
          key={`${item.notice.participant.identityId}:${item.notice.triggerSequence}:${item.notice.failedAt}`}
          notice={item.notice}
          canOpenDetails={canOpenIssueDetails}
          onViewDetails={onViewIssueDetails}
        />)}
      {!rows.length ? <div className="grid min-h-48 place-items-center p-6">
        <div className="empty-state max-w-md text-center">
          <Menu className="mx-auto h-5 w-5" />
          <h2 className="font-semibold">No messages yet</h2>
          <p>Mention an agent below to begin a focused collaboration.</p>
        </div>
      </div> : null}
    </div>
  );
}
