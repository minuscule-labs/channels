import type { LocalAuthoredDocument, LocalAuthoredDocumentSummary } from "@minu/channels-control/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { LocalControlClientError } from "@minu/channels-control/client";
import { localControl } from "../lib/api";
import { queryKeys } from "../lib/query-keys";
import { MessageMarkdown } from "./message-markdown";
import { ErrorNotice } from "./ui/error-notice";
import { EllipsisVertical } from "lucide-react";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "./ui/dropdown-menu";

type Scope = { workspaceId: string; actorIdentityId: string; onDenied(): void };
function useAccessBoundary(scope: Scope, errors: readonly unknown[]) {
  useEffect(() => {
    if (errors.some(error => error instanceof LocalControlClientError && (error.status === 401 || error.status === 403))) scope.onDenied();
  }, [scope.onDenied, ...errors]);
}
const keys = {
  library: ({ workspaceId, actorIdentityId }: Scope) => ["local", "authored", workspaceId, actorIdentityId] as const,
  document: (scope: Scope, id: string) => [...keys.library(scope), "document", id] as const,
};

function DocumentEditor({ scope, document, kind, onSaved, onDirtyChange, disabled = false }: {
  scope: Scope;
  document?: LocalAuthoredDocument;
  kind: LocalAuthoredDocument["kind"];
  onSaved(document: LocalAuthoredDocument): void;
  onDirtyChange?(dirty: boolean): void;
  disabled?: boolean;
}) {
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [base, setBase] = useState(document);
  const [name, setName] = useState(document?.name ?? "");
  const [description, setDescription] = useState(document?.description ?? "");
  const [content, setContent] = useState(document?.content ?? "");
  const [review, setReview] = useState<LocalAuthoredDocument>();
  const queryClient = useQueryClient();
  const dirty = content !== (base?.content ?? "") || (kind === "skill"
    && (name !== (base?.name ?? "") || description !== (base?.description ?? "")));
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  const editable = (!base || base.state === "active") && !disabled;
  const saveFields = { ...(kind === "skill" ? { name, description } : {}), content };
  const mutation = useMutation({
    retry: false,
    mutationFn: (action: "commit" | "archive") => base
      ? localControl.updateAuthoredDocument(scope.workspaceId, base.id, action === "commit"
        ? { action, expectedVersion: base.version, ...saveFields } : { action, expectedVersion: base.version })
      : localControl.createAuthoredDocument(scope.workspaceId, { action: "commit", kind, ...saveFields }),
    onSuccess: (next) => {
      void queryClient.invalidateQueries({ queryKey: keys.library(scope) });
      if (!mounted.current) return;
      setBase(next); setName(next.name); setDescription(next.description); setContent(next.content); setReview(undefined);
      queryClient.setQueryData(keys.document(scope, next.id), next);
      onSaved(next);
    },
  });
  const latest = useMutation({
    retry: false,
    mutationFn: () => localControl.getAuthoredDocument(scope.workspaceId, base!.id),
    onSuccess: next => { if (mounted.current) setReview(next); },
  });
  useAccessBoundary(scope, [mutation.error, latest.error]);
  useEffect(() => {
    if (!document || !base || document.id !== base.id || document.version <= base.version || dirty || mutation.isPending || review) return;
    setBase(document); setName(document.name); setDescription(document.description); setContent(document.content);
  }, [document, base?.id, base?.version, dirty, mutation.isPending, review]);
  return <div className="space-y-3" aria-label={kind === "instructions" ? "Instruction editor" : "Skill editor"}>
    <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
      <span>Workspace</span>
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
    {review ? <section aria-label="Latest saved version" className="rounded border border-[var(--border)] p-3">
      <h4 className="text-xs font-semibold">Latest saved version</h4>
      {kind === "skill" ? <p className="mt-2 text-xs">{review.name} · {review.description}</p> : null}
      <MessageMarkdown body={review.content} />
      <button className="button-secondary mt-2" type="button" disabled={review.state !== "active"} onClick={() => { setBase(review); setReview(undefined); mutation.reset(); }}>Keep my edits</button>
    </section> : null}
    <div className="flex flex-wrap gap-2">
      <button className="button-primary" type="button" disabled={!editable || mutation.isPending || (kind === "skill" && (!name.trim() || !description.trim() || !content.trim()))} onClick={() => mutation.mutate("commit")}>Save</button>
      {base && mutation.error ? <button className="button-secondary" type="button" disabled={latest.isPending} onClick={() => latest.mutate()}>Review latest</button> : null}
      {base && kind === "skill" && editable ? <button className="button-secondary" type="button" disabled={dirty || mutation.isPending} onClick={() => mutation.mutate("archive")}>Archive skill</button> : null}
    </div>
    {mutation.isSuccess && !dirty ? <span role="status" className="text-xs text-[var(--success)]">Saved</span> : null}
  </div>;
}

