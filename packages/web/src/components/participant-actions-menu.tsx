import * as Dialog from "@radix-ui/react-dialog";
import * as Popover from "@radix-ui/react-popover";
import { EllipsisVertical, LoaderCircle, Play, Square } from "lucide-react";
import { useRef, useState } from "react";
import { ErrorNotice } from "./ui/error-notice";

export function ParticipantActionsMenu({
  startEligible,
  stopEligible,
  pendingAction,
  disabled = false,
  onStart,
  onStop,
  onDismissError,
  onViewDiagnostics,
}: {
  startEligible: number;
  stopEligible: number;
  pendingAction?: "start" | "stop";
  disabled?: boolean;
  onStart?(): void | Promise<void>;
  onStop?(): Promise<void>;
  onDismissError?(): void;
  onViewDiagnostics?(trigger: HTMLElement | null): void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [submitting, setSubmitting] = useState(false);
  const submission = useRef(false);
  const confirmationVersion = useRef(0);
  const openingDetails = useRef(false);
  const busy = pendingAction !== undefined || submitting;
  const pending = disabled || busy;
  const closeConfirmation = () => {
    confirmationVersion.current += 1;
    setConfirmOpen(false);
  };
  const viewDiagnostics = () => {
    openingDetails.current = confirmOpen;
    closeConfirmation();
    setMenuOpen(false);
    onViewDiagnostics?.(triggerRef.current);
  };
  const start = () => {
    if (pending || submission.current) return;
    submission.current = true;
    setSubmitting(true);
    setMenuOpen(false);
    void Promise.resolve().then(() => onStart?.()).catch(() => undefined).finally(() => {
      submission.current = false;
      setSubmitting(false);
    });
  };
  const openStopConfirmation = () => {
    if (pending || submission.current) return;
    confirmationVersion.current += 1;
    setMenuOpen(false);
    setError(undefined);
    setConfirmOpen(true);
  };
  const stop = async () => {
    if (pending || submission.current) return;
    const version = confirmationVersion.current;
    submission.current = true;
    setSubmitting(true);
    setError(undefined);
    try {
      await onStop?.();
      if (version === confirmationVersion.current) closeConfirmation();
    } catch (cause) {
      if (version === confirmationVersion.current) {
        setError(cause instanceof Error ? cause.message : "Unable to stop active agents.");
      }
    } finally {
      submission.current = false;
      setSubmitting(false);
    }
  };

  return (
    <Dialog.Root
      open={confirmOpen}
      onOpenChange={(open) => {
        if (!open) closeConfirmation();
      }}
    >
      <Popover.Root open={menuOpen} onOpenChange={setMenuOpen}>
        <Popover.Trigger asChild>
          <button
            ref={triggerRef}
            type="button"
            className="icon-button inline-flex shrink-0"
            aria-label="Open participant actions"
            title="Participant actions"
          >
            <EllipsisVertical className="h-4 w-4" />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="end"
            sideOffset={6}
            className="z-50 min-w-56 rounded-md border border-[var(--border)] bg-[var(--panel)] p-1 shadow-xl outline-none"
          >
            {pending ? <p className="max-w-64 px-2.5 py-2 text-xs text-[var(--muted)]">An agent action is pending. Details remain available.</p> : null}
            {onStart ? (
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-sm hover:bg-[var(--hover)] disabled:cursor-not-allowed disabled:opacity-50"
                disabled={startEligible === 0 || pending}
                onClick={start}
              >
                {pendingAction === "start" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                Start eligible agents ({startEligible})
              </button>
            ) : null}
            {onStop ? (
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-sm text-[var(--danger)] hover:bg-[var(--hover)] disabled:cursor-not-allowed disabled:opacity-50"
                disabled={stopEligible === 0 || pending}
                onClick={openStopConfirmation}
              >
                <Square className="h-4 w-4" />
                Stop active agents ({stopEligible})
              </button>
            ) : null}
            {onViewDiagnostics ? <button type="button" className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-sm hover:bg-[var(--hover)]" onClick={viewDiagnostics}>View diagnostics</button> : null}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-[var(--border)] bg-[var(--panel)] p-5 shadow-2xl outline-none"
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
          <Dialog.Title className="text-base font-semibold">Stop active agents?</Dialog.Title>
          <Dialog.Description className="mt-2 text-sm leading-5 text-[var(--muted)]">
            Active work will be interrupted and queued turns discarded. External tool or filesystem effects cannot be rolled back.
          </Dialog.Description>
          {busy ? <p className="mt-3 text-xs text-[var(--muted)]">Closing this dialog does not cancel the operation.</p> : null}
          {error ? <ErrorNotice className="mt-3" onDismiss={() => {
            setError(undefined);
            onDismissError?.();
          }}>{error}</ErrorNotice> : null}
          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Close asChild>
              <button ref={cancelRef} type="button" className="button-secondary">{busy ? "Close" : "Cancel"}</button>
            </Dialog.Close>
            {busy && onViewDiagnostics ? <button type="button" className="button-secondary" onClick={viewDiagnostics}>View diagnostics</button> : null}
            <button
              type="button"
              className="inline-flex min-h-8 items-center justify-center gap-1.5 rounded border border-[var(--danger)] px-3 text-xs font-semibold text-[var(--danger)] hover:bg-[var(--danger)]/10 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={pending}
              onClick={() => void stop()}
            >
              {pendingAction === "stop" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
              Stop active agents
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
