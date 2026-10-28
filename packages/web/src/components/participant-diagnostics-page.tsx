import { LocalControlClientError } from "@minu/channels-control/client";
import { ConversationClientError } from "@minu/channels-core/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import { useLayoutEffect, useState } from "react";
import { conversations, localControl } from "../lib/api";
import { participantDiagnosticsHref, participantLabel } from "../lib/participants";
import { queryKeys } from "../lib/query-keys";
import { liveCapabilityLabel, runtimeStateLabel } from "../lib/participant-status";
import { OperationDiagnostics } from "./operation-diagnostics";
import { TurnFailureDiagnostics } from "./turn-failure-diagnostics";

export function ParticipantDiagnosticsPage() {
  const { workspaceId, conversationId, participantId } = useParams({ from: "/app/workspaces/$workspaceId/conversations/$conversationId/participants/$participantId/diagnostics" });
  const navigate = useNavigate();
  const location = useLocation();
  const [revoked, setRevoked] = useState(false);
  const queryClient = useQueryClient();
  const workspace = useQuery({ queryKey: queryKeys.workspace(workspaceId), queryFn: () => conversations.getWorkspace(workspaceId), retry: false, refetchInterval: 5_000 });
  const metadata = useQuery({ queryKey: queryKeys.conversation(conversationId), queryFn: () => conversations.getConversation(conversationId), retry: false, refetchInterval: 5_000 });
  const session = useQuery({ queryKey: queryKeys.localCurrentSession(), queryFn: () => localControl.currentSession(), retry: false, refetchInterval: 5_000 });
  const members = useQuery({ queryKey: queryKeys.workspaceMembers(workspaceId), queryFn: () => conversations.listWorkspaceMembers(workspaceId), retry: false, refetchInterval: 5_000 });
  const identities = useQuery({ queryKey: queryKeys.identities(), queryFn: () => conversations.listIdentities(), retry: false, refetchInterval: 5_000 });
  const humanIdentityId = session.data?.identityId;
  const human = identities.data?.find(({ id }) => id === humanIdentityId);
  const membership = members.data?.find(({ identityId }) => identityId === humanIdentityId);
  const participant = metadata.data?.participants.find(({ id }) => id === humanIdentityId);
  const target = metadata.data?.participants.find(({ id }) => id === participantId);
  useLayoutEffect(() => setRevoked(false), [workspaceId, conversationId, participantId, humanIdentityId]);
  const authorized = !revoked && workspace.isSuccess && workspace.data.status === "active" && metadata.isSuccess && metadata.data.workspaceId === workspaceId
    && session.isSuccess && members.isSuccess && identities.isSuccess && human?.type === "human" && human.status === "active"
    && membership?.status === "active" && (membership.accessRole === "owner" || membership.accessRole === "admin") && participant && participant.status !== "disabled";
  const agentKey = [...queryKeys.localConversationAgents(conversationId), participantId, humanIdentityId] as const;
  const agent = useQuery({ queryKey: agentKey, queryFn: () => localControl.conversationAgent(conversationId, participantId), enabled: Boolean(authorized && target && (target.type === "agent" || target.type === "service")), retry: false, refetchInterval: 5_000 });
  const actionsKey = ["local", "pending-agent-actions", conversationId, humanIdentityId] as const;
  const actions = useQuery({ queryKey: actionsKey, queryFn: ({ signal }) => localControl.pendingAgentActions(conversationId, signal), enabled: Boolean(authorized), retry: false, refetchInterval: 1_000 });
  const requestPending = !actions.isSuccess || actions.data.actions.some(action => !action.identityId || action.identityId === participantId);
  // Sidebar notification previews use a bounded page under the ordinary message key.
  // Diagnostics needs its own complete public snapshot for exact message navigation.
  const messages = useQuery({ queryKey: [...queryKeys.conversationMessages(conversationId), "diagnostics"], queryFn: () => conversations.listMessages(conversationId), enabled: Boolean(authorized), retry: false });
  const failures = useQuery({ queryKey: queryKeys.localConversationTurnFailures(conversationId, humanIdentityId), queryFn: () => localControl.listConversationTurnFailures(conversationId), enabled: Boolean(authorized), retry: false, refetchInterval: 10_000 });
  const accessDenied = [workspace.error, metadata.error, session.error, members.error, identities.error, agent.error, actions.error, messages.error, failures.error]
    .some(error => (error instanceof LocalControlClientError || error instanceof ConversationClientError) && (error.status === 401 || error.status === 403));
  // Denial from any read revokes the whole surface, even while public metadata
  // is stale. Latch it so query cleanup or late responses cannot restore access.
  useLayoutEffect(() => { if (accessDenied) setRevoked(true); }, [accessDenied]);
  const canInspect = Boolean(authorized && !accessDenied);
  useLayoutEffect(() => {
    if (!canInspect) return;
    return () => {
      for (const queryKey of [agentKey, actionsKey, queryKeys.localConversationTurnFailures(conversationId, humanIdentityId)]) {
        void queryClient.cancelQueries({ queryKey, exact: true });
        queryClient.removeQueries({ queryKey, exact: true });
      }
    };
  }, [canInspect, conversationId, participantId, humanIdentityId, queryClient]);
  const viewMessage = (sequence: number) => {
    void navigate({ to: "/app/workspaces/$workspaceId/conversations/$conversationId", params: { workspaceId, conversationId }, hash: `message-${sequence}` });
  };
  const loadedSequences = new Set((messages.data ?? []).map(({ sequence }) => sequence));
  const search = new URLSearchParams(location.searchStr);
  const selectedSequence = Number(search.get("triggerSequence"));
  const selectedTime = search.get("failedAt");
  const selectedIssue = Number.isSafeInteger(selectedSequence) && selectedSequence > 0 && selectedTime;
  const issues = failures.data?.diagnostics.filter(issue => issue.participant.identityId === participantId
    && (!selectedIssue || (issue.triggerSequence === selectedSequence && issue.failedAt === selectedTime))) ?? [];
  return <main aria-label="Participant diagnostics" className="flex min-h-0 min-w-0 flex-1 flex-col">
    <header className="flex min-h-14 flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] px-5 py-3">
      <h1 className="text-base font-semibold">Diagnostics for {participantLabel(target, participantId)}</h1>
      <div className="flex items-center gap-2">
        <Link className="button-secondary" to="/app/workspaces/$workspaceId/conversations/$conversationId" params={{ workspaceId, conversationId }} hash={`participant-${participantId}`}>Back to conversation</Link>
        <a className="icon-button inline-flex" href={`${participantDiagnosticsHref(workspaceId, conversationId, participantId)}${location.searchStr}`} target="_blank" rel="noopener noreferrer" aria-label="Open diagnostics in new tab" title="Open diagnostics in new tab"><ExternalLink className="h-4 w-4" /></a>
      </div>
    </header>
    <div className="minu-scroll min-h-0 flex-1 overflow-y-auto p-5 text-xs">
      {canInspect && humanIdentityId ? <div className="mx-auto max-w-4xl space-y-6">
        {actions.isSuccess && requestPending ? <p role="status">Participant action pending</p> : null}
        <section aria-label="Participant diagnostics" className="space-y-2">
          <div className="flex items-center justify-between gap-2"><h2 className="font-semibold">Runtime</h2><button type="button" className="button-secondary" disabled={agent.isFetching} onClick={() => { void agent.refetch(); }}>Refresh status</button></div>
          <p>{agent.data ? runtimeStateLabel(agent.data) : "Status unavailable"}</p>
          {agent.isError ? <p role="status" className="text-[var(--warning)]">Status refresh failed</p> : null}
          {agent.data?.diagnostics ? <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[var(--muted)]">
            <dt>Connection</dt><dd>{agent.data.diagnostics.connection}</dd>
            <dt>Queue</dt><dd>{agent.data.diagnostics.queuedTurnsExact ? agent.data.diagnostics.queuedTurns : `${agent.data.diagnostics.queuedTurns}+`}</dd>
            <dt>Last binding verification</dt><dd>{agent.data.diagnostics.lastVerifiedAt ?? "Not verified"}</dd>
            {([["Safe activity", "safeActivityEvents"], ["Interrupt", "interrupt"], ["Reconnect existing", "reconnectExisting"], ["Interactive attach", "interactiveAttach"], ["Open diagnostic", "openDiagnostic"], ["Live skill verification", "liveSkillVerification"]] as const).map(([label, key]) => <div key={key} className="contents"><dt>{label}</dt><dd>{liveCapabilityLabel(agent.data!.diagnostics!.capabilities[key])}</dd></div>)}
          </dl> : null}
        </section>
        {selectedIssue ? <p>Runtime issue · message #{selectedSequence}</p> : null}
        {issues.length ? <TurnFailureDiagnostics diagnostics={issues} loadedSequences={loadedSequences} onViewMessage={viewMessage} /> : null}
        <OperationDiagnostics scope={{ workspaceId, conversationId, participantIdentityId: participantId, humanIdentityId }} loadedSequences={loadedSequences} onViewMessage={viewMessage} requestPending={requestPending} onAccessLost={() => setRevoked(true)} />
      </div> : <p role="status">Diagnostics unavailable</p>}
    </div>
  </main>;
}
