import type { LocalWorkspaceConfigurationSummary } from "@minu/channels-control/contracts";
import type { Workspace, WorkspaceMember } from "@minu/channels-core/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import { Check, LoaderCircle, Settings, X } from "lucide-react";
import { useMemo, useState } from "react";
import { channels, localControl } from "../lib/api";
import { queryKeys } from "../lib/query-keys";

function ConfigurationState({ configured, label }: { configured: boolean; label: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] px-2 py-0.5 text-[10px] text-[var(--muted)]"
      data-configured={configured}
    >
      <span className={`status-dot ${configured ? "" : "opacity-30"}`} />
      {label}: {configured ? "configured" : "not configured"}
    </span>
  );
}

function WorkspaceRootForm({
  workspaceId,
  summary,
}: {
  workspaceId: string;
  summary: LocalWorkspaceConfigurationSummary;
}) {
  const queryClient = useQueryClient();
  const [rootUri, setRootUri] = useState("");
  const mutation = useMutation({
    mutationFn: () => localControl.updateWorkspaceConfiguration(workspaceId, { rootUri }),
    onSuccess: (next) => {
      queryClient.setQueryData(queryKeys.workspaceConfiguration(workspaceId), next);
      setRootUri("");
    },
  });

  return (
    <form
      className="rounded-lg border border-[var(--border)] bg-[var(--bg)] p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (rootUri.trim() && !mutation.isPending) mutation.mutate();
      }}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Workspace source</h3>
          <p className="mt-1 text-xs leading-5 text-[var(--muted)]">
            The default source location used when starting new agent sessions.
          </p>
        </div>
        <ConfigurationState configured={summary.rootConfigured} label="Source" />
      </div>
      <label className="mt-4 block text-xs font-medium" htmlFor={`workspace-root-${workspaceId}`}>
        {summary.rootConfigured ? "Replace source location" : "Source location"}
      </label>
      <input
        id={`workspace-root-${workspaceId}`}
        value={rootUri}
        onChange={(event) => setRootUri(event.target.value)}
        autoComplete="off"
        spellCheck={false}
        placeholder="Path or URI"
        className="settings-input mt-1.5 font-mono"
      />
      <p className="mt-1.5 text-[10px] text-[var(--muted)]">
        The saved value is never read back. Existing sessions are unchanged.
      </p>
      <div className="mt-3 flex items-center justify-end gap-2">
        {mutation.error ? <span className="mr-auto text-xs text-[var(--danger)]">{mutation.error.message}</span> : null}
        {mutation.isSuccess ? <span className="mr-auto inline-flex items-center gap-1 text-xs text-[var(--success)]"><Check className="h-3 w-3" /> Saved</span> : null}
        <button className="button-primary" type="submit" disabled={!rootUri.trim() || mutation.isPending}>
          {mutation.isPending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : null}
          Save source
        </button>
      </div>
    </form>
  );
}

export function WorkspaceSettingsDialog({ workspace }: { workspace: Workspace }) {
  const [open, setOpen] = useState(false);
  const session = useQuery({
    queryKey: queryKeys.localCurrentSession(),
    queryFn: () => localControl.currentSession(),
    enabled: open,
    retry: false,
  });
  const configuration = useQuery({
    queryKey: queryKeys.workspaceConfiguration(workspace.id),
    queryFn: () => localControl.getWorkspaceConfiguration(workspace.id),
    enabled: open && session.isSuccess,
    retry: false,
  });
  const members = useQuery({
    queryKey: queryKeys.workspaceMembers(workspace.id),
    queryFn: () => channels.listWorkspaceMembers(workspace.id),
    enabled: open,
  });
  const membersById = useMemo(
    () => new Map((members.data ?? []).map((member) => [member.identityId, member])),
    [members.data],
  );
  const currentMembership: WorkspaceMember | undefined = session.data
    ? membersById.get(session.data.identityId)
    : undefined;

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button type="button" className="icon-button inline-flex min-h-8 min-w-8" aria-label={`Configure Workspace ${workspace.name}`} title="Workspace configuration">
          <Settings className="h-3.5 w-3.5" />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/55" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-[71] flex max-h-[min(42rem,92vh)] w-[min(38rem,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl outline-none">
          <header className="flex shrink-0 items-start justify-between gap-4 border-b border-[var(--border)] px-5 py-4">
            <div>
              <Dialog.Title className="text-base font-semibold">{workspace.name} configuration</Dialog.Title>
              <Dialog.Description className="mt-1 text-xs leading-5 text-[var(--muted)]">
                Configure Workspace source without exposing the private path in conversations.
              </Dialog.Description>
            </div>
            <Dialog.Close className="icon-button inline-flex" aria-label="Close Workspace configuration"><X className="h-4 w-4" /></Dialog.Close>
          </header>
          <div className="minu-scroll min-h-0 flex-1 overflow-y-auto p-5">
            {currentMembership ? (
              <p className="mb-4 text-[11px] text-[var(--muted)]">
                Signed in as <strong className="font-mono text-[var(--text)]">@{currentMembership.mentionHandle}</strong> · {currentMembership.accessRole}
              </p>
            ) : null}
            {session.isPending || members.isPending || (session.isSuccess && configuration.isPending) ? (
              <div className="empty-state"><p>Loading Workspace configuration…</p></div>
            ) : session.error || configuration.error || members.error ? (
              <div className="empty-state">
                <h2 className="text-sm font-semibold text-[var(--text)]">Configuration unavailable</h2>
                <p>{(session.error ?? configuration.error ?? members.error)?.message}</p>
                <button className="button-secondary w-fit" type="button" onClick={() => {
                  void session.refetch();
                  void configuration.refetch();
                  void members.refetch();
                }}>Retry</button>
              </div>
            ) : configuration.data ? (
              <WorkspaceRootForm workspaceId={workspace.id} summary={configuration.data} />
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
