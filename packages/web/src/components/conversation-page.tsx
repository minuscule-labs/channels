import type { LocalBulkAgentLifecycleResult, LocalSessionContextMode, LocalTurnFailureNotice } from "@minu/channels-control/contracts";
import type { Participant } from "@minu/channels-core/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { AlertCircle, RefreshCw, Users } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { conversations, localControl } from "../lib/api";
import { useLiveConversation } from "../lib/live-conversation";
import { queryKeys } from "../lib/query-keys";
import { agentStatusRequestError, pendingAgentInspection, type AgentDiagnosticsSnapshot, type PendingAgentActions } from "../lib/agent-diagnostics";
import { readSequence, resetReadSequence, writeReadSequence } from "../lib/conversation-notifications";
import { isNearTimelineEnd } from "../lib/timeline";
import { ConversationActivityStrip } from "./conversation-activity-strip";
import { ConversationComposer } from "./conversation-composer";
import { ConversationTimeline } from "./conversation-timeline";
import { MemberRoster } from "./member-roster";
import { ParticipantDetailsDialog } from "./participant-details-dialog";
import { Drawer } from "./ui/drawer";
import { ErrorNotice } from "./ui/error-notice";

export function ConversationPage() {
  const { workspaceId, conversationId } = useParams({ from: "/app/workspaces/$workspaceId/conversations/$conversationId" });
  // Route parameters can change without unmounting the page. Keep feedback and
  // in-flight mutation callbacks scoped to the Conversation that created them.
  return <ConversationPageContent key={`${workspaceId}:${conversationId}`} workspaceId={workspaceId} conversationId={conversationId} />;
}

