import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import { useNavigate } from "@tanstack/react-router";
import { FolderOpen, FolderPlus, LoaderCircle, X } from "lucide-react";
import { useRef, useState } from "react";
import { localControl } from "../lib/api";
import { queryKeys } from "../lib/query-keys";

function workspaceSlug(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 52) || "workspace";
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

export function WorkspaceCreateDialog({ onNavigate }: { onNavigate?(): void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [sourcePath, setSourcePath] = useState("");
  const provisioningSlug = useRef<string | undefined>(undefined);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const session = useQuery({
    queryKey: queryKeys.localCurrentSession(),
    queryFn: () => localControl.currentSession(),
    enabled: open,
    retry: false,
  });
  const picker = useMutation({
    mutationFn: () => localControl.selectLocalFolder(),
    onSuccess: (path) => { if (path) setSourcePath(path); },
  });
  const mutation = useMutation({
    mutationFn: async () => {
      if (!session.data) throw new Error("Local session is unavailable");
      provisioningSlug.current ??= workspaceSlug(name.trim());
      return localControl.provisionWorkspace({
        slug: provisioningSlug.current,
        name: name.trim(),
        rootUri: sourcePath.trim(),
      });
    },
    onSuccess: ({ workspaceId, channelId }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaces() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceChannels(workspaceId) });
      setOpen(false);
      setName("");
      setSourcePath("");
      provisioningSlug.current = undefined;
      onNavigate?.();
      void navigate({
        to: "/app/workspaces/$workspaceId/channels/$channelId",
        params: { workspaceId, channelId },
      });
    },
  });
  const valid = Boolean(name.trim() && sourcePath.trim().startsWith("/") && session.data);

  return (
    <Dialog.Root open={open} onOpenChange={(next) => {
      setOpen(next);
      if (!next) {
        provisioningSlug.current = undefined;
        mutation.reset();
        picker.reset();
      }
    }}>
      <Dialog.Trigger asChild>
        <button type="button" className="icon-button inline-flex" aria-label="Add Workspace" title="Add Workspace"><FolderPlus className="h-4 w-4" /></button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/55" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-[71] w-[min(36rem,94vw)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl outline-none">
          <header className="flex items-start justify-between gap-4 border-b border-[var(--border)] px-5 py-4">
            <div><Dialog.Title className="text-base font-semibold">Add Workspace</Dialog.Title><Dialog.Description className="mt-1 text-xs leading-5 text-[var(--muted)]">Connect a local source folder to a new Workspace.</Dialog.Description></div>
            <Dialog.Close className="icon-button inline-flex" aria-label="Close Add Workspace"><X className="h-4 w-4" /></Dialog.Close>
          </header>
          <form className="p-5" onSubmit={(event) => { event.preventDefault(); if (valid && !mutation.isPending) mutation.mutate(); }}>
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
            <div className="mt-5 flex items-center justify-end gap-2">
              {mutation.error || picker.error || session.error ? <span className="mr-auto text-xs text-[var(--danger)]">{(mutation.error ?? picker.error ?? session.error)?.message}</span> : null}
              <Dialog.Close asChild><button type="button" className="button-secondary">Cancel</button></Dialog.Close>
              <button type="submit" className="button-primary" disabled={!valid || mutation.isPending}>{mutation.isPending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : null}Create Workspace</button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
