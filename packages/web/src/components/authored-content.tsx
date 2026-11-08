import type { LocalAuthoredDocument, LocalAuthoredDocumentSummary } from "@minu/channels-control/contracts";
import type { Participant } from "@minu/channels-core/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { LocalControlClientError } from "@minu/channels-control/client";
import { localControl } from "../lib/api";
import { queryKeys } from "../lib/query-keys";
import { MessageMarkdown } from "./message-markdown";
import { ErrorNotice } from "./ui/error-notice";

type Scope = { workspaceId: string; actorIdentityId: string; onDenied(): void };
function useAccessBoundary(scope: Scope, errors: readonly unknown[]) {
  useEffect(() => {
    if (errors.some(error => error instanceof LocalControlClientError && (error.status === 401 || error.status === 403))) scope.onDenied();
  }, [scope.onDenied, ...errors]);
}
const keys = {
  library: ({ workspaceId, actorIdentityId }: Scope) => ["local", "authored", workspaceId, actorIdentityId] as const,
  document: (scope: Scope, id: string) => [...keys.library(scope), "document", id] as const,
  history: (scope: Scope, id: string, version: number) => [...keys.library(scope), "history", id, version] as const,
  context: (scope: Scope, id: string) => [...keys.library(scope), "context", id] as const,
};

function DocumentEditor({ scope, document, kind, conversationId, onSaved }: {
  scope: Scope;
  document?: LocalAuthoredDocument;
  kind: LocalAuthoredDocument["kind"];
  conversationId?: string;
  onSaved(document: LocalAuthoredDocument): void;
}) {
  const [base, setBase] = useState(document);
  const [name, setName] = useState(document?.name ?? "");
  const [description, setDescription] = useState(document?.description ?? "");
  const [content, setContent] = useState(document?.content ?? "");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [review, setReview] = useState<LocalAuthoredDocument>();
  const queryClient = useQueryClient();
  const dirty = content !== (base?.content ?? "") || (kind === "skill"
    && (name !== (base?.name ?? "") || description !== (base?.description ?? "")));
  const editable = !base || base.state === "active";
  const saveFields = { ...(kind === "skill" ? { name, description } : {}), content };
  const mutation = useMutation({
    retry: false,
    mutationFn: (action: "save" | "publish" | "archive") => base
      ? localControl.updateAuthoredDocument(scope.workspaceId, base.id, action === "save"
        ? { action, expectedVersion: base.version, ...saveFields } : { action, expectedVersion: base.version })
      : localControl.createAuthoredDocument(scope.workspaceId, { kind, ...(conversationId ? { conversationId } : {}), ...saveFields }),
    onSuccess: (next) => {
      setBase(next); setName(next.name); setDescription(next.description); setContent(next.content); setReview(undefined);
      queryClient.setQueryData(keys.document(scope, next.id), next);
      onSaved(next);
    },
  });
  const latest = useMutation({
    retry: false,
    mutationFn: () => localControl.getAuthoredDocument(scope.workspaceId, base!.id),
    onSuccess: setReview,
  });
  const history = useQuery({
    queryKey: keys.history(scope, base?.id ?? "new", base?.version ?? 0),
    queryFn: () => localControl.listAuthoredDocumentRevisions(scope.workspaceId, base!.id),
    enabled: historyOpen && Boolean(base), retry: false, gcTime: 0,
  });
  useAccessBoundary(scope, [mutation.error, latest.error, history.error]);
  useEffect(() => {
    if (!document || !base || document.id !== base.id || document.version <= base.version || dirty || mutation.isPending || review) return;
    setBase(document); setName(document.name); setDescription(document.description); setContent(document.content);
  }, [document, base?.id, base?.version, dirty, mutation.isPending, review]);
  return <div className="space-y-3" aria-label={kind === "instructions" ? "Instruction editor" : "Skill editor"}>
    <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
      <span>{conversationId ? "Channel" : "Workspace"}</span>
      {base ? <><span>Draft v{base.version}</span><span>{base.publishedRevision ? `Published r${base.publishedRevision}` : "Unpublished"}</span></> : null}
      {base?.state === "archived" ? <span>Archived</span> : null}
    </div>
    {kind === "skill" ? <>
      <label className="block text-xs font-medium">Name<input className="settings-input mt-1" value={name} onChange={event => setName(event.target.value)} disabled={!editable || mutation.isPending} /></label>
      <label className="block text-xs font-medium">Description<input className="settings-input mt-1" value={description} onChange={event => setDescription(event.target.value)} disabled={!editable || mutation.isPending} /></label>
    </> : null}
    <label className="block text-xs font-medium">Instructions
      <textarea aria-label="Instructions" className="settings-input mt-1 min-h-36 font-mono" value={content} onChange={event => setContent(event.target.value)} disabled={!editable || mutation.isPending} />
    </label>
    <details className="text-xs"><summary className="cursor-pointer">Preview</summary><div className="message-markdown mt-2"><MessageMarkdown body={content} /></div></details>
    {mutation.error ? <ErrorNotice onDismiss={mutation.reset}>{mutation.error.message}</ErrorNotice> : null}
    {latest.error ? <ErrorNotice onDismiss={latest.reset}>{latest.error.message}</ErrorNotice> : null}
    {review ? <section aria-label="Latest saved draft" className="rounded border border-[var(--border)] p-3">
      <h4 className="text-xs font-semibold">Latest saved draft · v{review.version}</h4>
      {kind === "skill" ? <p className="mt-2 text-xs">{review.name} · {review.description}</p> : null}
      <MessageMarkdown body={review.content} />
      <button className="button-secondary mt-2" type="button" disabled={review.state !== "active"} onClick={() => { setBase(review); setReview(undefined); mutation.reset(); }}>Keep draft on latest revision</button>
    </section> : null}
    <div className="flex flex-wrap gap-2">
      <button className="button-secondary" type="button" disabled={!editable || mutation.isPending || (!dirty && Boolean(base)) || (kind === "skill" && !name.trim())} onClick={() => mutation.mutate("save")}>Save draft</button>
      <button className="button-primary" type="button" disabled={!editable || !base || dirty || mutation.isPending || (kind === "skill" && (!description.trim() || !content.trim()))} onClick={() => mutation.mutate("publish")}>Publish</button>
      {base ? <button className="button-secondary" type="button" onClick={() => setHistoryOpen(!historyOpen)}>Revision history</button> : null}
      {base && mutation.error ? <button className="button-secondary" type="button" disabled={latest.isPending} onClick={() => latest.mutate()}>Review latest</button> : null}
      {base && kind === "skill" && editable ? <button className="button-secondary" type="button" disabled={dirty || mutation.isPending} onClick={() => mutation.mutate("archive")}>Archive skill</button> : null}
    </div>
    {historyOpen ? <section aria-label="Published revisions" className="space-y-2">
      {history.isPending ? <span className="text-xs">Loading revisions…</span> : null}
      {history.error ? <p role="alert" className="text-xs text-[var(--danger)]">{history.error.message}</p> : null}
      {history.data?.length === 0 ? <span className="text-xs">No published revisions</span> : null}
      {history.data?.map(revision => <details key={revision.revision} className="rounded border border-[var(--border)] p-2 text-xs">
        <summary className="cursor-pointer">Revision {revision.revision} · {revision.createdAt}</summary>
        <MessageMarkdown body={revision.content} />
      </details>)}
    </section> : null}
  </div>;
}

