import type { Workspace } from "@minu/channels-core/types";
import { useNavigate } from "@tanstack/react-router";
import { Settings } from "lucide-react";
import { cloneElement, useCallback, useEffect, type ReactElement, type ReactNode } from "react";
import type { NotificationSound } from "../lib/conversation-notifications";

export function WorkspaceSettingsDialog({ workspace, open, onOpenChange, trigger, focusName = false }: {
  workspace: Workspace; open?: boolean; onOpenChange?(open: boolean): void;
  trigger?: ReactNode | null; onCloseAutoFocus?(event: Event): void; focusName?: boolean;
  sound?: NotificationSound; onSoundChange?(sound: NotificationSound): void;
}) {
  const navigate = useNavigate();
  const launch = useCallback(() => {
    onOpenChange?.(false);
    void navigate({ to: "/app/workspaces/$workspaceId/settings", params: { workspaceId: workspace.id }, search: { focusName: focusName || undefined } });
  }, [focusName, navigate, onOpenChange, workspace.id]);
  useEffect(() => { if (open) launch(); }, [open, launch]);
  if (trigger === null) return null;
  return trigger ? cloneElement(trigger as ReactElement<{ onClick(): void }>, { onClick: launch })
    : <button type="button" className="icon-button inline-flex min-h-8 min-w-8" aria-label={`Configure Workspace ${workspace.name}`} title="Workspace configuration" onClick={launch}>
      <Settings className="h-3.5 w-3.5" />
    </button>;
}
