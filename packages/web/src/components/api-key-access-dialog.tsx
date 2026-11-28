import type { LocalAgentCredentialSummary } from "@minu/channels-control/contracts";
import * as Dialog from "@radix-ui/react-dialog";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { Check, Copy, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { conversations, localControl } from "../lib/api";
import {
  buildCreateInput, buildTargetCatalog, buildUpdateInput, capabilityLabel, classifyCredentialFailure, credentialIntents, credentialStatus, draftFromCredential,
  findCreatedCredential, intentKey, mapBounded, newCreateRequestId, newDraft, rebaseDraft, scopeGrants, targetLabel,
  type AccessDraft, type CredentialIntent, type CredentialTarget, type RebasedDraft,
} from "../lib/agent-credentials";
import { queryKeys } from "../lib/query-keys";
import { IntegrationAccessForm, type TargetCatalogState } from "./integration-access-form";
import { ErrorNotice } from "./ui/error-notice";

/** Metadata only. Secrets returned with the credential are never passed here. */
export function upsertCredential(queryClient: QueryClient, workspaceId: string, credential: LocalAgentCredentialSummary): void {
  queryClient.setQueryData<LocalAgentCredentialSummary[]>(queryKeys.agentCredentials(workspaceId), current => current
    ? current.some(item => item.id === credential.id) ? current.map(item => item.id === credential.id ? credential : item) : [...current, credential]
    : current);
  void queryClient.invalidateQueries({ queryKey: queryKeys.agentCredentials(workspaceId) });
}

const THREAD_READ_CONCURRENCY = 4;
const TARGET_STALE_MS = 30_000;

/**
 * Selectable targets for an open access surface. Thread lists are read on demand, a few parents at a time,
 * reusing recent cached lists; a parent whose threads fail to load is reported rather than hidden.
 * When disabled, only already-cached results are returned.
 */
export function useTargetCatalog(workspaceId: string, enabled: boolean): TargetCatalogState {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.agentCredentialTargets(workspaceId),
    enabled,
    retry: false,
    staleTime: TARGET_STALE_MS,
    queryFn: async () => {
      const read = <T,>(queryKey: readonly unknown[], queryFn: () => Promise<T>) => queryClient.fetchQuery({ queryKey, queryFn, staleTime: TARGET_STALE_MS, retry: false });
      const parents = await read(queryKeys.workspaceConversations(workspaceId), () => conversations.listWorkspaceConversations(workspaceId));
      const threads = await mapBounded(parents, THREAD_READ_CONCURRENCY,
        parent => read(queryKeys.conversationThreads(parent.id), () => conversations.listThreads(parent.id)).catch(() => undefined));
      return { targets: buildTargetCatalog(parents, threads.flatMap(list => list ?? [])), partial: threads.includes(undefined) };
    },
  });
  return { targets: query.data?.targets ?? [], pending: enabled && query.isPending, failed: query.isError || query.data?.partial === true };
}

export function useCredentialIntent(key: string): CredentialIntent | undefined {
  return useSyncExternalStore(credentialIntents.subscribe, () => credentialIntents.get(key));
}

export function useMounted() {
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  return mounted;
}

