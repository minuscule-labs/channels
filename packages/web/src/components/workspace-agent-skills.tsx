import type { LocalAccountLibraryItem, LocalAuthoredDocumentSummary, LocalWorkspaceAgentConfiguration } from "@minu/channels-control/contracts";
import { LocalControlClientError } from "@minu/channels-control/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { localControl } from "../lib/api";
import { queryKeys } from "../lib/query-keys";
import { ErrorNotice } from "./ui/error-notice";

const denied = (error: unknown) => error instanceof LocalControlClientError && [401, 403].includes(error.status);
export function WorkspaceAgentSkills({ workspaceId, agentId, actorIdentityId }: { workspaceId: string; agentId: string; actorIdentityId: string }) {
  const config = useQuery({ queryKey: queryKeys.workspaceAgentConfiguration(workspaceId, agentId), queryFn: () => localControl.getWorkspaceAgentConfiguration(workspaceId, agentId), retry: false });
  const account = useQuery({ queryKey: ["local", "account-library", actorIdentityId], queryFn: () => localControl.listAccountLibraryItems(), retry: false, gcTime: 0 });
  const workspace = useQuery({ queryKey: ["local", "workspace-skills", workspaceId, actorIdentityId], queryFn: () => localControl.listAuthoredDocuments(workspaceId), retry: false, gcTime: 0 });
  const errors = [config.error, account.error, workspace.error].filter(Boolean);
  if (errors.some(denied)) return <p role="alert">Skill selection unavailable.</p>;
  const notice = errors.length ? <div role="alert" className="text-sm text-[var(--danger)]">{errors[0]?.message} <button type="button" className="underline" onClick={() => { void config.refetch(); void account.refetch(); void workspace.refetch(); }}>Reload skills</button></div> : null;
  if (!config.data || !account.data || !workspace.data) return notice ?? <p role="status">Loading skill selection…</p>;
  return <section aria-label="Agent authored skills" className="mt-5 space-y-4 rounded-lg border border-[var(--border)] p-4">
    <h2 className="text-sm font-semibold">Account and workspace skills</h2>
    {notice}
    <SkillSelectionEditor key={`${actorIdentityId}:${agentId}`} config={config.data} account={account.data} workspace={workspace.data} actorIdentityId={actorIdentityId} />
  </section>;
}

