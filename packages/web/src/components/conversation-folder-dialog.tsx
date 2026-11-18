import type { ConversationFolder, ConversationMetadata } from "@minu/channels-core/types";
import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { conversations } from "../lib/api";
import { cacheConversationMetadata } from "../lib/conversation-folders";
import { queryKeys } from "../lib/query-keys";
import { AdministrationDialog } from "./conversation-administration-dialog";
import { ErrorNotice } from "./ui/error-notice";

export function ConversationFolderDialog({ workspaceId, actorIdentityId, folder, open: controlledOpen, onOpenChange, trigger = null, onCloseAutoFocus }: {
  workspaceId: string;
  actorIdentityId: string;
  folder?: ConversationFolder;
  open?: boolean;
  onOpenChange?(open: boolean): void;
  trigger?: ReactNode;
  onCloseAutoFocus?(event: Event): void;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setInternalOpen(next);
    onOpenChange?.(next);
  };
  const [name, setName] = useState(folder?.name ?? "");
  const wasOpen = useRef(false);
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => folder
      ? conversations.updateWorkspaceFolder(workspaceId, folder.id, { actorIdentityId, name })
      : conversations.createWorkspaceFolder(workspaceId, { actorIdentityId, name }),
    onSuccess: updated => {
      client.setQueryData<ConversationFolder[]>(queryKeys.workspaceFolders(workspaceId), (current = []) => [
        ...current.filter(item => item.id !== updated.id), updated,
      ]);
      void client.invalidateQueries({ queryKey: queryKeys.workspaceFolders(workspaceId), exact: true });
      setOpen(false);
    },
  });
  useEffect(() => {
    if (open && !wasOpen.current) { setName(folder?.name ?? ""); mutation.reset(); }
    wasOpen.current = open;
  }, [open, folder?.name, mutation.reset]);
  const title = folder ? "Rename folder" : "Create folder";
  return (
    <AdministrationDialog open={open} onOpenChange={next => { if (!mutation.isPending) setOpen(next); }} title={title} trigger={trigger} onCloseAutoFocus={onCloseAutoFocus}>
      <form className="space-y-5" onSubmit={event => {
        event.preventDefault();
        if (name.trim() && !mutation.isPending) mutation.mutate();
      }}>
        <label className="block text-xs font-medium">
          Folder name
          <input className="settings-input mt-1.5" value={name} onChange={event => setName(event.target.value)} maxLength={100} required autoFocus disabled={mutation.isPending} />
        </label>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {mutation.error ? <ErrorNotice className="mr-auto" onDismiss={mutation.reset}>{mutation.error.message}</ErrorNotice> : null}
          <Dialog.Close asChild><button className="button-secondary" type="button" disabled={mutation.isPending}>Cancel</button></Dialog.Close>
          <button className="button-primary" type="submit" disabled={!name.trim() || mutation.isPending}>
            {mutation.isPending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : null}
            {folder ? "Save folder" : "Create folder"}
          </button>
        </div>
      </form>
    </AdministrationDialog>
  );
}

export function MoveConversationFolderDialog({ conversation, actorIdentityId, onClose, onMoved, onCloseAutoFocus }: {
  conversation: ConversationMetadata;
  actorIdentityId: string;
  onClose(): void;
  onMoved(updated: ConversationMetadata): void;
  onCloseAutoFocus(event: Event): void;
}) {
  const [folderId, setFolderId] = useState(conversation.folderId ?? "");
  const client = useQueryClient();
  const folders = useQuery({
    queryKey: queryKeys.workspaceFolders(conversation.workspaceId),
    queryFn: () => conversations.listWorkspaceFolders(conversation.workspaceId),
  });
  const mutation = useMutation({
    mutationFn: () => conversations.assignConversationFolder(conversation.id, { actorIdentityId, folderId: folderId || null }),
    onSuccess: updated => {
      cacheConversationMetadata(client, updated);
      void client.invalidateQueries({ queryKey: queryKeys.workspaceFolders(conversation.workspaceId), exact: true });
      onMoved(updated);
      onClose();
    },
  });
  return (
    <AdministrationDialog open onOpenChange={next => { if (!next && !mutation.isPending) onClose(); }} title={`Move #${conversation.name}`} trigger={null} onCloseAutoFocus={onCloseAutoFocus}>
      <form className="space-y-5" onSubmit={event => {
        event.preventDefault();
        if (!folders.isPending && !folders.error && !mutation.isPending) mutation.mutate();
      }}>
        <label className="block text-xs font-medium">
          Folder
          <select className="settings-input mt-1.5" value={folderId} onChange={event => setFolderId(event.target.value)} disabled={folders.isPending || mutation.isPending}>
            <option value="">Unfiled</option>
            {(folders.data ?? []).map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
          </select>
        </label>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {folders.error ? <div role="alert" className="mr-auto text-xs text-[var(--danger)]">{folders.error.message}<button className="ml-2 underline" type="button" onClick={() => void folders.refetch()}>Retry</button></div> : null}
          {mutation.error ? <ErrorNotice className="mr-auto" onDismiss={mutation.reset}>{mutation.error.message}</ErrorNotice> : null}
          <Dialog.Close asChild><button className="button-secondary" type="button" disabled={mutation.isPending}>Cancel</button></Dialog.Close>
          <button className="button-primary" type="submit" disabled={folders.isPending || Boolean(folders.error) || mutation.isPending}>
            {mutation.isPending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : null}
            Move Conversation
          </button>
        </div>
      </form>
    </AdministrationDialog>
  );
}
