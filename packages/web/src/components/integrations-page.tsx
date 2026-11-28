import { LocalControlClientError } from "@minu/channels-control/client";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { conversations, localControl } from "../lib/api";
import { buildTargetCatalog, credentialStatus, grantSummary, intentKey, type CredentialStatus } from "../lib/agent-credentials";
import { queryKeys } from "../lib/query-keys";
import { ApiKeyAccessDialog, useCredentialIntent, useTargetCatalog } from "./api-key-access-dialog";
import { IntegrationActionsMenu } from "./integration-actions-menu";
import { AdministrationState, useWorkspacePageData, WorkspaceSettingsLayout } from "./workspace-settings-page";

const columns = "md:grid-cols-[1.4fr_0.9fr_1fr_1fr_auto]";

function StatusBadge({ status }: { status: CredentialStatus }) {
  if (status === "active") return null;
  return <span className={`rounded px-1.5 py-0.5 text-xs ${status === "expired" ? "bg-[var(--warning)]/10 text-[var(--warning)]" : "bg-[var(--danger)]/10 text-[var(--danger)]"}`}>
    {status === "expired" ? "Expired" : "Revoked"}
  </span>;
}

function ReviewBadge({ workspaceId, credentialId }: { workspaceId: string; credentialId: string }) {
  const intent = useCredentialIntent(intentKey(workspaceId, "credential", credentialId));
  if (!intent || intent.state === "pending") return null;
  return <span className="rounded bg-[var(--warning)]/10 px-1.5 py-0.5 text-xs text-[var(--warning)]">Needs review</span>;
}

function loadFailure(error: Error): string {
  if (error instanceof LocalControlClientError && (error.status === 401 || error.status === 403)) return "An active Workspace owner or admin session is required to manage API keys.";
  if (error instanceof LocalControlClientError && error.status === 404) return "API key administration isn’t available in this app.";
  return "API keys couldn’t be loaded.";
}

function ConnectionDetails() {
  // The SPA is served from the web origin; only the control server knows its bound loopback listener.
  const capabilities = useQuery({ queryKey: queryKeys.localCapabilities(), queryFn: () => localControl.capabilities(), retry: false, staleTime: 60_000 });
  const inspectionUrl = capabilities.data?.agentApi?.inspectionUrl;
  return <section className="mt-8" aria-labelledby="api-connection-heading">
    <h2 id="api-connection-heading" className="text-lg font-semibold">Connection</h2>
    <div className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4">
      <pre className="minu-scroll overflow-x-auto text-xs leading-5" aria-label="HTTP request example">{[
        `POST ${inspectionUrl ?? "$CONTROL_ORIGIN/api/agent/v1/conversation/inspect"}`,
        "Authorization: Bearer <API key>",
        "Content-Type: application/json",
        "",
        "{\"conversationId\":\"<permitted Conversation or thread ID>\"}",
      ].join("\n")}</pre>
      {!inspectionUrl ? <p className="mt-3 text-xs text-[var(--muted)]">Use the loopback control origin from your launch URL (normally http://127.0.0.1:47411), not this page’s address.</p> : null}
    </div>
  </section>;
}

function ApiKeysSection({ workspaceId }: { workspaceId: string }) {
  const [createOpen, setCreateOpen] = useState(false);
  const credentials = useQuery({ queryKey: queryKeys.agentCredentials(workspaceId), queryFn: () => localControl.listAgentCredentials(workspaceId), retry: false });
  // Row summaries name parent Conversations from one list read; thread names appear once an access dialog has loaded them.
  const parents = useQuery({ queryKey: queryKeys.workspaceConversations(workspaceId), queryFn: () => conversations.listWorkspaceConversations(workspaceId) });
  const loaded = useTargetCatalog(workspaceId, false);
  const byId = new Map([...buildTargetCatalog(parents.data ?? [], []), ...loaded.targets].map(target => [target.id, target]));
  const failure = credentials.error ? loadFailure(credentials.error) : undefined;
  const denied = credentials.error instanceof LocalControlClientError && [401, 403, 404].includes(credentials.error.status);
  const now = Date.now();

  return <>
    <section aria-labelledby="api-keys-heading">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 id="api-keys-heading" className="text-lg font-semibold">API keys</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">Keys for scripts and agents that inspect Conversation status.</p>
        </div>
        {!denied ? <ApiKeyAccessDialog workspaceId={workspaceId} open={createOpen} onOpenChange={setCreateOpen}
          trigger={<button type="button" className="button-primary self-start sm:self-auto">Create key</button>} /> : null}
      </div>
      <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--panel)]" role="table" aria-label="API keys">
        <div role="row" className={`hidden gap-3 border-b border-[var(--border)] bg-[var(--panel-muted)] px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-[var(--muted)] md:grid ${columns}`}>
          <span role="columnheader">Name</span><span role="columnheader">UID</span><span role="columnheader">Created</span>
          <span role="columnheader">Expires</span><span role="columnheader"><span className="sr-only">Actions</span></span>
        </div>
        {credentials.isPending ? <p role="status" className="p-4 text-sm text-[var(--muted)]">Loading keys…</p> : null}
        {failure ? <div role="alert" className="flex flex-wrap items-center gap-3 p-4 text-sm">
          <span className={denied ? "text-[var(--muted)]" : "text-[var(--danger)]"}>{failure}</span>
          {!denied ? <button type="button" className="button-secondary" onClick={() => void credentials.refetch()}>Retry</button> : null}
        </div> : null}
        {(credentials.data ?? []).map(credential => {
          const status = credentialStatus(credential, now);
          return <div key={credential.id} role="row" className={`grid gap-3 border-b border-[var(--border-subtle)] px-4 py-4 text-sm transition-colors last:border-b-0 hover:bg-[var(--hover)] md:items-center md:py-3 ${columns}`}>
            <div role="cell" className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="truncate font-medium">{credential.name}</p>
                <StatusBadge status={status} />
                <ReviewBadge workspaceId={workspaceId} credentialId={credential.id} />
              </div>
              <p className="mt-0.5 truncate text-xs text-[var(--muted)]">{grantSummary(credential, byId)}</p>
            </div>
            <code role="cell" className="min-w-0 truncate text-xs text-[var(--muted)]" title={credential.id}>
              <span className="md:hidden">UID </span>{credential.id}
            </code>
            <span role="cell" className="text-xs text-[var(--muted)]"><span className="md:hidden">Created </span>{new Date(credential.createdAt).toLocaleString()}</span>
            <span role="cell" className="text-xs text-[var(--muted)]">
              <span className="md:hidden">{status === "expired" ? "Expired " : "Expires "}</span>{new Date(credential.expiresAt).toLocaleString()}
            </span>
            <div role="cell" className="flex md:justify-end">
              <IntegrationActionsMenu workspaceId={workspaceId} credential={credential} />
            </div>
          </div>;
        })}
        {credentials.data?.length === 0 ? <p className="p-4 text-sm text-[var(--muted)]">No API keys yet.</p> : null}
      </div>
    </section>
    {!denied ? <ConnectionDetails /> : null}
  </>;
}

export function IntegrationsPage() {
  const data = useWorkspacePageData();
  return <WorkspaceSettingsLayout>
    <div className="max-w-5xl">
      <AdministrationState pending={data.pending} error={data.error} canAdminister={data.canAdminister}>
        {/* Keyed so a Workspace change discards drafts and any visible one-time secret. */}
        <ApiKeysSection key={data.workspaceId} workspaceId={data.workspaceId} />
      </AdministrationState>
    </div>
  </WorkspaceSettingsLayout>;
}
