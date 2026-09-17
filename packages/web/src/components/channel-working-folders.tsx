import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderOpen, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { localControl } from "../lib/api";
import { queryKeys } from "../lib/query-keys";

type DraftFolder = { relativePath?: string; path?: string; primary: boolean };

export function ChannelWorkingFolders({ channelId, canAdminister }: {
  channelId: string;
  canAdminister: boolean;
}) {
  const queryClient = useQueryClient();
  const folders = useQuery({
    queryKey: queryKeys.channelWorkingFolders(channelId),
    queryFn: () => localControl.getChannelWorkingFolders(channelId),
    enabled: canAdminister,
    retry: false,
  });
  const [draft, setDraft] = useState<DraftFolder[]>([]);
  useEffect(() => {
    if (folders.data) setDraft(folders.data.folders.map(({ relativePath, primary }) => ({ relativePath, primary })));
  }, [folders.data]);
  const save = useMutation({
    mutationFn: () => localControl.updateChannelWorkingFolders(channelId, {
      folders: draft.map((folder) => folder.path
        ? { path: folder.path, primary: folder.primary }
        : { relativePath: folder.relativePath!, primary: folder.primary }),
    }),
    onSuccess: (value) => {
      queryClient.setQueryData(queryKeys.channelWorkingFolders(channelId), value);
      setDraft(value.folders.map(({ relativePath, primary }) => ({ relativePath, primary })));
    },
  });
  const select = useMutation({
    mutationFn: async () => {
      const path = await localControl.selectLocalFolder();
      return path ? { path, ...(await localControl.previewChannelWorkingFolder(channelId, path)) } : undefined;
    },
    onSuccess: (selection) => {
      if (!selection || draft.some((folder) => folder.relativePath === selection.relativePath)) return;
      setDraft((current) => [...current, {
        path: selection.path,
        relativePath: selection.relativePath,
        primary: current.length === 0,
      }]);
    },
  });
  const move = (index: number, direction: -1 | 1) => setDraft((current) => {
    const next = [...current];
    const destination = index + direction;
    if (destination < 0 || destination >= next.length) return current;
    [next[index], next[destination]] = [next[destination]!, next[index]!];
    return next;
  });
  if (!canAdminister) return null;
  return <section className="rounded-lg border border-[var(--border)] bg-[var(--bg)] p-4" aria-label="Working folders">
    <h3 className="text-xs font-medium">Working folders</h3>
    <p className="mt-1 text-[11px] leading-4 text-[var(--muted)]">
      {folders.data?.inheritedFromWorkspace ? "Inherited from Workspace. Primary: Workspace source." : "All agents in this Conversation share these folders. Changes apply to new sessions."}
    </p>
    <p className="mt-2 text-[11px] leading-4 text-[var(--muted)]">Working folders guide where agents should work. They are not a filesystem sandbox.</p>
    <div className="mt-3 space-y-2">
      {folders.isError ? <div className="text-xs text-[var(--danger)]">Could not load working folders. <button type="button" className="underline" onClick={() => void folders.refetch()}>Retry</button></div> : null}
      {draft.map((folder, index) => <div key={folder.path ?? folder.relativePath} className="flex flex-wrap items-center gap-2 text-xs">
        <span className="min-w-0 flex-1 truncate font-mono">{folder.relativePath}</span>
        {folder.primary ? <span className="text-[10px] text-[var(--success)]">Primary</span> : <button className="button-secondary" type="button" onClick={() => setDraft((current) => current.map((item, itemIndex) => ({ ...item, primary: itemIndex === index })))}>Make primary</button>}
        <button className="button-secondary" type="button" disabled={index === 0} onClick={() => move(index, -1)}>Up</button>
        <button className="button-secondary" type="button" disabled={index === draft.length - 1} onClick={() => move(index, 1)}>Down</button>
        <button className="button-secondary" type="button" onClick={() => setDraft((current) => current.filter((_, itemIndex) => itemIndex !== index))}>Remove</button>
      </div>)}
    </div>
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <button className="button-secondary" type="button" disabled={!folders.data || select.isPending || draft.length >= 16} onClick={() => select.mutate()}>{select.isPending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <FolderOpen className="h-3.5 w-3.5" />} Add folder</button>
      <button className="button-primary" type="button" disabled={!folders.data || folders.isError || save.isPending || folders.isPending || (draft.length > 0 && !draft.some((folder) => folder.primary))} onClick={() => save.mutate()}>{save.isPending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : null} Save</button>
      {select.error ? <span className="text-xs text-[var(--danger)]">{select.error.message}</span> : null}
      {save.error ? <span className="text-xs text-[var(--danger)]">{save.error.message}</span> : null}
    </div>
  </section>;
}