function SavedEditor({ scope, id, onSaved }: { scope: Scope; id: string; onSaved(document: LocalAuthoredDocument): void }) {
  const query = useQuery({ queryKey: keys.document(scope, id), queryFn: () => localControl.getAuthoredDocument(scope.workspaceId, id),
    retry: false, gcTime: 0, refetchOnWindowFocus: false });
  useAccessBoundary(scope, [query.error]);
  if (query.error) return <p role="alert" className="text-xs text-[var(--danger)]">{query.error.message}</p>;
  if (!query.data) return <span className="text-xs">Loading draft…</span>;
  return <DocumentEditor key={id} scope={scope} document={query.data} kind={query.data.kind} conversationId={query.data.conversationId} onSaved={onSaved} />;
}

function EffectiveContext({ scope, conversationId, participants }: { scope: Scope; conversationId: string; participants: readonly Participant[] }) {
  const context = useQuery({ queryKey: keys.context(scope, conversationId), queryFn: () => localControl.getConversationAuthoredContext(conversationId),
    retry: false, gcTime: 0, refetchInterval: 5_000 });
  useAccessBoundary(scope, [context.error]);
  if (context.error) return <p role="alert" className="text-xs text-[var(--danger)]">{context.error.message}</p>;
  if (!context.data) return <span className="text-xs">Loading published instructions…</span>;
  const statuses = { applied: "Applied", pending: "Pending", legacy: "Not verified", not_started: "Not started", unavailable: "Unavailable" };
  return <section aria-label="Effective instructions" className="space-y-2 rounded border border-[var(--border)] p-3">
    <h4 className="text-xs font-semibold">Published instructions</h4>
    {context.data.instructions ? <MessageMarkdown body={context.data.instructions} /> : <span className="text-xs">None</span>}
    <h4 className="text-xs font-semibold">Session instructions</h4>
    {context.data.agents.map(agent => <div key={agent.identityId} className="text-xs">
      <span>{participants.find(participant => participant.id === agent.identityId)?.handle ?? agent.identityId}</span>
      <span className="ml-2" data-context-status={agent.status}>{statuses[agent.status]}</span>
      {agent.applied?.length ? <details><summary className="cursor-pointer">Applied revisions</summary><ul>{agent.applied.map(ref => <li key={ref.documentId}>{ref.source === "workspace" ? "Workspace" : "Channel"} · {ref.kind} · {ref.documentId} · r{ref.revision}</li>)}</ul></details> : null}
    </div>)}
  </section>;
}

