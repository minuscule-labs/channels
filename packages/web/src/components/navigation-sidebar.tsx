import type { ConversationLifecycleState, ConversationMetadata, Workspace } from "@minu/channels-core/types";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Archive, Bell, Bot, ChevronDown, Clock3, Hash, MessageSquare, X } from "lucide-react";
import type { NotificationSound } from "../lib/conversation-notifications";
import { CreateConversationDialog } from "./conversation-administration-dialog";
import { WorkspaceCreateDialog } from "./workspace-create-dialog";
import { WorkspaceSettingsDialog } from "./workspace-settings-dialog";

function snoozeAt(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function snoozeAtLocal(hour: number, daysAhead = 0): string {
  const date = new Date();
  date.setDate(date.getDate() + daysAhead);
  date.setHours(hour, 0, 0, 0);
  if (date.getTime() <= Date.now()) date.setDate(date.getDate() + 1);
  return date.toISOString();
}

function datetimeLocalValue(value: string): string {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export interface WorkspaceNavigationItem {
  workspace: Workspace;
  conversations: ConversationMetadata[];
  loading: boolean;
  lifecycle?: ReadonlyMap<string, ConversationLifecycleState>;
  unread?: ReadonlyMap<string, { count: number; mentionCount: number }>;
}

function ConversationNavigationLink({
  conversation,
  workspaceId,
  activeConversationId,
  unread,
  lifecycleState,
  onLifecycleChange,
  pendingLifecycle,
  onNavigate,
}: {
  conversation: ConversationMetadata;
  workspaceId: string;
  activeConversationId?: string;
  unread?: ReadonlyMap<string, { count: number; mentionCount: number }>;
  lifecycleState: ConversationLifecycleState;
  onLifecycleChange?(
    conversationId: string,
    input: { state: ConversationLifecycleState; snoozedUntil?: string },
  ): void;
  pendingLifecycle?: boolean;
  onNavigate?(): void;
}) {
  const active = conversation.id === activeConversationId;
  const unreadState = unread?.get(conversation.id);
  const [customSnoozeUntil, setCustomSnoozeUntil] = useState(() => datetimeLocalValue(snoozeAt(60)));
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  return (
    <li key={conversation.id}>
      <Link
        to="/app/workspaces/$workspaceId/conversations/$conversationId"
        params={{ workspaceId, conversationId: conversation.id }}
        onClick={onNavigate}
        className={`flex min-h-10 items-center gap-2 rounded-md px-2.5 text-sm transition-colors ${
          active
            ? "bg-[var(--selected)] text-[var(--text)]"
            : "text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
        }`}
        aria-current={active ? "page" : undefined}
      >
        <Hash className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{conversation.name}</span>
        {unreadState?.count ? (
          <span
            className={`min-w-5 rounded-full px-1.5 text-center text-[10px] font-semibold ${unreadState.mentionCount ? "bg-[var(--accent)] text-white" : "bg-[var(--border)] text-[var(--text)]"}`}
            aria-label={`${unreadState.count} unread message${unreadState.count === 1 ? "" : "s"}${unreadState.mentionCount ? `, ${unreadState.mentionCount} direct mention${unreadState.mentionCount === 1 ? "" : "s"}` : ""}`}
          >
            {unreadState.count}
          </span>
        ) : null}
      </Link>
      {onLifecycleChange ? (
        <details className="relative -mt-8 ml-auto mr-1 w-7" onClick={(event) => event.stopPropagation()}>
          <summary className="icon-button ml-auto flex h-7 w-7 cursor-pointer list-none items-center justify-center text-xs" aria-label={`Conversation actions for ${conversation.name}`}>•••</summary>
          <div className="absolute right-0 z-30 mt-1 w-40 rounded-md border border-[var(--border)] bg-[var(--panel)] p-1 shadow-lg">
            {lifecycleState === "active" ? <>
              <button className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs hover:bg-[var(--hover)]" type="button" aria-expanded={snoozeOpen} onClick={() => setSnoozeOpen((open) => !open)}>Snooze <span className="text-[var(--muted)]">›</span></button>
              {snoozeOpen ? <div className="absolute left-full top-0 ml-1 w-56 rounded-md border border-[var(--border)] bg-[var(--panel)] p-1 shadow-lg">
                  {[
                    ["In 1 hour", snoozeAt(60)],
                    ["In 3 hours", snoozeAt(180)],
                    ["This evening", snoozeAtLocal(18)],
                    ["Tomorrow", snoozeAtLocal(9, 1)],
                    ["Next week", snoozeAtLocal(9, 7)],
                  ].map(([label, snoozedUntil]) => (
                    <button key={label as string} className="w-full rounded px-2 py-1.5 text-left text-xs hover:bg-[var(--hover)]" type="button" disabled={pendingLifecycle} onClick={() => onLifecycleChange(conversation.id, { state: "snoozed", snoozedUntil: snoozedUntil as string })}>{label as string}</button>
                  ))}
                  <form className="mt-1 border-t border-[var(--border)] px-2 pt-2" onSubmit={(event) => {
                    event.preventDefault();
                    onLifecycleChange(conversation.id, { state: "snoozed", snoozedUntil: new Date(customSnoozeUntil).toISOString() });
                  }}>
                    <label className="block text-[10px] text-[var(--muted)]" htmlFor={`snooze-${conversation.id}`}>Custom…</label>
                    <input id={`snooze-${conversation.id}`} aria-label={`Snooze ${conversation.name} until`} className="mt-1 w-full rounded border border-[var(--border)] bg-transparent px-1 py-1 text-[11px]" type="datetime-local" min={datetimeLocalValue(new Date().toISOString())} value={customSnoozeUntil} onChange={(event) => setCustomSnoozeUntil(event.target.value)} required />
                    <button className="my-1 w-full rounded px-1 py-1 text-left text-xs hover:bg-[var(--hover)]" type="submit" disabled={pendingLifecycle}>Snooze until this time</button>
                  </form>
                </div> : null}
              <button className="w-full rounded px-2 py-1.5 text-left text-xs hover:bg-[var(--hover)]" type="button" disabled={pendingLifecycle} onClick={() => onLifecycleChange(conversation.id, { state: "settled" })}>Settle to Archive</button>
            </> : (
              <button className="w-full rounded px-2 py-1.5 text-left text-xs hover:bg-[var(--hover)]" type="button" disabled={pendingLifecycle} onClick={() => onLifecycleChange(conversation.id, { state: "active" })}>Reopen Conversation</button>
            )}
          </div>
        </details>
      ) : null}
    </li>
  );
}

export function NavigationSidebar({
  items,
  activeConversationId,
  activeAgentsWorkspaceId,
  workspaces,
  selectedWorkspaceId,
  onSelectWorkspace,
  onNavigate,
  onClose,
  sound = "off",
  onSoundChange,
  onTestSound,
  workspaceUnread = new Map(),
  onLifecycleChange,
  pendingLifecycleConversationId,
}: {
  items: WorkspaceNavigationItem[];
  activeConversationId?: string;
  activeAgentsWorkspaceId?: string;
  workspaces: Workspace[];
  selectedWorkspaceId?: string;
  onSelectWorkspace(workspaceId: string): void;
  onNavigate?(): void;
  onClose?(): void;
  sound?: NotificationSound;
  onSoundChange?(sound: NotificationSound): void;
  onTestSound?(): void;
  workspaceUnread?: ReadonlyMap<string, number>;
  onLifecycleChange?(
    conversationId: string,
    input: { state: ConversationLifecycleState; snoozedUntil?: string },
  ): void;
  pendingLifecycleConversationId?: string;
}) {
  const [snoozedOpen, setSnoozedOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  return (
    <aside className="flex h-full min-h-0 w-full flex-col border-r border-[var(--border)] bg-[var(--panel-muted)] md:w-72">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--border)] px-4">
        <div className="flex min-w-0 items-center gap-2">
          <MessageSquare className="h-4 w-4 shrink-0 text-[var(--accent)]" />
          <label className="sr-only" htmlFor="workspace-switcher">Selected Workspace</label>
          <select
            id="workspace-switcher"
            value={selectedWorkspaceId ?? ""}
            onChange={(event) => onSelectWorkspace(event.target.value)}
            className="min-w-0 max-w-40 bg-transparent text-sm font-semibold outline-none"
          >
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}{workspaceUnread.get(workspace.id) ? ` (${workspaceUnread.get(workspace.id)} unread)` : ""}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-1">
          <WorkspaceCreateDialog onNavigate={onNavigate} />
          {onClose ? (
            <button className="icon-button inline-flex md:hidden" type="button" onClick={onClose} aria-label="Close navigation">
              <X className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      </div>
      <nav className="minu-scroll min-h-0 flex-1 overflow-y-auto p-3" aria-label="Workspaces and Conversations">
        {items.length === 0 ? (
          <p className="px-2 py-6 text-sm text-[var(--muted)]">No Workspaces yet.</p>
        ) : null}
        <div className="space-y-5">
          {items.map(({ workspace, conversations, loading, lifecycle, unread }) => (
            <section key={workspace.id}>
              <div className="mb-1 flex items-end justify-between gap-2 px-2">
                <div className="min-w-0">
                  <p className="text-[9px] font-semibold uppercase tracking-[0.16em] text-[var(--muted)]">Workspace</p>
                  <h2 className="truncate text-sm font-semibold text-[var(--text)]" title={workspace.name}>
                    {workspace.name}
                  </h2>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="status-dot" data-status={workspace.status} title={workspace.status} />
                  <CreateConversationDialog workspace={workspace} onNavigate={onNavigate} />
                  <WorkspaceSettingsDialog workspace={workspace} />
                </div>
              </div>
              <Link
                to="/app/workspaces/$workspaceId/agents"
                params={{ workspaceId: workspace.id }}
                onClick={onNavigate}
                className={`mb-1 flex min-h-9 items-center gap-2 rounded-md px-2.5 text-sm transition-colors ${
                  activeAgentsWorkspaceId === workspace.id
                    ? "bg-[var(--selected)] text-[var(--text)]"
                    : "text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
                }`}
                aria-current={activeAgentsWorkspaceId === workspace.id ? "page" : undefined}
              >
                <Bot className="h-3.5 w-3.5 shrink-0" />
                <span>Agents</span>
              </Link>
              {loading ? <p className="px-2 py-2 text-xs text-[var(--muted)]">Loading Conversations…</p> : null}
              {(() => {
                const active = conversations.filter((conversation) => (lifecycle?.get(conversation.id) ?? "active") === "active");
                const snoozed = conversations.filter((conversation) => lifecycle?.get(conversation.id) === "snoozed");
                const settled = conversations.filter((conversation) => lifecycle?.get(conversation.id) === "settled");
                const link = (conversation: ConversationMetadata) => (
                  <ConversationNavigationLink
                    key={conversation.id}
                    conversation={conversation}
                    workspaceId={workspace.id}
                    activeConversationId={activeConversationId}
                    unread={unread}
                    lifecycleState={lifecycle?.get(conversation.id) ?? "active"}
                    onLifecycleChange={onLifecycleChange}
                    pendingLifecycle={pendingLifecycleConversationId === conversation.id}
                    onNavigate={onNavigate}
                  />
                );
                return <>
                  <ul className="space-y-1">{active.map(link)}</ul>
                  {(snoozed.length > 0 || settled.length > 0) ? (
                    <div className="mt-4 border-t border-[var(--border)] pt-2">
                      {snoozed.length > 0 ? <>
                        <button
                          type="button"
                          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs font-medium text-[var(--accent)] hover:bg-[var(--hover)]"
                          aria-expanded={snoozedOpen}
                          onClick={() => setSnoozedOpen((open) => !open)}
                        >
                          <Clock3 className="h-3.5 w-3.5" /> Snoozed
                          <ChevronDown className={`ml-auto h-3.5 w-3.5 transition-transform ${snoozedOpen ? "rotate-180" : ""}`} />
                        </button>
                        {snoozedOpen ? <ul className="space-y-1">{snoozed.map(link)}</ul> : null}
                      </> : null}
                      {settled.length > 0 ? <>
                        <button
                          type="button"
                          className="mt-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs font-medium text-[var(--muted)] hover:bg-[var(--hover)]"
                          aria-expanded={archiveOpen}
                          onClick={() => setArchiveOpen((open) => !open)}
                        >
                          <Archive className="h-3.5 w-3.5" /> Archive
                          <ChevronDown className={`ml-auto h-3.5 w-3.5 transition-transform ${archiveOpen ? "rotate-180" : ""}`} />
                        </button>
                        {archiveOpen ? <ul className="space-y-1">{settled.map(link)}</ul> : null}
                      </> : null}
                    </div>
                  ) : null}
                </>;
              })()}
            </section>
          ))}
        </div>
      </nav>
      {onSoundChange ? (
        <div className="border-t border-[var(--border)] p-3">
          <label className="flex items-center gap-2 text-xs text-[var(--muted)]">
            <Bell className="h-3.5 w-3.5" />
            <span>Sound</span>
            <select
              aria-label="Notification sound"
              className="ml-auto bg-transparent text-xs text-[var(--text)]"
              value={sound}
              onChange={(event) => onSoundChange(event.target.value as NotificationSound)}
            >
              <option value="off">Off</option>
              <option value="mentions">Mentions and agent replies</option>
              <option value="all">All new messages</option>
            </select>
          </label>
          {sound !== "off" && onTestSound ? <button className="button-secondary mt-2 w-full" type="button" onClick={onTestSound}>Test sound</button> : null}
        </div>
      ) : null}
    </aside>
  );
}
