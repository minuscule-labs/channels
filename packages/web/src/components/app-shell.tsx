import type { ConversationMessage, ConversationMetadata, EffectiveConversationLifecycle } from "@minu/channels-core/types";
import { useMutation, useQueries, useQuery, useQueryClient, type Query } from "@tanstack/react-query";
import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { Menu } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { conversations, localControl } from "../lib/api";
import { queryKeys } from "../lib/query-keys";
import { cacheConversationMetadata, writeFolderCollapsed } from "../lib/conversation-folders";
import { mergeMessages } from "../lib/messages";
import { runBackgroundConversationsConnection } from "../lib/background-conversation";
import { sharedConversationEvents } from "../lib/shared-conversation-events";
import { announceLifecycleChange, listenForLifecycleChanges, snoozeRefetchInterval } from "../lib/conversation-lifecycle";
import { playNotificationSound } from "../lib/notification-sound";
import { readSequence, readSound, writeSound, type NotificationSound } from "../lib/conversation-notifications";
import { inboxKey, activityKey, useInbox } from "../lib/inbox";
import { Drawer } from "./ui/drawer";
import { NavigationSidebar, type WorkspaceNavigationItem } from "./navigation-sidebar";
import { NotificationPreferencesContext } from "./notification-preferences";
import { WorkspaceCreateDialog } from "./workspace-create-dialog";
import { WorkspaceSettingsSidebar } from "./workspace-settings-sidebar";

