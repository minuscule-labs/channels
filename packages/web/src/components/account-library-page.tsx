import type { LocalAccountLibraryContent, LocalAccountLibraryItem } from "@minu/channels-control/contracts";
import { LocalControlClientError } from "@minu/channels-control/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { localControl } from "../lib/api";
import { queryKeys } from "../lib/query-keys";
import { WorkspacePresetEditor } from "./workspace-preset-editor";
import { SettingsPageLayout } from "./settings-page-layout";
import { ErrorNotice } from "./ui/error-notice";

type Kind = LocalAccountLibraryItem["kind"];
type PlainItem = Exclude<LocalAccountLibraryItem, { kind: "workspace-preset" }>;
const paths = { "workspace-preset": "/app/account/settings/presets", skill: "/app/account/settings/skills", "agent-template": "/app/account/settings/agents" } as const;
const editorPaths = { "workspace-preset": "/app/account/settings/presets/$itemId", skill: "/app/account/settings/skills/$itemId", "agent-template": "/app/account/settings/agents/$itemId" } as const;
const libraryKey = (identityId: string) => ["local", "account-library", identityId] as const;
const denied = (error: unknown) => error instanceof LocalControlClientError && [401, 403].includes(error.status);

export function AccountLibraryPage({ kind = "skill" }: { kind?: Kind }) {
  const { itemId } = useParams({ strict: false });
  const session = useQuery({ queryKey: queryKeys.localCurrentSession(), queryFn: () => localControl.currentSession(), retry: false });
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col pt-9 md:pt-0"><SettingsPageLayout title="Account settings" containerWidth="max-w-4xl">
    <nav aria-label="Account settings" className="mb-6 flex gap-3 border-b border-[var(--border)] pb-3">
      <Link to={paths["agent-template"]} aria-current={kind === "agent-template" ? "page" : undefined} className={kind === "agent-template" ? "font-semibold" : "text-[var(--muted)]"}>Agent templates</Link>
      <Link to={paths["workspace-preset"]} aria-current={kind === "workspace-preset" ? "page" : undefined} className={kind === "workspace-preset" ? "font-semibold" : "text-[var(--muted)]"}>Workspace presets</Link>
      <Link to={paths.skill} aria-current={kind === "skill" ? "page" : undefined} className={kind === "skill" ? "font-semibold" : "text-[var(--muted)]"}>Skills</Link>
    </nav>
    {session.error ? <div role="alert" className="text-sm text-[var(--danger)]">{session.error.message}<button type="button" className="ml-2 underline" onClick={() => void session.refetch()}>Retry</button></div> : null}
    {denied(session.error) ? null : session.data
      ? <AccountLibrary key={`${session.data.identityId}:${kind}:${itemId ?? "list"}`} identityId={session.data.identityId} kind={kind} itemId={itemId} />
      : !session.error ? <p role="status">Loading account…</p> : null}
  </SettingsPageLayout></div>;
}

