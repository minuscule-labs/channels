import { createResourceId } from "@minu/channels-core/ids";
import type { ConversationMetadata } from "@minu/channels-core/types";
import type { ConversationSetup, LocalConversationSettings, UpdateConversationSettingsInput } from "@minu/channels-control/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { FolderOpen, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { conversations, localControl } from "../lib/api";
import { cacheConversationMetadata } from "../lib/conversation-folders";
import { queryKeys } from "../lib/query-keys";
import { SettingsPageLayout } from "./settings-page-layout";
import { AuthoredContent } from "./authored-content";
import { AdministrationState, useWorkspacePageData } from "./workspace-settings-page";
import { ParticipantChoices, type WorkspaceParticipant } from "./workspace-participants";
import { ConversationPresetPicker, ConversationSetupFields, ConversationCreationSettings, copySetup } from "./conversation-preset-editor";
import { ConversationWorkingFolders } from "./conversation-working-folders";
import { ErrorNotice } from "./ui/error-notice";

function useConversationCache() {
  const client = useQueryClient();
  return (conversation: ConversationMetadata) => cacheConversationMetadata(client, conversation);
}

export function CreateConversationPage() {
  const data = useWorkspacePageData();
  const { folderId } = useSearch({ from: "/app/workspaces/$workspaceId/conversations/new" });
  return <SettingsPageLayout title="Create a Conversation" description={`Name it, choose your team, and set a folder${data.workspace.data ? ` in ${data.workspace.data.name}` : ""}.`}>
    <AdministrationState pending={data.pending || data.workspace.isPending} error={data.error ?? data.workspace.error} canAdminister={data.canAdminister}>
      <CreateConversationForm key={`${data.workspaceId}:${folderId ?? "unfiled"}`} initialFolderId={folderId} workspaceId={data.workspaceId} participants={data.participants} humanId={data.session.data?.identityId} />
    </AdministrationState>
  </SettingsPageLayout>;
}

