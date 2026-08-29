import type { ChannelMetadata, Workspace } from "@minu/channels-core/types";
import { Link } from "@tanstack/react-router";
import { Hash, MessageSquare, X } from "lucide-react";
import { WorkspaceSettingsDialog } from "./workspace-settings-dialog";

export interface WorkspaceNavigationItem {
  workspace: Workspace;
  channels: ChannelMetadata[];
  loading: boolean;
}

export function NavigationSidebar({
  items,
  activeChannelId,
  onNavigate,
  onClose,
}: {
  items: WorkspaceNavigationItem[];
  activeChannelId?: string;
  onNavigate?(): void;
  onClose?(): void;
}) {
  return (
    <aside className="flex h-full min-h-0 w-full flex-col border-r border-[var(--border)] bg-[var(--panel-muted)] md:w-72">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--border)] px-4">
        <Link to="/" className="flex items-center gap-2 font-mono font-semibold" onClick={onNavigate}>
          <MessageSquare className="h-4 w-4 text-[var(--accent)]" />
          MinuChannels
        </Link>
        {onClose ? (
          <button className="icon-button inline-flex md:hidden" type="button" onClick={onClose} aria-label="Close navigation">
            <X className="h-4 w-4" />
          </button>
        ) : null}
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
                  <WorkspaceSettingsDialog workspace={workspace} />
                </div>
              </div>
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
                        <span className="ml-auto text-[10px] tabular-nums">{channel.participants.length}</span>
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
