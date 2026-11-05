import type { ConversationMetadata, Workspace } from "@minu/channels-core/types";
import { useNavigate } from "@tanstack/react-router";
import { SquarePen } from "lucide-react";
import { cloneElement, useEffect, type ReactElement, type ReactNode } from "react";

export function CreateConversationDialog({ workspace, onNavigate }: { workspace: Workspace; onNavigate?(): void }) {
  const navigate = useNavigate();
  return <button type="button" className="icon-button inline-flex min-h-8 min-w-8" aria-label={`Create Conversation in ${workspace.name}`} title="Create Conversation"
    onClick={() => { onNavigate?.(); void navigate({ to: "/app/workspaces/$workspaceId/conversations/new", params: { workspaceId: workspace.id } }); }}>
    <SquarePen className="h-3.5 w-3.5" />
  </button>;
}

export function EditConversationParticipantsDialog({ conversation, open, onOpenChange, trigger = null }: {
  conversation: ConversationMetadata; open?: boolean; onOpenChange?(open: boolean): void;
  onCloseAutoFocus?(event: Event): void; trigger?: ReactNode;
}) {
  const navigate = useNavigate();
  const launch = () => {
    onOpenChange?.(false);
    void navigate({ to: "/app/workspaces/$workspaceId/conversations/$conversationId/settings",
      params: { workspaceId: conversation.workspaceId, conversationId: conversation.id } });
  };
  useEffect(() => { if (open) launch(); }, [open]); // Opening the existing menu action now navigates to its content page.
  return trigger ? cloneElement(trigger as ReactElement<{ onClick(): void }>, { onClick: launch }) : null;
}
