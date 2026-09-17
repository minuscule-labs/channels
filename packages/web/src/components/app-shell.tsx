import type { ConversationMessage, ConversationMetadata } from "@minu/channels-core/types";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { Menu } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { conversations, localControl } from "../lib/api";
import { queryKeys } from "../lib/query-keys";
import { mergeMessages } from "../lib/messages";
import { runBackgroundConversationsConnection } from "../lib/background-conversation";
import { readSequence, readSound, unreadFor, writeSound, type NotificationSound } from "../lib/conversation-notifications";
import { Drawer } from "./ui/drawer";
import { NavigationSidebar, type WorkspaceNavigationItem } from "./navigation-sidebar";
import { WorkspaceCreateDialog } from "./workspace-create-dialog";

export function AppShell() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [readRevision, setReadRevision] = useState(0);
  const [sound, setSound] = useState<NotificationSound>("off");
  const soundedMessages = useRef(new Set<string>());
  const viewingActiveConversationEnd = useRef(false);
  const audioContext = useRef<AudioContext | undefined>(undefined);
  const [knownConversations, setKnownConversations] = useState<ConversationMetadata[]>([]);
  const workspaces = useQuery({ queryKey: queryKeys.workspaces(), queryFn: () => conversations.listWorkspaces() });
  const routeWorkspaceId = pathname.match(/\/app\/workspaces\/([^/]+)/)?.[1];
  const selectedWorkspaceId = routeWorkspaceId
    ?? (workspaces.data ?? []).find((workspace) => workspace.id === localStorage.getItem("minu-channels:last-workspace"))?.id
    ?? workspaces.data?.[0]?.id;
  const selectedWorkspace = (workspaces.data ?? []).find((workspace) => workspace.id === selectedWorkspaceId);
  const selectedConversations = useQuery({
    queryKey: selectedWorkspace ? queryKeys.workspaceConversations(selectedWorkspace.id) : ["workspace", "none", "conversations"],
    queryFn: () => conversations.listWorkspaceConversations(selectedWorkspace!.id),
    enabled: Boolean(selectedWorkspace),
    staleTime: 5_000,
  });
  const currentSession = useQuery({
    queryKey: queryKeys.localCurrentSession(),
    queryFn: () => localControl.currentSession(),
    retry: false,
    staleTime: 60_000,
  });
  const activeConversationId = pathname.match(/\/conversations\/([^/]+)/)?.[1];
  const observedConversations = useMemo(() => {
    const byId = new Map(knownConversations.map((conversation) => [conversation.id, conversation]));
    for (const conversation of selectedConversations.data ?? []) byId.set(conversation.id, conversation);
    return [...byId.values()];
  }, [knownConversations, selectedConversations.data]);
  const conversationMessageQueries = useQueries({
    queries: observedConversations.map((conversation) => ({
      queryKey: queryKeys.conversationMessages(conversation.id),
      queryFn: () => conversations.listMessages(conversation.id, { limit: 100 }),
      enabled: Boolean(currentSession.data?.identityId),
      staleTime: Infinity,
    })),
  });
  const activeAgentsWorkspaceId = pathname.match(/\/workspaces\/([^/]+)\/agents(?:\/|$)/)?.[1];
  const allUnread = useMemo(() => {
    const result = new Map<string, { count: number; mentionCount: number }>();
    const identityId = currentSession.data?.identityId;
    if (!identityId) return result;
    for (const [index, conversation] of observedConversations.entries()) {
      const messages = conversationMessageQueries[index]?.data ?? [];
      result.set(conversation.id, unreadFor(messages, identityId, readSequence(localStorage, identityId, conversation.id)));
    }
    return result;
  // readRevision is incremented when a visible timeline advances its durable read cursor.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationMessageQueries.map(({ data }) => data), currentSession.data?.identityId, observedConversations, readRevision]);
  const unread = useMemo(() => new Map((selectedConversations.data ?? []).map((conversation) => [
    conversation.id,
    allUnread.get(conversation.id) ?? { count: 0, mentionCount: 0 },
  ])), [allUnread, selectedConversations.data]);
  const unreadTotal = [...allUnread.values()].reduce((sum, value) => sum + value.count, 0);
  const workspaceUnread = useMemo(() => new Map((workspaces.data ?? []).map((workspace) => [
    workspace.id,
    observedConversations
      .filter((conversation) => conversation.workspaceId === workspace.id)
      .reduce((sum, conversation) => sum + (allUnread.get(conversation.id)?.count ?? 0), 0),
  ])), [allUnread, observedConversations, workspaces.data]);
  const navigationItems = useMemo<WorkspaceNavigationItem[]>(() => selectedWorkspace ? [{
    workspace: selectedWorkspace,
    conversations: selectedConversations.data ?? [],
    loading: selectedConversations.isLoading,
    unread,
  }] : [], [selectedConversations.data, selectedConversations.isLoading, selectedWorkspace, unread]);

  const selectWorkspace = async (workspaceId: string) => {
    const workspace = (workspaces.data ?? []).find((candidate) => candidate.id === workspaceId);
    if (!workspace) return;
    localStorage.setItem("minu-channels:last-workspace", workspaceId);
    const conversationList = await conversations.listWorkspaceConversations(workspaceId);
    const rememberedConversationId = localStorage.getItem(`minu-channels:last-conversation:${workspaceId}`);
    const conversation = conversationList.find(({ id }) => id === rememberedConversationId) ?? conversationList[0];
    void navigate(conversation ? {
      to: "/app/workspaces/$workspaceId/conversations/$conversationId",
      params: { workspaceId, conversationId: conversation.id },
    } : { to: "/app/workspaces/$workspaceId/agents", params: { workspaceId } });
  };

  const activateAudio = () => {
    try {
      audioContext.current ??= new window.AudioContext();
      if (audioContext.current.state === "suspended") void audioContext.current.resume();
      return audioContext.current;
    } catch {
      return undefined;
    }
  };
  const playSound = () => {
    try {
      const context = audioContext.current;
      if (!context) return;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      gain.gain.value = 0.04;
      oscillator.frequency.value = 660;
      oscillator.connect(gain).connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.12);
    } catch {
      // Sound is optional; visual unread state remains authoritative.
    }
  };
  const changeSound = (value: NotificationSound) => {
    const identityId = currentSession.data?.identityId;
    if (!identityId) return;
    setSound(value);
    writeSound(localStorage, identityId, value);
    if (value !== "off" && activateAudio()) playSound();
  };

  useEffect(() => setNavigationOpen(false), [pathname]);
  useEffect(() => {
    const identityId = currentSession.data?.identityId;
    if (!identityId) {
      setKnownConversations([]);
      return;
    }
    setSound(readSound(localStorage, identityId));
    try {
      setKnownConversations(JSON.parse(localStorage.getItem(`minu-channels:known-conversations:${identityId}`) ?? "[]") as ConversationMetadata[]);
    } catch {
      setKnownConversations([]);
    }
  }, [currentSession.data?.identityId]);
  useEffect(() => {
    const identityId = currentSession.data?.identityId;
    if (!identityId || !selectedConversations.data) return;
    setKnownConversations((current) => {
      const byId = new Map(current
        .filter((conversation) => conversation.workspaceId !== selectedWorkspaceId)
        .map((conversation) => [conversation.id, conversation]));
      for (const conversation of selectedConversations.data) byId.set(conversation.id, conversation);
      const next = [...byId.values()];
      localStorage.setItem(`minu-channels:known-conversations:${identityId}`, JSON.stringify(next));
      return next;
    });
  }, [currentSession.data?.identityId, selectedConversations.data, selectedWorkspaceId]);
  useEffect(() => {
    const identityId = currentSession.data?.identityId;
    const backgroundConversations = observedConversations.filter(({ id }) => id !== activeConversationId);
    if (!identityId || backgroundConversations.length === 0) return;
    const controller = new AbortController();
    const connections = backgroundConversations.map((conversation) => {
      const mergeMessage = (message: ConversationMessage) => {
        queryClient.setQueryData<ConversationMessage[]>(
          queryKeys.conversationMessages(conversation.id),
          (current) => mergeMessages(current, [message]),
        );
      };
      return {
        conversationId: conversation.id,
        currentMessages: () => queryClient.getQueryData<ConversationMessage[]>(queryKeys.conversationMessages(conversation.id)),
        listMessages: (options: { afterSequence: number; limit: number }) => conversations.listMessages(conversation.id, options),
        onLiveMessage: (message: ConversationMessage) => {
          mergeMessage(message);
          window.dispatchEvent(new CustomEvent("minu-live-message", { detail: { conversation, message } }));
        },
        onCatchUpMessage: mergeMessage,
        onRosterUpdated: () => {
          void conversations.getConversation(conversation.id).then((updated) => {
            queryClient.setQueryData(queryKeys.conversation(conversation.id), updated);
            setKnownConversations((current) => {
              const next = current.map((item) => item.id === updated.id ? updated : item);
              localStorage.setItem(`minu-channels:known-conversations:${identityId}`, JSON.stringify(next));
              return next;
            });
          }).catch(() => undefined);
        },
      };
    });
    void (async () => {
      while (!controller.signal.aborted) {
        try {
          await runBackgroundConversationsConnection({
            signal: controller.signal,
            conversations: connections,
            events: (options) => conversations.eventsMany(backgroundConversations.map(({ id }) => id), options),
          });
        } catch {
          // The next bounded catch-up reconciles messages missed while disconnected.
        }
        if (!controller.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    })();
    return () => controller.abort();
  }, [activeConversationId, currentSession.data?.identityId, observedConversations, queryClient]);
  useEffect(() => {
    const identityId = currentSession.data?.identityId;
    if (!identityId || sound === "off") return;
    const notify = (event: Event) => {
      const { conversation, message } = (event as CustomEvent<{ conversation: ConversationMetadata; message: ConversationMessage }>).detail;
      if (soundedMessages.current.has(message.id)) return;
      soundedMessages.current.add(message.id);
      if (soundedMessages.current.size > 1_000) {
        const oldest = soundedMessages.current.values().next().value as string | undefined;
        if (oldest) soundedMessages.current.delete(oldest);
      }
      const viewingAtEnd = document.visibilityState === "visible"
        && conversation.id === activeConversationId
        && viewingActiveConversationEnd.current;
      if (message.participantId === identityId || viewingAtEnd) return;
      const author = conversation.participants.find(({ id }) => id === message.participantId);
      if (sound === "all" || message.to.includes(identityId) || author?.type === "agent") playSound();
    };
    window.addEventListener("minu-live-message", notify);
    return () => window.removeEventListener("minu-live-message", notify);
  }, [activeConversationId, currentSession.data?.identityId, sound]);
  useEffect(() => {
    viewingActiveConversationEnd.current = Boolean(activeConversationId);
    const changed = () => setReadRevision((value) => value + 1);
    const viewing = (event: Event) => {
      const detail = (event as CustomEvent<{ conversationId: string; nearEnd: boolean }>).detail;
      if (detail.conversationId === activeConversationId) viewingActiveConversationEnd.current = detail.nearEnd;
    };
    window.addEventListener("minu-read-state", changed);
    window.addEventListener("minu-conversation-view", viewing);
    return () => {
      window.removeEventListener("minu-read-state", changed);
      window.removeEventListener("minu-conversation-view", viewing);
    };
  }, [activeConversationId]);
  useEffect(() => {
    document.title = unreadTotal ? `(${unreadTotal}) MinuChannels` : "MinuChannels";
  }, [unreadTotal]);
  useEffect(() => {
    if (routeWorkspaceId) localStorage.setItem("minu-channels:last-workspace", routeWorkspaceId);
    if (routeWorkspaceId && activeConversationId) localStorage.setItem(`minu-channels:last-conversation:${routeWorkspaceId}`, activeConversationId);
  }, [activeConversationId, routeWorkspaceId]);
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
          <h1 className="text-base font-semibold">Conversations API unavailable</h1>
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
          activeConversationId={activeConversationId}
          activeAgentsWorkspaceId={activeAgentsWorkspaceId}
          workspaces={workspaces.data ?? []}
          selectedWorkspaceId={selectedWorkspaceId}
          onSelectWorkspace={(workspaceId) => void selectWorkspace(workspaceId)}
          workspaceUnread={workspaceUnread}
          sound={sound}
          onSoundChange={currentSession.isSuccess ? changeSound : undefined}
          onTestSound={() => { if (activateAudio()) playSound(); }}
        />
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Drawer
          open={navigationOpen}
          onOpenChange={setNavigationOpen}
          side="left"
          title="Navigation"
          description="Choose a Workspace and Conversation."
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
            activeConversationId={activeConversationId}
            activeAgentsWorkspaceId={activeAgentsWorkspaceId}
            workspaces={workspaces.data ?? []}
            selectedWorkspaceId={selectedWorkspaceId}
            onSelectWorkspace={(workspaceId) => { void selectWorkspace(workspaceId); setNavigationOpen(false); }}
            workspaceUnread={workspaceUnread}
            sound={sound}
            onSoundChange={currentSession.isSuccess ? changeSound : undefined}
            onTestSound={() => { if (activateAudio()) playSound(); }}
            onNavigate={() => setNavigationOpen(false)}
            onClose={() => setNavigationOpen(false)}
          />
        </Drawer>
        <Outlet />
      </div>
    </div>
  );
}
