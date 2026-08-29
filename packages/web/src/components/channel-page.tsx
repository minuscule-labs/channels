import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { AlertCircle, RefreshCw, Users } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { channels, localControl } from "../lib/api";
import { useLiveChannel } from "../lib/live-channel";
import { shortId } from "../lib/messages";
import { queryKeys } from "../lib/query-keys";
import { isNearTimelineEnd } from "../lib/timeline";
import { ChannelComposer } from "./channel-composer";
import { ChannelTimeline } from "./channel-timeline";
import { MemberRoster } from "./member-roster";
import { Drawer } from "./ui/drawer";

export function ChannelPage() {
  const { workspaceId, channelId } = useParams({ from: "/app/workspaces/$workspaceId/channels/$channelId" });
  const [rosterOpen, setRosterOpen] = useState(false);
  const [unseenMessages, setUnseenMessages] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const nearEndRef = useRef(true);
  const previousMessageCountRef = useRef(0);
  const workspace = useQuery({
    queryKey: queryKeys.workspace(workspaceId),
    queryFn: () => channels.getWorkspace(workspaceId),
  });
  const metadata = useQuery({
    queryKey: queryKeys.channel(channelId),
    queryFn: () => channels.getChannel(channelId),
  });
  const messages = useQuery({
    queryKey: queryKeys.channelMessages(channelId),
    queryFn: () => channels.listMessages(channelId),
  });
  const localAgents = useQuery({
    queryKey: queryKeys.localChannelAgents(channelId),
    queryFn: async () => (await localControl.listChannelAgents(channelId)).agents,
    retry: false,
    refetchInterval: (query) => query.state.status === "error" ? 30_000 : 5_000,
  });
  const { connection, retry } = useLiveChannel(channelId);
  const participants = metadata.data?.participants ?? [];
  const localAgentMap = useMemo(
    () => localAgents.data ? new Map(localAgents.data.map((agent) => [agent.identityId, agent])) : undefined,
    [localAgents.data],
  );
  const localStatus = localAgents.isSuccess ? "available" : localAgents.isError ? "unavailable" : "loading";

  useEffect(() => {
    const count = messages.data?.length ?? 0;
    const previousCount = previousMessageCountRef.current;
    previousMessageCountRef.current = count;
    if (!count || count <= previousCount) return;
    const added = count - previousCount;
    if (previousCount === 0 || nearEndRef.current) {
      requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }));
      setUnseenMessages(0);
    } else {
      setUnseenMessages((current) => current + added);
    }
  }, [messages.data?.length]);

  if (metadata.isLoading || messages.isLoading) {
    return <div className="grid h-full place-items-center text-sm text-[var(--muted)]">Loading Channel…</div>;
  }
  if (metadata.error || messages.error || !metadata.data) {
    const error = metadata.error ?? messages.error;
    return (
      <div className="grid h-full place-items-center p-6">
        <div className="empty-state max-w-lg">
          <AlertCircle className="h-5 w-5 text-[var(--danger)]" />
          <h1 className="font-semibold">Unable to open Channel</h1>
          <p>{error instanceof Error ? error.message : "Channel metadata is unavailable."}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-4 pl-14 md:pl-5">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-sm font-semibold" title={metadata.data.name}>#{metadata.data.name}</h1>
              <span className={`connection-pill ${connection}`} aria-label={`Live updates ${connection}`}>
                <span className="status-dot" /> {connection}
              </span>
            </div>
            <p className="truncate text-[11px] text-[var(--muted)]">
              Workspace: {workspace.data?.name ?? shortId(workspaceId)} · Channel ID {shortId(channelId)} · roster {metadata.data.rosterRevision}
            </p>
          </div>
          {connection === "disconnected" ? (
            <button className="button-secondary" type="button" onClick={retry}>
              <RefreshCw className="h-3.5 w-3.5" /> Retry
            </button>
          ) : null}
          <Drawer
            open={rosterOpen}
            onOpenChange={setRosterOpen}
            side="right"
            title="Participants"
            description="Public members of this Channel."
            trigger={(
              <button className="icon-button inline-flex lg:hidden" type="button" aria-label="Show participants">
                <Users className="h-4 w-4" />
              </button>
            )}
          >
            <MemberRoster participants={participants} localAgents={localAgentMap} localStatus={localStatus} drawer />
          </Drawer>
        </header>
        <div className="relative min-h-0 flex-1">
          <div
            ref={scrollRef}
            className="minu-scroll absolute inset-0 overflow-y-auto bg-[var(--bg)]"
            onScroll={(event) => {
              nearEndRef.current = isNearTimelineEnd(event.currentTarget);
              if (nearEndRef.current) setUnseenMessages(0);
            }}
          >
            <ChannelTimeline messages={messages.data ?? []} participants={participants} />
          </div>
          {unseenMessages ? (
            <button
              type="button"
              className="button-secondary absolute bottom-3 left-1/2 z-10 -translate-x-1/2 shadow-lg"
              onClick={() => {
                nearEndRef.current = true;
                setUnseenMessages(0);
                scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
              }}
            >
              {unseenMessages} new {unseenMessages === 1 ? "message" : "messages"}
            </button>
          ) : null}
        </div>
        <ChannelComposer participants={participants} workspaceId={workspaceId} channelId={channelId} />
      </section>
      <div className="hidden lg:block">
        <MemberRoster participants={participants} localAgents={localAgentMap} localStatus={localStatus} />
      </div>
    </div>
  );
}