function ContentPanel({ scope, conversationId, channelId, participants, section }: {
  scope: Scope; conversationId?: string; channelId?: string; participants: readonly Participant[]; section?: "instructions" | "skills";
}) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string>();
  const [newScope, setNewScope] = useState<"workspace" | "channel">(channelId ? "channel" : "workspace");
  const library = useQuery({ queryKey: keys.library(scope), queryFn: () => localControl.listAuthoredDocuments(scope.workspaceId), retry: false, gcTime: 0 });
  const refresh = (document?: LocalAuthoredDocument) => {
    if (document?.kind === "skill") setSelected(document.id);
    void queryClient.invalidateQueries({ queryKey: keys.library(scope) });
  };
  useAccessBoundary(scope, [library.error]);
  if (library.error) return <div role="alert" className="text-xs text-[var(--danger)]">{library.error.message}<button className="ml-2 underline" type="button" onClick={() => void library.refetch()}>Reload library</button></div>;
  if (!library.data) return <span className="text-xs">Loading instructions and skills…</span>;
  const instructions = library.data.find(document => document.kind === "instructions" && document.conversationId === channelId);
  const skills = library.data.filter(document => document.kind === "skill" && (document.conversationId === undefined || document.conversationId === channelId));
  const skillLabel = (document: LocalAuthoredDocumentSummary) => `${document.name} · ${document.conversationId ? "Channel" : "Workspace"}${document.state === "archived" ? " · Archived" : ""}`;
  return <div className="space-y-4">
    {section !== "skills" ? <section aria-label={channelId ? "Channel instructions" : "Workspace instructions"} className="space-y-3 rounded-lg border border-[var(--border)] bg-[var(--bg)] p-4">
      <h3 className="text-sm font-semibold">{channelId ? "Channel instructions" : "Workspace instructions"}</h3>
      {instructions ? <SavedEditor scope={scope} id={instructions.id} onSaved={refresh} />
        : <DocumentEditor scope={scope} kind="instructions" conversationId={channelId} onSaved={refresh} />}
    </section> : null}
    {section !== "instructions" ? <section aria-label="Authored skills" className="space-y-3 rounded-lg border border-[var(--border)] bg-[var(--bg)] p-4">
      <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-semibold">Skills</h3>
        <button className="button-secondary" type="button" onClick={() => setSelected("new")}>New skill</button></div>
      <div className="flex flex-col items-start gap-1">{skills.map(document => <button key={document.id} className="text-left text-xs underline underline-offset-2" type="button" onClick={() => setSelected(document.id)}>{skillLabel(document)}</button>)}</div>
      {selected === "new" ? <>
        {channelId ? <label className="block text-xs font-medium">Skill scope<select aria-label="Skill scope" className="settings-input mt-1" value={newScope} onChange={event => setNewScope(event.target.value as "workspace" | "channel")}><option value="channel">Channel</option><option value="workspace">Workspace</option></select></label> : null}
        <DocumentEditor key="new-skill" scope={scope} kind="skill" conversationId={newScope === "channel" ? channelId : undefined} onSaved={refresh} />
      </> : selected ? <SavedEditor key={selected} scope={scope} id={selected} onSaved={refresh} /> : null}
    </section> : null}
    {conversationId && section !== "skills" ? <EffectiveContext scope={scope} conversationId={conversationId} participants={participants} /> : null}
  </div>;
}

export function AuthoredContent({ workspaceId, actorIdentityId, canAdminister, conversationId, channelId = conversationId, participants = [], section }: {
  workspaceId: string; actorIdentityId?: string; canAdminister: boolean; section?: "instructions" | "skills";
  conversationId?: string; channelId?: string; participants?: readonly Participant[];
}) {
  const capabilities = useQuery({ queryKey: queryKeys.localCapabilities(), queryFn: () => localControl.capabilities(), enabled: canAdminister, retry: false, staleTime: 60_000 });
  const queryClient = useQueryClient();
  const identityKey = `${workspaceId}:${actorIdentityId}`;
  const [denied, setDenied] = useState<string>();
  const onDenied = useCallback(() => {
    setDenied(identityKey);
    queryClient.removeQueries({ queryKey: ["local", "authored", workspaceId, actorIdentityId] });
  }, [identityKey, workspaceId, actorIdentityId, queryClient]);
  if (!canAdminister || !actorIdentityId || denied === identityKey || !capabilities.data?.features.authoredContent) return null;
  return <ContentPanel key={`${workspaceId}:${actorIdentityId}:${conversationId ?? "workspace"}`} scope={{ workspaceId, actorIdentityId, onDenied }}
    conversationId={conversationId} channelId={channelId} participants={participants} section={section} />;
}