function CreateConversationForm({ workspaceId, participants, humanId, initialFolderId }: { workspaceId: string; participants: WorkspaceParticipant[]; humanId?: string; initialFolderId?: string }) {
  const [name, setName] = useState("");
  const [setup, setSetup] = useState<ConversationSetup>({ participants: [] });
  const [folder, setFolder] = useState("");
  const [folderId, setFolderId] = useState(initialFolderId ?? "");
  const folders = useQuery({ queryKey: queryKeys.workspaceFolders(workspaceId), queryFn: () => conversations.listWorkspaceFolders(workspaceId), refetchOnMount: "always" });
  const [id, setId] = useState(() => createResourceId("conversation"));
  const navigate = useNavigate();
  const cache = useConversationCache();
  const queryClient = useQueryClient();
  const [returnConversationId] = useState(() => localStorage.getItem(`minu-channels:last-conversation:${workspaceId}`));
  const returnConversation = queryClient.getQueryData<ConversationMetadata[]>(queryKeys.workspaceConversations(workspaceId))?.find(({ id }) => id === returnConversationId);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const picker = useMutation({ mutationFn: () => localControl.selectLocalFolder(), onSuccess: (path) => { if (path && mounted.current) setFolder(path); } });
  const mutation = useMutation({ mutationFn: (input: Parameters<typeof localControl.createConversationWithSetup>[1]) => localControl.createConversationWithSetup(workspaceId, input), onSuccess: (conversation) => {
    cache(conversation);
    void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceConversations(workspaceId), exact: true });
    if (mounted.current) void navigate({ to: "/app/workspaces/$workspaceId/conversations/$conversationId", params: { workspaceId, conversationId: conversation.id } });
  } });
  const ready = Boolean(name.trim()) && setup.participants.length <= 16 && setup.participants.every(({ identityId, role }) => Boolean(role.trim()) && participants.some(({ identity, member }) => identity.id === identityId && identity.status === "active" && member.status === "active"));
  const busy = mutation.isPending || picker.isPending || folders.isPending;
  return <form className="max-w-3xl space-y-6" onSubmit={(event) => {
    event.preventDefault();
    const path = folder.trim();
    if (ready && !busy) mutation.mutate({ ...copySetup(setup), id, name: name.trim(), folderId: folderId || null, ...(path ? { workingFolder: path.startsWith("/") || path.startsWith("file:") || /^[a-z]:[\\/]/i.test(path) ? { path } : { relativePath: path } } : {}) });
  }}>
    <fieldset disabled={busy} className="space-y-6">
      <section className="rounded-lg border border-[var(--border)] p-5"><label className="block text-sm font-medium">Conversation name<input autoFocus className="settings-input mt-2" value={name} maxLength={100} placeholder="e.g. Website refresh" onChange={(event) => setName(event.target.value)} /></label>
        <label className="mt-4 block text-xs font-medium">Folder
          <select aria-label="Folder" className="settings-input mt-1.5" value={folderId} onChange={(event) => setFolderId(event.target.value)}>
            <option value="">Unfiled</option>
            {folderId && !folders.data?.some((entry) => entry.id === folderId) ? <option value={folderId}>Unavailable folder</option> : null}
            {folders.data?.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          </select>
        </label>
        <p className="mt-2 text-xs text-[var(--muted)]">Organize this Conversation in the sidebar.</p>
        {folders.error ? <p role="alert" className="mt-2 text-xs">Could not load folders. <button type="button" className="underline" onClick={() => void folders.refetch()}>Retry folders</button></p> : null}
      </section>
      <section className="space-y-5 rounded-lg border border-[var(--border)] p-5">
        <h2 className="text-sm font-semibold">Participants</h2>
        <ConversationPresetPicker workspaceId={workspaceId} onChange={setSetup} />
        <ParticipantChoices showHeading={false} participants={participants} selected={new Set([...(humanId ? [humanId] : []), ...setup.participants.flatMap(({ identityId }) => identityId ? [identityId] : [])])} currentHumanIdentityId={humanId} onToggle={(identityId) => setSetup((current) => {
          if (current.participants.some((entry) => entry.identityId === identityId)) return { ...current, participants: current.participants.filter((entry) => entry.identityId !== identityId) };
          const empty = current.participants.findIndex((entry) => !entry.identityId);
          if (empty >= 0) return { ...current, participants: current.participants.map((entry, position) => position === empty ? { ...entry, identityId } : entry) };
          return { ...current, participants: [...current.participants, { identityId, role: participants.find(({ identity }) => identity.id === identityId)?.member.roleLabel || "Collaborator" }] };
        })} />
        {setup.participants.some(({ identityId }) => !identityId) ? <p role="status" className="text-xs text-[var(--muted)]">Select an agent for each preset role: {setup.participants.filter(({ identityId }) => !identityId).map(({ role }) => role).join(", ")}. Select agents above to fill them.</p> : null}
        {setup.participants.some(({ identityId }) => identityId && !participants.some(({ identity, member }) => identity.id === identityId && identity.status === "active" && member.status === "active")) ? <p role="alert" className="text-xs">This preset includes an unavailable agent. Remove it below or choose another preset.</p> : null}
        {setup.participants.filter(({ identityId }) => identityId && !participants.some(({ identity, member }) => identity.id === identityId && identity.status === "active" && member.status === "active")).map((entry) => <button type="button" key={entry.identityId} className="button-secondary" onClick={() => setSetup({ ...setup, participants: setup.participants.filter((candidate) => candidate !== entry) })}>Remove unavailable {entry.role}</button>)}
      </section>
      <section className="rounded-lg border border-[var(--border)] p-5">
        <label className="block text-sm font-medium" htmlFor="creation-folder">Working folder</label><p className="mt-1 text-xs leading-5 text-[var(--muted)]">Use the Workspace source folder or choose a folder inside it.</p>
        <div className="mt-3 flex gap-2"><input id="creation-folder" className="settings-input min-w-0 flex-1" value={folder} onChange={(event) => setFolder(event.target.value)} placeholder="Workspace source (default)" /><button type="button" className="button-secondary" onClick={() => picker.mutate()}><FolderOpen className="h-4 w-4" />Browse</button></div>
        {picker.error ? <ErrorNotice onDismiss={picker.reset} className="mt-3">{picker.error.message}</ErrorNotice> : null}
      </section>
    </fieldset>
    {mutation.error ? <ErrorNotice onDismiss={mutation.reset}>{mutation.error.message} <button type="button" className="underline" onClick={() => { setId(createResourceId("conversation")); mutation.reset(); }}>Start a new draft</button></ErrorNotice> : null}
    <div className="flex flex-wrap items-center justify-end gap-3 border-t border-[var(--border)] pt-5">{returnConversation ? <Link to="/app/workspaces/$workspaceId/conversations/$conversationId" params={{ workspaceId, conversationId: returnConversation.id }} className="button-secondary">Cancel</Link> : <Link to="/app/workspaces/$workspaceId/agents" params={{ workspaceId }} className="button-secondary">Cancel</Link>}<button type="submit" className="button-primary" disabled={!ready || busy || folders.isError}><Plus className="h-4 w-4" />{mutation.isPending ? "Creating…" : "Create Conversation"}</button></div>
  </form>;
}

