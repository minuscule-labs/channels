import type { Identity, WorkspaceMember } from "@minu/channels-core/types";
import { isReservedMentionHandle } from "@minu/channels-core/mentions";
import { LocalControlClientError } from "@minu/channels-control/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { localControl } from "../lib/api";
import { queryKeys } from "../lib/query-keys";
import { ErrorNotice } from "./ui/error-notice";

const harnessNames: Record<string, string> = { pi: "Pi", codex: "Codex", claude: "Claude Code", "claude-code": "Claude Code" };
const providerNames: Record<string, string> = { openai: "OpenAI", "openai-codex": "OpenAI Codex", anthropic: "Anthropic", google: "Google" };
const reasoningNames: Record<string, string> = { off: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };

export function AddAccountAgentForm({ workspaceId, actorIdentityId, existingMembers, onCreated }: {
  workspaceId: string; actorIdentityId: string; existingMembers: WorkspaceMember[];
  onCreated(identity: Identity): void;
}) {
  const queryClient = useQueryClient();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [templateId, setTemplateId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [mentionHandle, setMentionHandle] = useState("");
  const library = useQuery({ queryKey: ["local", "account-library", actorIdentityId], queryFn: () => localControl.listAccountLibraryItems(), retry: false, gcTime: 0 });
  const templates = library.data?.filter(item => item.kind === "agent-template" && item.state === "active") ?? [];
  const template = templates.find(item => item.id === templateId);
  const handle = mentionHandle.trim().toLowerCase();
  const valid = template && displayName.trim() && /^[a-z0-9][a-z0-9_-]{0,62}$/.test(handle)
    && !isReservedMentionHandle(handle) && !existingMembers.some(member => member.mentionHandle.toLowerCase() === handle);
  const refreshAgents = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.identities() });
    void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceMembers(workspaceId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceConfiguration(workspaceId) });
  };
  const mutation = useMutation({
    retry: false,
    mutationFn: () => localControl.createWorkspaceAgentFromAccountTemplate(workspaceId, {
      templateId: template!.id, expectedTemplateVersion: template!.version, displayName: displayName.trim(), mentionHandle: handle,
    }),
    onSuccess: ({ identity, member }) => {
      queryClient.setQueryData<Identity[]>(queryKeys.identities(), (current = []) => [...current.filter(item => item.id !== identity.id), identity]);
      queryClient.setQueryData<WorkspaceMember[]>(queryKeys.workspaceMembers(workspaceId), (current = []) => [...current.filter(item => item.identityId !== member.identityId), member]);
      refreshAgents();
      if (mounted.current) onCreated(identity);
    },
    onError: refreshAgents,
  });
  const denied = [library.error, mutation.error].some(error => error instanceof LocalControlClientError && [401, 403].includes(error.status));
  if (denied) return <p role="alert">Account agent addition unavailable.</p>;
  const refreshError = library.error ? <div role="alert" className="text-sm text-[var(--danger)]">{library.error.message} <button type="button" className="underline" onClick={() => void library.refetch()}>Reload account agents</button></div> : null;
  if (!library.data) return refreshError ?? <p role="status">Loading account agents…</p>;
  return <form aria-label="Add from account agents" className="space-y-4" onSubmit={event => { event.preventDefault(); if (valid && !mutation.isPending) mutation.mutate(); }}>
    {refreshError}
    <fieldset className="min-w-0 space-y-4" disabled={mutation.isPending}>
      <label className="block text-xs font-medium">Account agent template<select aria-label="Account agent template" className="settings-input mt-1" value={templateId} onChange={event => {
        const selected = templates.find(item => item.id === event.target.value);
        setTemplateId(event.target.value); setDisplayName(selected?.name ?? "");
        const suggested = (selected?.name ?? "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
        setMentionHandle(isReservedMentionHandle(suggested) ? `${suggested}-agent` : suggested);
        mutation.reset();
      }}><option value="">Select an agent template</option>{templates.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label className="block text-xs font-medium">Display name<input required maxLength={200} className="settings-input mt-1" value={displayName} onChange={event => setDisplayName(event.target.value)} /></label>
      <label className="block text-xs font-medium">Mention handle<input required maxLength={63} className="settings-input mt-1 font-mono" value={mentionHandle} onChange={event => setMentionHandle(event.target.value)} /></label>
      {template?.kind === "agent-template" ? <dl aria-label="Template configuration" className="grid grid-cols-2 gap-3 text-sm">
        {[
          ["Harness", harnessNames[template.configuration.runtimeAdapter ?? ""] ?? template.configuration.runtimeAdapter ?? "Default"],
          ["Provider", providerNames[template.configuration.modelProvider ?? ""] ?? template.configuration.modelProvider ?? "Default"],
          ["Model", template.configuration.modelId ?? "Default"],
          ["Reasoning", reasoningNames[template.configuration.reasoningLevel ?? ""] ?? "Default"],
        ].map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-xs text-[var(--muted)]">{label}</dt><dd className="mt-1 break-words">{value}</dd></div>)}
      </dl> : null}
    </fieldset>
    {mutation.error ? <ErrorNotice onDismiss={mutation.reset}>{mutation.error.message} <button type="button" className="underline" onClick={() => void library.refetch()}>Reload account agents</button></ErrorNotice> : null}
    <button type="submit" className="button-primary" disabled={!valid || mutation.isPending}>Add agent</button>
  </form>;
}
