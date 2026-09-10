import type { ChannelMessage, ChannelMetadata } from "@minu/channels-core/types";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { Menu } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { channels, localControl } from "../lib/api";
import { queryKeys } from "../lib/query-keys";
import { mergeMessages } from "../lib/messages";
import { runBackgroundChannelConnection } from "../lib/background-channel";
import { readSequence, readSound, unreadFor, writeSound, type NotificationSound } from "../lib/channel-notifications";
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
  const viewingActiveChannelEnd = useRef(false);
  const audioContext = useRef<AudioContext | undefined>(undefined);
  const [knownChannels, setKnownChannels] = useState<ChannelMetadata[]>([]);
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
  const currentSession = useQuery({
    queryKey: queryKeys.localCurrentSession(),
    queryFn: () => localControl.currentSession(),
    retry: false,
    staleTime: 60_000,
  });
  const activeChannelId = pathname.match(/\/channels\/([^/]+)/)?.[1];
  const observedChannels = useMemo(() => {
    const byId = new Map(knownChannels.map((channel) => [channel.id, channel]));
    for (const channel of selectedChannels.data ?? []) byId.set(channel.id, channel);
    return [...byId.values()];
  }, [knownChannels, selectedChannels.data]);
  const channelMessageQueries = useQueries({
    queries: observedChannels.map((channel) => ({
      queryKey: queryKeys.channelMessages(channel.id),
      queryFn: () => channels.listMessages(channel.id, { limit: 100 }),
      enabled: Boolean(currentSession.data?.identityId),
      staleTime: Infinity,
    })),
  });
  const activeAgentsWorkspaceId = pathname.match(/\/workspaces\/([^/]+)\/agents(?:\/|$)/)?.[1];
  const allUnread = useMemo(() => {
    const result = new Map<string, { count: number; mentionCount: number }>();
    const identityId = currentSession.data?.identityId;
    if (!identityId) return result;
    for (const [index, channel] of observedChannels.entries()) {
      const messages = channelMessageQueries[index]?.data ?? [];
      result.set(channel.id, unreadFor(messages, identityId, readSequence(localStorage, identityId, channel.id)));
    }
    return result;
  // readRevision is incremented when a visible timeline advances its durable read cursor.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelMessageQueries.map(({ data }) => data), currentSession.data?.identityId, observedChannels, readRevision]);
  const unread = useMemo(() => new Map((selectedChannels.data ?? []).map((channel) => [
    channel.id,
    allUnread.get(channel.id) ?? { count: 0, mentionCount: 0 },
  ])), [allUnread, selectedChannels.data]);
  const unreadTotal = [...allUnread.values()].reduce((sum, value) => sum + value.count, 0);
  const workspaceUnread = useMemo(() => new Map((workspaces.data ?? []).map((workspace) => [
    workspace.id,
    observedChannels
      .filter((channel) => channel.workspaceId === workspace.id)
      .reduce((sum, channel) => sum + (allUnread.get(channel.id)?.count ?? 0), 0),
  ])), [allUnread, observedChannels, workspaces.data]);
  const navigationItems = useMemo<WorkspaceNavigationItem[]>(() => selectedWorkspace ? [{
    workspace: selectedWorkspace,
    channels: selectedChannels.data ?? [],
    loading: selectedChannels.isLoading,
    unread,
  }] : [], [selectedChannels.data, selectedChannels.isLoading, selectedWorkspace, unread]);

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
      setKnownChannels([]);
      return;
    }
    setSound(readSound(localStorage, identityId));
    try {
      setKnownChannels(JSON.parse(localStorage.getItem(`minu-channels:known-channels:${identityId}`) ?? "[]") as ChannelMetadata[]);
    } catch {
      setKnownChannels([]);
    }
  }, [currentSession.data?.identityId]);
  useEffect(() => {
    const identityId = currentSession.data?.identityId;
    if (!identityId || !selectedChannels.data) return;
    setKnownChannels((current) => {
      const byId = new Map(current
        .filter((channel) => channel.workspaceId !== selectedWorkspaceId)
        .map((channel) => [channel.id, channel]));
      for (const channel of selectedChannels.data) byId.set(channel.id, channel);
      const next = [...byId.values()];
      localStorage.setItem(`minu-channels:known-channels:${identityId}`, JSON.stringify(next));
      return next;
    });
  }, [currentSession.data?.identityId, selectedChannels.data, selectedWorkspaceId]);
  useEffect(() => {
    const identityId = currentSession.data?.identityId;
    if (!identityId) return;
    const controllers = observedChannels.filter(({ id }) => id !== activeChannelId).map((channel) => {
      const controller = new AbortController();
      const mergeMessage = (message: ChannelMessage) => {
        queryClient.setQueryData<ChannelMessage[]>(
          queryKeys.channelMessages(channel.id),
          (current) => mergeMessages(current, [message]),
        );
      };
      const mergeLiveMessage = (message: ChannelMessage) => {
        mergeMessage(message);
        window.dispatchEvent(new CustomEvent("minu-live-message", { detail: { channel, message } }));
      };
      void (async () => {
        while (!controller.signal.aborted) {
          try {
            await runBackgroundChannelConnection({
              signal: controller.signal,
              currentMessages: () => queryClient.getQueryData<ChannelMessage[]>(queryKeys.channelMessages(channel.id)),
              events: (options) => channels.events(channel.id, options),
              listMessages: (options) => channels.listMessages(channel.id, options),
              onLiveMessage: mergeLiveMessage,
              onCatchUpMessage: mergeMessage,
              onRosterUpdated: () => {
                void channels.getChannel(channel.id).then((updated) => {
                  queryClient.setQueryData(queryKeys.channel(channel.id), updated);
                  setKnownChannels((current) => {
                    const next = current.map((item) => item.id === updated.id ? updated : item);
                    localStorage.setItem(`minu-channels:known-channels:${identityId}`, JSON.stringify(next));
                    return next;
                  });
                }).catch(() => undefined);
              },
            });
          } catch {
            // The next bounded catch-up reconciles messages missed while disconnected.
          }
          if (!controller.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
      })();
      return controller;
    });
    return () => controllers.forEach((controller) => controller.abort());
  }, [activeChannelId, currentSession.data?.identityId, observedChannels, queryClient]);
  useEffect(() => {
    const identityId = currentSession.data?.identityId;
    if (!identityId || sound === "off") return;
    const notify = (event: Event) => {
      const { channel, message } = (event as CustomEvent<{ channel: ChannelMetadata; message: ChannelMessage }>).detail;
      if (soundedMessages.current.has(message.id)) return;
      soundedMessages.current.add(message.id);
      if (soundedMessages.current.size > 1_000) {
        const oldest = soundedMessages.current.values().next().value as string | undefined;
        if (oldest) soundedMessages.current.delete(oldest);
      }
      const viewingAtEnd = document.visibilityState === "visible"
        && channel.id === activeChannelId
        && viewingActiveChannelEnd.current;
      if (message.participantId === identityId || viewingAtEnd) return;
      const author = channel.participants.find(({ id }) => id === message.participantId);
      if (sound === "all" || message.to.includes(identityId) || author?.type === "agent") playSound();
    };
    window.addEventListener("minu-live-message", notify);
    return () => window.removeEventListener("minu-live-message", notify);
  }, [activeChannelId, currentSession.data?.identityId, sound]);
  useEffect(() => {
    viewingActiveChannelEnd.current = Boolean(activeChannelId);
    const changed = () => setReadRevision((value) => value + 1);
    const viewing = (event: Event) => {
      const detail = (event as CustomEvent<{ channelId: string; nearEnd: boolean }>).detail;
      if (detail.channelId === activeChannelId) viewingActiveChannelEnd.current = detail.nearEnd;
    };
    window.addEventListener("minu-read-state", changed);
    window.addEventListener("minu-channel-view", viewing);
    return () => {
      window.removeEventListener("minu-read-state", changed);
      window.removeEventListener("minu-channel-view", viewing);
    };
  }, [activeChannelId]);
  useEffect(() => {
    document.title = unreadTotal ? `(${unreadTotal}) MinuChannels` : "MinuChannels";
  }, [unreadTotal]);
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
