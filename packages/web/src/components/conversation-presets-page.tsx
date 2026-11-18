import { type ConversationPreset, type LocalConversationPresets, type SaveConversationPresetInput } from "@minu/channels-control/contracts";
import { createResourceId } from "@minu/channels-core/ids";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { EllipsisVertical, Plus } from "lucide-react";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "./ui/dropdown-menu";
import { useEffect, useRef, useState } from "react";
import { localControl } from "../lib/api";
import { queryKeys } from "../lib/query-keys";
import { ParticipantChoices } from "./workspace-participants";

function copyPreset(setup: Pick<ConversationPreset, "participants" | "guidance">) {
  return { participants: setup.participants.map(({ identityId }) => ({ identityId })),
    ...(setup.guidance ? { guidance: setup.guidance } : {}) };
}
import { AdministrationState, useWorkspacePageData, WorkspaceSettingsLayout } from "./workspace-settings-page";
import type { WorkspaceParticipant } from "./workspace-participants";
import { ErrorNotice } from "./ui/error-notice";

export function ConversationPresetsPage() {
  const data = useWorkspacePageData();
  const presets = useQuery({ queryKey: queryKeys.conversationPresets(data.workspaceId), queryFn: () => localControl.listConversationPresets(data.workspaceId), enabled: data.canAdminister === true });
  return <WorkspaceSettingsLayout>
    <AdministrationState pending={data.pending || (data.canAdminister === true && presets.isPending)} error={data.error ?? presets.error} canAdminister={data.canAdminister}>
      <PresetList key={data.workspaceId} workspaceId={data.workspaceId} presets={presets.data?.presets ?? []} onReload={() => presets.refetch()} />
    </AdministrationState>
  </WorkspaceSettingsLayout>;
}

function PresetList({ workspaceId, presets, onReload }: { workspaceId: string; presets: ConversationPreset[]; onReload(): Promise<unknown> }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirmation, setConfirmation] = useState<ConversationPreset>();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const remove = useMutation({
    retry: false,
    mutationFn: (preset: ConversationPreset) => localControl.deleteConversationPreset(workspaceId, preset.id, preset.revision),
    onSuccess: (_result, preset) => {
      queryClient.setQueryData<LocalConversationPresets>(queryKeys.conversationPresets(workspaceId), current => current
        ? { ...current, presets: current.presets.filter(entry => entry.id !== preset.id) } : current);
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversationPresets(workspaceId) });
      if (mounted.current) setConfirmation(undefined);
    },
  });
  return <div className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-sm font-semibold">Conversation presets</h2><Link to="/app/workspaces/$workspaceId/settings/presets/new" params={{ workspaceId }} className="button-secondary"><Plus className="h-4 w-4" />New preset</Link></div>
    <div className="overflow-hidden rounded-md border border-[var(--border)]">
      <table aria-label="Conversation presets" className="w-full table-fixed text-sm">
        <colgroup><col /><col className="w-1/3" /><col className="w-14" /></colgroup>
        <thead className="bg-[var(--panel)] text-left text-xs text-[var(--muted)]"><tr><th scope="col" className="px-3 py-2 font-medium">Name</th><th scope="col" className="px-3 py-2 font-medium">Team</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{presets.map(preset => <tr key={preset.id} className="border-t border-[var(--border)] align-top">
          <td className="break-words px-3 py-3 font-medium">{preset.name}</td><td className="px-3 py-3 text-[var(--muted)]">{preset.participants.length} participants</td>
          <td className="px-2 py-2"><DropdownMenu><DropdownMenuTrigger asChild><button type="button" className="icon-button inline-flex" aria-label={`Preset actions for ${preset.name}`} disabled={remove.isPending}><EllipsisVertical className="h-4 w-4" aria-hidden="true" /></button></DropdownMenuTrigger>
            <DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => void navigate({ to: "/app/workspaces/$workspaceId/settings/presets/$presetId", params: { workspaceId, presetId: preset.id } })}>Edit</DropdownMenuItem><DropdownMenuItem tone="danger" onSelect={() => { remove.reset(); setConfirmation(preset); }}>Remove</DropdownMenuItem></DropdownMenuContent>
          </DropdownMenu></td>
        </tr>)}</tbody>
      </table>
      {!presets.length ? <p className="p-5 text-sm text-[var(--muted)]">No presets yet</p> : null}
    </div>
    {remove.error ? <ErrorNotice onDismiss={remove.reset}>{remove.error.message} <button type="button" className="underline" disabled={remove.isPending} onClick={() => { remove.reset(); setConfirmation(undefined); void onReload(); }}>Reload presets</button></ErrorNotice> : null}
    {confirmation ? <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--danger)] p-4 text-xs"><p className="mr-auto">Delete “{confirmation.name}”? Existing Conversations keep their settings.</p><button type="button" className="button-secondary" disabled={remove.isPending} onClick={() => setConfirmation(undefined)}>Keep preset</button><button type="button" className="button-primary" disabled={remove.isPending || remove.isError} onClick={() => remove.mutate(confirmation)}>Confirm delete</button></div> : null}
  </div>;
}

