import { CONVERSATION_PRESET_STARTERS, type ConversationPreset, type ConversationSetup, type LocalConversationPresets, type SaveConversationPresetInput } from "@minu/channels-control/contracts";
import { createResourceId } from "@minu/channels-core/ids";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { localControl } from "../lib/api";
import { queryKeys } from "../lib/query-keys";
import { ConversationSetupFields, copySetup } from "./conversation-preset-editor";
import { AdministrationState, useWorkspacePageData, WorkspaceSettingsLayout } from "./workspace-settings-page";
import type { WorkspaceParticipant } from "./workspace-participants";
import { ErrorNotice } from "./ui/error-notice";

export function ConversationPresetsPage() {
  const data = useWorkspacePageData();
  const presets = useQuery({ queryKey: queryKeys.conversationPresets(data.workspaceId), queryFn: () => localControl.listConversationPresets(data.workspaceId), enabled: data.canAdminister === true });
  return <WorkspaceSettingsLayout active="presets">
    <AdministrationState pending={data.pending || (data.canAdminister === true && presets.isPending)} error={data.error ?? presets.error} canAdminister={data.canAdminister}>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-base font-semibold">Conversation presets</h2><p className="mt-1 text-sm text-[var(--muted)]">Reusable teams and defaults built from your existing Workspace agents.</p></div><Link to="/app/workspaces/$workspaceId/settings/presets/new" params={{ workspaceId: data.workspaceId }} className="button-primary"><Plus className="h-4 w-4" />New preset</Link></div>
      <div className="overflow-hidden rounded-lg border border-[var(--border)]">
        {presets.data?.presets.length ? presets.data.presets.map((preset) => <div key={preset.id} className="flex flex-wrap items-center gap-4 border-b border-[var(--border)] p-5 last:border-0">
          <div className="min-w-0 flex-1"><Link to="/app/workspaces/$workspaceId/settings/presets/$presetId" params={{ workspaceId: data.workspaceId, presetId: preset.id }} className="text-sm font-semibold text-[var(--accent)] hover:underline">{preset.name}</Link><p className="mt-1 text-xs text-[var(--muted)]">{preset.participants.length} agent roles · {preset.model ? `${preset.model.provider}/${preset.model.id}` : "Agent defaults"}</p>{preset.guidance ? <p className="mt-2 line-clamp-2 text-xs leading-5 text-[var(--muted)]">{preset.guidance}</p> : null}</div>
          <Link to="/app/workspaces/$workspaceId/settings/presets/$presetId" params={{ workspaceId: data.workspaceId, presetId: preset.id }} className="button-secondary" aria-label={`Edit ${preset.name}`}>Edit preset</Link>
        </div>) : <div className="empty-state p-8"><h3 className="text-sm font-semibold">No presets yet</h3><p>Create a team once, then select it when starting a Conversation.</p></div>}
      </div>
    </AdministrationState>
  </WorkspaceSettingsLayout>;
}

function PresetForm({ workspaceId, preset, participants }: { workspaceId: string; preset?: ConversationPreset; participants: WorkspaceParticipant[] }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [id] = useState(() => preset?.id ?? createResourceId("preset"));
  const [name, setName] = useState(preset?.name ?? "");
  const [setup, setSetup] = useState<ConversationSetup>(preset ? copySetup(preset) : { participants: [] });
  const [revision, setRevision] = useState<number | null>(preset?.revision ?? null);
  const [copyId] = useState(() => createResourceId("preset"));
  const pendingTarget = useRef(id);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [starter, setStarter] = useState("");
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
      setName(latest.name); setSetup(copySetup(latest)); setRevision(latest.revision);
    }
    else if (preset) { void navigate({ to: "/app/workspaces/$workspaceId/settings/presets", params: { workspaceId } }); }
    save.reset(); remove.reset(); setConfirmDelete(false);
  } });
  const busy = save.isPending || remove.isPending || reload.isPending;
  const valid = Boolean(name.trim()) && setup.participants.length <= 16 && setup.participants.every(({ role }) => Boolean(role.trim()));
  return <form onSubmit={(event) => { event.preventDefault(); if (valid && !busy) { pendingTarget.current = id; save.mutate({ targetId: id, input: { ...copySetup(setup), name: name.trim(), expectedRevision: revision } }); } }} className="max-w-4xl space-y-5">
    <div><Link to="/app/workspaces/$workspaceId/settings/presets" params={{ workspaceId }} className="text-xs text-[var(--muted)] hover:underline">← Conversation presets</Link><h2 className="mt-3 text-lg font-semibold">{preset ? "Edit preset" : "Create preset"}</h2><p className="mt-1 text-xs leading-5 text-[var(--muted)]">Changes to a preset apply when it is selected for a new Conversation.</p></div>
    <fieldset disabled={busy} className="space-y-5">
      <section className="space-y-4 rounded-lg border border-[var(--border)] p-5">
        <label className="block text-xs font-medium">Preset name<input className="settings-input mt-1.5" autoFocus value={name} maxLength={100} onChange={(event) => setName(event.target.value)} placeholder="Feature team" /></label>
        {!preset && revision === null ? <label className="block text-xs font-medium">Starting point<select aria-label="Starting point" className="settings-input mt-1.5" value={starter} onChange={(event) => {
          setStarter(event.target.value); const next = CONVERSATION_PRESET_STARTERS.find(({ id: candidate }) => candidate === event.target.value);
          setSetup(next ? copySetup(next) : { participants: [] });
        }}><option value="">Blank preset</option>{CONVERSATION_PRESET_STARTERS.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label> : null}
      </section>
      <ConversationSetupFields workspaceId={workspaceId} participants={participants} setup={setup} onChange={setSetup} />
    </fieldset>
    {save.error || remove.error || reload.error ? <ErrorNotice onDismiss={() => { save.reset(); remove.reset(); reload.reset(); }}>{(save.error ?? remove.error ?? reload.error)!.message} <button type="button" className="underline" disabled={busy} onClick={() => reload.mutate()}>Reload presets</button></ErrorNotice> : null}
    {save.isSuccess ? <p role="status" className="text-xs text-[var(--success)]">Preset saved.</p> : null}
    <div className="flex flex-wrap items-center justify-end gap-3 border-t border-[var(--border)] pt-5">
      {revision !== null ? <button type="button" className="button-secondary mr-auto" disabled={busy} onClick={() => setConfirmDelete(true)}>Delete preset</button> : null}
      {preset ? <button className="button-secondary" type="button" disabled={!valid || busy} onClick={() => {
        pendingTarget.current = copyId;
        save.mutate({ targetId: copyId, input: { ...copySetup(setup), name: name.trim(), expectedRevision: null } });
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
  return <WorkspaceSettingsLayout active="presets"><AdministrationState pending={data.pending || (!isNew && data.canAdminister === true && presets.isPending)} error={data.error ?? presets.error} canAdminister={data.canAdminister}>
    {isNew || preset ? <PresetForm key={`${data.workspaceId}:${presetId ?? "new"}`} workspaceId={data.workspaceId} participants={data.participants} preset={preset} /> : <p role="alert" className="text-sm">This preset is no longer available. <Link to="/app/workspaces/$workspaceId/settings/presets" params={{ workspaceId: data.workspaceId }} className="underline">Back to presets</Link></p>}
  </AdministrationState></WorkspaceSettingsLayout>;
}
