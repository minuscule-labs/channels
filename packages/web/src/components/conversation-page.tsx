import type { LocalBulkAgentLifecycleResult } from "@minu/channels-control/contracts";
import type { Participant } from "@minu/channels-core/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { AlertCircle, RefreshCw, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { conversations, localControl } from "../lib/api";
import { useLiveConversation } from "../lib/live-conversation";
import { shortId } from "../lib/messages";
import { queryKeys } from "../lib/query-keys";
import { readSequence, resetReadSequence, writeReadSequence } from "../lib/conversation-notifications";
import { isNearTimelineEnd } from "../lib/timeline";
import { ConversationActivityStrip } from "./conversation-activity-strip";
import { EditConversationParticipantsDialog } from "./conversation-administration-dialog";
import { ConversationComposer } from "./conversation-composer";
import { ConversationTimeline } from "./conversation-timeline";
import { MemberRoster } from "./member-roster";
import { Drawer } from "./ui/drawer";

export function ConversationPage() {
  const { workspaceId, conversationId } = useParams({ from: "/app/workspaces/$workspaceId/conversations/$conversationId" });
  const queryClient = useQueryClient();
  const [rosterOpen, setRosterOpen] = useState(false);
  const [unseenMessages, setUnseenMessages] = useState(0);
  const [bulkResults, setBulkResults] = useState<readonly LocalBulkAgentLifecycleResult[]>();
  const [pendingBulkTargets, setPendingBulkTargets] = useState<ReadonlySet<string>>();
  const scrollRef = useRef<HTMLDivElement>(null);
  const nearEndRef = useRef(true);
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
    queryFn: async () => (await localControl.listConversationAgents(conversationId)).agents,
    retry: false,
    refetchInterval: (query) => query.state.status === "error"
      ? 30_000
      : query.state.data?.some((agent) => agent.activity) ? 1_000 : 5_000,
  });
  const { connection, retry } = useLiveConversation(conversationId);
  const agentAction = useMutation({
    mutationFn: ({ action, identityId }: { action: "start" | "reconnect" | "replace" | "stop" | "cancel"; identityId: string }) => {
      if (action === "reconnect") return localControl.reconnectConversationAgent(conversationId, identityId);
      if (action === "replace") return localControl.replaceConversationAgent(conversationId, identityId);
      if (action === "stop") return localControl.stopConversationAgent(conversationId, identityId);
      if (action === "cancel") return localControl.cancelCurrentConversationAgent(conversationId, identityId);
      return localControl.startConversationAgent(conversationId, identityId);
    },
    onMutate: ({ action, identityId }) => {
      setBulkResults(undefined);
      if (action !== "cancel") return undefined;
      const previous = localAgents.data;
      queryClient.setQueryData(queryKeys.localConversationAgents(conversationId), (current: typeof localAgents.data) =>
        current?.map((agent) => agent.identityId === identityId && agent.activity
          ? { ...agent, activity: { ...agent.activity, phase: "canceling" as const }, capabilities: { ...agent.capabilities, interrupt: false } }
          : agent),
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
  const diagnosticAction = useMutation({
    mutationFn: async (target: { conversationId: string; identityId: string }) => {
      await localControl.openConversationAgentDiagnostic(target.conversationId, target.identityId);
      return target;
    },
  });
  const bulkAgentAction = useMutation({
    mutationFn: (action: "start" | "stop") => action === "start"
      ? localControl.startAllConversationAgents(conversationId)
      : localControl.stopAllConversationAgents(conversationId),
    onMutate: (action) => {
      setBulkResults(undefined);
      setPendingBulkTargets(new Set((localAgents.data ?? [])
        .filter(({ state }) => action === "start"
          ? state === "unbound" || state === "disabled"
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
  const startAllAgents = () => bulkAgentAction.mutate("start");
  const stopAllAgents = async () => {
    await bulkAgentAction.mutateAsync("stop");
  };
  const participants = metadata.data?.participants ?? [];
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
    () => localAgents.data ? new Map(localAgents.data.map((agent) => [agent.identityId, agent])) : undefined,
    [localAgents.data],
  );
  const localStatus = localAgents.isSuccess ? "available" : localAgents.isError ? "unavailable" : "loading";
  const currentMembership = workspaceMembers.data?.find(
    ({ identityId }) => identityId === currentSession.data?.identityId,
  );
  const canOpenDiagnostics = currentMembership?.status === "active"
    && (currentMembership.accessRole === "owner" || currentMembership.accessRole === "admin");
  const settled = lifecycle.data?.state === "settled";
  const lifecycleLabel = lifecycle.data?.state === "snoozed" ? "Snoozed"
    : lifecycle.data?.state === "settled" ? "Archived"
      : "Active";

  useEffect(() => {
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
    if (!identityId || sequence === undefined || document.visibilityState !== "visible" || !nearEndRef.current) return;
    if (readSequence(localStorage, identityId, conversationId) > sequence) resetReadSequence(localStorage, identityId, conversationId);
    writeReadSequence(localStorage, identityId, conversationId, sequence);
    window.dispatchEvent(new Event("minu-read-state"));
  }, [conversationId, currentSession.data?.identityId, messages.data]);

  useEffect(() => {
    const count = messages.data?.length ?? 0;
    const previousCount = previousMessageCountRef.current;
    previousMessageCountRef.current = count;
    if (!count || count <= previousCount) return;
    const added = count - previousCount;
    if (previousCount === 0 || nearEndRef.current) {
      requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }));
      setUnseenMessages(0);
      markRead();
    } else {
      setUnseenMessages((current) => current + added);
    }
  }, [markRead, messages.data?.length]);
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
            <div className="flex items-center gap-2">
              <h1 className="truncate text-sm font-semibold" title={metadata.data.name}>#{metadata.data.name}</h1>
              <span className={`connection-pill ${connection}`} aria-label={`Live updates ${connection}`}>
                <span className="status-dot" /> {connection}
              </span>
            </div>
            <p className="truncate text-[11px] text-[var(--muted)]">
              Workspace: {workspace.data?.name ?? shortId(workspaceId)} · Conversation ID {shortId(conversationId)} · roster {metadata.data.rosterRevision}
            </p>
          </div>
          {connection === "disconnected" ? (
            <button className="button-secondary" type="button" onClick={retry}>
              <RefreshCw className="h-3.5 w-3.5" /> Retry
            </button>
          ) : null}
          {settled ? null : <EditConversationParticipantsDialog conversation={metadata.data} />}
          {lifecycle.data ? <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${settled ? "border-[var(--border)] text-[var(--muted)]" : lifecycle.data.state === "snoozed" ? "border-[var(--accent)]/40 text-[var(--accent)]" : "border-[var(--border)] text-[var(--muted)]"}`}>{lifecycleLabel}</span> : null}
          {canOpenDiagnostics && lifecycle.data && lifecycle.data.state !== "active" ? (
            <button className="button-secondary" type="button" disabled={lifecycleAction.isPending} onClick={() => lifecycleAction.mutate("active")}>Reopen</button>
          ) : null}
          <Drawer
            open={rosterOpen}
            onOpenChange={setRosterOpen}
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
              showDiagnostics={currentSession.isSuccess}
              drawer
              readOnly={settled}
              onStartAgent={(identityId) => agentAction.mutateAsync({ action: "start", identityId })}
              onReconnectAgent={(identityId) => agentAction.mutateAsync({ action: "reconnect", identityId })}
              onReplaceAgent={(identityId) => agentAction.mutateAsync({ action: "replace", identityId })}
              onCancelAgent={(identityId) => agentAction.mutateAsync({ action: "cancel", identityId })}
              onStopAgent={(identityId) => agentAction.mutateAsync({ action: "stop", identityId })}
              onOpenAgentDiagnostic={canOpenDiagnostics
                ? (identityId) => diagnosticAction.mutateAsync({ conversationId, identityId })
                : undefined}
              openedDiagnosticIdentityId={diagnosticAction.data?.conversationId === conversationId
                ? diagnosticAction.data.identityId
                : undefined}
              pendingDiagnosticIdentityId={diagnosticAction.isPending
                && diagnosticAction.variables.conversationId === conversationId
                ? diagnosticAction.variables.identityId
                : undefined}
              onStartAllAgents={localCapabilities.data?.features.agentBulkStart ? startAllAgents : undefined}
              onStopAllAgents={localCapabilities.data?.features.agentBulkStop ? stopAllAgents : undefined}
              pendingAgentAction={agentAction.isPending ? agentAction.variables : undefined}
              pendingBulkAction={bulkAgentAction.isPending ? bulkAgentAction.variables : undefined}
              pendingBulkIdentityIds={pendingBulkTargets}
              bulkResultAction={bulkAgentAction.data ? bulkAgentAction.variables : undefined}
              bulkResults={bulkResults}
            />
          </Drawer>
        </header>
        {settled ? (
          <div className="border-b border-[var(--border)] bg-[var(--panel)] px-4 py-2 text-xs text-[var(--muted)]" role="status">
            This Conversation is archived and read-only. Reopen it to send messages, edit participants, or manage agents.
          </div>
        ) : null}
        {agentAction.error || diagnosticAction.error || bulkAgentAction.error || lifecycleAction.error ? (
          <div className="border-b border-[var(--danger)]/30 bg-[var(--panel)] px-4 py-2 text-xs text-[var(--danger)]" role="alert">
            {(agentAction.error ?? diagnosticAction.error ?? bulkAgentAction.error ?? lifecycleAction.error)?.message}
          </div>
        ) : null}
        <div className="relative min-h-0 flex-1">
          <div
            ref={scrollRef}
            className="minu-scroll absolute inset-0 overflow-y-auto bg-[var(--bg)]"
            onScroll={(event) => {
              nearEndRef.current = isNearTimelineEnd(event.currentTarget);
              window.dispatchEvent(new CustomEvent("minu-conversation-view", {
                detail: { conversationId, nearEnd: nearEndRef.current },
              }));
              if (nearEndRef.current) {
                setUnseenMessages(0);
                markRead();
              }
            }}
          >
            <ConversationTimeline messages={messages.data ?? []} participants={attributionParticipants} />
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
          activity={<ConversationActivityStrip agents={localAgents.data ?? []} participants={participants} />}
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
          showDiagnostics={currentSession.isSuccess}
          readOnly={settled}
          onStartAgent={(identityId) => agentAction.mutateAsync({ action: "start", identityId })}
          onReconnectAgent={(identityId) => agentAction.mutateAsync({ action: "reconnect", identityId })}
          onReplaceAgent={(identityId) => agentAction.mutateAsync({ action: "replace", identityId })}
          onCancelAgent={(identityId) => agentAction.mutateAsync({ action: "cancel", identityId })}
          onStopAgent={(identityId) => agentAction.mutateAsync({ action: "stop", identityId })}
          onOpenAgentDiagnostic={canOpenDiagnostics
            ? (identityId) => diagnosticAction.mutateAsync({ conversationId, identityId })
            : undefined}
          openedDiagnosticIdentityId={diagnosticAction.data?.conversationId === conversationId
            ? diagnosticAction.data.identityId
            : undefined}
          pendingDiagnosticIdentityId={diagnosticAction.isPending
            && diagnosticAction.variables.conversationId === conversationId
            ? diagnosticAction.variables.identityId
            : undefined}
          onStartAllAgents={localCapabilities.data?.features.agentBulkStart ? startAllAgents : undefined}
          onStopAllAgents={localCapabilities.data?.features.agentBulkStop ? stopAllAgents : undefined}
          pendingAgentAction={agentAction.isPending ? agentAction.variables : undefined}
          pendingBulkAction={bulkAgentAction.isPending ? bulkAgentAction.variables : undefined}
          pendingBulkIdentityIds={pendingBulkTargets}
          bulkResultAction={bulkAgentAction.data ? bulkAgentAction.variables : undefined}
          bulkResults={bulkResults}
        />
      </div>
    </div>
  );
}
