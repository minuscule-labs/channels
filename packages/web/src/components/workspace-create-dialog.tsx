import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import { Link, useNavigate } from "@tanstack/react-router";
import { FolderOpen, FolderPlus, LoaderCircle, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { WorkspaceCompositionPlan, WorkspaceCompositionRequest } from "@minu/channels-control/contracts";
import { LocalControlClientError } from "@minu/channels-control/client";
import { WorkspacePresetFields } from "./workspace-preset-fields";
import { localControl } from "../lib/api";
import { queryKeys } from "../lib/query-keys";
import { readWorkspaceCreationIntent, rememberWorkspaceCreationIntent, forgetWorkspaceCreationIntent } from "../lib/workspace-creation-intent";
import { ErrorNotice } from "./ui/error-notice";

function workspaceSlug(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 52) || "workspace";
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

export function WorkspaceCreateDialog({
  onNavigate,
  onboarding = false,
}: {
  onNavigate?(): void;
  onboarding?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [sourcePath, setSourcePath] = useState("");
  const provisioningSlug = useRef<string | undefined>(undefined);
  const attempt = useRef<WorkspaceCompositionRequest | undefined>(undefined);
  const [writeDenied, setWriteDenied] = useState(false);
  const [attemptId, setAttemptId] = useState<string>();
  const attemptUncertain = useRef(false);
  const attemptOwner = useRef<string | undefined>(undefined);
  const [intentError, setIntentError] = useState<Error>();
  const [presetId, setPresetId] = useState("");
  const selectedPreset = useRef("");
  const [plan, setPlan] = useState<WorkspaceCompositionPlan>();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const session = useQuery({
    queryKey: queryKeys.localCurrentSession(),
    queryFn: () => localControl.currentSession(),
    enabled: onboarding || open,
    retry: false,
  });
  const library = useQuery({ queryKey: ["local", "account-library", session.data?.identityId], queryFn: () => localControl.listAccountLibraryItems(), enabled: Boolean(session.data && (onboarding || open)), retry: false, gcTime: 0 });
  const receipts = useQuery({ queryKey: ["local", "workspace-compositions", session.data?.identityId], queryFn: () => localControl.listWorkspaceCompositions(), enabled: Boolean(session.data && (onboarding || open)), retry: false, gcTime: 0 });
  const preview = useMutation({ retry: false, mutationFn: (id: string) => localControl.previewWorkspacePreset(id), onSuccess: next => { if (mounted.current && selectedPreset.current === next.presetId && !attempt.current) setPlan(next); } });
  const inspect = useMutation({ retry: false, mutationFn: (id: string) => localControl.getWorkspaceComposition(id), onSuccess: record => {
    if (!mounted.current || record.ownerIdentityId !== session.data?.identityId) return;
    try {
      if (rememberWorkspaceCreationIntent(localStorage, record.ownerIdentityId, record.requestId) !== record.requestId) throw new Error("Resume the unresolved workspace creation first");
    } catch (error) { setIntentError(error instanceof Error ? error : new Error(String(error))); return; }
    attemptOwner.current = record.ownerIdentityId;
    attemptUncertain.current = true;
    attempt.current = record.request; setAttemptId(record.requestId); setPlan(record.request.plan); setName(record.request.name); setSourcePath(record.request.rootUri); setPresetId(record.request.plan.presetId);
  } });
  const identity = useRef(session.data?.identityId);
  const accessDenied = writeDenied || [session.error, library.error, receipts.error, inspect.error, preview.error].some(error => error instanceof LocalControlClientError && [401, 403].includes(error.status));
  useEffect(() => {
    if (accessDenied || identity.current && identity.current !== session.data?.identityId) {
      attempt.current = undefined; setAttemptId(undefined); setPlan(undefined); setPresetId(""); selectedPreset.current = ""; setName(""); setSourcePath("");
    }
    identity.current = session.data?.identityId;
  }, [session.data?.identityId, accessDenied]);
  const restoreIntent = () => {
    const owner = session.data?.identityId;
    if (!owner || accessDenied) return;
    try {
      const saved = readWorkspaceCreationIntent(localStorage, owner);
      setIntentError(undefined);
      if (saved && attempt.current?.requestId !== saved) {
        attempt.current = undefined; attemptOwner.current = owner; attemptUncertain.current = true;
        setAttemptId(saved); setPlan(undefined); setPresetId(""); selectedPreset.current = ""; setName(""); setSourcePath("");
      }
    } catch (error) { setIntentError(error instanceof Error ? error : new Error(String(error))); }
  };
  useEffect(() => { if (onboarding || open) restoreIntent(); }, [session.data?.identityId, accessDenied, onboarding, open]);
  const picker = useMutation({
    mutationFn: () => localControl.selectLocalFolder(),
    onSuccess: (path) => {
      if (!path) return;
      setSourcePath(path);
      setName((current) => current || path.split("/").filter(Boolean).at(-1) || "Workspace");
    },
  });
  const mutation = useMutation({
    mutationFn: async () => {
      if (!session.data) throw new Error("Local session is unavailable");
      const owner = session.data.identityId;
      const saved = readWorkspaceCreationIntent(localStorage, owner);
      if (saved && attempt.current?.requestId !== saved) {
        restoreIntent();
        throw new Error("Inspect the unresolved workspace creation before continuing");
      }
      if (attemptId && !attempt.current) throw new Error("Inspect the unresolved workspace creation before continuing");
      if (plan || attempt.current) {
        const request = attempt.current ?? { requestId: crypto.randomUUID(), slug: workspaceSlug(name.trim()), name: name.trim(), rootUri: sourcePath.trim(), plan: structuredClone(plan!) };
        if (rememberWorkspaceCreationIntent(localStorage, owner, request.requestId) !== request.requestId) {
          restoreIntent(); throw new Error("Resume the unresolved workspace creation first");
        }
        if (!attempt.current) attemptUncertain.current = false;
        attempt.current = request; attemptOwner.current = owner;
        setAttemptId(request.requestId);
        return { result: await localControl.composeWorkspace(request), intent: { owner, requestId: request.requestId } };
      }
      provisioningSlug.current ??= workspaceSlug(name.trim());
      return { result: await localControl.provisionWorkspace({
        slug: provisioningSlug.current,
        name: name.trim(),
        rootUri: sourcePath.trim(),
      }) };
    },
    onError: async error => {
      void queryClient.invalidateQueries({ queryKey: ["local", "workspace-compositions", session.data?.identityId] });
      if (error instanceof LocalControlClientError && [401, 403].includes(error.status)) { setWriteDenied(true); return; }
      const id = attempt.current?.requestId;
      if (!id) return;
      if (!attemptUncertain.current && error instanceof LocalControlClientError && error.compositionOutcome === "rejected-before-reservation") {
        try { forgetWorkspaceCreationIntent(localStorage, attemptOwner.current!, id); }
        catch (storageError) { setIntentError(storageError instanceof Error ? storageError : new Error(String(storageError))); return; }
        attempt.current = undefined; setAttemptId(undefined);
      } else {
        // A missing receipt is only a current observation: an earlier dispatch may
        // still reserve/commit. Even a later rejected retry cannot undo that uncertainty.
        attemptUncertain.current = true;
      }
    },
    onSuccess: outcome => {
      const { workspaceId, conversationId } = outcome.result;
      if ("intent" in outcome && outcome.intent) {
        try { forgetWorkspaceCreationIntent(localStorage, outcome.intent.owner, outcome.intent.requestId); }
        catch { /* Keep the marker on cleanup failure; its completed receipt remains safe to inspect/retry. */ }
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaces() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceConversations(workspaceId) });
      void queryClient.invalidateQueries({ queryKey: ["local", "workspace-compositions", session.data?.identityId] });
      if (!mounted.current || "intent" in outcome && outcome.intent?.owner !== identity.current) return;
      attempt.current = undefined; setAttemptId(undefined); setPlan(undefined); setPresetId(""); selectedPreset.current = "";
      setOpen(false);
      setName("");
      setSourcePath("");
      provisioningSlug.current = undefined;
      onNavigate?.();
      void navigate({
        to: "/app/workspaces/$workspaceId/conversations/$conversationId",
        params: { workspaceId, conversationId },
      });
    },
  });
  const valid = Boolean(session.data && !accessDenied && !intentError && !preview.isPending && (attemptId ? attempt.current : name.trim() && sourcePath.trim().startsWith("/") && (!presetId || plan)));
  const frozen = mutation.isPending || Boolean(attemptId);

  return (
    <Dialog.Root open={onboarding || open} onOpenChange={(next) => {
      if (onboarding || mutation.isPending && attempt.current) return;
      setOpen(next);
      if (next) setWriteDenied(false);
      if (!next) {
        provisioningSlug.current = undefined;
        mutation.reset();
        picker.reset();
      }
    }}>
      {!onboarding ? (
        <Dialog.Trigger asChild>
          <button type="button" className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--text)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]" aria-label="Add Workspace" title="Add Workspace"><FolderPlus className="h-4 w-4" /></button>
        </Dialog.Trigger>
      ) : null}
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/55" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-[71] max-h-[90dvh] overflow-y-auto w-[min(48rem,94vw)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl outline-none">
          <header className="flex items-start justify-between gap-4 border-b border-[var(--border)] px-5 py-4">
            <div><Dialog.Title className="text-base font-semibold">{onboarding ? "Create your first Workspace" : "Add Workspace"}</Dialog.Title><Dialog.Description className="mt-1 text-xs leading-5 text-[var(--muted)]">Connect a local source folder to a new Workspace. The folder stays on this computer.</Dialog.Description></div>
            {!onboarding ? <Dialog.Close className="icon-button inline-flex" aria-label="Close Add Workspace"><X className="h-4 w-4" /></Dialog.Close> : null}
          </header>
          <form className="p-5" onSubmit={(event) => { event.preventDefault(); if (valid && !mutation.isPending) mutation.mutate(); }}>
            {accessDenied ? <p role="alert">Workspace setup access unavailable.</p> : <>
            {receipts.data?.filter(record => record.state === "pending" && (record.requestId !== attemptId || !attempt.current)).slice(-5).map(record => <button key={record.requestId} type="button" className="button-secondary mb-3 mr-2" disabled={mutation.isPending || inspect.isPending || Boolean(attemptId && record.requestId !== attemptId)} onClick={() => inspect.mutate(record.requestId)}>Resume {record.name}</button>)}
            <fieldset disabled={frozen} className="min-w-0">
            <label className="mb-4 block text-xs font-medium">Workspace preset<select aria-label="Workspace preset" className="settings-input mt-1" value={presetId} onChange={event => {
              const id = event.target.value; selectedPreset.current = id; setPresetId(id); setPlan(undefined); preview.reset();
              if (id) { preview.mutate(id); if (!name.trim()) setName(library.data?.find(item => item.id === id)?.name ?? ""); }
            }}><option value="">None</option>{library.data?.filter(item => item.kind === "workspace-preset" && (item.state === "active" || item.id === presetId)).map(item => <option key={item.id} value={item.id} disabled={item.state !== "active"}>{item.name}{item.state === "archived" ? " (Archived)" : ""}</option>)}</select></label>
            <label className="block text-xs font-medium">Name
              <input value={name} onChange={(event) => setName(event.target.value)} maxLength={200} placeholder="Runtime" className="settings-input mt-1.5" />
            </label>
            <label htmlFor="workspace-source-folder" className="mt-4 block text-xs font-medium">Source folder</label>
              <div className="mt-1.5 flex gap-2">
                <input id="workspace-source-folder" value={sourcePath} onChange={(event) => setSourcePath(event.target.value)} placeholder="/absolute/path/to/project" autoComplete="off" spellCheck={false} className="settings-input font-mono" />
                <button type="button" className="button-secondary shrink-0" disabled={picker.isPending} onClick={() => picker.mutate()}>
                  {picker.isPending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <FolderOpen className="h-3.5 w-3.5" />} Browse
                </button>
              </div>
            <p className="mt-1.5 text-[10px] leading-4 text-[var(--muted)]">Use an absolute local path. It remains private configuration.</p>
            {plan ? <section aria-label="Review workspace composition" className="mt-5"><WorkspacePresetFields value={plan} onChange={value => setPlan(value as WorkspaceCompositionPlan)} library={library.data ?? []} /></section> : null}
            </fieldset>
            {preview.isPending ? <p role="status">Loading workspace preset…</p> : null}
            {library.error ? <div role="alert">{library.error.message}<button type="button" className="ml-2 underline" onClick={() => void library.refetch()}>Reload workspace presets</button></div> : null}
            {mutation.error && presetId && !attemptId ? <button type="button" className="button-secondary" disabled={preview.isPending} onClick={() => preview.mutate(presetId)}>Review preset again</button> : null}
            {intentError ? <div role="alert">{intentError.message}<button type="button" className="ml-2 underline" onClick={restoreIntent}>Reload creation identity</button></div> : null}
            {attemptId && !attempt.current ? <output aria-label="Workspace creation status">Unresolved</output> : null}
            {inspect.data && inspect.data.requestId === attemptId ? <div className="mt-3 flex items-center gap-3"><output aria-label="Workspace creation status">{inspect.data.state}</output><Link className="button-secondary" to="/app/workspaces/$workspaceId/agents" params={{ workspaceId: inspect.data.workspaceId }}>Open workspace</Link></div> : null}
            {preview.error ? <ErrorNotice onDismiss={preview.reset}>{preview.error.message}</ErrorNotice> : null}
            {inspect.error ? <ErrorNotice onDismiss={inspect.reset}>{inspect.error.message}</ErrorNotice> : null}
            <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
              {mutation.error ? <ErrorNotice className="mr-auto" onDismiss={mutation.reset}>{mutation.error.message}</ErrorNotice> : null}
              {picker.error ? <ErrorNotice className="mr-auto" onDismiss={picker.reset}>{picker.error.message}</ErrorNotice> : null}
              {session.error ? <span className="mr-auto text-xs text-[var(--danger)]">{session.error.message}</span> : null}
              {onboarding && session.data && !mutation.isPending ? <Link to="/app/account/settings" className="button-secondary">Account settings</Link> : null}
              {attemptId ? <button type="button" className="button-secondary" disabled={mutation.isPending || inspect.isPending} onClick={() => inspect.mutate(attemptId)}>Inspect creation</button> : null}
              {!onboarding ? <Dialog.Close asChild><button type="button" className="button-secondary" disabled={mutation.isPending && Boolean(attemptId)}>Cancel</button></Dialog.Close> : null}
              <button type="submit" className="button-primary" disabled={!valid || mutation.isPending}>{mutation.isPending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : null}{attemptId ? "Retry workspace creation" : "Create Workspace"}</button>
            </div></>}
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
