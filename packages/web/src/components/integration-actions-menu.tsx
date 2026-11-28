import type { LocalAgentCredentialSummary } from "@minu/channels-control/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { EllipsisVertical } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { localControl } from "../lib/api";
import { classifyCredentialFailure, credentialIntents, credentialStatus, intentKey } from "../lib/agent-credentials";
import { queryKeys } from "../lib/query-keys";
import {
  ApiKeyAccessDialog, ApiKeyDialogFrame, CredentialFacts, OneTimeSecretPanel, upsertCredential, useCredentialIntent, useCredentialRead, useMounted,
  useTargetCatalog,
} from "./api-key-access-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { ErrorNotice } from "./ui/error-notice";

type Surface = "edit" | "rotate" | "revoke";

const dangerButton = "inline-flex min-h-8 items-center justify-center rounded border border-[var(--danger)] px-3 text-xs font-semibold text-[var(--danger)] hover:bg-[var(--danger)]/10 disabled:cursor-not-allowed disabled:opacity-50";

function CredentialActionDialog({ action, workspaceId, credential, open, onOpenChange, onCloseAutoFocus }: {
  action: "rotate" | "revoke"; workspaceId: string; credential: LocalAgentCredentialSummary;
  open: boolean; onOpenChange(open: boolean): void; onCloseAutoFocus(event: Event): void;
}) {
  const queryClient = useQueryClient();
  const mounted = useMounted();
  const key = intentKey(workspaceId, "credential", credential.id);
  const intent = useCredentialIntent(key);
  const [base, setBase] = useState(credential);
  const [phase, setPhase] = useState<"confirm" | "secret" | "review">("confirm");
  const [reason, setReason] = useState<"conflict" | "unknown" | "denied" | "undelivered">("unknown");
  const [attempted, setAttempted] = useState({ revision: credential.revision, secretGeneration: credential.secretGeneration });
  const [secret, setSecret] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const inFlight = useRef(false);
  const openRef = useRef(open);
  openRef.current = open;
  const currentRead = useCredentialRead(workspaceId, credential.id);
  const current = currentRead.state.status === "loaded" ? currentRead.state.current : undefined;
  // Target names are only needed to review current metadata.
  const catalog = useTargetCatalog(workspaceId, open && phase === "review");
  const catalogById = new Map(catalog.targets.map(target => [target.id, target]));

  useEffect(() => {
    if (!open) { setSecret(undefined); return; }
    setBase(credential);
    setError(undefined);
    currentRead.reset();
    const pending = credentialIntents.get(key);
    if (pending && pending.kind !== "create" && pending.state !== "pending") {
      setAttempted({ revision: pending.expectedRevision, secretGeneration: pending.secretGeneration });
      setReason(pending.state === "undelivered" ? "undelivered" : pending.denied ? "denied" : "unknown");
      setPhase("review");
      void currentRead.read();
    } else setPhase("confirm");
    // Reset only on open so a list refresh cannot replace a reviewed revision mid-dialog.
  }, [open]);

  const close = () => {
    setSecret(undefined);
    // Reviewing current metadata resolves an unconfirmed outcome; nothing is replayed.
    if (phase === "review" && current) credentialIntents.clear(key);
    onOpenChange(false);
  };

  const run = async (target: LocalAgentCredentialSummary) => {
    if (inFlight.current || credentialIntents.get(key)?.state === "pending") return;
    const before = { revision: target.revision, secretGeneration: target.secretGeneration };
    inFlight.current = true;
    setSaving(true);
    setError(undefined);
    setAttempted(before);
    credentialIntents.set(key, { kind: action, credentialId: target.id, expectedRevision: before.revision, secretGeneration: before.secretGeneration, state: "pending" });
    try {
      if (action === "rotate") {
        const result = await localControl.rotateAgentCredential(workspaceId, target.id, target.revision);
        upsertCredential(queryClient, workspaceId, result.credential);
        if (mounted.current && openRef.current) {
          credentialIntents.clear(key);
          setSecret(result.secret);
          setPhase("secret");
        } else credentialIntents.set(key, { kind: action, credentialId: target.id, expectedRevision: before.revision, secretGeneration: before.secretGeneration, state: "undelivered" });
      } else {
        const result = await localControl.revokeAgentCredential(workspaceId, target.id, target.revision);
        upsertCredential(queryClient, workspaceId, result);
        credentialIntents.clear(key);
        if (mounted.current && openRef.current) onOpenChange(false);
      }
    } catch (cause) {
      const failure = classifyCredentialFailure(cause);
      // A denial can follow a committed rotation/revocation; keep the intent until metadata is reviewed.
      if (failure.mayHaveCommitted) credentialIntents.set(key, { kind: action, credentialId: target.id, expectedRevision: before.revision, secretGeneration: before.secretGeneration, state: "unknown", denied: failure.kind === "denied" });
      else credentialIntents.clear(key);
      if (failure.mayHaveCommitted || failure.kind === "conflict") {
        if (mounted.current) { setReason(failure.kind === "conflict" ? "conflict" : failure.kind === "denied" ? "denied" : "unknown"); setPhase("review"); void currentRead.read(); }
      } else {
        if (failure.kind === "inactive") void queryClient.invalidateQueries({ queryKey: queryKeys.agentCredentials(workspaceId) });
        if (mounted.current) setError(failure.message);
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setSaving(false);
    }
  };

  const verb = action === "rotate" ? "Rotate" : "Revoke";
  const title = phase === "secret" ? "API key rotated" : phase === "review" ? `Review ${action === "rotate" ? "rotation" : "revocation"}` : `${verb} API key?`;
  const description = phase === "confirm"
    ? action === "rotate"
      ? `A new secret is issued and the current secret stops working immediately. Expiry stays ${new Date(base.expiresAt).toLocaleString()}.`
      : "This key stops working immediately and can’t be restored."
    : undefined;
  const notice = reason === "conflict" ? `This key changed since the list loaded. Review the current version; nothing was ${action === "rotate" ? "rotated" : "revoked"}.`
    : reason === "denied" ? `Access was denied after the ${action === "rotate" ? "rotation" : "revocation"} was sent, so it may already have happened${action === "rotate" ? " and the previous secret may be invalid" : ""}. Restore an owner or admin session, then review the current version.`
    : reason === "undelivered" ? "The key was rotated, but the new secret couldn’t be shown. The previous secret no longer works."
      : `The server didn’t confirm the ${action === "rotate" ? "rotation. The previous secret may already be invalid" : "revocation"}. Review the current version.`;
  const canRepeat = current && (action === "rotate" ? credentialStatus(current, Date.now()) === "active" : !current.revokedAt);

  return <ApiKeyDialogFrame open={open} onOpenChange={next => { if (!next) close(); }} title={title} description={description} busy={saving}
    onCloseAutoFocus={onCloseAutoFocus}>
    {phase === "secret" && secret ? <>
      <OneTimeSecretPanel secret={secret} />
      <div className="mt-4 flex justify-end"><button type="button" className="button-primary" onClick={close}>Done</button></div>
    </> : phase === "review" ? <div role="region" aria-label={title} className="mt-4 text-sm">
      <p className="rounded-md border border-[var(--warning)]/60 bg-[var(--warning)]/10 p-3">{notice}</p>
      {currentRead.state.status === "loading" ? <p role="status" className="mt-3 text-xs text-[var(--muted)]">Loading current key…</p> : null}
      {currentRead.state.status === "failed" ? <p role="alert" className="mt-3 text-xs text-[var(--danger)]">The current key couldn’t be loaded.</p> : null}
      {current ? <CredentialFacts current={current} attempted={attempted} catalog={catalogById} /> : null}
      {error ? <ErrorNotice className="mt-3" onDismiss={() => setError(undefined)}>{error}</ErrorNotice> : null}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        {currentRead.state.status === "failed" ? <button type="button" className="button-secondary" onClick={() => void currentRead.read()}>Retry</button> : null}
        <button type="button" className="button-secondary" disabled={saving} onClick={close}>Close</button>
        {canRepeat ? <button type="button" className={dangerButton} disabled={saving} onClick={() => { setBase(current); void run(current); }}>
          {saving ? `${verb === "Rotate" ? "Rotating" : "Revoking"}…` : `${verb} this version`}
        </button> : null}
      </div>
    </div> : <>
      {error ? <ErrorNotice className="mt-3" onDismiss={() => setError(undefined)}>{error}</ErrorNotice> : null}
      {intent?.state === "pending" && !saving ? <p role="status" className="mt-3 text-xs text-[var(--muted)]">A previous request for this key is still waiting for the server.</p> : null}
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className="button-secondary" disabled={saving} onClick={close}>Cancel</button>
        <button type="button" className={dangerButton} disabled={saving || intent?.state === "pending"} onClick={() => void run(base)}>
          {saving ? `${verb === "Rotate" ? "Rotating" : "Revoking"}…` : `${verb} key`}
        </button>
      </div>
    </>}
  </ApiKeyDialogFrame>;
}

export function IntegrationActionsMenu({ workspaceId, credential }: { workspaceId: string; credential: LocalAgentCredentialSummary }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [surface, setSurface] = useState<Surface>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const openingSurface = useRef(false);
  const intent = useCredentialIntent(intentKey(workspaceId, "credential", credential.id));
  const status = credentialStatus(credential, Date.now());
  const pending = intent?.state === "pending";
  const unresolved = intent && intent.kind !== "create" && intent.state !== "pending" ? intent : undefined;
  const open = (next: Surface) => { openingSurface.current = true; setMenuOpen(false); setSurface(next); };
  const returnFocus = (event: Event) => { event.preventDefault(); triggerRef.current?.focus(); };
  const changeSurface = (next: boolean) => {
    if (next) return;
    setSurface(undefined);
    // The surface unmounts on close, so restore focus explicitly as well.
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  return <>
    <DropdownMenu open={menuOpen} onOpenChange={next => { if (next) openingSurface.current = false; setMenuOpen(next); }}>
      <DropdownMenuTrigger asChild>
        <button ref={triggerRef} type="button" aria-label={`Actions for API key ${credential.name}`} title="API key actions"
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--text)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]">
          <EllipsisVertical className="h-4 w-4" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64" onCloseAutoFocus={event => {
        if (openingSurface.current) event.preventDefault();
        openingSurface.current = false;
      }}>
        {unresolved ? <DropdownMenuItem tone="warning" onSelect={() => open(unresolved.kind === "update" ? "edit" : unresolved.kind)}>Review unresolved change</DropdownMenuItem> : null}
        <DropdownMenuItem disabled={status !== "active" || pending || !!unresolved} onSelect={() => open("edit")}>Edit access</DropdownMenuItem>
        <DropdownMenuItem disabled={status !== "active" || pending || !!unresolved} onSelect={() => open("rotate")}>Rotate key</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem tone="danger" disabled={status === "revoked" || pending || !!unresolved} onSelect={() => open("revoke")}>Revoke key</DropdownMenuItem>
        <div className="border-t border-[var(--border)] p-2 text-xs text-[var(--muted)]">
          <span className="capitalize">{status}</span> · Revision {credential.revision} · Secret generation {credential.secretGeneration}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
    {surface === "edit" ? <ApiKeyAccessDialog workspaceId={workspaceId} credential={credential} open onOpenChange={changeSurface} onCloseAutoFocus={returnFocus} /> : null}
    {surface === "rotate" || surface === "revoke" ? <CredentialActionDialog action={surface} workspaceId={workspaceId} credential={credential}
      open onOpenChange={changeSurface} onCloseAutoFocus={returnFocus} /> : null}
  </>;
}