function ConversationNameForm({ conversation, actorIdentityId }: { conversation: ConversationMetadata; actorIdentityId: string }) {
  const [name, setName] = useState(conversation.name);
  const cache = useConversationCache();
  const save = useMutation({ mutationFn: () => conversations.updateConversation(conversation.id, { actorIdentityId, name: name.trim() }), onSuccess: cache });
  return <form className="rounded-lg border border-[var(--border)] p-5" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
    <h2 className="mb-4 text-sm font-semibold">General</h2><label className="block text-xs font-medium">Conversation name<input className="settings-input mt-1.5" value={name} maxLength={100} onChange={(event) => setName(event.target.value)} /></label>
    <div className="mt-4 flex items-center justify-end gap-3">{save.error ? <ErrorNotice onDismiss={save.reset}>{save.error.message}</ErrorNotice> : null}{save.isSuccess && name.trim() === conversation.name ? <p role="status" className="mr-auto text-xs text-[var(--success)]">Name saved</p> : null}<button className="button-primary" disabled={!name.trim() || name.trim() === conversation.name || save.isPending}>Save name</button></div>
  </form>;
}

function RosterForm({ conversation, participants, humanId }: { conversation: ConversationMetadata; participants: WorkspaceParticipant[]; humanId: string }) {
  const [selected, setSelected] = useState(new Set(conversation.participants.filter(({ status }) => status === "active").map(({ id }) => id)));
  const cache = useConversationCache();
  const queryClient = useQueryClient();
  const save = useMutation({ mutationFn: () => conversations.updateConversationParticipants(conversation.id, { actorIdentityId: humanId, participantIds: [...new Set([...selected, humanId])], expectedRosterRevision: conversation.rosterRevision }), onSuccess: (updated) => { cache(updated); void queryClient.invalidateQueries({ queryKey: queryKeys.localConversationAgents(conversation.id) }); } });
  return <form className="rounded-lg border border-[var(--border)] p-5" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
    <h2 className="mb-4 text-sm font-semibold">Participants</h2><fieldset disabled={save.isPending}><ParticipantChoices participants={participants} selected={selected} currentHumanIdentityId={humanId} existingParticipantIds={new Set(conversation.participants.map(({ id }) => id))} onToggle={(id) => setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; })} /></fieldset>
    <div className="mt-4 flex items-center justify-end gap-3">{save.error ? <ErrorNotice onDismiss={save.reset}>{save.error.message} <button type="button" className="underline" onClick={() => void queryClient.invalidateQueries({ queryKey: queryKeys.conversation(conversation.id) })}>Reload participants</button></ErrorNotice> : null}<button className="button-primary" disabled={save.isPending}>Save participants</button></div>
  </form>;
}

function setupForRoster(setup: ConversationSetup, conversation: ConversationMetadata, participants: WorkspaceParticipant[]): ConversationSetup {
  return { ...copySetup(setup), participants: participants.filter(({ identity }) => identity.type === "agent"
    && conversation.participants.some(({ id, status }) => id === identity.id && status === "active"))
    .map(({ identity, member }) => ({ identityId: identity.id,
      role: setup.participants.find(({ identityId }) => identityId === identity.id)?.role ?? member.roleLabel ?? "Collaborator" })) };
}