export function AppShell() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [navigationOpen, setNavigationOpen] = useState(false);
  useEffect(() => { setNavigationOpen(false); }, [pathname]);
  const importedReadCursors = useRef(new Set<string>());
  const [sound, setSound] = useState<NotificationSound>("off");
  const soundedMessages = useRef(new Set<string>());
  const viewingActiveConversationEnd = useRef(false);
  const audioContext = useRef<AudioContext | undefined>(undefined);
  const [knownConversations, setKnownConversations] = useState<ConversationMetadata[]>([]);
  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>({});
  const changeFolderCollapse = useCallback((key: string, collapsed: boolean) => {
    writeFolderCollapsed(localStorage, key, collapsed);
    setCollapsedFolders(current => current[key] === collapsed ? current : { ...current, [key]: collapsed });
  }, []);
  const workspaces = useQuery({ queryKey: queryKeys.workspaces(), queryFn: () => conversations.listWorkspaces() });
  const routeWorkspaceId = pathname.match(/\/app\/workspaces\/([^/]+)/)?.[1];
  const settingsWorkspaceId = pathname.match(/^\/app\/workspaces\/([^/]+)\/(?:settings|agents)(?:\/|$)/)?.[1];
  const selectedWorkspaceId = routeWorkspaceId
    ?? (workspaces.data ?? []).find((workspace) => workspace.id === localStorage.getItem("minu-channels:last-workspace"))?.id
    ?? workspaces.data?.[0]?.id;
  const selectedWorkspace = (workspaces.data ?? []).find((workspace) => workspace.id === selectedWorkspaceId);
  const selectedConversations = useQuery({
    queryKey: selectedWorkspace ? queryKeys.workspaceConversations(selectedWorkspace.id) : ["workspace", "none", "conversations"],
    queryFn: () => conversations.listWorkspaceConversations(selectedWorkspace!.id),
    enabled: Boolean(selectedWorkspace),
    staleTime: 5_000,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
  });
  const workspaceFolders = useQuery({
    queryKey: selectedWorkspace ? queryKeys.workspaceFolders(selectedWorkspace.id) : ["workspace", "none", "folders"],
    queryFn: () => conversations.listWorkspaceFolders(selectedWorkspace!.id),
    enabled: Boolean(selectedWorkspace),
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
  });
  const refreshWorkspaceNavigation = useCallback(() => {
    if (!selectedWorkspaceId) return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceConversations(selectedWorkspaceId), exact: true });
    void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceFolders(selectedWorkspaceId), exact: true });
  }, [queryClient, selectedWorkspaceId]);
  useEffect(() => {
    window.addEventListener("focus", refreshWorkspaceNavigation);
    return () => window.removeEventListener("focus", refreshWorkspaceNavigation);
  }, [refreshWorkspaceNavigation]);
  const currentSession = useQuery({
    queryKey: queryKeys.localCurrentSession(),
    queryFn: () => localControl.currentSession(),
    retry: false,
    staleTime: 60_000,
  });
  useEffect(() => {
    const identityId = currentSession.data?.identityId;
    if (!identityId) return;
    return listenForLifecycleChanges(identityId, (conversationId) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.localConversationLifecycle(conversationId), exact: true });
    });
  }, [currentSession.data?.identityId, queryClient]);
  const conversationLifecycleQueries = useQueries({
    queries: (selectedConversations.data ?? []).map((conversation) => ({
      queryKey: queryKeys.localConversationLifecycle(conversation.id),
      queryFn: () => localControl.getConversationLifecycle(conversation.id),
      enabled: Boolean(currentSession.data?.identityId),
      staleTime: 5_000,
      refetchInterval: (query: Query<EffectiveConversationLifecycle>) => snoozeRefetchInterval(query.state.data),
    })),
  });
  const selectedWorkspaceMembers = useQuery({
    queryKey: selectedWorkspace ? queryKeys.workspaceMembers(selectedWorkspace.id) : ["workspace", "none", "members"],
    queryFn: () => conversations.listWorkspaceMembers(selectedWorkspace!.id),
    enabled: Boolean(selectedWorkspace && currentSession.data?.identityId),
    staleTime: 60_000,
  });
  const lifecycleAction = useMutation({
    mutationFn: ({ conversationId, state, snoozedUntil }: {
      conversationId: string;
      state: "active" | "snoozed" | "settled";
      snoozedUntil?: string;
    }) => localControl.updateConversationLifecycle(
      conversationId,
      state === "snoozed" ? { state, snoozedUntil } : { state },
    ),
    onSuccess: (lifecycle, { conversationId }) => {
      queryClient.setQueryData(queryKeys.localConversationLifecycle(conversationId), lifecycle);
      announceLifecycleChange(currentSession.data?.identityId, conversationId);
      void queryClient.invalidateQueries({ queryKey: queryKeys.localConversationLifecycle(conversationId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.localConversationAgents(conversationId) });
    },
  });
  const canAdministerLifecycle = selectedWorkspaceMembers.data?.some((member) =>
    member.identityId === currentSession.data?.identityId
    && member.status === "active"
    && (member.accessRole === "owner" || member.accessRole === "admin"),
  ) ?? false;
  const canAdministerFolders = canAdministerLifecycle && selectedWorkspace?.status === "active";
  const runLifecycleChange = (
    conversationId: string,
    input: { state: "active" | "snoozed" | "settled"; snoozedUntil?: string },
  ) => {
    lifecycleAction.reset();
    lifecycleAction.mutate({ conversationId, ...input });
  };
  const routeConversationId = pathname.match(/\/conversations\/([^/]+)/)?.[1];
  const selectedConversationId = routeConversationId === "new" ? undefined : routeConversationId;
  const activeConversationId = /\/conversations\/[^/]+\/?$/.test(pathname) ? selectedConversationId : undefined;
  const observedConversations = useMemo(() => {
    const byId = new Map(knownConversations.map((conversation) => [conversation.id, conversation]));
    for (const conversation of selectedConversations.data ?? []) byId.set(conversation.id, conversation);
    return [...byId.values()];
  }, [knownConversations, selectedConversations.data]);
  const observedConversationsRef = useRef(observedConversations);
  useEffect(() => { observedConversationsRef.current = observedConversations; }, [observedConversations]);
  // Metadata changes must not tear down the same topic subscription. Otherwise
  // readiness refetches can feed back into another unsubscribe/ready cycle.
  // Include the current view so the observer port survives navigation and preserves grace.
  const backgroundConversationIdsKey = JSON.stringify(observedConversations.map(({ id }) => id).sort());
  // Retain the existing background observer's cache; unread counts come from the server.
  useQueries({
    queries: observedConversations.map((conversation) => ({
      queryKey: queryKeys.conversationMessages(conversation.id),
      queryFn: () => conversations.listMessages(conversation.id, { limit: 100 }),
      enabled: Boolean(currentSession.data?.identityId),
      staleTime: Infinity,
    })),
  });
  const activeAgentsWorkspaceId = pathname.match(/\/workspaces\/([^/]+)\/agents(?:\/|$)/)?.[1];
  const inbox = useInbox(currentSession.data?.identityId);
  const allUnread = useMemo(() => new Map((inbox.data ?? []).map(summary => [summary.conversationId, summary])), [inbox.data]);
  useEffect(() => {
    const identityId = currentSession.data?.identityId;
    if (!identityId) return;
    // Preserve existing browser read marks once, without overwriting server state.
    for (const summary of inbox.data ?? []) {
      const key = `${identityId}:${summary.conversationId}`;
      const sequence = readSequence(localStorage, identityId, summary.conversationId);
      if (sequence <= (summary.readSequence ?? 0) || sequence > summary.latestSequence || importedReadCursors.current.has(key)) continue;
      importedReadCursors.current.add(key);
      void conversations.acknowledgeRead(summary.conversationId, sequence).then(() => {
        void queryClient.invalidateQueries({ queryKey: inboxKey(identityId) });
        void queryClient.invalidateQueries({ queryKey: activityKey(identityId) });
      }).catch(() => { importedReadCursors.current.delete(key); });
    }
  }, [inbox.data, currentSession.data?.identityId, queryClient]);
  const unread = useMemo(() => new Map((selectedConversations.data ?? []).map((conversation) => [
    conversation.id,
    allUnread.get(conversation.id) ?? { count: 0, mentionCount: 0 },
  ])), [allUnread, selectedConversations.data]);
  const unreadTotal = [...allUnread.values()].reduce((sum, value) => sum + value.count, 0);
  const activityUnread = [...allUnread.values()].reduce((sum, value) => sum + (value.activityCount ?? 0), 0);
  const workspaceUnread = useMemo(() => new Map((workspaces.data ?? []).map((workspace) => [
    workspace.id,
    [...allUnread.values()]
      .filter(summary => summary.workspaceId === workspace.id)
      .reduce((sum, summary) => sum + summary.count, 0),
  ])), [allUnread, workspaces.data]);
  const conversationLifecycles = useMemo(() => new Map((selectedConversations.data ?? []).map((conversation, index) => [
    conversation.id,
    conversationLifecycleQueries[index]?.data?.state ?? "active",
  ])), [conversationLifecycleQueries, selectedConversations.data]);
  const navigationItems = useMemo<WorkspaceNavigationItem[]>(() => selectedWorkspace ? [{
    workspace: selectedWorkspace,
    conversations: selectedConversations.data ?? [],
    folders: workspaceFolders.data ?? [],
    loading: selectedConversations.isLoading,
    lifecycle: conversationLifecycles,
    unread,
  }] : [], [conversationLifecycles, selectedConversations.data, selectedConversations.isLoading, selectedWorkspace, workspaceFolders.data, unread]);

  const selectWorkspace = async (workspaceId: string, returnToWorkspace = false) => {
    const workspace = (workspaces.data ?? []).find((candidate) => candidate.id === workspaceId);
    if (!workspace) return;
    localStorage.setItem("minu-channels:last-workspace", workspaceId);
    const conversationList = await conversations.listWorkspaceConversations(workspaceId);
    const rememberedConversationId = localStorage.getItem(`minu-channels:last-conversation:${workspaceId}`);
    const conversation = conversationList.find(({ id }) => id === rememberedConversationId) ?? conversationList[0];
    void navigate(conversation ? {
      to: "/app/workspaces/$workspaceId/conversations/$conversationId",
      params: { workspaceId, conversationId: conversation.id },
    } : returnToWorkspace ? { to: "/" } : { to: "/app/workspaces/$workspaceId/agents", params: { workspaceId } });
  };

  const activateAudio = useCallback(() => {
    try {
      if (!audioContext.current || audioContext.current.state === "closed") {
        audioContext.current = new window.AudioContext();
      }
      // Resume can reject under browser autoplay policy; keep notifications optional
      // and retry on the next genuine user interaction.
      if (audioContext.current.state === "suspended") void audioContext.current.resume().catch(() => undefined);
      return audioContext.current;
    } catch {
      return undefined;
    }
  }, []);
  const playSound = () => {
    try {
      const context = audioContext.current;
      if (!context || context.state !== "running") return;
      playNotificationSound(context);
    } catch {
      // Sound is optional; visual unread state remains authoritative.
    }
  };
  const changeSound = (value: NotificationSound) => {
    const identityId = currentSession.data?.identityId;
    if (!identityId) return;
    setSound(value);
    writeSound(localStorage, identityId, value);
    // Create/resume within this user gesture so future notifications may play,
    // without treating a preference change as a notification itself.
    if (value !== "off") activateAudio();
  };

  useEffect(() => {
    if (!currentSession.data?.identityId || sound === "off") return;
    // A saved preference does not unlock Web Audio after reload. Re-arm it within
    // a user gesture without requiring the user to toggle their setting again.
    const unlock = (event: Event) => {
      if (event.isTrusted) activateAudio();
    };
    document.addEventListener("pointerdown", unlock, { passive: true });
    document.addEventListener("keydown", unlock);
    return () => {
      document.removeEventListener("pointerdown", unlock);
      document.removeEventListener("keydown", unlock);
    };
  }, [activateAudio, currentSession.data?.identityId, sound]);
  useEffect(() => () => {
    const context = audioContext.current;
    audioContext.current = undefined;
    if (context && context.state !== "closed") void context.close().catch(() => undefined);
  }, []);
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
  const suspendedConversationIds = JSON.stringify([...conversationLifecycles].filter(([, state]) => state !== "active").map(([id]) => id).sort());
  useEffect(() => {
    const identityId = currentSession.data?.identityId;
    const backgroundConversationIds = JSON.parse(backgroundConversationIdsKey) as string[];
    const suspendedIds = JSON.parse(suspendedConversationIds) as string[];
    if (!identityId || backgroundConversationIds.length === 0) return;
    const controller = new AbortController();
    const connections = backgroundConversationIds.map((conversationId) => {
      const mergeMessage = (message: ConversationMessage) => {
        queryClient.setQueryData<ConversationMessage[]>(
          queryKeys.conversationMessages(conversationId),
          (current) => mergeMessages(current, [message]),
        );
      };
      let metadataGeneration = 0;
      const refreshMetadata = () => {
        const generation = ++metadataGeneration;
        void conversations.getConversation(conversationId).then(updated => {
          // Responses may arrive out of order within this stable subscription.
          if (controller.signal.aborted || generation !== metadataGeneration) return;
          cacheConversationMetadata(queryClient, updated);
          void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceFolders(updated.workspaceId), exact: true });
          void queryClient.invalidateQueries({ queryKey: queryKeys.localConversationLifecycle(updated.id), exact: true });
          setKnownConversations(current => {
            if (controller.signal.aborted || generation !== metadataGeneration) return current;
            const previous = current.find(item => item.id === updated.id);
            if (!previous || JSON.stringify(previous) === JSON.stringify(updated)) return current;
            const next = current.map(item => item.id === updated.id ? updated : item);
            localStorage.setItem(`minu-channels:known-conversations:${identityId}`, JSON.stringify(next));
            return next;
          });
        }).catch(() => undefined);
      };
      return {
        conversationId,
        currentMessages: () => queryClient.getQueryData<ConversationMessage[]>(queryKeys.conversationMessages(conversationId)),
        listMessages: (options: { afterSequence: number; limit: number }) => conversations.listMessages(conversationId, options),
        onLiveMessage: (message: ConversationMessage) => {
          mergeMessage(message);
          const conversation = observedConversationsRef.current.find(item => item.id === conversationId);
          if (conversation) window.dispatchEvent(new CustomEvent("minu-live-message", { detail: { conversation, message } }));
        },
        onCatchUpMessage: mergeMessage,
        onRosterUpdated: refreshMetadata,
        onConversationUpdated: refreshMetadata,
      };
    });
    void (async () => {
      while (!controller.signal.aborted) {
        try {
          await runBackgroundConversationsConnection({
            signal: controller.signal,
            onReady: refreshWorkspaceNavigation,
            conversations: connections,
            // Remembered history observes available events without adding live topics.
            events: (options) => sharedConversationEvents(identityId, backgroundConversationIds, {
              ...options, mode: "observe", suspendedIds,
            }),
          });
        } catch {
          // The next bounded catch-up reconciles messages missed while disconnected.
        }
        if (!controller.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    })();
    return () => controller.abort();
  }, [backgroundConversationIdsKey, currentSession.data?.identityId, queryClient, refreshWorkspaceNavigation, suspendedConversationIds]);
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
        && document.hasFocus()
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
    const changed = () => {
      void queryClient.invalidateQueries({ queryKey: inboxKey(currentSession.data?.identityId) });
      void queryClient.invalidateQueries({ queryKey: activityKey(currentSession.data?.identityId) });
    };
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
  }, [activeConversationId, currentSession.data?.identityId, queryClient]);
  useEffect(() => {
    document.title = unreadTotal ? `(${unreadTotal}) MinuChannels` : "MinuChannels";
  }, [unreadTotal]);
  useEffect(() => {
    if (routeWorkspaceId) localStorage.setItem("minu-channels:last-workspace", routeWorkspaceId);
    if (routeWorkspaceId && activeConversationId) localStorage.setItem(`minu-channels:last-conversation:${routeWorkspaceId}`, activeConversationId);
  }, [activeConversationId, routeWorkspaceId]);
  useEffect(() => {
    if (pathname !== "/" || !selectedWorkspaceId) return;
    void selectWorkspace(selectedWorkspaceId, true);
  // Empty Workspaces must keep the chooser outside the settings/Agents shell.
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
      {lifecycleAction.error ? (
        <div className="fixed inset-x-4 top-3 z-50 flex items-center justify-between gap-3 rounded-md border border-[var(--danger)]/40 bg-[var(--panel)] px-3 py-2 text-xs text-[var(--danger)] shadow-lg" role="alert">
          <span>{lifecycleAction.error.message}</span>
          <button className="icon-button inline-flex" type="button" aria-label="Dismiss lifecycle error" onClick={() => lifecycleAction.reset()}>×</button>
        </div>
      ) : null}
      {workspaceFolders.error ? (
        <div role="alert" className="fixed right-4 top-3 z-50 rounded-md border border-[var(--danger)] bg-[var(--panel)] p-3 text-xs">
          {workspaceFolders.error.message}
          <button className="ml-2 underline" type="button" onClick={() => void workspaceFolders.refetch()}>Retry folders</button>
        </div>
      ) : null}
      <div className="hidden md:block">
        {settingsWorkspaceId ? <WorkspaceSettingsSidebar
          key={settingsWorkspaceId}
          workspaceId={settingsWorkspaceId}
          pathname={pathname}
          onBack={() => selectWorkspace(settingsWorkspaceId, true)}
        /> : <NavigationSidebar
          items={navigationItems}
          identityId={currentSession.data?.identityId}
          actorIdentityId={canAdministerFolders ? currentSession.data?.identityId : undefined}
          collapsedFolders={collapsedFolders}
          onFolderCollapseChange={changeFolderCollapse}
          activeConversationId={selectedConversationId}
          activeAgentsWorkspaceId={activeAgentsWorkspaceId}
          workspaces={workspaces.data ?? []}
          selectedWorkspaceId={selectedWorkspaceId}
          onSelectWorkspace={(workspaceId) => void selectWorkspace(workspaceId)}
          workspaceUnread={workspaceUnread}
          activityUnread={activityUnread}
          sound={sound}
          onSoundChange={currentSession.isSuccess ? changeSound : undefined}
          onLifecycleChange={canAdministerLifecycle ? runLifecycleChange : undefined}
          pendingLifecycleConversationId={lifecycleAction.isPending ? lifecycleAction.variables.conversationId : undefined}
        />}
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Drawer
          open={navigationOpen}
          onOpenChange={setNavigationOpen}
          side="left"
          title="Navigation"
          description={settingsWorkspaceId ? "Workspace settings" : "Choose a Workspace and Conversation."}
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
          {settingsWorkspaceId ? <WorkspaceSettingsSidebar
            key={settingsWorkspaceId}
            workspaceId={settingsWorkspaceId}
            pathname={pathname}
            onBack={() => selectWorkspace(settingsWorkspaceId, true)}
            mobile
            onNavigate={() => setNavigationOpen(false)}
          /> : <NavigationSidebar
            items={navigationItems}
            identityId={currentSession.data?.identityId}
            actorIdentityId={canAdministerFolders ? currentSession.data?.identityId : undefined}
            collapsedFolders={collapsedFolders}
            onFolderCollapseChange={changeFolderCollapse}
            activeConversationId={selectedConversationId}
            activeAgentsWorkspaceId={activeAgentsWorkspaceId}
            workspaces={workspaces.data ?? []}
            selectedWorkspaceId={selectedWorkspaceId}
            onSelectWorkspace={(workspaceId) => { void selectWorkspace(workspaceId); setNavigationOpen(false); }}
            workspaceUnread={workspaceUnread}
            activityUnread={activityUnread}
            sound={sound}
            onSoundChange={currentSession.isSuccess ? changeSound : undefined}
            onLifecycleChange={canAdministerLifecycle ? runLifecycleChange : undefined}
            pendingLifecycleConversationId={lifecycleAction.isPending ? lifecycleAction.variables.conversationId : undefined}
            onNavigate={() => setNavigationOpen(false)}
            onClose={() => setNavigationOpen(false)}
          />}
        </Drawer>
        <NotificationPreferencesContext.Provider value={currentSession.data ? { sound, onSoundChange: changeSound } : null}><Outlet /></NotificationPreferencesContext.Provider>
      </div>
    </div>
  );
}