function AccountLibrary({ identityId, kind, itemId }: { identityId: string; kind: Kind; itemId?: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [accessDenied, setAccessDenied] = useState(false);
  const library = useQuery({ queryKey: libraryKey(identityId), queryFn: () => localControl.listAccountLibraryItems(), retry: false, gcTime: 0, enabled: !accessDenied });
  const onDenied = () => {
    setAccessDenied(true);
    queryClient.removeQueries({ queryKey: libraryKey(identityId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.localCurrentSession() });
  };
  const archive = useMutation({
    retry: false,
    mutationFn: (item: LocalAccountLibraryItem) => localControl.updateAccountLibraryItem(item.id, { action: "archive", expectedVersion: item.version }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: libraryKey(identityId) }); },
  });
  useEffect(() => { if (denied(library.error) || denied(archive.error)) onDenied(); }, [library.error, archive.error]);
  if (accessDenied || denied(library.error) || denied(archive.error)) return <p role="alert">Account library access unavailable.</p>;
  const refreshError = library.error ? <div role="alert" className="text-sm text-[var(--danger)]">{library.error.message} <button type="button" className="underline" onClick={() => void library.refetch()}>Reload library</button></div> : null;
  if (!library.data) return refreshError ?? <p role="status">Loading library…</p>;
  const items = library.data.filter(item => item.kind === kind && item.state === "active");
  const current = library.data.find(item => item.id === itemId && item.kind === kind);
  const title = kind === "skill" ? "Skills" : kind === "workspace-preset" ? "Workspace presets" : "Agent templates";
  const onSaved = (item: LocalAccountLibraryItem) => {
    void queryClient.invalidateQueries({ queryKey: libraryKey(identityId) });
    if (!mounted.current) return;
    if (item.state === "archived") void navigate({ to: paths[kind] });
    else if (itemId === "new") void navigate({ to: editorPaths[kind], params: { itemId: item.id }, replace: true });
  };
  if (itemId) return <section aria-label="Account library editor" className="space-y-4">
    {refreshError}
    <Link to={paths[kind]} className="text-sm text-[var(--muted)]">← {title}</Link>
    {itemId !== "new" && !current ? <p role="alert">Library item unavailable.</p>
      : kind === "workspace-preset" ? <WorkspacePresetEditor item={current?.kind === "workspace-preset" ? current : undefined} library={library.data} onSaved={onSaved} onDenied={onDenied} />
      : <AccountLibraryEditor kind={kind} item={current?.kind === "workspace-preset" ? undefined : current} skills={library.data.filter(item => item.kind === "skill")} onSaved={onSaved} onDenied={onDenied} />}
    <Link to={paths[kind]} className="button-secondary inline-flex">Cancel</Link>
  </section>;
  return <section aria-label={`Account ${title.toLowerCase()}`} className="space-y-4">
    {refreshError}
    <div className="flex items-center justify-between gap-3"><h2 className="text-base font-semibold">{title}</h2>
      <Link to={editorPaths[kind]} params={{ itemId: "new" }} className="button-primary">{kind === "skill" ? "New skill" : kind === "workspace-preset" ? "New workspace preset" : "New agent template"}</Link></div>
    <div className="overflow-hidden rounded-md border border-[var(--border)]">
      <table aria-label={title} className="w-full table-fixed text-sm">
        <colgroup><col className="w-1/3" /><col /><col className="w-24" /></colgroup>
        <thead className="bg-[var(--panel)] text-left"><tr><th className="px-3 py-2" scope="col">Name</th><th className="px-3 py-2" scope="col">Description</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{items.map(item => <tr key={item.id} className="border-t border-[var(--border)] align-top">
          <td className="break-words px-3 py-3"><Link to={editorPaths[kind]} params={{ itemId: item.id }} className="font-medium hover:underline">{item.name}</Link></td>
          <td className="break-words px-3 py-3 text-[var(--muted)]">{item.description}</td>
          <td className="px-2 py-2"><button type="button" className="button-secondary" aria-label={`Archive ${item.name}`} disabled={archive.isPending} onClick={() => archive.mutate(item)}>Archive</button></td>
        </tr>)}</tbody>
      </table>
    </div>
    {archive.error ? <ErrorNotice onDismiss={archive.reset}>{archive.error.message} <button type="button" className="underline" onClick={() => { archive.reset(); void library.refetch(); }}>Reload library</button></ErrorNotice> : null}
  </section>;
}