function SavedEditor({ scope, id, onSaved, onDirtyChange, disabled, workspaceSkillOnly = false }: { scope: Scope; id: string; onSaved(document: LocalAuthoredDocument): void; onDirtyChange?(dirty: boolean): void; disabled?: boolean; workspaceSkillOnly?: boolean }) {
  const query = useQuery({ queryKey: keys.document(scope, id), queryFn: () => localControl.getAuthoredDocument(scope.workspaceId, id),
    retry: false, gcTime: 0, refetchOnWindowFocus: false });
  useAccessBoundary(scope, [query.error]);
  if (query.error) return <p role="alert" className="text-xs text-[var(--danger)]">{query.error.message}</p>;
  if (!query.data) return <span className="text-xs">Loading document…</span>;
  if (query.data.conversationId || (workspaceSkillOnly && (query.data.kind !== "skill" || query.data.state !== "active"))) return <p role="alert" className="text-sm">Skill is unavailable.</p>;
  return <DocumentEditor key={id} scope={scope} document={query.data} kind={query.data.kind} onSaved={onSaved} onDirtyChange={onDirtyChange} disabled={disabled} />;
}

function ContentPanel({ scope, section, skillId }: {
  scope: Scope; section: "instructions" | "skills"; skillId?: string;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const library = useQuery({ queryKey: keys.library(scope), queryFn: () => localControl.listAuthoredDocuments(scope.workspaceId), retry: false, gcTime: 0 });
  const refresh = (document?: LocalAuthoredDocument) => {
    void queryClient.invalidateQueries({ queryKey: keys.library(scope) });
    if (!mounted.current) return;
    if (section === "skills" && skillId && document) {
      if (document.state === "archived") void navigate({ to: "/app/workspaces/$workspaceId/settings/skills", params: { workspaceId: scope.workspaceId } });
      else if (skillId === "new") void navigate({ to: "/app/workspaces/$workspaceId/settings/skills/$skillId", params: { workspaceId: scope.workspaceId, skillId: document.id }, replace: true });
    }
  };
  const remove = useMutation({
    retry: false,
    mutationFn: (document: LocalAuthoredDocumentSummary) => localControl.updateAuthoredDocument(scope.workspaceId, document.id, { action: "archive", expectedVersion: document.version }),
    onSuccess: next => {
      void queryClient.invalidateQueries({ queryKey: keys.library(scope) });
      if (!mounted.current) return;
      queryClient.setQueryData(keys.document(scope, next.id), next);
    },
  });
  useAccessBoundary(scope, [library.error, remove.error]);
  if (library.error) return <div role="alert" className="text-xs text-[var(--danger)]">{library.error.message}<button className="ml-2 underline" type="button" onClick={() => void library.refetch()}>Reload library</button></div>;
  if (!library.data) return <span className="text-xs">Loading instructions and skills…</span>;
  const instructions = library.data.find(document => document.kind === "instructions" && document.conversationId === undefined);
  const skills = library.data.filter(document => document.kind === "skill" && document.conversationId === undefined);
  if (section === "skills" && skillId) {
    const existing = skills.find(document => document.id === skillId && !document.conversationId && document.state === "active");
    if (skillId !== "new" && !existing) return <p role="alert" className="text-sm">Skill is unavailable.</p>;
    return <section aria-label="Authored skills" className="space-y-3 rounded-lg border border-[var(--border)] bg-[var(--bg)] p-5">
      <h2 className="text-sm font-semibold">{skillId === "new" ? "New skill" : "Edit skill"}</h2>
      {skillId === "new" ? <DocumentEditor scope={scope} kind="skill" onSaved={refresh} /> : <SavedEditor scope={scope} id={skillId} onSaved={refresh} workspaceSkillOnly />}
    </section>;
  }
  return <div className="space-y-4">
    {section === "instructions" ? <section aria-label="Workspace instructions" className="space-y-3 rounded-lg border border-[var(--border)] bg-[var(--bg)] p-5">
      <h3 className="text-sm font-semibold">Workspace instructions</h3>
      {instructions ? <SavedEditor scope={scope} id={instructions.id} onSaved={refresh} />
        : <DocumentEditor scope={scope} kind="instructions" onSaved={refresh} />}
    </section> : null}
    {section === "skills" ? <section aria-label="Authored skills" className="space-y-3 rounded-lg border border-[var(--border)] bg-[var(--bg)] p-5">
      <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-semibold">Skills</h3>
        <Link className="button-secondary" to="/app/workspaces/$workspaceId/settings/skills/new" params={{ workspaceId: scope.workspaceId }}>New skill</Link></div>
      <div className="overflow-hidden rounded-md border border-[var(--border)]">
        <table aria-label="Skills" className="w-full table-fixed text-sm">
          <colgroup><col className="w-1/3" /><col /><col className="w-14" /></colgroup>
          <thead className="bg-[var(--panel)] text-left text-xs text-[var(--muted)]"><tr><th scope="col" className="px-3 py-2 font-medium">Name</th><th scope="col" className="px-3 py-2 font-medium">Description</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>{skills.filter(document => document.state === "active").map(document => <tr key={document.id} className="border-t border-[var(--border)] align-top">
            <td className="break-words px-3 py-3 font-medium">{document.name}</td><td className="break-words px-3 py-3 text-[var(--muted)]">{document.description}</td>
            <td className="px-2 py-2"><DropdownMenu><DropdownMenuTrigger asChild><button type="button" className="icon-button inline-flex" aria-label={`Skill actions for ${document.name}`} disabled={remove.isPending}><EllipsisVertical className="h-4 w-4" aria-hidden="true" /></button></DropdownMenuTrigger>
              <DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => void navigate({ to: "/app/workspaces/$workspaceId/settings/skills/$skillId", params: { workspaceId: scope.workspaceId, skillId: document.id } })}>Edit</DropdownMenuItem><DropdownMenuItem tone="danger" disabled={remove.isPending} onSelect={() => remove.mutate(document)}>Remove</DropdownMenuItem></DropdownMenuContent>
            </DropdownMenu></td>
          </tr>)}</tbody>
        </table>
      </div>
      {remove.error ? <ErrorNotice onDismiss={remove.reset}>{remove.error.message} <button type="button" className="underline" onClick={() => { remove.reset(); void library.refetch(); }}>Reload skills</button></ErrorNotice> : null}

    </section> : null}
  </div>;
}

export function AuthoredContent({ workspaceId, actorIdentityId, canAdminister, section, skillId }: {
  workspaceId: string; actorIdentityId?: string; canAdminister: boolean; section: "instructions" | "skills"; skillId?: string;
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
  return <ContentPanel key={`${workspaceId}:${actorIdentityId}:${section}:${skillId ?? "list"}`} scope={{ workspaceId, actorIdentityId, onDenied }}
    section={section} skillId={skillId} />;
}
