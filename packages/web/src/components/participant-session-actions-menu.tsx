import * as Dialog from "@radix-ui/react-dialog";
import * as Popover from "@radix-ui/react-popover";
import {
  CircleX,
  EllipsisVertical,
  LoaderCircle,
  Info,
  Play,
  RefreshCw,
  Square,
} from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import type { LocalSessionContextMode } from "@minu/channels-control/contracts";
import { ErrorNotice } from "./ui/error-notice";

type ParticipantSessionAction = "start" | "start-fresh" | "reconnect" | "replace" | "replace-fresh" | "stop" | "cancel";
type ConfirmedAction = "replace" | "fresh" | "start-fresh" | "stop";

export function ParticipantSessionActionsMenu({
  participantName,
  canStart,
  canResume,
  canReconnect,
  canReplace,
  canCancel,
  canStop,
  pendingAction,
  actionsDisabled = false,
  onStart,
  onReconnect,
  onReplace,
  onCancel,
  onStop,
  onDismissError,
  onDetails,
  onRefresh,
  refreshing = false,
  diagnosticsHref,
  hasError = false,
  trigger,
}: {
  participantName: string;
  canStart: boolean;
  canResume: boolean;
  canReconnect: boolean;
  canReplace: boolean;
  canCancel: boolean;
  canStop: boolean;
  pendingAction?: ParticipantSessionAction;
  actionsDisabled?: boolean;
  onStart?(contextMode: LocalSessionContextMode): void | Promise<unknown>;
  onReconnect?(): void | Promise<unknown>;
  onReplace?(contextMode: LocalSessionContextMode): void | Promise<unknown>;
  onCancel?(): void | Promise<unknown>;
  onStop?(): void | Promise<unknown>;
  onDismissError?(): void;
  onDetails?(trigger: HTMLButtonElement | null): void;
  onRefresh?(): void | Promise<void>;
  refreshing?: boolean;
  diagnosticsHref?: string;
  hasError?: boolean;
  trigger?: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmedAction, setConfirmedAction] = useState<ConfirmedAction>();
  const [error, setError] = useState<string>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [submitting, setSubmitting] = useState(false);
  const submission = useRef(false);
  const confirmationVersion = useRef(0);
  const openingDetails = useRef(false);
  const pending = pendingAction !== undefined || submitting;
  const blocked = actionsDisabled || pending;
  const hasActions = canStart || canResume || canReconnect || canReplace || canCancel || canStop;

  if (!hasActions && !onDetails && !onRefresh && !diagnosticsHref) return null;

  const closeConfirmation = () => {
    confirmationVersion.current += 1;
    setConfirmedAction(undefined);
  };
  const viewDetails = () => {
    openingDetails.current = confirmedAction !== undefined;
    closeConfirmation();
    setMenuOpen(false);
    onDetails?.(triggerRef.current);
  };
  const invoke = (action: () => void | Promise<unknown>) => {
    if (blocked || submission.current) return;
    submission.current = true;
    setSubmitting(true);
    setMenuOpen(false);
    void Promise.resolve().then(action).catch(() => undefined).finally(() => {
      submission.current = false;
      setSubmitting(false);
    });
  };
  const requestConfirmation = (action: ConfirmedAction) => {
    if (blocked || submission.current) return;
    confirmationVersion.current += 1;
    setMenuOpen(false);
    setError(undefined);
    setConfirmedAction(action);
  };
  const confirm = async () => {
    if (!confirmedAction || blocked || submission.current) return;
    const version = confirmationVersion.current;
    submission.current = true;
    setSubmitting(true);
    setError(undefined);
    try {
      if (confirmedAction === "replace") await onReplace?.("with_context");
      else if (confirmedAction === "fresh") await onReplace?.("fresh");
      else if (confirmedAction === "start-fresh") await onStart?.("fresh");
      else await onStop?.();
      if (version === confirmationVersion.current) closeConfirmation();
    } catch (cause) {
      if (version === confirmationVersion.current) {
        setError(cause instanceof Error ? cause.message : "Unable to complete the participant action.");
      }
    } finally {
      submission.current = false;
      setSubmitting(false);
    }
  };
  const replacing = confirmedAction === "replace" || confirmedAction === "fresh" || confirmedAction === "start-fresh";
  const fresh = confirmedAction === "fresh" || confirmedAction === "start-fresh";
  const replacementLabel = fresh ? "Fresh session" : "New session with context";

  return (
    <Dialog.Root
      open={confirmedAction !== undefined}
      onOpenChange={(open) => {
        if (!open) closeConfirmation();
      }}
    >
      <Popover.Root open={menuOpen} onOpenChange={setMenuOpen}>
        <Popover.Trigger asChild ref={triggerRef}>
          {trigger ?? <button
            type="button"
            className="icon-button inline-flex shrink-0"
            aria-label={`Open actions for ${participantName}`}
            title={`Actions for ${participantName}`}
          >
            {pending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <EllipsisVertical className="h-4 w-4" />}
          </button>}
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="end"
            sideOffset={6}
            className="z-50 min-w-52 rounded-md border border-[var(--border)] bg-[var(--panel)] p-1 shadow-xl outline-none"
          >
            <div className={blocked ? "[&_button]:cursor-not-allowed [&_button]:opacity-50" : undefined}>
              {(canResume || canStart) && onStart ? (
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-sm hover:bg-[var(--hover)] disabled:opacity-50"
                  disabled={blocked}
                  onClick={() => invoke(() => onStart("with_context"))}
                >
                  <Play className="h-4 w-4" /> Start agent
                </button>
              ) : null}
              {canStart && onStart ? (
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-sm hover:bg-[var(--hover)]"
                  disabled={blocked}
                  onClick={() => requestConfirmation("start-fresh")}
                >
                  <Play className="h-4 w-4" /> Fresh session
                </button>
              ) : null}
              {canReconnect && onReconnect ? (
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-sm hover:bg-[var(--hover)]"
                  disabled={blocked}
                  onClick={() => invoke(onReconnect)}
                >
                  <RefreshCw className="h-4 w-4" /> Reconnect
                </button>
              ) : null}
              {canReplace && onReplace ? (
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-sm hover:bg-[var(--hover)]"
                  disabled={blocked}
                  onClick={() => requestConfirmation("replace")}
                >
                  <RefreshCw className="h-4 w-4" /> New session with context
                </button>
              ) : null}
              {canReplace && onReplace ? (
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-sm hover:bg-[var(--hover)]"
                  disabled={blocked}
                  onClick={() => requestConfirmation("fresh")}
                >
                  <Play className="h-4 w-4" /> Fresh session
                </button>
              ) : null}
              {canCancel && onCancel ? (
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-sm text-[var(--warning)] hover:bg-[var(--hover)]"
                  disabled={blocked}
                  onClick={() => invoke(onCancel)}
                >
                  <CircleX className="h-4 w-4" /> Cancel current
                </button>
              ) : null}
              {canStop && onStop ? (
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-sm text-[var(--danger)] hover:bg-[var(--hover)]"
                  disabled={blocked}
                  onClick={() => requestConfirmation("stop")}
                >
                  <Square className="h-4 w-4" /> Stop agent
                </button>
              ) : null}
            </div>
            {onRefresh ? <button type="button" className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-sm hover:bg-[var(--hover)] disabled:opacity-50" disabled={refreshing} onClick={() => { void onRefresh(); }}><RefreshCw className={`h-4 w-4${refreshing ? " animate-spin" : ""}`} />Refresh status</button> : null}
            {diagnosticsHref ? <a className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-sm hover:bg-[var(--hover)]" href={diagnosticsHref}>Diagnostics</a> : null}
            {hasError && onDismissError ? <button type="button" className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-sm hover:bg-[var(--hover)]" onClick={() => { setError(undefined); onDismissError(); setMenuOpen(false); }}><CircleX className="h-4 w-4" />Dismiss action notice</button> : null}
            {onDetails ? (
              <div className={hasActions ? "mt-1 border-t border-[var(--border)] pt-1" : undefined}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-sm hover:bg-[var(--hover)]"
                  onClick={viewDetails}
                >
                  <Info className="h-4 w-4" /> Details
                </button>
              </div>
            ) : null}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-[var(--border)] bg-[var(--panel)] p-5 shadow-2xl outline-none"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            cancelRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (!openingDetails.current) triggerRef.current?.focus();
            openingDetails.current = false;
          }}
        >
          <Dialog.Title className="text-base font-semibold">
            {confirmedAction === "replace"
              ? `Start a new session with context for ${participantName}?`
              : fresh
                ? `Start a fresh session for ${participantName}?`
                : `Stop ${participantName}?`}
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm leading-5 text-[var(--muted)]">
            {confirmedAction === "replace"
              ? "This creates a new Runtime session; it does not resume the current transcript. A temporary handoff may be summarized from public Conversation history, and future turns receive configured recent context. Pending work through the current Conversation head is discarded. Conversation history and filesystem effects remain."
              : confirmedAction === "fresh"
                ? "This creates a new Runtime session with no handoff and excludes Conversation messages from before it starts. Current agent/project instructions and configuration still apply; future messages are included. Pending work through the current Conversation head is discarded. Conversation history and filesystem effects remain."
                : confirmedAction === "start-fresh"
                  ? "Starts a Runtime session with no handoff and excludes all earlier Conversation messages. Saved agent/project instructions and configuration still apply; messages posted after it starts are included."
                : "Active work will be interrupted and queued turns through the stop boundary discarded. The same Runtime session is kept; messages posted while stopped wait until you resume it. External tool or filesystem effects cannot be rolled back."}
          </Dialog.Description>
          {error ? <ErrorNotice className="mt-3" onDismiss={() => {
            setError(undefined);
            onDismissError?.();
          }}>{error}</ErrorNotice> : null}
          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Close asChild>
              <button ref={cancelRef} type="button" className="button-secondary">{pending ? "Close" : "Cancel"}</button>
            </Dialog.Close>
            {pending && onDetails ? <button type="button" className="button-secondary" onClick={viewDetails}>View details</button> : null}
            <button
              type="button"
              className={`inline-flex min-h-8 items-center justify-center gap-1.5 rounded border px-3 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${
                replacing
                  ? "border-[var(--border)] text-[var(--text)] hover:bg-[var(--hover)]"
                  : "border-[var(--danger)] text-[var(--danger)] hover:bg-[var(--danger)]/10"
              }`}
              disabled={blocked}
              onClick={() => void confirm()}
            >
              {pending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
              {replacing ? replacementLabel : "Stop agent"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
