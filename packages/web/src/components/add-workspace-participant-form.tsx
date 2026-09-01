import type { Identity, WorkspaceMember } from "@minu/channels-core/types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, LoaderCircle, UserPlus } from "lucide-react";
import { useState } from "react";
import { channels, localControl } from "../lib/api";
import { queryKeys } from "../lib/query-keys";

function suggestedHandle(value: string): string {
  return value.toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

export function AddWorkspaceParticipantForm({
  workspaceId,
  existingMembers,
  onCreated,
}: {
  workspaceId: string;
  existingMembers: WorkspaceMember[];
  onCreated?(identity: Identity, member: WorkspaceMember): void;
}) {
  const queryClient = useQueryClient();
  const [type, setType] = useState<Identity["type"]>("agent");
  const [displayName, setDisplayName] = useState("");
  const [mentionHandle, setMentionHandle] = useState("");
  const [handleCustomized, setHandleCustomized] = useState(false);
  const [roleLabel, setRoleLabel] = useState("");
  const [runtimeAdapter, setRuntimeAdapter] = useState("pi");
  const [personaPrompt, setPersonaPrompt] = useState("");
  const normalizedHandle = mentionHandle.trim().replace(/^@+/, "").toLowerCase();
  const handleValid = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(normalizedHandle);
  const handleAvailable = !existingMembers.some(
    (member) => member.mentionHandle.toLowerCase() === normalizedHandle,
  );
  const executionIdentity = type === "agent" || type === "service";
  const canSubmit = Boolean(
    displayName.trim()
      && handleValid
      && handleAvailable
      && (!executionIdentity || runtimeAdapter.trim()),
  );
  const mutation = useMutation({
    mutationFn: async () => {
      const identity = await channels.createIdentity({
        type,
        displayName: displayName.trim(),
      });
      const member = await channels.addWorkspaceMember(workspaceId, {
        identityId: identity.id,
        mentionHandle: normalizedHandle,
        roleLabel: roleLabel.trim() || undefined,
      });
      let configurationWarning: string | undefined;
      if (executionIdentity) {
        try {
          await localControl.updateWorkspaceAgentConfiguration(workspaceId, identity.id, {
            runtimeAdapter: runtimeAdapter.trim(),
            ...(personaPrompt.trim() ? { personaPrompt: personaPrompt.trim() } : {}),
            status: "active",
          });
        } catch (error) {
          configurationWarning = error instanceof Error ? error.message : "Agent configuration failed";
        }
      }
      return { identity, member, configurationWarning };
    },
    onSuccess: ({ identity, member }) => {
      queryClient.setQueryData<Identity[]>(queryKeys.identities(), (current = []) => [
        ...current.filter(({ id }) => id !== identity.id),
        identity,
      ]);
      queryClient.setQueryData<WorkspaceMember[]>(queryKeys.workspaceMembers(workspaceId), (current = []) => [
        ...current.filter(({ identityId }) => identityId !== member.identityId),
        member,
      ]);
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceConfiguration(workspaceId) });
      onCreated?.(identity, member);
      setDisplayName("");
      setMentionHandle("");
      setHandleCustomized(false);
      setRoleLabel("");
      setRuntimeAdapter("pi");
      setPersonaPrompt("");
      setType("agent");
    },
  });

  return (
    <form
      className="rounded-lg border border-[var(--border)] bg-[var(--bg)] p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit && !mutation.isPending) mutation.mutate();
      }}
    >
      <div className="flex items-start gap-3">
        <UserPlus className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent)]" />
        <div>
          <h2 className="text-sm font-semibold">Create a participant</h2>
          <p className="mt-1 text-xs leading-5 text-[var(--muted)]">
            Add a reusable identity to this Workspace and select it for this Channel.
          </p>
        </div>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="block text-xs font-medium">
          Participant type
          <select
            value={type}
            onChange={(event) => setType(event.target.value as Identity["type"])}
            className="settings-input mt-1.5"
          >
            <option value="agent">Agent</option>
            <option value="human">Human</option>
            <option value="service">Service</option>
          </select>
        </label>
        <label className="block text-xs font-medium">
          Display name
          <input
            value={displayName}
            onChange={(event) => {
              const value = event.target.value;
              setDisplayName(value);
              if (!handleCustomized) setMentionHandle(suggestedHandle(value));
            }}
            maxLength={200}
            placeholder={type === "agent" ? "Reviewer" : "Name"}
            className="settings-input mt-1.5"
          />
        </label>
        <label className="block text-xs font-medium">
          Mention handle
          <div className="relative mt-1.5">
            <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 font-mono text-xs text-[var(--muted)]">@</span>
            <input
              value={mentionHandle}
              onChange={(event) => {
                setHandleCustomized(true);
                setMentionHandle(event.target.value.replace(/^@+/, ""));
              }}
              maxLength={64}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="reviewer"
              className="settings-input pl-7 font-mono"
            />
          </div>
          {mentionHandle && (!handleValid || !handleAvailable) ? (
            <span className="mt-1 block text-[10px] text-[var(--danger)]">
              {handleAvailable ? "Use letters, numbers, underscores, or hyphens." : "That handle is already in use."}
            </span>
          ) : null}
        </label>
        <label className="block text-xs font-medium">
          Public role <span className="font-normal text-[var(--muted)]">(optional)</span>
          <input
            value={roleLabel}
            onChange={(event) => setRoleLabel(event.target.value)}
            maxLength={100}
            placeholder={executionIdentity ? "reviewer" : "member"}
            className="settings-input mt-1.5"
          />
        </label>
      </div>
      {executionIdentity ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="block text-xs font-medium">
            Runtime
            <input
              value={runtimeAdapter}
              onChange={(event) => setRuntimeAdapter(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="pi"
              className="settings-input mt-1.5 font-mono"
            />
          </label>
          <label className="block text-xs font-medium sm:col-span-2">
            Persona <span className="font-normal text-[var(--muted)]">(optional)</span>
            <textarea
              value={personaPrompt}
              onChange={(event) => setPersonaPrompt(event.target.value)}
              rows={4}
              placeholder="Stable instructions for this agent"
              className="settings-input mt-1.5 resize-y leading-5"
            />
          </label>
          <p className="text-[10px] leading-4 text-[var(--muted)] sm:col-span-2">
            Persona and Runtime are restricted Workspace configuration. Saved values are not read back.
          </p>
        </div>
      ) : null}
      <p className="mt-3 text-[10px] leading-4 text-[var(--muted)]">
        Additional humans cannot sign in through the local single-human session yet.
      </p>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        {mutation.error ? <span className="mr-auto text-xs text-[var(--danger)]">{mutation.error.message}</span> : null}
        {mutation.data?.configurationWarning ? (
          <span className="mr-auto text-xs text-[var(--warning)]">
            Participant added, but configuration needs attention: {mutation.data.configurationWarning}
          </span>
        ) : null}
        {mutation.isSuccess && !mutation.data.configurationWarning ? (
          <span className="mr-auto inline-flex items-center gap-1 text-xs text-[var(--success)]">
            <Check className="h-3 w-3" /> Participant created and selected
          </span>
        ) : null}
        <button className="button-primary" type="submit" disabled={!canSubmit || mutation.isPending}>
          {mutation.isPending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <UserPlus className="h-3.5 w-3.5" />}
          Create participant
        </button>
      </div>
    </form>
  );
}
