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
import { ErrorNotice } from "./ui/error-notice";

type ParticipantSessionAction = "start" | "reconnect" | "replace" | "stop" | "cancel";
type ConfirmedAction = "replace" | "stop";

export function ParticipantSessionActionsMenu({
  participantName,
  replacementStartsSession = false,
  canStart,
  canReconnect,
  canReplace,
  canCancel,
  canStop,
  pendingAction,
  disabled = false,
  onStart,
  onReconnect,
  onReplace,
  onCancel,
  onStop,
  onDismissError,
  onDetails,
  trigger,
}: {
  participantName: string;
  replacementStartsSession?: boolean;
  canStart: boolean;
  canReconnect: boolean;
  canReplace: boolean;
  canCancel: boolean;
  canStop: boolean;
  pendingAction?: ParticipantSessionAction;
  disabled?: boolean;
  onStart?(): void | Promise<unknown>;
  onReconnect?(): void | Promise<unknown>;
  onReplace?(): void | Promise<unknown>;
  onCancel?(): void | Promise<unknown>;
  onStop?(): void | Promise<unknown>;
  onDismissError?(): void;
  onDetails?(trigger: HTMLButtonElement | null): void;
  trigger?: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmedAction, setConfirmedAction] = useState<ConfirmedAction>();
  const [error, setError] = useState<string>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const pending = pendingAction !== undefined;
  const hasActions = canStart || canReconnect || canReplace || canCancel || canStop;

  if (!hasActions && !onDetails) return null;

  const invoke = (action: () => void | Promise<unknown>) => {
    setMenuOpen(false);
    void Promise.resolve(action()).catch(() => undefined);
  };
  const requestConfirmation = (action: ConfirmedAction) => {
    setMenuOpen(false);
    setError(undefined);
    setConfirmedAction(action);
  };
  const confirm = async () => {
    if (!confirmedAction) return;
    setError(undefined);
    try {
      if (confirmedAction === "replace") await onReplace?.();
      else await onStop?.();
      setConfirmedAction(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to complete the participant action.");
    }
  };
  const replacing = confirmedAction === "replace";
  const replacementLabel = replacementStartsSession ? "Start session" : "New session";

  return (
    <Dialog.Root
      open={confirmedAction !== undefined}
      onOpenChange={(open) => {
        if (!open && !pending) setConfirmedAction(undefined);
      }}
    >
      <Popover.Root open={menuOpen} onOpenChange={setMenuOpen}>
        <Popover.Trigger asChild ref={triggerRef} disabled={disabled || pending}>
          {trigger ?? <button
            type="button"
            className="icon-button inline-flex shrink-0"
            aria-label={`Open actions for ${participantName}`}
            title={`Actions for ${participantName}`}
            disabled={disabled || pending}
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
            {canStart && onStart ? (
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-sm hover:bg-[var(--hover)]"
                onClick={() => invoke(onStart)}
              >
                <Play className="h-4 w-4" /> Start session
              </button>
            ) : null}
            {canReconnect && onReconnect ? (
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-sm hover:bg-[var(--hover)]"
                onClick={() => invoke(onReconnect)}
              >
                <RefreshCw className="h-4 w-4" /> Reconnect
              </button>
            ) : null}
            {canReplace && onReplace ? (
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-sm hover:bg-[var(--hover)]"
                onClick={() => requestConfirmation("replace")}
              >
                {replacementStartsSession ? <Play className="h-4 w-4" /> : <RefreshCw className="h-4 w-4" />} {replacementLabel}
              </button>
            ) : null}
            {canCancel && onCancel ? (
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-sm text-[var(--warning)] hover:bg-[var(--hover)]"
                onClick={() => invoke(onCancel)}
              >
                <CircleX className="h-4 w-4" /> Cancel current
              </button>
            ) : null}
            {canStop && onStop ? (
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-sm text-[var(--danger)] hover:bg-[var(--hover)]"
                onClick={() => requestConfirmation("stop")}
              >
                <Square className="h-4 w-4" /> Stop agent
              </button>
            ) : null}
            {onDetails ? (
              <div className={hasActions ? "mt-1 border-t border-[var(--border)] pt-1" : undefined}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-sm hover:bg-[var(--hover)]"
                  onClick={() => {
                    setMenuOpen(false);
                    onDetails(triggerRef.current);
                  }}
                >
                  <Info className="h-4 w-4" /> Details &amp; diagnostics
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
            triggerRef.current?.focus();
          }}
        >
          <Dialog.Title className="text-base font-semibold">
            {replacing ? `Start a new session for ${participantName}?` : `Stop ${participantName}?`}
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm leading-5 text-[var(--muted)]">
            {replacing
              ? "The private Runtime transcript will reset using the current configuration. A temporary handoff is created from public Conversation history when available; it is not stored as memory. Pending work through the current Conversation head will be discarded. Conversation history and filesystem effects remain; future turns receive the configured recent context."
              : "Active work will be interrupted and queued turns discarded. External tool or filesystem effects cannot be rolled back."}
          </Dialog.Description>
          {error ? <ErrorNotice className="mt-3" onDismiss={() => {
            setError(undefined);
            onDismissError?.();
          }}>{error}</ErrorNotice> : null}
          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Close asChild>
              <button ref={cancelRef} type="button" className="button-secondary" disabled={pending}>Cancel</button>
            </Dialog.Close>
            <button
              type="button"
              className={`inline-flex min-h-8 items-center justify-center gap-1.5 rounded border px-3 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${
                replacing
                  ? "border-[var(--border)] text-[var(--text)] hover:bg-[var(--hover)]"
                  : "border-[var(--danger)] text-[var(--danger)] hover:bg-[var(--danger)]/10"
              }`}
              disabled={pending}
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
