import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { MessageSquare } from "lucide-react";
import { AgentCreatePage, AgentDetailPage, AgentManagementPage } from "./components/agent-management-page";
import { AppShell } from "./components/app-shell";
import { ChannelPage } from "./components/channel-page";

const rootRoute = createRootRoute({ component: AppShell });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => (
    <div className="grid min-h-0 flex-1 place-items-center p-6">
      <div className="empty-state max-w-lg text-center">
        <MessageSquare className="mx-auto h-6 w-6 text-[var(--accent)]" />
        <h1 className="text-lg font-semibold">Choose a Channel</h1>
        <p>Select a Workspace Channel from the sidebar to view live messages and participants.</p>
      </div>
    </div>
  ),
});

const agentManagementRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app/workspaces/$workspaceId/agents",
  component: AgentManagementPage,
});

const agentCreateRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app/workspaces/$workspaceId/agents/new",
  component: AgentCreatePage,
});

const agentDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app/workspaces/$workspaceId/agents/$agentId",
  component: AgentDetailPage,
});

const channelRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app/workspaces/$workspaceId/channels/$channelId",
  component: ChannelPage,
});

const routeTree = rootRoute.addChildren([indexRoute, agentManagementRoute, agentCreateRoute, agentDetailRoute, channelRoute]);
export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
