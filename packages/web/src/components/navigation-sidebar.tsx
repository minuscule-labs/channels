import type { ChannelMetadata, Workspace } from "@minu/channels-core/types";
import { Link } from "@tanstack/react-router";
import { Bot, Hash, MessageSquare, X } from "lucide-react";
import { CreateChannelDialog } from "./channel-administration-dialog";
import { WorkspaceCreateDialog } from "./workspace-create-dialog";
import { WorkspaceSettingsDialog } from "./workspace-settings-dialog";

export interface WorkspaceNavigationItem {
  workspace: Workspace;
  channels: ChannelMetadata[];
  loading: boolean;
}

export function NavigationSidebar({
  items,
  activeChannelId,
  activeAgentsWorkspaceId,
  workspaces,
  selectedWorkspaceId,
  onSelectWorkspace,
  onNavigate,
  onClose,
}: {
  items: WorkspaceNavigationItem[];
  activeChannelId?: string;
  activeAgentsWorkspaceId?: string;
  workspaces: Workspace[];
  selectedWorkspaceId?: string;
  onSelectWorkspace(workspaceId: string): void;
  onNavigate?(): void;
  onClose?(): void;
}) {
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
            {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
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
      <nav className="minu-scroll min-h-0 flex-1 overflow-y-auto p-3" aria-label="Workspaces and Channels">
        {items.length === 0 ? (
          <p className="px-2 py-6 text-sm text-[var(--muted)]">No Workspaces yet.</p>
        ) : null}
        <div className="space-y-5">
          {items.map(({ workspace, channels, loading }) => (
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
                  <CreateChannelDialog workspace={workspace} onNavigate={onNavigate} />
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
              {loading ? <p className="px-2 py-2 text-xs text-[var(--muted)]">Loading Channels…</p> : null}
              <ul className="space-y-1">
                {channels.map((channel) => {
                  const active = channel.id === activeChannelId;
                  return (
                    <li key={channel.id}>
                      <Link
                        to="/app/workspaces/$workspaceId/channels/$channelId"
                        params={{ workspaceId: workspace.id, channelId: channel.id }}
                        onClick={onNavigate}
                        className={`flex min-h-10 items-center gap-2 rounded-md px-2.5 text-sm transition-colors ${
                          active
                            ? "bg-[var(--selected)] text-[var(--text)]"
                            : "text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
                        }`}
                        aria-current={active ? "page" : undefined}
                      >
                        <Hash className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{channel.name}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      </nav>
    </aside>
  );
}