export function ApiKeyDialogFrame({ open, onOpenChange, title, description, busy = false, trigger, onCloseAutoFocus, children }: {
  open: boolean; onOpenChange(open: boolean): void; title: string; description?: string; busy?: boolean;
  trigger?: ReactNode; onCloseAutoFocus?(event: Event): void; children: ReactNode;
}) {
  const block = (event: Event) => { if (busy) event.preventDefault(); };
  return <Dialog.Root open={open} onOpenChange={next => { if (next || !busy) onOpenChange(next); }}>
    {trigger ? <Dialog.Trigger asChild>{trigger}</Dialog.Trigger> : null}
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/55" />
      <Dialog.Content {...(!description ? { "aria-describedby": undefined } : {})} onCloseAutoFocus={onCloseAutoFocus}
        onEscapeKeyDown={block} onInteractOutside={block}
        className="minu-scroll fixed top-1/2 left-1/2 z-[71] max-h-[calc(100dvh-2rem)] w-[min(42rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4 shadow-2xl outline-none sm:p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
            {description ? <Dialog.Description className="mt-1 text-sm text-[var(--muted)]">{description}</Dialog.Description> : null}
          </div>
          <Dialog.Close className="icon-button inline-flex" aria-label={`Close ${title}`} disabled={busy}>
            <X className="h-4 w-4" aria-hidden="true" />
          </Dialog.Close>
        </div>
        {children}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

/** Shown once from transient component state; never cached, persisted or placed in a URL or toast. */
export function OneTimeSecretPanel({ secret }: { secret: string }) {
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copySecret = async () => {
    window.clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(secret);
      setCopy("copied");
      timer.current = window.setTimeout(() => setCopy("idle"), 1_600);
    } catch {
      setCopy("failed");
    }
  };
  return <div className="mt-4 rounded-md border border-[var(--warning)]/60 bg-[var(--warning)]/10 p-3 text-sm">
    <p className="font-medium text-[var(--warning)]">Copy this key now. It will not be shown again.</p>
    <div className="mt-2 flex items-center gap-2 rounded bg-[var(--panel-muted)] p-2">
      <code className="min-w-0 flex-1 overflow-x-auto text-xs whitespace-nowrap select-all" aria-label="API key secret">{secret}</code>
      <button type="button" className={`icon-button inline-flex ${copy === "copied" ? "text-[var(--success)]" : ""}`} onClick={() => void copySecret()} aria-label="Copy API key">
        {copy === "copied" ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
      </button>
    </div>
    {copy === "copied" ? <p role="status" className="mt-2 text-xs text-[var(--success)]">Copied</p> : null}
    {copy === "failed" ? <p role="alert" className="mt-2 text-xs text-[var(--danger)]">Copy failed. Select the key and copy it manually.</p> : null}
  </div>;
}

/** Current backend metadata for explicit review after a conflict or an unconfirmed outcome. */
export function CredentialFacts({ current, attempted, catalog }: {
  current: LocalAgentCredentialSummary; attempted?: { revision: number; secretGeneration: number };
  catalog: ReadonlyMap<string, CredentialTarget>;
}) {
  const changed = (now: number, before?: number) => before !== undefined && before !== now ? ` (was ${before})` : "";
  const label = (id: string) => catalog.has(id) ? targetLabel(catalog.get(id)) : `Not currently listed · ${id}`;
  return <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border border-[var(--border)] p-3 text-xs" aria-label="Current key metadata">
    <dt className="text-[var(--muted)]">Name</dt><dd className="min-w-0 truncate">{current.name}</dd>
    <dt className="text-[var(--muted)]">Status</dt><dd className="capitalize">{credentialStatus(current, Date.now())}</dd>
    <dt className="text-[var(--muted)]">Revision</dt><dd>{current.revision}{changed(current.revision, attempted?.revision)}</dd>
    <dt className="text-[var(--muted)]">Secret generation</dt><dd>{current.secretGeneration}{changed(current.secretGeneration, attempted?.secretGeneration)}</dd>
    <dt className="text-[var(--muted)]">Expires</dt><dd>{new Date(current.expiresAt).toLocaleString()}</dd>
    <dt className="text-[var(--muted)]">Permissions</dt><dd>{capabilityLabel(current)}</dd>
    <dt className="text-[var(--muted)]">{current.scope.mode === "locked" ? "Single target" : "Targets"}</dt>
    <dd className="min-w-0">
      <ul aria-label="Current targets">
        {scopeGrants(current.scope).map(grant => <li key={grant.conversationId} className="truncate">
          {label(grant.conversationId)}{grant.includeThreads ? " · existing and future threads" : ""}
        </li>)}
      </ul>
    </dd>
  </dl>;
}

/** Explicit metadata read used to resolve conflicts and unknown outcomes. */
export function useCredentialRead(workspaceId: string, credentialId: string | undefined) {
  const queryClient = useQueryClient();
  const mounted = useMounted();
  const [state, setState] = useState<{ status: "idle" | "loading" | "failed" } | { status: "loaded"; current: LocalAgentCredentialSummary }>({ status: "idle" });
  const read = useCallback(async () => {
    if (!credentialId) return;
    setState({ status: "loading" });
    try {
      const current = await localControl.getAgentCredential(workspaceId, credentialId);
      upsertCredential(queryClient, workspaceId, current);
      if (mounted.current) setState({ status: "loaded", current });
    } catch {
      if (mounted.current) setState({ status: "failed" });
    }
  }, [credentialId, mounted, queryClient, workspaceId]);
  const reset = useCallback(() => setState({ status: "idle" }), []);
  return { state, read, reset };
}

type Review = { reason: "conflict" | "unknown" | "denied"; attempted: { revision: number; secretGeneration: number } };

export function ApiKeyAccessDialog({ workspaceId, credential, open, onOpenChange, trigger, onCloseAutoFocus }: {
  workspaceId: string;
  credential?: LocalAgentCredentialSummary;
  open: boolean;
  onOpenChange(open: boolean): void;
  trigger?: ReactNode;
  onCloseAutoFocus?(event: Event): void;
}) {
  const queryClient = useQueryClient();
  const mounted = useMounted();
  const editing = credential !== undefined;
  const key = editing ? intentKey(workspaceId, "credential", credential.id) : intentKey(workspaceId, "create");
  const intent = useCredentialIntent(key);
  const [draft, setDraft] = useState<AccessDraft>(() => credential ? draftFromCredential(credential) : newDraft());
  const [base, setBase] = useState(credential);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [review, setReview] = useState<Review>();
  const [rebased, setRebased] = useState<RebasedDraft & { revision: number }>();
  const [issued, setIssued] = useState<{ secret: string; credential: LocalAgentCredentialSummary }>();
  const [createCheck, setCreateCheck] = useState<"idle" | "checking" | "not-found" | "failed" | "denied">("idle");
  const inFlight = useRef(false);
  const openRef = useRef(open);
  openRef.current = open;
  const currentRead = useCredentialRead(workspaceId, credential?.id);
  const catalog = useTargetCatalog(workspaceId, open);
  const catalogById = new Map(catalog.targets.map(target => [target.id, target]));

  // Every open starts from current metadata; closing discards the one-time secret.
  useEffect(() => {
    if (!open) { setIssued(undefined); return; }
    setDraft(credential ? draftFromCredential(credential) : newDraft());
    setBase(credential);
    setError(undefined);
    setReview(undefined);
    setRebased(undefined);
    setCreateCheck("idle");
    currentRead.reset();
    const pending = credentialIntents.get(key);
    if (credential && pending && pending.state !== "pending") {
      setReview({ reason: pending.denied ? "denied" : "unknown", attempted: { revision: pending.kind === "create" ? credential.revision : pending.expectedRevision,
        secretGeneration: pending.kind === "create" ? credential.secretGeneration : pending.secretGeneration } });
      void currentRead.read();
    }
    // Reset only when the dialog opens; later list refreshes must not overwrite the human's draft.
  }, [open]);

  const close = () => { setIssued(undefined); onOpenChange(false); };

  const createAttempt = async (attempt: { requestId: string; input: NonNullable<ReturnType<typeof buildCreateInput>["input"]> }) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setError(undefined);
    setCreateCheck("idle");
    credentialIntents.set(key, { kind: "create", requestId: attempt.requestId, input: attempt.input, state: "pending" });
    try {
      const result = await localControl.createAgentCredential(workspaceId, attempt.input);
      upsertCredential(queryClient, workspaceId, result.credential);
      if (mounted.current && openRef.current) {
        credentialIntents.clear(key);
        setIssued({ secret: result.secret, credential: result.credential });
      } else {
        credentialIntents.set(key, { kind: "create", ...attempt, state: "undelivered", credentialId: result.credential.id });
      }
    } catch (cause) {
      const failure = classifyCredentialFailure(cause);
      // A denial can follow a committed write, so it keeps the frozen request for inspection.
      if (failure.mayHaveCommitted) credentialIntents.set(key, { kind: "create", ...attempt, state: "unknown", denied: failure.kind === "denied" });
      else if (failure.kind === "recorded") {
        credentialIntents.set(key, { kind: "create", ...attempt, state: "unknown" });
        void checkCreate();
      } else {
        credentialIntents.clear(key);
        if (mounted.current) setError(failure.message);
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setSaving(false);
    }
  };

  const checkCreate = async () => {
    const pending = credentialIntents.get(key);
    if (pending?.kind !== "create") return;
    setCreateCheck("checking");
    try {
      const credentials = await localControl.listAgentCredentials(workspaceId);
      queryClient.setQueryData(queryKeys.agentCredentials(workspaceId), credentials);
      const found = findCreatedCredential(credentials, pending.requestId);
      credentialIntents.set(key, found ? { ...pending, state: "undelivered", credentialId: found.id, denied: false } : { ...pending, denied: false });
      if (mounted.current) setCreateCheck(found ? "idle" : "not-found");
    } catch (cause) {
      if (mounted.current) setCreateCheck(classifyCredentialFailure(cause).kind === "denied" ? "denied" : "failed");
    }
  };

  const submitCreate = () => {
    if (inFlight.current || credentialIntents.get(key)) return;
    const requestId = newCreateRequestId();
    const built = buildCreateInput(draft, requestId, Date.now());
    if (!built.input) { setError(built.error); return; }
    void createAttempt({ requestId, input: built.input });
  };

  const submitUpdate = async () => {
    if (!base || inFlight.current || credentialIntents.get(key)) return;
    const built = buildUpdateInput(draft, base, base.revision, Date.now());
    if (!built.input) { setError(built.error); return; }
    const attempted = { revision: base.revision, secretGeneration: base.secretGeneration };
    inFlight.current = true;
    setSaving(true);
    setError(undefined);
    credentialIntents.set(key, { kind: "update", credentialId: base.id, expectedRevision: base.revision, secretGeneration: base.secretGeneration, input: built.input, state: "pending" });
    try {
      const next = await localControl.updateAgentCredential(workspaceId, base.id, built.input);
      upsertCredential(queryClient, workspaceId, next);
      credentialIntents.clear(key);
      if (mounted.current && openRef.current) onOpenChange(false);
    } catch (cause) {
      const failure = classifyCredentialFailure(cause);
      if (failure.mayHaveCommitted || failure.kind === "conflict") {
        if (failure.mayHaveCommitted) credentialIntents.set(key, { kind: "update", credentialId: base.id, expectedRevision: attempted.revision, secretGeneration: attempted.secretGeneration, input: built.input, state: "unknown", denied: failure.kind === "denied" });
        else credentialIntents.clear(key);
        if (mounted.current) { setRebased(undefined); setReview({ reason: failure.kind === "conflict" ? "conflict" : failure.kind === "denied" ? "denied" : "unknown", attempted }); void currentRead.read(); }
      } else {
        credentialIntents.clear(key);
        if (failure.kind === "inactive") void queryClient.invalidateQueries({ queryKey: queryKeys.agentCredentials(workspaceId) });
        if (mounted.current) setError(failure.message);
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setSaving(false);
    }
  };

  const title = issued ? "API key created" : editing ? "Edit API key" : "Create API key";
  const createIntent = !editing && intent?.kind === "create" && intent.state !== "pending" ? intent : undefined;
  const createIntentCredential = createIntent?.credentialId
    ? queryClient.getQueryData<LocalAgentCredentialSummary[]>(queryKeys.agentCredentials(workspaceId))?.find(item => item.id === createIntent.credentialId)
    : undefined;
  const pendingElsewhere = intent?.state === "pending" && !saving;
  const loadedCurrent = currentRead.state.status === "loaded" ? currentRead.state.current : undefined;

  let body: ReactNode;
  if (issued) {
    body = <>
      <OneTimeSecretPanel secret={issued.secret} />
      <div className="mt-4 flex justify-end"><button type="button" className="button-primary" onClick={close}>Done</button></div>
    </>;
  } else if (createIntent) {
    body = <div className="mt-4 space-y-3 text-sm" role="region" aria-label="Unresolved key creation">
      {createIntent.state === "undelivered" ? <>
        <p className="rounded-md border border-[var(--warning)]/60 bg-[var(--warning)]/10 p-3">
          “{createIntent.input.name}” was created{createIntentCredential ? ` (${createIntentCredential.id})` : ""}, but its secret can’t be shown again. Revoke it if you don’t have the secret, then create a new key.
        </p>
        <div className="flex justify-end"><button type="button" className="button-primary" onClick={() => credentialIntents.clear(key)}>Done</button></div>
      </> : <>
        <p className="rounded-md border border-[var(--warning)]/60 bg-[var(--warning)]/10 p-3">
          {createIntent.denied
            ? `Access was denied after “${createIntent.input.name}” was sent, so it may already have been created. Restore an owner or admin session, then check the outcome; a new key is never issued automatically.`
            : `The server didn’t confirm whether “${createIntent.input.name}” was created. Check before trying again; a new key is never issued automatically.`}
        </p>
        {createCheck === "not-found" ? <p role="status" className="text-xs text-[var(--muted)]">No key has been recorded for this request.</p> : null}
        {createCheck === "failed" ? <ErrorNotice onDismiss={() => setCreateCheck("idle")}>The key list couldn’t be checked. Try again.</ErrorNotice> : null}
        {createCheck === "denied" ? <ErrorNotice onDismiss={() => setCreateCheck("idle")}>Access is still denied. Restore an owner or admin session, then check again.</ErrorNotice> : null}
        <div className="flex flex-wrap justify-end gap-2">
          {createCheck === "not-found" ? <>
            <button type="button" className="button-secondary" onClick={() => { credentialIntents.clear(key); setCreateCheck("idle"); }}>Discard request</button>
            <button type="button" className="button-secondary" disabled={saving} onClick={() => void createAttempt({ requestId: createIntent.requestId, input: createIntent.input })}>Send same request again</button>
          </> : null}
          <button type="button" className="button-primary" disabled={createCheck === "checking" || saving} onClick={() => void checkCreate()}>
            {createCheck === "checking" ? "Checking…" : "Check outcome"}
          </button>
        </div>
      </>}
    </div>;
  } else if (review) {
    body = <div className="mt-4 text-sm" role="region" aria-label="Review current key">
      <p className="rounded-md border border-[var(--warning)]/60 bg-[var(--warning)]/10 p-3">
        {review.reason === "conflict" ? "This key changed since you opened it. Review the current version; your changes have not been applied."
          : review.reason === "denied" ? "Access was denied after the change was sent, so it may already have been saved. Restore an owner or admin session, then review the current version."
            : "The server didn’t confirm the last change. Review the current version before continuing."}
      </p>
      {currentRead.state.status === "loading" ? <p role="status" className="mt-3 text-xs text-[var(--muted)]">Loading current key…</p> : null}
      {currentRead.state.status === "failed" ? <p role="alert" className="mt-3 text-xs text-[var(--danger)]">The current key couldn’t be loaded.</p> : null}
      {loadedCurrent ? <CredentialFacts current={loadedCurrent} attempted={review.attempted} catalog={catalogById} /> : null}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        {currentRead.state.status === "failed" ? <button type="button" className="button-secondary" onClick={() => void currentRead.read()}>Retry</button> : null}
        <button type="button" className="button-secondary" disabled={!loadedCurrent} onClick={() => {
          credentialIntents.clear(key);
          setDraft(draftFromCredential(loadedCurrent!)); setBase(loadedCurrent); setReview(undefined); setRebased(undefined); setError(undefined);
        }}>Start from current</button>
        <button type="button" className="button-primary" disabled={!loadedCurrent || !base || credentialStatus(loadedCurrent, Date.now()) !== "active"} onClick={() => {
          // Only the human's own edits move onto the reviewed revision; saving stays a separate explicit step.
          const next = rebaseDraft(draft, base!, loadedCurrent!);
          credentialIntents.clear(key);
          setDraft(next.draft); setBase(loadedCurrent); setRebased({ ...next, revision: loadedCurrent!.revision }); setReview(undefined); setError(undefined);
        }}>Keep my changes</button>
      </div>
    </div>;
  } else {
    body = <>
      <input className="settings-input mt-4" aria-label="Key name" placeholder="Key name, e.g. Conversation foreman" maxLength={100}
        value={draft.name} disabled={saving} onChange={event => setDraft({ ...draft, name: event.target.value })} />
      <IntegrationAccessForm draft={draft} onChange={setDraft} catalog={catalog} currentExpiresAt={base?.expiresAt} disabled={saving} />
      {rebased ? <div role="status" className="mt-4 rounded-md border border-[var(--warning)]/60 bg-[var(--warning)]/10 p-3 text-xs">
        <p>Your edits now apply to revision {rebased.revision}. Everything else matches the current version.</p>
        {rebased.scopeReset ? <p className="mt-1">The scope changed in both versions, so the current scope is shown. Re-apply your scope changes if they’re still needed.</p> : null}
        {rebased.conflicts.length > 0 ? <p className="mt-1">
          Current access kept for {rebased.conflicts.map(id => catalogById.has(id) ? targetLabel(catalogById.get(id)) : id).join(", ")}, which changed in both versions.
        </p> : null}
      </div> : null}
      {pendingElsewhere ? <p role="status" className="mt-4 text-xs text-[var(--muted)]">A previous request for this key is still waiting for the server.</p> : null}
      {error ? <ErrorNotice className="mt-4" onDismiss={() => setError(undefined)}>{error}</ErrorNotice> : null}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="button-primary" disabled={saving || pendingElsewhere || !draft.name.trim()}
          onClick={() => editing ? void submitUpdate() : submitCreate()}>
          {saving ? "Saving…" : editing ? "Save changes" : "Create key"}
        </button>
      </div>
    </>;
  }

  return <ApiKeyDialogFrame open={open} onOpenChange={next => next ? onOpenChange(true) : close()} title={title}
    description={issued || createIntent || review ? undefined : "Choose a scope, then set what this key can do there."}
    busy={saving} trigger={trigger} onCloseAutoFocus={onCloseAutoFocus}>
    {body}
  </ApiKeyDialogFrame>;
}