function AdvancedSettingsForm({ conversation, participants, initial }: { conversation: ConversationMetadata; participants: WorkspaceParticipant[]; initial: LocalConversationSettings }) {
  const queryClient = useQueryClient();
  const [revision, setRevision] = useState(initial.settings.revision);
  const cache = useConversationCache();
  const [setup, setSetup] = useState<ConversationSetup>(() => setupForRoster(initial.settings, conversation, participants));
  const save = useMutation({ mutationFn: (input: UpdateConversationSettingsInput) => localControl.updateConversationSettings(conversation.id, input), onSuccess: (result) => { queryClient.setQueryData(queryKeys.conversationSettings(conversation.id), result); setRevision(result.settings.revision); setSetup(setupForRoster(result.settings, conversation, participants)); } });
  const reload = useMutation({ mutationFn: async () => {
    const [settings, metadata] = await Promise.all([
      localControl.getConversationSettings(conversation.id), conversations.getConversation(conversation.id),
    ]);
    return { settings, metadata };
  }, onSuccess: ({ settings, metadata }) => {
    queryClient.setQueryData(queryKeys.conversationSettings(conversation.id), settings);
    cache(metadata);
    setSetup(setupForRoster(settings.settings, metadata, participants));
    setRevision(settings.settings.revision);
    save.reset();
  } });
  return <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); save.mutate({ ...copySetup(setup), expectedRevision: revision }); }}>
    <fieldset disabled={save.isPending || reload.isPending}><ConversationSetupFields workspaceId={conversation.workspaceId} setup={setup} onChange={setSetup} participants={participants} editParticipants={false} /></fieldset>
    {save.error || reload.error ? <ErrorNotice onDismiss={() => { save.reset(); reload.reset(); }}>{(save.error ?? reload.error)!.message} <button className="underline" type="button" disabled={save.isPending || reload.isPending} onClick={() => reload.mutate()}>Reload settings</button></ErrorNotice> : null}
    <div className="flex items-center justify-end gap-3">{save.isSuccess ? <p role="status" className="mr-auto text-xs text-[var(--success)]">Conversation settings saved</p> : null}<button type="submit" className="button-primary" disabled={save.isPending || reload.isPending || setup.participants.some(({ role }) => !role.trim())}>Save Conversation settings</button></div>
  </form>;
}

export function ConversationSettingsPage() {
  const data = useWorkspacePageData();
  const { conversationId = "" } = useParams({ strict: false });
  const conversation = useQuery({ queryKey: queryKeys.conversation(conversationId), queryFn: () => conversations.getConversation(conversationId) });
  const settings = useQuery({ queryKey: queryKeys.conversationSettings(conversationId), queryFn: () => localControl.getConversationSettings(conversationId), enabled: data.canAdminister === true, retry: false });
  return <SettingsPageLayout title="Conversation settings" description={conversation.data ? `#${conversation.data.name} · ${data.workspace.data?.name ?? "Workspace"}` : undefined} actions={<Link className="button-secondary" to="/app/workspaces/$workspaceId/conversations/$conversationId" params={{ workspaceId: data.workspaceId, conversationId }}>Back to Conversation</Link>}>
    <AdministrationState pending={data.pending || conversation.isPending || (data.canAdminister === true && settings.isPending)} error={data.error ?? conversation.error ?? settings.error} canAdminister={data.canAdminister}>
      {conversation.data?.workspaceId !== data.workspaceId ? <p role="alert">Conversation unavailable in this Workspace.</p> : conversation.data && data.session.data && settings.data ? conversation.data.thread ? <p className="text-sm">This thread inherits its settings. <Link className="underline" to="/app/workspaces/$workspaceId/conversations/$conversationId/settings" params={{ workspaceId: data.workspaceId, conversationId: conversation.data.thread.parentConversationId }}>Edit parent Conversation settings</Link></p> : <div className="max-w-4xl space-y-6">
        <ConversationNameForm key={`${conversationId}:name`} conversation={conversation.data} actorIdentityId={data.session.data.identityId} />
        <RosterForm key={`${conversationId}:roster:${conversation.data.rosterRevision}`} conversation={conversation.data} participants={data.participants} humanId={data.session.data.identityId} />
        <p className="text-xs text-[var(--muted)]">Create and configure agents on the <Link className="text-[var(--accent)] underline" to="/app/workspaces/$workspaceId/agents" params={{ workspaceId: data.workspaceId }}>Agents page</Link>.</p>
        <ConversationWorkingFolders conversationId={conversationId} canAdminister={data.canAdminister} />
        <AdvancedSettingsForm key={`${conversationId}:advanced:${conversation.data.rosterRevision}`} conversation={conversation.data} initial={settings.data} participants={data.participants} />
        <ConversationCreationSettings conversationId={conversationId} />
      </div> : null}
      {conversation.data?.workspaceId === data.workspaceId && data.session.data && settings.data ? <div className="mt-6 max-w-4xl">
        <AuthoredContent workspaceId={data.workspaceId} actorIdentityId={data.session.data.identityId} canAdminister={data.canAdminister === true}
          conversationId={conversationId} channelId={conversation.data.thread?.parentConversationId ?? conversationId} participants={conversation.data.participants} />
      </div> : null}
    </AdministrationState>
  </SettingsPageLayout>;
}