function PresetForm({ workspaceId, preset, participants }: { workspaceId: string; preset?: ConversationPreset; participants: WorkspaceParticipant[] }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [id] = useState(() => preset?.id ?? createResourceId("preset"));
  const [name, setName] = useState(preset?.name ?? "");
  const [setup, setSetup] = useState<Pick<ConversationPreset, "participants" | "guidance">>(preset ? copyPreset(preset) : { participants: [] });
  const [revision, setRevision] = useState<number | null>(preset?.revision ?? null);
  const [copyId] = useState(() => createResourceId("preset"));
  const pendingTarget = useRef(id);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const save = useMutation({ mutationFn: (request: { targetId: string; input: SaveConversationPresetInput }) => localControl.saveConversationPreset(workspaceId, request.targetId, request.input),
    onSuccess: (saved) => {
      queryClient.setQueryData<LocalConversationPresets>(queryKeys.conversationPresets(workspaceId), (current) => current
        ? { ...current, presets: [...current.presets.filter((entry) => entry.id !== saved.id), saved] } : current);
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversationPresets(workspaceId) });
      if (!mounted.current) return;
      setRevision(saved.revision);
      if (!preset || saved.id !== id) void navigate({ to: "/app/workspaces/$workspaceId/settings/presets/$presetId", params: { workspaceId, presetId: saved.id }, replace: true });
    } });
  const remove = useMutation({ mutationFn: (expected: number) => localControl.deleteConversationPreset(workspaceId, id, expected), onSuccess: () => {
    queryClient.setQueryData<LocalConversationPresets>(queryKeys.conversationPresets(workspaceId), (current) => current
      ? { ...current, presets: current.presets.filter((entry) => entry.id !== id) } : current);
    void queryClient.invalidateQueries({ queryKey: queryKeys.conversationPresets(workspaceId) });
    if (mounted.current) void navigate({ to: "/app/workspaces/$workspaceId/settings/presets", params: { workspaceId } });
  } });
  const reload = useMutation({ mutationFn: () => localControl.listConversationPresets(workspaceId), onSuccess: (result) => {
    queryClient.setQueryData(queryKeys.conversationPresets(workspaceId), result);
    if (!mounted.current) return;
    const latest = result.presets.find((entry) => entry.id === pendingTarget.current) ?? result.presets.find((entry) => entry.id === id);
    if (latest) {
      if (!preset || latest.id !== id) { void navigate({ to: "/app/workspaces/$workspaceId/settings/presets/$presetId", params: { workspaceId, presetId: latest.id }, replace: true }); return; }
      setName(latest.name); setSetup(copyPreset(latest)); setRevision(latest.revision);
    }
    else if (preset) { void navigate({ to: "/app/workspaces/$workspaceId/settings/presets", params: { workspaceId } }); }
    save.reset(); remove.reset(); setConfirmDelete(false);
  } });
  const busy = save.isPending || remove.isPending || reload.isPending;
  const valid = Boolean(name.trim()) && setup.participants.length <= 16 && setup.participants.every(({ identityId }) => Boolean(identityId));
  return <form onSubmit={(event) => { event.preventDefault(); if (valid && !busy) { pendingTarget.current = id; save.mutate({ targetId: id, input: { ...copyPreset(setup), name: name.trim(), expectedRevision: revision } }); } }} className="max-w-4xl space-y-5">
    <div><Link to="/app/workspaces/$workspaceId/settings/presets" params={{ workspaceId }} className="text-xs text-[var(--muted)] hover:underline">← Conversation presets</Link><h2 className="mt-3 text-lg font-semibold">{preset ? "Edit preset" : "Create preset"}</h2></div>
    <fieldset disabled={busy} className="space-y-5">
      <section className="space-y-4 rounded-lg border border-[var(--border)] p-5">
        <label className="block text-xs font-medium">Preset name<input className="settings-input mt-1.5" autoFocus value={name} maxLength={100} onChange={(event) => setName(event.target.value)} placeholder="Feature team" /></label>

      </section>
      <section className="rounded-lg border border-[var(--border)] p-5">
        <ParticipantChoices minimal participants={participants} selected={new Set(setup.participants.map(({ identityId }) => identityId))} onToggle={(identityId) => {
          setSetup(current => ({ ...current, participants: current.participants.some(entry => entry.identityId === identityId)
            ? current.participants.filter(entry => entry.identityId !== identityId) : [...current.participants, { identityId }] }));
        }} />
        {setup.participants.filter(({ identityId }) => !participants.some(({ identity, member }) => identity.id === identityId && identity.status === "active" && member.status === "active")).map(({ identityId }) =>
          <button key={identityId} type="button" className="button-secondary mt-3" onClick={() => setSetup(current => ({ ...current, participants: current.participants.filter(entry => entry.identityId !== identityId) }))}>Remove unavailable {identityId}</button>)}
      </section>
      <section className="rounded-lg border border-[var(--border)] p-5">
        <label className="block text-xs font-medium">Instructions<textarea className="settings-input mt-1.5 min-h-32" maxLength={16000} value={setup.guidance ?? ""} onChange={event => setSetup({ ...setup, guidance: event.target.value })} /></label>
      </section>
    </fieldset>
    {save.error || remove.error || reload.error ? <ErrorNotice onDismiss={() => { save.reset(); remove.reset(); reload.reset(); }}>{(save.error ?? remove.error ?? reload.error)!.message} <button type="button" className="underline" disabled={busy} onClick={() => reload.mutate()}>Reload presets</button></ErrorNotice> : null}
    {save.isSuccess ? <p role="status" className="text-xs text-[var(--success)]">Preset saved.</p> : null}
    <div className="flex flex-wrap items-center justify-end gap-3 border-t border-[var(--border)] pt-5">
      {revision !== null ? <button type="button" className="button-secondary mr-auto" disabled={busy} onClick={() => setConfirmDelete(true)}>Delete preset</button> : null}
      {preset ? <button className="button-secondary" type="button" disabled={!valid || busy} onClick={() => {
        pendingTarget.current = copyId;
        save.mutate({ targetId: copyId, input: { ...copyPreset(setup), name: name.trim(), expectedRevision: null } });
      }}>Save as new preset</button> : null}
      <Link className="button-secondary" to="/app/workspaces/$workspaceId/settings/presets" params={{ workspaceId }}>Cancel</Link>
      <button className="button-primary" type="submit" disabled={!valid || busy}>{busy ? "Saving…" : "Save preset"}</button>
    </div>
    {confirmDelete ? <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--danger)] p-4 text-xs"><p className="mr-auto">Delete “{preset?.name ?? name}”? Existing Conversations keep their settings.</p><button type="button" className="button-secondary" disabled={busy} onClick={() => setConfirmDelete(false)}>Keep preset</button><button type="button" className="button-primary" disabled={busy} onClick={() => { pendingTarget.current = id; remove.mutate(revision!); }}>Confirm delete</button></div> : null}
  </form>;
}

export function ConversationPresetPage() {
  const data = useWorkspacePageData();
  const { presetId } = useParams({ strict: false });
  const isNew = !presetId;
  const presets = useQuery({ queryKey: queryKeys.conversationPresets(data.workspaceId), queryFn: () => localControl.listConversationPresets(data.workspaceId), enabled: !isNew && data.canAdminister === true });
  const preset = presets.data?.presets.find(({ id }) => id === presetId);
  return <WorkspaceSettingsLayout><AdministrationState pending={data.pending || (!isNew && data.canAdminister === true && presets.isPending)} error={data.error ?? presets.error} canAdminister={data.canAdminister}>
    {isNew || preset ? <PresetForm key={`${data.workspaceId}:${presetId ?? "new"}`} workspaceId={data.workspaceId} participants={data.participants} preset={preset} /> : <p role="alert" className="text-sm">This preset is no longer available. <Link to="/app/workspaces/$workspaceId/settings/presets" params={{ workspaceId: data.workspaceId }} className="underline">Back to presets</Link></p>}
  </AdministrationState></WorkspaceSettingsLayout>;
}
