import type { WorkspaceMember } from "@minu/channels-core/types";
import type { LocalWorkspaceConfigurationSummary } from "@minu/channels-control/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useSearch } from "@tanstack/react-router";
import { Bot, Clock, Settings, Users } from "lucide-react";
import { useState, type ReactNode } from "react";
import { conversations, localControl } from "../lib/api";
import { queryKeys } from "../lib/query-keys";
import { SettingsPageLayout } from "./settings-page-layout";
import { WorkspaceNameForm, WorkspaceRootForm, WorkspaceIdleSleepForm } from "./workspace-settings-forms";
import { NotificationPreferences } from "./notification-preferences";
import { useWorkspaceParticipants } from "./workspace-participants";
import { ErrorNotice } from "./ui/error-notice";

export function useWorkspacePageData() {
  const { workspaceId = "" } = useParams({ strict: false });
  const workspace = useQuery({ queryKey: queryKeys.workspace(workspaceId), queryFn: () => conversations.getWorkspace(workspaceId) });
  const administration = useWorkspaceParticipants(workspaceId, true);
  return { workspaceId, workspace, ...administration };
}

export function WorkspaceSettingsLayout({ active, children }: { active: "general" | "people" | "presets" | "defaults"; children: ReactNode }) {
  const { workspaceId, workspace, canAdminister } = useWorkspacePageData();
  const presets = useQuery({ queryKey: queryKeys.conversationPresets(workspaceId), queryFn: () => localControl.listConversationPresets(workspaceId), enabled: canAdminister === true, retry: false });
  const tabs = [
    { id: "general", label: "General", icon: Settings, to: "/app/workspaces/$workspaceId/settings" },
    { id: "people", label: "People & permissions", icon: Users, to: "/app/workspaces/$workspaceId/settings/people" },
    { id: "presets", label: "Conversation presets", icon: Bot, to: "/app/workspaces/$workspaceId/settings/presets" },
    { id: "defaults", label: "Defaults & timeouts", icon: Clock, to: "/app/workspaces/$workspaceId/settings/defaults" },
  ] as const;
  return <SettingsPageLayout title="Workspace settings" description={workspace.data?.name ?? "Manage this Workspace"}>
    <nav aria-label="Workspace settings" className="mb-7 flex gap-1 overflow-x-auto border-b border-[var(--border)]">
      {tabs.map(({ id, label, icon: Icon, to }) => <Link key={id} to={to} params={{ workspaceId }} aria-current={active === id ? "page" : undefined}
        className={`relative flex shrink-0 items-center gap-2 px-3 pb-3 pt-2 text-sm ${active === id ? "font-semibold text-[var(--text)] after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-[#f78166]" : "text-[var(--muted)] hover:text-[var(--text)]"}`}>
        <Icon className="h-4 w-4" aria-hidden="true" />{label}{id === "presets" && presets.data ? <span className="rounded-full bg-[var(--hover)] px-1.5 text-xs">{presets.data.presets.length}</span> : null}
      </Link>)}
    </nav>
    {children}
  </SettingsPageLayout>;
}

export function AdministrationState({ pending, error, canAdminister, children }: { pending: boolean; error?: Error | null; canAdminister?: boolean; children: ReactNode }) {
  if (pending) return <p role="status" className="p-4 text-sm text-[var(--muted)]">Loading settings…</p>;
  if (error) return <p role="alert" className="text-sm text-[var(--danger)]">{error.message} <button className="underline" type="button" onClick={() => window.location.reload()}>Reload settings</button></p>;
  if (!canAdminister) return <p role="alert" className="p-4 text-sm text-[var(--muted)]">An active Workspace owner or admin is required to edit these settings.</p>;
  return children;
}

function WorkspaceTurnTimeoutForm({ workspaceId, summary }: { workspaceId: string; summary: LocalWorkspaceConfigurationSummary }) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState(summary.turnTimeoutMs ?? 30 * 60_000);
  const mutation = useMutation({ mutationFn: () => localControl.updateWorkspaceConfiguration(workspaceId, { turnTimeoutMs: value }),
    onSuccess: (next) => queryClient.setQueryData(queryKeys.workspaceConfiguration(workspaceId), next) });
  return <form className="rounded-lg border border-[var(--border)] p-5" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}>
    <h2 className="text-sm font-semibold">Base turn timeout</h2><p className="mt-1 text-xs leading-5 text-[var(--muted)]">The default waiting limit for agent turns. Conversations can override it. Changes apply to the next turn.</p>
    <label className="mt-4 block text-xs font-medium">Turn timeout<select aria-label="Turn timeout" className="settings-input mt-1.5" value={value} onChange={(event) => setValue(Number(event.target.value))}>
      {[1, 5, 10, 15, 30].map((minutes) => <option key={minutes} value={minutes * 60_000}>{minutes} {minutes === 1 ? "minute" : "minutes"}{minutes === 30 ? " (default)" : ""}</option>)}
    </select></label>
    <div className="mt-4 flex items-center justify-end gap-3">{mutation.error ? <ErrorNotice onDismiss={mutation.reset}>{mutation.error.message}</ErrorNotice> : null}{mutation.isSuccess && value === (summary.turnTimeoutMs ?? 30 * 60_000) ? <span role="status" className="mr-auto text-xs text-[var(--success)]">Saved</span> : null}<button className="button-primary" disabled={mutation.isPending || value === (summary.turnTimeoutMs ?? 30 * 60_000)}>Save turn timeout</button></div>
  </form>;
}

