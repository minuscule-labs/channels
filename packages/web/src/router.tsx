import { createRootRoute, createRoute, createRouter, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useState, type ComponentType } from "react";
import { MessageSquare } from "lucide-react";
import type * as AgentManagementModule from "./components/agent-management-page";
import { AppShell } from "./components/app-shell";
import { ConversationPage } from "./components/conversation-page";

const rootRoute = createRootRoute({ component: AppShell });
type AgentPageExport = "AgentManagementPage" | "AgentCreatePage" | "AgentDetailPage";
type AgentRouteLoadState =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "loaded"; component: ComponentType };

let agentManagementModule: Promise<typeof AgentManagementModule> | undefined;
function loadAgentManagement() {
  agentManagementModule ??= import("./components/agent-management-page")
    .catch((error: unknown) => {
      agentManagementModule = undefined;
      throw error;
    });
  return agentManagementModule;
}

function AgentRoutePending() {
  return <div className="grid min-h-0 flex-1 place-items-center p-6 text-sm text-[var(--muted)]">Loading agent management…</div>;
}

function lazyAgentPage(exportName: AgentPageExport) {
  function RoutePage() {
    const [loaded, setLoaded] = useState<AgentRouteLoadState>({ status: "loading" });

    useEffect(() => {
      let cancelled = false;
      void loadAgentManagement().then((module) => {
        if (!cancelled) setLoaded({ status: "loaded", component: module[exportName] });
      }).catch(() => {
        if (!cancelled) setLoaded({ status: "failed" });
      });
      return () => { cancelled = true; };
    }, []);

    if (loaded.status === "loading") return <AgentRoutePending />;
    if (loaded.status === "failed") {
      return (
        <div className="grid min-h-0 flex-1 place-items-center p-6" role="alert">
          <div className="empty-state max-w-lg text-center">
            <h1 className="text-base font-semibold">Agent management couldn’t be loaded</h1>
            <p>Conversation navigation is still available. Check the connection, then reload this page to retry.</p>
            <button className="button-secondary mt-3" type="button" onClick={() => window.location.reload()}>
              Reload and retry
            </button>
          </div>
        </div>
      );
    }
    const Page = loaded.component;
    return <Page />;
  }

  // Start TanStack Router's intent preload without blocking navigation or the AppShell.
  return Object.assign(RoutePage, {
    preload: (): Promise<void> | undefined => {
      void loadAgentManagement().catch(() => undefined);
      return undefined;
    },
  });
}

const AgentManagementPage = lazyAgentPage("AgentManagementPage");
const AgentCreatePage = lazyAgentPage("AgentCreatePage");
const AgentDetailPage = lazyAgentPage("AgentDetailPage");

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
  pendingComponent: AgentRoutePending,
});

const agentCreateRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app/workspaces/$workspaceId/agents/new",
  component: AgentCreatePage,
  pendingComponent: AgentRoutePending,
});

const agentDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app/workspaces/$workspaceId/agents/$agentId",
  component: AgentDetailPage,
  pendingComponent: AgentRoutePending,
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
