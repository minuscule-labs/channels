import { createRootRoute, createRoute, createRouter, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect } from "react";
import { MessageSquare } from "lucide-react";
import { AgentCreatePage, AgentDetailPage, AgentManagementPage } from "./components/agent-management-page";
import { AppShell } from "./components/app-shell";
import { ConversationPage } from "./components/conversation-page";

const rootRoute = createRootRoute({ component: AppShell });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => (
    <div className="grid min-h-0 flex-1 place-items-center p-6">
      <div className="empty-state max-w-lg text-center">
        <MessageSquare className="mx-auto h-6 w-6 text-[var(--accent)]" />
        <h1 className="text-lg font-semibold">Choose a Conversation</h1>
        <p>Select a Workspace Conversation from the sidebar to view live messages and participants.</p>
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

const conversationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app/workspaces/$workspaceId/conversations/$conversationId",
  component: ConversationPage,
});

function LegacyConversationRedirect() {
  const { workspaceId, conversationId } = useParams({ from: "/app/workspaces/$workspaceId/channels/$conversationId" });
  const navigate = useNavigate();
  useEffect(() => {
    void navigate({
      to: "/app/workspaces/$workspaceId/conversations/$conversationId",
      params: { workspaceId, conversationId },
      replace: true,
    });
  }, [conversationId, navigate, workspaceId]);
  return null;
}

const legacyConversationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app/workspaces/$workspaceId/channels/$conversationId",
  component: LegacyConversationRedirect,
});

const routeTree = rootRoute.addChildren([indexRoute, agentManagementRoute, agentCreateRoute, agentDetailRoute, conversationRoute, legacyConversationRoute]);
export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