function MemberAccess({ workspaceId, member, actorIdentityId, label, canEdit }: { workspaceId: string; member: WorkspaceMember; actorIdentityId: string; label: string; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const [role, setRole] = useState(member.accessRole);
  const mutation = useMutation({ mutationFn: () => conversations.updateWorkspaceMember(workspaceId, member.identityId, { actorIdentityId, accessRole: role }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceMembers(workspaceId) }); } });
  return <div className="border-t border-[var(--border)] px-4 py-3">
    <form className="flex flex-wrap items-center gap-3" onSubmit={(event) => { event.preventDefault(); if (canEdit && role !== member.accessRole && !mutation.isPending) mutation.mutate(); }}>
      <div className="min-w-36 flex-1"><p className="text-sm font-medium">{label}</p><p className="text-xs text-[var(--muted)]">@{member.mentionHandle} · {member.status}</p></div>
      {canEdit ? <select aria-label={`Access role for ${label}`} className="settings-input max-w-36" value={role} onChange={(event) => setRole(event.target.value as WorkspaceMember["accessRole"])}>
        <option value="owner">Owner</option><option value="admin">Admin</option><option value="member">Member</option>
      </select> : <span className="text-xs capitalize text-[var(--muted)]">{member.accessRole}</span>}
      {canEdit ? <button type="submit" className="button-secondary" disabled={role === member.accessRole || mutation.isPending}>Save role</button> : null}
    </form>{mutation.error ? <ErrorNotice onDismiss={mutation.reset} className="mt-2">{mutation.error.message}</ErrorNotice> : null}
  </div>;
}

export function WorkspaceSettingsPage({ section = "general" }: { section?: "general" | "people" | "defaults" }) {
  const data = useWorkspacePageData();
  const { focusName } = useSearch({ strict: false });
  const configuration = useQuery({ queryKey: queryKeys.workspaceConfiguration(data.workspaceId), queryFn: () => localControl.getWorkspaceConfiguration(data.workspaceId), enabled: data.session.isSuccess, retry: false });
  return <WorkspaceSettingsLayout active={section}>
    <div className="max-w-4xl space-y-5">
      {section === "general" ? <NotificationPreferences /> : null}
      <AdministrationState pending={data.pending || data.workspace.isPending || (data.canAdminister === true && configuration.isPending)} error={data.error ?? data.workspace.error ?? (data.canAdminister ? configuration.error : null)} canAdminister={data.canAdminister}>
        {data.workspace.data && data.session.data && configuration.data ? <>
          {section === "general" ? <><WorkspaceNameForm autoFocus={focusName === true} key={data.workspaceId} workspace={data.workspace.data} actorIdentityId={data.session.data.identityId} /><WorkspaceRootForm key={data.workspaceId} workspaceId={data.workspaceId} summary={configuration.data} /></> : null}
          {section === "defaults" ? <><WorkspaceTurnTimeoutForm key={`${data.workspaceId}:turn`} workspaceId={data.workspaceId} summary={configuration.data} /><WorkspaceIdleSleepForm key={`${data.workspaceId}:idle`} workspaceId={data.workspaceId} summary={configuration.data} /></> : null}
          {section === "people" ? <section className="overflow-hidden rounded-lg border border-[var(--border)]">
            <div className="flex flex-wrap items-center justify-between gap-3 p-5"><div><h2 className="text-sm font-semibold">People & permissions</h2><p className="mt-1 text-xs text-[var(--muted)]">Workspace membership controls access to Conversations and administration.</p></div><Link to="/app/workspaces/$workspaceId/agents" params={{ workspaceId: data.workspaceId }} className="button-secondary">Manage agents</Link></div>
            {data.participants.map(({ identity, member }) => <MemberAccess key={`${member.identityId}:${member.accessRole}`} workspaceId={data.workspaceId} actorIdentityId={data.session.data!.identityId} canEdit={data.currentMembership?.accessRole === "owner" && identity.type === "human"} member={member} label={identity.displayName ?? member.mentionHandle} />)}
          </section> : null}
        </> : null}
      </AdministrationState>
    </div>
  </WorkspaceSettingsLayout>;
}
