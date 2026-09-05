import { useQueries, useQuery } from "@tanstack/react-query";
import { Outlet, useRouterState } from "@tanstack/react-router";
import { Menu } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { channels } from "../lib/api";
import { queryKeys } from "../lib/query-keys";
import { Drawer } from "./ui/drawer";
import { NavigationSidebar, type WorkspaceNavigationItem } from "./navigation-sidebar";

export function AppShell() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [navigationOpen, setNavigationOpen] = useState(false);
  const workspaces = useQuery({ queryKey: queryKeys.workspaces(), queryFn: () => channels.listWorkspaces() });
  const channelQueries = useQueries({
    queries: (workspaces.data ?? []).map((workspace) => ({
      queryKey: queryKeys.workspaceChannels(workspace.id),
      queryFn: () => channels.listWorkspaceChannels(workspace.id),
      staleTime: 5_000,
    })),
  });
  const activeChannelId = pathname.match(/\/channels\/([^/]+)/)?.[1];
  const activeAgentsWorkspaceId = pathname.match(/\/workspaces\/([^/]+)\/agents(?:\/|$)/)?.[1];
  const navigationItems = useMemo<WorkspaceNavigationItem[]>(
    () =>
      (workspaces.data ?? []).map((workspace, index) => ({
        workspace,
        channels: channelQueries[index]?.data ?? [],
        loading: channelQueries[index]?.isLoading ?? false,
      })),
    [channelQueries, workspaces.data],
  );

  useEffect(() => setNavigationOpen(false), [pathname]);

  if (workspaces.isLoading) {
    return <div className="grid min-h-screen place-items-center text-sm text-[var(--muted)]">Loading MinuChannels…</div>;
  }
  if (workspaces.error) {
    return (
      <div className="grid min-h-screen place-items-center p-6">
        <div className="empty-state max-w-lg">
          <h1 className="text-base font-semibold">Channels API unavailable</h1>
          <p>{workspaces.error instanceof Error ? workspaces.error.message : "Unable to load Workspaces."}</p>
          <button className="button-secondary" type="button" onClick={() => void workspaces.refetch()}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen min-h-0 overflow-hidden bg-[var(--bg)] text-[var(--text)]">
      <div className="hidden md:block">
        <NavigationSidebar
          items={navigationItems}
          activeChannelId={activeChannelId}
          activeAgentsWorkspaceId={activeAgentsWorkspaceId}
        />
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Drawer
          open={navigationOpen}
          onOpenChange={setNavigationOpen}
          side="left"
          title="Navigation"
          description="Choose a Workspace and Channel."
          trigger={(
            <button
              type="button"
              className="icon-button fixed top-2.5 left-3 z-40 inline-flex md:hidden"
              aria-label="Open navigation"
            >
              <Menu className="h-4 w-4" />
            </button>
          )}
        >
          <NavigationSidebar
            items={navigationItems}
            activeChannelId={activeChannelId}
            activeAgentsWorkspaceId={activeAgentsWorkspaceId}
            onNavigate={() => setNavigationOpen(false)}
            onClose={() => setNavigationOpen(false)}
          />
        </Drawer>
        <Outlet />
      </div>
    </div>
  );
}
