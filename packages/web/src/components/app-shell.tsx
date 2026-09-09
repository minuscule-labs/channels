import { useQuery } from "@tanstack/react-query";
import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { Menu } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { channels } from "../lib/api";
import { queryKeys } from "../lib/query-keys";
import { Drawer } from "./ui/drawer";
import { NavigationSidebar, type WorkspaceNavigationItem } from "./navigation-sidebar";
import { WorkspaceCreateDialog } from "./workspace-create-dialog";

export function AppShell() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const navigate = useNavigate();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const workspaces = useQuery({ queryKey: queryKeys.workspaces(), queryFn: () => channels.listWorkspaces() });
  const routeWorkspaceId = pathname.match(/\/app\/workspaces\/([^/]+)/)?.[1];
  const selectedWorkspaceId = routeWorkspaceId
    ?? (workspaces.data ?? []).find((workspace) => workspace.id === localStorage.getItem("minu-channels:last-workspace"))?.id
    ?? workspaces.data?.[0]?.id;
  const selectedWorkspace = (workspaces.data ?? []).find((workspace) => workspace.id === selectedWorkspaceId);
  const selectedChannels = useQuery({
    queryKey: selectedWorkspace ? queryKeys.workspaceChannels(selectedWorkspace.id) : ["workspace", "none", "channels"],
    queryFn: () => channels.listWorkspaceChannels(selectedWorkspace!.id),
    enabled: Boolean(selectedWorkspace),
    staleTime: 5_000,
  });
  const activeChannelId = pathname.match(/\/channels\/([^/]+)/)?.[1];
  const activeAgentsWorkspaceId = pathname.match(/\/workspaces\/([^/]+)\/agents(?:\/|$)/)?.[1];
  const navigationItems = useMemo<WorkspaceNavigationItem[]>(() => selectedWorkspace ? [{
    workspace: selectedWorkspace,
    channels: selectedChannels.data ?? [],
    loading: selectedChannels.isLoading,
  }] : [], [selectedChannels.data, selectedChannels.isLoading, selectedWorkspace]);

  const selectWorkspace = async (workspaceId: string) => {
    const workspace = (workspaces.data ?? []).find((candidate) => candidate.id === workspaceId);
    if (!workspace) return;
    localStorage.setItem("minu-channels:last-workspace", workspaceId);
    const channelList = await channels.listWorkspaceChannels(workspaceId);
    const rememberedChannelId = localStorage.getItem(`minu-channels:last-channel:${workspaceId}`);
    const channel = channelList.find(({ id }) => id === rememberedChannelId) ?? channelList[0];
    void navigate(channel ? {
      to: "/app/workspaces/$workspaceId/channels/$channelId",
      params: { workspaceId, channelId: channel.id },
    } : { to: "/app/workspaces/$workspaceId/agents", params: { workspaceId } });
  };

  useEffect(() => setNavigationOpen(false), [pathname]);
  useEffect(() => {
    if (routeWorkspaceId) localStorage.setItem("minu-channels:last-workspace", routeWorkspaceId);
    if (routeWorkspaceId && activeChannelId) localStorage.setItem(`minu-channels:last-channel:${routeWorkspaceId}`, activeChannelId);
  }, [activeChannelId, routeWorkspaceId]);
  useEffect(() => {
    if (pathname !== "/" || !selectedWorkspaceId) return;
    void selectWorkspace(selectedWorkspaceId);
  // Redirecting from the index only needs the current loaded Workspace set.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, selectedWorkspaceId]);

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
  if (workspaces.data?.length === 0) {
    return (
      <div className="grid min-h-screen place-items-center bg-[var(--bg)] p-6">
        <div className="empty-state max-w-lg text-center">
          <h1 className="text-lg font-semibold">Welcome to MinuChannels</h1>
          <p>Choose a local source folder to create your first Workspace.</p>
        </div>
        <WorkspaceCreateDialog onboarding />
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
          workspaces={workspaces.data ?? []}
          selectedWorkspaceId={selectedWorkspaceId}
          onSelectWorkspace={(workspaceId) => void selectWorkspace(workspaceId)}
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
            workspaces={workspaces.data ?? []}
            selectedWorkspaceId={selectedWorkspaceId}
            onSelectWorkspace={(workspaceId) => { void selectWorkspace(workspaceId); setNavigationOpen(false); }}
            onNavigate={() => setNavigationOpen(false)}
            onClose={() => setNavigationOpen(false)}
          />
        </Drawer>
        <Outlet />
      </div>
    </div>
  );
}
