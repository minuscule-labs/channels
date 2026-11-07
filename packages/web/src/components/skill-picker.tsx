import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import type { Participant } from "@minu/channels-core/types";
import type { LocalConversationAuthoredSkillCatalog } from "@minu/channels-control/contracts";
import { skillAvailability, type SkillChoice } from "../lib/skills";

export function SkillPicker({ open, onOpenChange, initialQuery, catalog, loading, error, targets, participants, agents, onSelect }: {
  open: boolean; onOpenChange(open: boolean): void; initialQuery: string;
  catalog?: LocalConversationAuthoredSkillCatalog; loading: boolean; error: boolean;
  targets: string[]; participants: Participant[]; agents?: ReadonlyArray<{ identityId: string; state: string }>; onSelect(skill: SkillChoice): void;
}) {
  const [query, setQuery] = useState(initialQuery);
  useEffect(() => { if (open) setQuery(initialQuery); }, [open, initialQuery]);
  const search = query.trim().toLowerCase();
  const skills = catalog?.skills.filter(skill => `${skill.name} ${skill.description} ${skill.source}`.toLowerCase().includes(search)) ?? [];
  const harness = catalog?.agents?.flatMap(agent => agent.harness.map(commandId => ({ identityId: agent.identityId, commandId })))
    .filter(skill => `harness ${skill.commandId}`.toLowerCase().includes(search)) ?? [];
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
      <Dialog.Content aria-describedby={undefined} className="fixed top-1/2 left-1/2 z-50 w-[min(32rem,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <Dialog.Title className="font-semibold">Skills</Dialog.Title>
          <Dialog.Close className="icon-button" aria-label="Close skills"><X className="h-4 w-4" /></Dialog.Close>
        </div>
        <input autoFocus aria-label="Search skills" className="settings-input mb-3 w-full" value={query}
          onChange={event => setQuery(event.target.value)} onKeyDown={event => {
            if (event.key === "Enter" && skills[0]) { event.preventDefault(); onSelect(skills[0]); onOpenChange(false); }
          }} />
        {loading ? <span role="status">Loading…</span> : null}
        {error ? <span role="alert">Catalog unavailable</span> : null}
        {!loading && !error && !skills.length && !harness.length ? <span>No skills</span> : null}
        <div role="listbox" aria-label="Skill catalog" className="max-h-80 space-y-1 overflow-y-auto">
          {skills.map(skill => <button type="button" role="option" aria-selected={false} key={`${skill.source}:${skill.documentId}:${skill.revision}`}
            className="flex w-full items-center justify-between gap-2 rounded px-2 py-2 text-left hover:bg-[var(--hover)]"
            onClick={() => { onSelect(skill); onOpenChange(false); }}>
            <span><span className="block text-sm font-medium">{skill.name}</span><span className="block text-xs text-[var(--muted)]">{skill.description}</span></span>
            <span className="text-xs">{skill.source === "channel" ? "Channel" : "Workspace"} · r{skill.revision} · {skillAvailability(skill, targets, participants, catalog, agents)}</span>
          </button>)}
          {harness.map(skill => <button type="button" role="option" aria-selected={false} disabled key={`harness:${skill.identityId}:${skill.commandId}`}
            className="flex w-full items-center justify-between gap-2 rounded px-2 py-2 text-left opacity-50">
            <span className="text-sm">{skill.commandId} · {participants.find(p => p.id === skill.identityId)?.displayName ?? skill.identityId}</span>
            <span className="text-xs">Harness · Unavailable</span>
          </button>)}
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