function SkillSelectionEditor({ config, account, workspace, actorIdentityId }: {
  config: LocalWorkspaceAgentConfiguration; account: LocalAccountLibraryItem[]; workspace: LocalAuthoredDocumentSummary[]; actorIdentityId: string;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [base, setBase] = useState(config);
  const [accountIds, setAccountIds] = useState(config.accountSkills?.ownerIdentityId === actorIdentityId ? config.accountSkills.skillIds : []);
  const [workspaceIds, setWorkspaceIds] = useState(config.workspaceSkillIds ?? []);
  const [accountTouched, setAccountTouched] = useState(false);
  const [workspaceTouched, setWorkspaceTouched] = useState(false);
  const selection = useMutation({
    retry: false,
    mutationFn: () => localControl.updateWorkspaceAgentConfiguration(config.workspaceId, config.identityId, {
      ...(accountTouched ? { accountSkillIds: accountIds } : {}), ...(workspaceTouched ? { workspaceSkillIds: workspaceIds } : {}),
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceAgentConfiguration(config.workspaceId, config.identityId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceConfiguration(config.workspaceId) });
      if (!mounted.current) return;
      setBase(current => ({ ...current, ...(accountTouched ? { accountSkills: { ownerIdentityId: actorIdentityId, skillIds: [...accountIds] } } : {}), ...(workspaceTouched ? { workspaceSkillIds: [...workspaceIds] } : {}) }));
      setAccountTouched(false); setWorkspaceTouched(false);
    },
  });
  const copy = useMutation({
    retry: false,
    mutationFn: (skill: LocalAccountLibraryItem) => localControl.copyAccountSkillToWorkspace(config.workspaceId, skill.id, skill.version),
    onSuccess: doc => {
      void queryClient.invalidateQueries({ queryKey: ["local", "workspace-skills", config.workspaceId, actorIdentityId] });
      if (mounted.current) void navigate({ to: "/app/workspaces/$workspaceId/settings/skills/$skillId", params: { workspaceId: config.workspaceId, skillId: doc.id } });
    },
  });
  if (denied(selection.error) || denied(copy.error)) return <p role="alert">Skill selection unavailable.</p>;
  const reload = () => {
    void queryClient.invalidateQueries({ queryKey: ["local", "account-library", actorIdentityId] });
    void queryClient.invalidateQueries({ queryKey: ["local", "workspace-skills", config.workspaceId, actorIdentityId] });
  };
  const pending = selection.isPending || copy.isPending;
  return <form aria-label="Agent skill selection" className="space-y-4" onSubmit={event => { event.preventDefault(); if ((accountTouched || workspaceTouched) && !pending) selection.mutate(); }}>
    <fieldset className="min-w-0 space-y-2" disabled={pending}><legend className="mb-2 text-xs font-medium">Account skills</legend>
      {account.filter(skill => skill.kind === "skill" && (skill.state === "active" || accountIds.includes(skill.id))).map(skill => <div key={skill.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-[var(--border)] p-2">
        <label className="flex min-w-0 items-start gap-2 text-sm"><input type="checkbox" aria-label={skill.name} checked={accountIds.includes(skill.id)} disabled={skill.state === "archived" && !accountIds.includes(skill.id)} onChange={event => { setAccountTouched(true); setAccountIds(ids => event.target.checked ? [...ids, skill.id] : ids.filter(id => id !== skill.id)); }} /><span className="break-words">{skill.name}{skill.state === "archived" ? " (Archived)" : ""}</span></label>
        <button type="button" className="button-secondary" aria-label={`Make independent copy of ${skill.name}`} disabled={skill.state !== "active"} onClick={() => copy.mutate(skill)}>Make independent copy</button>
      </div>)}
      {base.accountSkills?.ownerIdentityId !== actorIdentityId && base.accountSkills?.skillIds.length ? <button type="button" className="button-secondary" onClick={() => { setAccountTouched(true); setAccountIds([]); }}>Clear account skill selection</button> : null}
    </fieldset>
    <fieldset className="min-w-0 space-y-2" disabled={pending}><legend className="mb-2 text-xs font-medium">Workspace skills</legend>
      {workspace.filter(skill => skill.kind === "skill" && skill.conversationId === undefined && (skill.state === "active" && skill.publishedRevision !== undefined || workspaceIds.includes(skill.id))).map(skill => <label key={skill.id} className="flex items-start gap-2 break-words text-sm">
        <input type="checkbox" aria-label={skill.name} checked={workspaceIds.includes(skill.id)} onChange={event => { setWorkspaceTouched(true); setWorkspaceIds(ids => event.target.checked ? [...ids, skill.id] : ids.filter(id => id !== skill.id)); }} />{skill.name}{skill.state === "archived" ? " (Archived)" : ""}
      </label>)}
    </fieldset>
    {selection.error ? <ErrorNotice onDismiss={selection.reset}>{selection.error.message} <button type="button" className="underline" onClick={reload}>Reload skills</button></ErrorNotice> : null}
    {copy.error ? <ErrorNotice onDismiss={copy.reset}>{copy.error.message} <button type="button" className="underline" onClick={reload}>Reload skills</button></ErrorNotice> : null}
    <button type="submit" className="button-primary" disabled={pending || !accountTouched && !workspaceTouched}>Save skill selection</button>
    {selection.isSuccess && !accountTouched && !workspaceTouched ? <span role="status" className="ml-3 text-xs text-[var(--success)]">Saved</span> : null}
  </form>;
}