function AccountLibraryEditor({ kind, item, skills, onSaved, onDenied }: {
  kind: Exclude<Kind, "workspace-preset">; item?: PlainItem; skills: LocalAccountLibraryItem[];
  onSaved(item: LocalAccountLibraryItem): void; onDenied(): void;
}) {
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [base, setBase] = useState(item);
  const [name, setName] = useState(item?.name ?? "");
  const [description, setDescription] = useState(item?.description ?? "");
  const [content, setContent] = useState(item?.kind === "skill" ? item.content : "");
  const [configuration, setConfiguration] = useState(item?.kind === "agent-template" ? item.configuration : {});
  const [review, setReview] = useState<PlainItem>();
  const draft: LocalAccountLibraryContent = kind === "skill" ? { kind, name, description, content } : { kind, name, description, configuration };
  const dirty = !base || JSON.stringify(draft) !== JSON.stringify(base.kind === "skill"
    ? { kind: base.kind, name: base.name, description: base.description, content: base.content }
    : { kind: base.kind, name: base.name, description: base.description, configuration: base.configuration });
  const apply = (next: PlainItem) => {
    setBase(next); setName(next.name); setDescription(next.description);
    if (next.kind === "skill") setContent(next.content); else setConfiguration(next.configuration);
    setReview(undefined);
  };
  const mutation = useMutation({
    retry: false,
    mutationFn: (action: "save" | "archive") => base
      ? localControl.updateAccountLibraryItem(base.id, action === "save" ? { action, expectedVersion: base.version, content: draft } : { action, expectedVersion: base.version })
      : localControl.createAccountLibraryItem(draft),
    onSuccess: next => { if (mounted.current && next.kind !== "workspace-preset") { apply(next); onSaved(next); } },
  });
  const latest = useMutation({ retry: false, mutationFn: () => localControl.getAccountLibraryItem(base!.id), onSuccess: next => { if (mounted.current && next.kind !== "workspace-preset") setReview(next); } });
  useEffect(() => { if (denied(mutation.error) || denied(latest.error)) onDenied(); }, [mutation.error, latest.error]);
  if (denied(mutation.error) || denied(latest.error)) return null;
  const editable = !base || base.state === "active";
  const valid = name.trim() && description.trim() && (kind === "skill" ? content.trim() : Boolean(configuration.modelProvider) === Boolean(configuration.modelId));
  const field = (key: "personaPrompt" | "runtimeAdapter" | "modelProvider" | "modelId", value: string) => setConfiguration(current => {
    const next = { ...current }; if (value) next[key] = value; else delete next[key]; return next;
  });
  const selectedSkills = configuration.accountSkillIds ?? [];
  return <form aria-label={kind === "skill" ? "Account skill editor" : "Account agent template editor"} className="space-y-4 rounded-lg border border-[var(--border)] p-5" onSubmit={event => { event.preventDefault(); if (editable && valid && !mutation.isPending) mutation.mutate("save"); }}>
    <h2 className="text-base font-semibold">{base ? kind === "skill" ? "Edit skill" : "Edit agent template" : kind === "skill" ? "New skill" : "New agent template"}</h2>
    {base?.state === "archived" ? <p role="status">Archived</p> : null}
    <fieldset disabled={!editable || mutation.isPending} className="min-w-0 space-y-4">
      <label className="block text-xs font-medium">Name<input required className="settings-input mt-1" value={name} onChange={event => setName(event.target.value)} /></label>
      <label className="block text-xs font-medium">Description<input required className="settings-input mt-1" value={description} onChange={event => setDescription(event.target.value)} /></label>
      {kind === "skill" ? <label className="block text-xs font-medium">Instructions<textarea aria-label="Instructions" required className="settings-input mt-1 min-h-48 font-mono" value={content} onChange={event => setContent(event.target.value)} /></label> : <>
        <label className="block text-xs font-medium">Instructions<textarea aria-label="Instructions" className="settings-input mt-1 min-h-36 font-mono" value={configuration.personaPrompt ?? ""} onChange={event => field("personaPrompt", event.target.value)} /></label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-xs font-medium">Runtime adapter<input className="settings-input mt-1" value={configuration.runtimeAdapter ?? ""} onChange={event => field("runtimeAdapter", event.target.value)} /></label>
          <label className="block text-xs font-medium">Reasoning level<select aria-label="Reasoning level" className="settings-input mt-1" value={configuration.reasoningLevel ?? ""} onChange={event => setConfiguration(current => {
            const next = { ...current }; if (event.target.value) next.reasoningLevel = event.target.value as typeof next.reasoningLevel; else delete next.reasoningLevel; return next;
          })}><option value="">Default</option>{["off", "minimal", "low", "medium", "high", "xhigh", "max"].map(level => <option key={level} value={level}>{level}</option>)}</select></label>
          <label className="block text-xs font-medium">Model provider<input className="settings-input mt-1" value={configuration.modelProvider ?? ""} onChange={event => field("modelProvider", event.target.value)} /></label>
          <label className="block text-xs font-medium">Model ID<input className="settings-input mt-1" value={configuration.modelId ?? ""} onChange={event => field("modelId", event.target.value)} /></label>
        </div>
        <fieldset className="min-w-0 space-y-2"><legend className="mb-2 text-xs font-medium">Account skills</legend>
          {skills.filter(skill => skill.state === "active" || selectedSkills.includes(skill.id)).map(skill => <label key={skill.id} className="flex items-center gap-2 break-words text-sm">
            <input type="checkbox" checked={selectedSkills.includes(skill.id)} disabled={skill.state === "archived" && !selectedSkills.includes(skill.id)} onChange={event => setConfiguration(current => ({ ...current, accountSkillIds: event.target.checked ? [...(current.accountSkillIds ?? []), skill.id] : (current.accountSkillIds ?? []).filter(id => id !== skill.id) }))} />{skill.name}{skill.state === "archived" ? " (Archived)" : ""}
          </label>)}
        </fieldset>
      </>}
    </fieldset>
    {mutation.error ? <ErrorNotice onDismiss={mutation.reset}>{mutation.error.message}</ErrorNotice> : null}
    {latest.error ? <ErrorNotice onDismiss={latest.reset}>{latest.error.message}</ErrorNotice> : null}
    {review ? <section aria-label="Latest saved version" className="space-y-3 rounded border border-[var(--border)] p-3">
      <h3 className="text-sm font-semibold">Latest saved version</h3><p className="break-words text-sm">{review.name} · {review.description}</p>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{review.kind === "skill" ? review.content : JSON.stringify(review.configuration, null, 2)}</pre>
      {review.state === "archived" ? <p>Archived</p> : null}
      <div className="flex flex-wrap gap-2"><button type="button" className="button-secondary" onClick={() => { apply(review); mutation.reset(); }}>Use latest</button>
        <button type="button" className="button-secondary" disabled={review.state !== "active"} onClick={() => { setBase(review); setReview(undefined); mutation.reset(); }}>Keep my edits</button></div>
    </section> : null}
    <div className="flex flex-wrap gap-2">
      <button type="submit" className="button-primary" disabled={!editable || !valid || mutation.isPending}>Save</button>
      {base && mutation.error ? <button type="button" className="button-secondary" disabled={latest.isPending} onClick={() => latest.mutate()}>Review latest</button> : null}
      {base && editable ? <button type="button" className="button-secondary" disabled={dirty || mutation.isPending} onClick={() => mutation.mutate("archive")}>Archive</button> : null}
    </div>
    {mutation.isSuccess && !dirty ? <span role="status" className="text-xs text-[var(--success)]">Saved</span> : null}
  </form>;
}
