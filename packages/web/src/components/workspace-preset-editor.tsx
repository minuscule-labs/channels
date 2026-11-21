import type { LocalAccountLibraryItem, WorkspacePresetDefinition } from "@minu/channels-control/contracts";
import { LocalControlClientError } from "@minu/channels-control/client";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { localControl } from "../lib/api";
import { ErrorNotice } from "./ui/error-notice";
import { emptyWorkspacePreset, WorkspacePresetFields } from "./workspace-preset-fields";
export type WorkspacePresetItem = Extract<LocalAccountLibraryItem, { kind: "workspace-preset" }>;
export function WorkspacePresetEditor({ item, library, onSaved, onDenied }: { item?: WorkspacePresetItem; library: LocalAccountLibraryItem[]; onSaved(item: LocalAccountLibraryItem): void; onDenied(): void }) {
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [base, setBase] = useState(item);
  const [name, setName] = useState(item?.name ?? "");
  const [description, setDescription] = useState(item?.description ?? "");
  const [definition, setDefinition] = useState(item?.definition ?? emptyWorkspacePreset());
  const [review, setReview] = useState<WorkspacePresetItem>();
  const dirty = name !== (base?.name ?? "") || description !== (base?.description ?? "") || JSON.stringify(definition) !== JSON.stringify(base?.definition ?? emptyWorkspacePreset());
  const apply = (next: WorkspacePresetItem) => { setBase(next); setName(next.name); setDescription(next.description); setDefinition(next.definition); setReview(undefined); };
  const mutation = useMutation({ retry: false, mutationFn: (action: "save" | "archive") => {
    const content = { kind: "workspace-preset" as const, name, description, definition };
    return base ? localControl.updateAccountLibraryItem(base.id, action === "archive" ? { action, expectedVersion: base.version } : { action, expectedVersion: base.version, content }) : localControl.createAccountLibraryItem(content);
  }, onSuccess: next => { if (mounted.current && next.kind === "workspace-preset") { apply(next); onSaved(next); } } });
  const latest = useMutation({ retry: false, mutationFn: () => localControl.getAccountLibraryItem(base!.id), onSuccess: next => { if (mounted.current && next.kind === "workspace-preset") setReview(next); } });
  const denied = [mutation.error, latest.error].some(error => error instanceof LocalControlClientError && [401, 403].includes(error.status));
  useEffect(() => { if (denied) onDenied(); }, [denied]);
  if (denied) return null;
  const editable = !base || base.state === "active";
  return <form aria-label="Workspace preset editor" className="space-y-4 rounded border border-[var(--border)] p-4" onSubmit={event => { event.preventDefault(); if (editable && !mutation.isPending) mutation.mutate("save"); }}>
    {base?.state === "archived" ? <p role="status">Archived</p> : null}
    <fieldset disabled={!editable || mutation.isPending} className="min-w-0 space-y-4">
      <label className="block text-xs font-medium">Name<input required className="settings-input mt-1" value={name} onChange={event => setName(event.target.value)} /></label>
      <label className="block text-xs font-medium">Description<input required className="settings-input mt-1" value={description} onChange={event => setDescription(event.target.value)} /></label>
      <WorkspacePresetFields value={definition} onChange={value => setDefinition(value as WorkspacePresetDefinition)} library={library} />
    </fieldset>
    {mutation.error ? <ErrorNotice onDismiss={mutation.reset}>{mutation.error.message}</ErrorNotice> : null}
    {latest.error ? <ErrorNotice onDismiss={latest.reset}>{latest.error.message}</ErrorNotice> : null}
    {review ? <section aria-label="Latest saved version" className="space-y-2 rounded border border-[var(--border)] p-3"><h3>Latest saved version</h3><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify({ name: review.name, description: review.description, definition: review.definition }, null, 2)}</pre>
      <button type="button" className="button-secondary" onClick={() => { apply(review); mutation.reset(); }}>Use latest</button>
      <button type="button" className="button-secondary ml-2" disabled={review.state !== "active"} onClick={() => { setBase(review); setReview(undefined); mutation.reset(); }}>Keep my edits</button></section> : null}
    <div className="flex flex-wrap gap-2"><button type="submit" className="button-primary" disabled={!editable || mutation.isPending || !name.trim() || !description.trim()}>Save</button>
      {base && mutation.error ? <button type="button" className="button-secondary" disabled={latest.isPending} onClick={() => latest.mutate()}>Review latest</button> : null}
      {base && editable ? <button type="button" className="button-secondary" disabled={dirty || mutation.isPending} onClick={() => mutation.mutate("archive")}>Archive</button> : null}</div>
    {mutation.isSuccess && !dirty ? <span role="status">Saved</span> : null}
  </form>;
}
