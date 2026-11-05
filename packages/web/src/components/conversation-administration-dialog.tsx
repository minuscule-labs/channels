import type { ConversationMetadata, Workspace } from "@minu/channels-core/types";
import { useNavigate } from "@tanstack/react-router";
import * as Dialog from "@radix-ui/react-dialog";
import { SquarePen, X } from "lucide-react";
import { cloneElement, useCallback, useEffect, type MouseEvent, type ReactElement, type ReactNode } from "react";

export function AdministrationDialog({
  open,
  onOpenChange,
  title,
  description,
  trigger,
  onCloseAutoFocus,
  children,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  description?: string;
  trigger: ReactNode;
  onCloseAutoFocus?(event: Event): void;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? <Dialog.Trigger asChild>{trigger}</Dialog.Trigger> : null}
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/55" />
        <Dialog.Content {...(!description ? { "aria-describedby": undefined } : {})} onCloseAutoFocus={onCloseAutoFocus} className="fixed top-1/2 left-1/2 z-[71] flex max-h-[min(46rem,94vh)] w-[min(36rem,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl outline-none">
          <header className="flex shrink-0 items-start justify-between gap-4 border-b border-[var(--border)] px-5 py-4">
            <div>
              <Dialog.Title className="text-base font-semibold">{title}</Dialog.Title>
              {description ? <Dialog.Description className="mt-1 text-xs leading-5 text-[var(--muted)]">{description}</Dialog.Description> : null}
            </div>
            <Dialog.Close className="icon-button inline-flex" aria-label={`Close ${title}`}>
              <X className="h-4 w-4" />
            </Dialog.Close>
          </header>
          <div className="minu-scroll min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

type NavigationTrigger = ReactElement<{ onClick?(event: MouseEvent<HTMLButtonElement>): void }>;

export function CreateConversationDialog({ workspace, onNavigate, open, onOpenChange, initialFolderId, trigger }: {
  workspace: Workspace; onNavigate?(): void; open?: boolean; onOpenChange?(open: boolean): void;
  initialFolderId?: string | null; trigger?: ReactNode; onCloseAutoFocus?(event: Event): void;
}) {
  const navigate = useNavigate();
  const launch = useCallback(() => {
    onOpenChange?.(false);
    onNavigate?.();
    void navigate({ to: "/app/workspaces/$workspaceId/conversations/new", params: { workspaceId: workspace.id },
      search: { folderId: initialFolderId ?? undefined } });
  }, [initialFolderId, navigate, onNavigate, onOpenChange, workspace.id]);
  useEffect(() => { if (open) launch(); }, [open, launch]);
  if (trigger === null) return null;
  if (trigger) {
    const button = trigger as NavigationTrigger;
    return cloneElement(button, { onClick: (event) => { button.props.onClick?.(event); if (!event.defaultPrevented) launch(); } });
  }
  return <button type="button" className="icon-button inline-flex min-h-8 min-w-8" aria-label={`Create Conversation in ${workspace.name}`} title="Create Conversation" onClick={launch}>
    <SquarePen className="h-3.5 w-3.5" />
  </button>;
}

export function EditConversationParticipantsDialog({ conversation, open, onOpenChange, trigger = null }: {
  conversation: ConversationMetadata; open?: boolean; onOpenChange?(open: boolean): void;
  onCloseAutoFocus?(event: Event): void; trigger?: ReactNode;
}) {
  const navigate = useNavigate();
  const launch = useCallback(() => {
    onOpenChange?.(false);
    void navigate({ to: "/app/workspaces/$workspaceId/conversations/$conversationId/settings",
      params: { workspaceId: conversation.workspaceId, conversationId: conversation.id } });
  }, [conversation.id, conversation.workspaceId, navigate, onOpenChange]);
  useEffect(() => { if (open) launch(); }, [open, launch]);
  return trigger ? cloneElement(trigger as NavigationTrigger, { onClick: launch }) : null;
}