function ConversationPageContent({ workspaceId, conversationId }: { workspaceId: string; conversationId: string }) {
  const queryClient = useQueryClient();
  const [rosterOpen, setRosterOpen] = useState(false);
  const [unseenMessages, setUnseenMessages] = useState(0);
  const [bulkResults, setBulkResults] = useState<readonly LocalBulkAgentLifecycleResult[]>();
  const [bulkResultsExpanded, setBulkResultsExpanded] = useState(true);
  const [pendingBulkTargets, setPendingBulkTargets] = useState<ReadonlySet<string>>();
  const [issueDialogParticipantId, setIssueDialogParticipantId] = useState<string>();
  const [issueDialogOpen, setIssueDialogOpen] = useState(false);
  const [selectedIssue, setSelectedIssue] = useState<LocalTurnFailureNotice>();
  const issueNoticeTriggerRef = useRef<HTMLButtonElement | null>(null);
  const drawerMessageFocus = useRef<number | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);
  const nearEndRef = useRef(true);
  const scrollLayoutRef = useRef({ scrollHeight: 0, clientHeight: 0 });
  const scrollToLatest = useCallback((scroll: HTMLDivElement) => {
    scroll.scrollTo({ top: scroll.scrollHeight });
    scrollLayoutRef.current = { scrollHeight: scroll.scrollHeight, clientHeight: scroll.clientHeight };
  }, []);
  const previousMessageCountRef = useRef(0);
  const workspace = useQuery({
    queryKey: queryKeys.workspace(workspaceId),
    queryFn: () => conversations.getWorkspace(workspaceId),
  });
  const metadata = useQuery({
    queryKey: queryKeys.conversation(conversationId),
    queryFn: () => conversations.getConversation(conversationId),
  });
  const workspaceMembers = useQuery({
    queryKey: queryKeys.workspaceMembers(workspaceId),
    queryFn: () => conversations.listWorkspaceMembers(workspaceId),
  });
  const identities = useQuery({
    queryKey: queryKeys.identities(),
    queryFn: () => conversations.listIdentities(),
  });
  const messages = useQuery({
    queryKey: queryKeys.conversationMessages(conversationId),
    queryFn: () => conversations.listMessages(conversationId),
  });
  const currentSession = useQuery({
    queryKey: queryKeys.localCurrentSession(),
    queryFn: () => localControl.currentSession(),
    retry: false,
    refetchInterval: 60_000,
  });
  const lifecycle = useQuery({
    queryKey: queryKeys.localConversationLifecycle(conversationId),
    queryFn: () => localControl.getConversationLifecycle(conversationId),
    retry: false,
    staleTime: 5_000,
  });
  const localCapabilities = useQuery({
    queryKey: queryKeys.localCapabilities(),
    queryFn: () => localControl.capabilities(),
    retry: false,
    staleTime: 60_000,
  });
  const localAgents = useQuery({
    queryKey: queryKeys.localConversationAgents(conversationId),
    queryFn: async () => {
      const { agents } = await localControl.listConversationAgents(conversationId);
      return { agents, receivedAt: Date.now() };
    },
    retry: false,
    refetchInterval: (query) => query.state.status === "error"
      ? 30_000
      : query.state.data?.agents.some((agent) => agent.activity) ? 1_000 : 5_000,
  });
  const { connection, retry } = useLiveConversation(conversationId, currentSession.data?.identityId);
  const agentAction = useMutation({
    mutationFn: ({ action, identityId }: {
      action: "start" | "start-fresh" | "reconnect" | "replace" | "replace-fresh" | "stop" | "cancel";
      identityId: string;
    }) => {
      if (action === "reconnect") return localControl.reconnectConversationAgent(conversationId, identityId);
      if (action === "replace") return localControl.replaceConversationAgent(conversationId, identityId, "with_context");
      if (action === "replace-fresh") return localControl.replaceConversationAgent(conversationId, identityId, "fresh");
      if (action === "stop") return localControl.stopConversationAgent(conversationId, identityId);
      if (action === "cancel") return localControl.cancelCurrentConversationAgent(conversationId, identityId);
      return localControl.startConversationAgent(
        conversationId,
        identityId,
        action === "start-fresh" ? "fresh" : "with_context",
      );
    },
    onMutate: ({ action, identityId }) => {
      setBulkResults(undefined);
      if (action !== "cancel") return undefined;
      const previous = localAgents.data;
      queryClient.setQueryData(queryKeys.localConversationAgents(conversationId), (current: typeof localAgents.data) =>
        current ? { ...current, agents: current.agents.map((agent) => agent.identityId === identityId && agent.activity
          ? { ...agent, activity: { ...agent.activity, phase: "canceling" as const }, capabilities: { ...agent.capabilities, interrupt: false } }
          : agent) } : current,
      );
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKeys.localConversationAgents(conversationId), context.previous);
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.localConversationAgents(conversationId) });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.localConversationAgents(conversationId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversationMessages(conversationId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceConfiguration(workspaceId) });
    },
  });
  const lifecycleAction = useMutation({
    mutationFn: (state: "active" | "snoozed" | "settled") => localControl.updateConversationLifecycle(
      conversationId,
      state === "snoozed"
        ? { state, snoozedUntil: new Date(Date.now() + 60 * 60 * 1_000).toISOString() }
        : { state },
    ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.localConversationLifecycle(conversationId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceConversations(workspaceId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.localConversationAgents(conversationId) });
    },
  });
  const bulkAgentAction = useMutation({
    mutationFn: (action: "start" | "stop") => action === "start"
      ? localControl.startAllConversationAgents(conversationId)
      : localControl.stopAllConversationAgents(conversationId),
    onMutate: (action) => {
      setBulkResults(undefined);
      setBulkResultsExpanded(true);
      setPendingBulkTargets(new Set((localAgents.data?.agents ?? [])
        .filter(({ state }) => action === "start"
          ? state === "unbound" || state === "stopped"
          : state === "idle" || state === "running" || state === "disconnected" || state === "offline")
        .map(({ identityId }) => identityId)));
    },
    onSuccess: (response) => {
      setBulkResults(response.results);
      void queryClient.invalidateQueries({ queryKey: queryKeys.localConversationAgents(conversationId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversationMessages(conversationId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceConfiguration(workspaceId) });
    },
    onSettled: () => setPendingBulkTargets(undefined),
  });
  const startAllAgents = async () => {
    await bulkAgentAction.mutateAsync("start");
  };
  const stopAllAgents = async () => {
    await bulkAgentAction.mutateAsync("stop");
  };
  const participants = metadata.data?.participants ?? [];
  const issueDialogParticipant = participants.find(({ id }) => id === issueDialogParticipantId);
  const attributionParticipants = useMemo<Participant[]>(() => {
    const byId = new Map(participants.map((participant) => [participant.id, participant]));
    const identitiesById = new Map((identities.data ?? []).map((identity) => [identity.id, identity]));
    for (const member of workspaceMembers.data ?? []) {
      if (byId.has(member.identityId)) continue;
      const identity = identitiesById.get(member.identityId);
      if (!identity) continue;
      byId.set(identity.id, {
        id: identity.id,
        handle: member.mentionHandle,
        type: identity.type,
        displayName: identity.displayName,
        role: member.roleLabel,
        profile: member.profileOverride ?? identity.publicProfile,
        status: member.status,
      });
    }
    return [...byId.values()];
  }, [identities.data, participants, workspaceMembers.data]);
  const localAgentMap = useMemo(
    () => localAgents.data ? new Map(localAgents.data.agents.map((agent) => [agent.identityId, agent])) : undefined,
    [localAgents.data],
  );
  const localStatus = localAgents.isSuccess ? "available" : localAgents.isError ? "unavailable" : "loading";
  const currentMembership = workspaceMembers.data?.find(
    ({ identityId }) => identityId === currentSession.data?.identityId,
  );
  const currentParticipant = participants.find(({ id }) => id === currentSession.data?.identityId);
  const currentIdentity = identities.data?.find(({ id }) => id === currentSession.data?.identityId);
  const canViewTurnFailureNotices = currentSession.isSuccess && workspaceMembers.isSuccess && metadata.isSuccess
    && currentMembership?.status === "active"
    && Boolean(currentParticipant && currentParticipant.status !== "disabled");
  const canOpenDiagnostics = canViewTurnFailureNotices && workspace.isSuccess && workspace.data.status === "active" && identities.isSuccess
    && currentIdentity?.type === "human" && currentIdentity.status === "active"
    && (currentMembership?.accessRole === "owner" || currentMembership?.accessRole === "admin");
  useLayoutEffect(() => {
    if (!canOpenDiagnostics) return;
    const humanId = currentSession.data!.identityId;
    return () => {
      // Purge privileged Phase 1 projections on observed access/identity loss and navigation.
      // New history/detail/report data never enters this shared cache.
      for (const queryKey of [queryKeys.localConversationTurnFailures(conversationId, humanId), queryKeys.localConversationAgents(conversationId)]) {
        void queryClient.cancelQueries({ queryKey, exact: true });
        queryClient.removeQueries({ queryKey, exact: true });
      }
    };
  }, [canOpenDiagnostics, currentSession.data?.identityId, conversationId, queryClient]);
  const turnFailures = useQuery({
    queryKey: queryKeys.localConversationTurnFailures(conversationId, currentSession.data?.identityId),
    queryFn: () => localControl.listConversationTurnFailures(conversationId),
    enabled: canViewTurnFailureNotices,
    retry: false,
    refetchInterval: 10_000,
  });
  const pendingActions: PendingAgentActions = {
    individual: agentAction.isPending && agentAction.variables
      ? { ...agentAction.variables, requestedAt: agentAction.submittedAt } : undefined,
    bulk: bulkAgentAction.isPending && bulkAgentAction.variables ? {
      action: bulkAgentAction.variables,
      requestedAt: bulkAgentAction.submittedAt,
      identityIds: pendingBulkTargets ?? new Set(),
    } : undefined,
  };
  const diagnosticsSnapshot: AgentDiagnosticsSnapshot = {
    // Keep actual receipt time separate from React Query's optimistic cache updates.
    receivedAt: localAgents.data?.receivedAt ?? 0,
    refreshing: localAgents.isFetching,
    refreshFailed: localAgents.isError,
    refreshError: localAgents.isError ? agentStatusRequestError(localAgents.error) : undefined,
    refresh: () => { void localAgents.refetch(); },
  };
  const focusMessage = (sequence: number) => {
    const target = scrollRef.current?.querySelector<HTMLElement>(`[data-message-sequence="${sequence}"]`);
    target?.scrollIntoView({ block: "center" });
    target?.focus({ preventScroll: true });
  };
  const viewMessage = (sequence: number) => {
    // Called by the details dialog after its focus scope has closed. On mobile,
    // pass ownership to the outer drawer rather than racing its focus restoration.
    if (rosterOpen) {
      drawerMessageFocus.current = sequence;
      setRosterOpen(false);
    } else focusMessage(sequence);
  };
  const participantFeedback = {
    diagnosticScope: canOpenDiagnostics ? { humanIdentityId: currentSession.data!.identityId, workspaceId, conversationId } : undefined,
    onViewMessage: viewMessage,
    pendingActions,
    diagnosticsSnapshot,
    bulkActionError: bulkAgentAction.isError ? `Conversation-wide bulk request failed: ${bulkAgentAction.error.message}` : undefined,
    participantActionError: agentAction.isError && agentAction.variables
      ? { identityId: agentAction.variables.identityId, message: agentAction.error.message } : undefined,
    turnFailures: canOpenDiagnostics ? turnFailures.data?.diagnostics : undefined,
  };
  const settled = lifecycle.data?.state === "settled";
  const lifecycleLabel = lifecycle.data?.state === "snoozed" ? "Snoozed"
    : lifecycle.data?.state === "settled" ? "Archived"
      : "Active";

  const timelineReady = !metadata.isLoading && !messages.isLoading && !metadata.error && !messages.error && Boolean(metadata.data);

  useLayoutEffect(() => {
    nearEndRef.current = true;
    previousMessageCountRef.current = 0;
    setUnseenMessages(0);
    window.dispatchEvent(new CustomEvent("minu-conversation-view", {
      detail: { conversationId, nearEnd: true },
    }));
  }, [conversationId]);

  const markRead = useCallback(() => {
    window.dispatchEvent(new CustomEvent("minu-conversation-view", {
      detail: { conversationId, nearEnd: nearEndRef.current },
    }));
    const identityId = currentSession.data?.identityId;
    const sequence = messages.data?.at(-1)?.sequence;
    if (!scrollRef.current || !identityId || sequence === undefined || document.visibilityState !== "visible" || !nearEndRef.current) return;
    if (readSequence(localStorage, identityId, conversationId) > sequence) resetReadSequence(localStorage, identityId, conversationId);
    writeReadSequence(localStorage, identityId, conversationId, sequence);
    window.dispatchEvent(new Event("minu-read-state"));
  }, [conversationId, currentSession.data?.identityId, messages.data]);

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    // Messages may arrive before metadata; don't consume the initial count until the timeline mounts.
    if (!timelineReady || !scroll) return;
    const count = messages.data?.length ?? 0;
    const previousCount = previousMessageCountRef.current;
    previousMessageCountRef.current = count;
    if (nearEndRef.current) {
      scrollToLatest(scroll);
      setUnseenMessages(0);
      markRead();
    } else if (count > previousCount) {
      setUnseenMessages((current) => current + count - previousCount);
    }
  }, [conversationId, markRead, messages.data?.length, scrollToLatest, timelineReady]);

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    const content = scroll?.firstElementChild;
    if (!timelineReady || !scroll || !content) return;
    // Diagrams, syntax highlighting, composer resizing, and viewport changes can all move the end.
    const observer = new ResizeObserver(() => {
      if (nearEndRef.current) scrollToLatest(scroll);
    });
    observer.observe(scroll);
    observer.observe(content);
    return () => observer.disconnect();
  }, [conversationId, scrollToLatest, timelineReady]);
  useEffect(() => {
    const visible = () => markRead();
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, [markRead]);

  if (metadata.isLoading || messages.isLoading) {
    return <div className="grid h-full place-items-center text-sm text-[var(--muted)]">Loading Conversation…</div>;
  }
  if (metadata.error || messages.error || !metadata.data) {
    const error = metadata.error ?? messages.error;
    return (
      <div className="grid h-full place-items-center p-6">
        <div className="empty-state max-w-lg">
          <AlertCircle className="h-5 w-5 text-[var(--danger)]" />
          <h1 className="font-semibold">Unable to open Conversation</h1>
          <p>{error instanceof Error ? error.message : "Conversation metadata is unavailable."}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-4 pl-14 md:pl-5">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold" title={metadata.data.name}>#{metadata.data.name}</h1>
            <p className="truncate text-[11px] text-[var(--muted)]">Workspace: {workspace.data?.name ?? "Workspace"}</p>
            <span className="sr-only" role="status" aria-label={`Live updates ${connection}`}>Live updates {connection}</span>
          </div>
          {connection === "disconnected" ? (
            <button className="button-secondary" type="button" onClick={retry}>
              <RefreshCw className="h-3.5 w-3.5" /> Retry
            </button>
          ) : null}
          {lifecycle.data ? <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${settled ? "border-[var(--border)] text-[var(--muted)]" : lifecycle.data.state === "snoozed" ? "border-[var(--accent)]/40 text-[var(--accent)]" : "border-[var(--border)] text-[var(--muted)]"}`}>{lifecycleLabel}</span> : null}
          {canOpenDiagnostics && lifecycle.data && lifecycle.data.state !== "active" ? (
            <button className="button-secondary" type="button" disabled={lifecycleAction.isPending} onClick={() => lifecycleAction.mutate("active")}>Reopen</button>
          ) : null}
          <Drawer
            open={rosterOpen}
            onOpenChange={setRosterOpen}
            onCloseAutoFocus={(event) => {
              const sequence = drawerMessageFocus.current;
              if (sequence === undefined) return;
              event.preventDefault();
              drawerMessageFocus.current = undefined;
              focusMessage(sequence);
            }}
            side="right"
            title="Participants"
            description="Public members of this Conversation."
            trigger={(
              <button className="icon-button inline-flex lg:hidden" type="button" aria-label="Show participants">
                <Users className="h-4 w-4" />
              </button>
            )}
          >
            <MemberRoster
              participants={participants}
              currentHumanIdentityId={currentSession.data?.identityId}
              messages={messages.data ?? []}
              localAgents={localAgentMap}
              localStatus={localStatus}
              showDiagnostics={canOpenDiagnostics}
              {...participantFeedback}
              drawer
              readOnly={settled}
              onStartAgent={(identityId, contextMode: LocalSessionContextMode) => agentAction.mutateAsync({
                action: contextMode === "fresh" ? "start-fresh" : "start",
                identityId,
              })}
              onReconnectAgent={(identityId) => agentAction.mutateAsync({ action: "reconnect", identityId })}
              onReplaceAgent={(identityId, contextMode: LocalSessionContextMode) => agentAction.mutateAsync({
                action: contextMode === "fresh" ? "replace-fresh" : "replace",
                identityId,
              })}
              onCancelAgent={(identityId) => agentAction.mutateAsync({ action: "cancel", identityId })}
              onStopAgent={(identityId) => agentAction.mutateAsync({ action: "stop", identityId })}
              onStartAllAgents={localCapabilities.data?.features.agentBulkStart ? startAllAgents : undefined}
              onStopAllAgents={localCapabilities.data?.features.agentBulkStop ? stopAllAgents : undefined}
              bulkResultAction={bulkAgentAction.data ? bulkAgentAction.variables : undefined}
              onDismissAgentError={() => { if (agentAction.isError) agentAction.reset(); }}
              onDismissBulkError={() => { if (bulkAgentAction.isError) bulkAgentAction.reset(); }}
              bulkResults={bulkResults}
              bulkResultsExpanded={bulkResultsExpanded}
              onToggleBulkResults={() => setBulkResultsExpanded((expanded) => !expanded)}
              onDismissBulkResults={() => setBulkResults(undefined)}
            />
          </Drawer>
        </header>
        {connection === "polling" ? <p role="status" className="border-b border-[var(--border)] px-4 py-2 text-xs text-[var(--muted)]">Live updates are unavailable in this browser. Checking periodically; notification sounds are unavailable in this fallback mode.</p> : null}
        {settled ? (
          <div className="border-b border-[var(--border)] bg-[var(--panel)] px-4 py-2 text-xs text-[var(--muted)]" role="status">
            This Conversation is archived and read-only. Reopen it to send messages, edit participants, or manage agents.
          </div>
        ) : null}
        {[
          { name: "agent action", mutation: agentAction },
          { name: "bulk action", mutation: bulkAgentAction },
          { name: "Conversation status", mutation: lifecycleAction },
        ].map(({ name, mutation }) => mutation.error ? (
          <ErrorNotice
            key={name}
            className="border-b border-[var(--danger)]/30 bg-[var(--panel)] px-4 py-2"
            dismissLabel={`Dismiss ${name} error`}
            onDismiss={mutation.reset}
          >
            {mutation.error.message}
          </ErrorNotice>
        ) : null)}
        <div className="relative min-h-0 flex-1">
          <div
            ref={scrollRef}
            className="minu-scroll absolute inset-0 overflow-y-auto bg-[var(--bg)]"
            onScroll={(event) => {
              const scroll = event.currentTarget;
              const previousLayout = scrollLayoutRef.current;
              const layoutChanged = previousLayout.scrollHeight !== scroll.scrollHeight
                || previousLayout.clientHeight !== scroll.clientHeight;
              // Layout/clamping can emit scroll before ResizeObserver. Don't mistake that for reading history.
              if (nearEndRef.current && layoutChanged) scrollToLatest(scroll);
              else nearEndRef.current = isNearTimelineEnd(scroll);
              scrollLayoutRef.current = { scrollHeight: scroll.scrollHeight, clientHeight: scroll.clientHeight };
              window.dispatchEvent(new CustomEvent("minu-conversation-view", {
                detail: { conversationId, nearEnd: nearEndRef.current },
              }));
              if (nearEndRef.current) {
                setUnseenMessages(0);
                markRead();
              }
            }}
          >
            <ConversationTimeline
              messages={messages.data ?? []}
              participants={participants}
              attributionParticipants={attributionParticipants}
              turnFailureNotices={turnFailures.data?.notices}
              canOpenIssueDetails={canOpenDiagnostics}
              onViewIssueDetails={(identityId, trigger, notice) => {
                issueNoticeTriggerRef.current = trigger;
                setSelectedIssue(notice);
                setIssueDialogParticipantId(identityId);
                setIssueDialogOpen(true);
              }}
            />
          </div>
          {unseenMessages ? (
            <button
              type="button"
              className="button-secondary absolute bottom-3 left-1/2 z-10 -translate-x-1/2 shadow-lg"
              onClick={() => {
                nearEndRef.current = true;
                setUnseenMessages(0);
                markRead();
                scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
              }}
            >
              {unseenMessages} new {unseenMessages === 1 ? "message" : "messages"}
            </button>
          ) : null}
        </div>
        <ConversationComposer
          key={`${conversationId}:${currentSession.data?.identityId ?? currentSession.status}`}
          participants={participants}
          workspaceId={workspaceId}
          conversationId={conversationId}
          currentHumanIdentityId={currentSession.isSuccess ? currentSession.data.identityId : undefined}
          identityStatus={currentSession.isPending ? "loading" : currentSession.isError ? "unavailable" : "ready"}
          activity={<ConversationActivityStrip agents={localAgents.data?.agents ?? []} participants={participants} />}
          readOnlyReason={settled ? "This Conversation is archived. Reopen it to send a message." : undefined}
        />
      </section>
      <div className="hidden lg:block">
        <MemberRoster
          participants={participants}
          currentHumanIdentityId={currentSession.data?.identityId}
          messages={messages.data ?? []}
          localAgents={localAgentMap}
          localStatus={localStatus}
          showDiagnostics={canOpenDiagnostics}
          {...participantFeedback}
          readOnly={settled}
          onStartAgent={(identityId, contextMode: LocalSessionContextMode) => agentAction.mutateAsync({
            action: contextMode === "fresh" ? "start-fresh" : "start",
            identityId,
          })}
          onReconnectAgent={(identityId) => agentAction.mutateAsync({ action: "reconnect", identityId })}
          onReplaceAgent={(identityId, contextMode: LocalSessionContextMode) => agentAction.mutateAsync({
            action: contextMode === "fresh" ? "replace-fresh" : "replace",
            identityId,
          })}
          onCancelAgent={(identityId) => agentAction.mutateAsync({ action: "cancel", identityId })}
          onStopAgent={(identityId) => agentAction.mutateAsync({ action: "stop", identityId })}
          onStartAllAgents={localCapabilities.data?.features.agentBulkStart ? startAllAgents : undefined}
          onStopAllAgents={localCapabilities.data?.features.agentBulkStop ? stopAllAgents : undefined}
          bulkResultAction={bulkAgentAction.data ? bulkAgentAction.variables : undefined}
          onDismissAgentError={() => { if (agentAction.isError) agentAction.reset(); }}
          onDismissBulkError={() => { if (bulkAgentAction.isError) bulkAgentAction.reset(); }}
          bulkResults={bulkResults}
          bulkResultsExpanded={bulkResultsExpanded}
          onToggleBulkResults={() => setBulkResultsExpanded((expanded) => !expanded)}
          onDismissBulkResults={() => setBulkResults(undefined)}
        />
      </div>
      {issueDialogParticipant ? <ParticipantDetailsDialog
        participant={issueDialogParticipant}
        agent={localAgentMap?.get(issueDialogParticipant.id)}
        messages={messages.data ?? []}
        participants={participants}
        localStatus={localStatus}
        showDiagnostics={canOpenDiagnostics}
        diagnosticScope={participantFeedback.diagnosticScope}
        selectedIssue={selectedIssue}
        onViewMessage={viewMessage}
        pendingAction={pendingAgentInspection(issueDialogParticipant.id, pendingActions)}
        diagnosticsSnapshot={diagnosticsSnapshot}
        open={issueDialogOpen}
        onOpenChange={setIssueDialogOpen}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (issueNoticeTriggerRef.current?.isConnected) issueNoticeTriggerRef.current.focus();
        }}
        actionError={agentAction.isError && agentAction.variables?.identityId === issueDialogParticipant.id ? agentAction.error.message : participantFeedback.bulkActionError}
        failures={canOpenDiagnostics ? turnFailures.data?.diagnostics.filter(({ participant }) => participant.identityId === issueDialogParticipant.id) : undefined}
      /> : null}
    </div>
  );
}
