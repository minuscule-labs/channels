import { useEffect } from "react";
import type { Participant } from "@minu/channels-core/types";
import type { LocalConversationAuthoredSkillCatalog } from "@minu/channels-control/contracts";
import { skillAvailability, type SkillChoice, type SkillPickerEntry } from "../lib/skills";

/** Uses the composer mention-popup pattern; focus stays in the textarea. */
export function SkillPicker({ id, entries, selectedIndex, onHighlight, catalog, loading, error, targets, participants, agents, onSelect }: {
  id: string; entries: SkillPickerEntry[]; selectedIndex: number; onHighlight(index: number): void;
  catalog?: LocalConversationAuthoredSkillCatalog; loading: boolean; error: boolean;
  targets: string[]; participants: Participant[]; agents?: ReadonlyArray<{ identityId: string; state: string }>; onSelect(skill: SkillChoice): void;
}) {
  useEffect(() => { document.getElementById(`${id}-${selectedIndex}`)?.scrollIntoView({ block: "nearest" }); }, [id, selectedIndex]);
  return <div id={id} role="listbox" aria-label="Skill suggestions"
    className="absolute right-0 bottom-[calc(100%+0.5rem)] left-0 z-20 max-h-72 overflow-y-auto rounded-md border border-[var(--border)] bg-[var(--panel-elevated)] p-1 shadow-xl">
    {loading ? <span role="status" className="block px-2.5 py-2 text-sm">Loading…</span> : null}
    {error ? <span role="alert" className="block px-2.5 py-2 text-sm">Catalog unavailable</span> : null}
    {!loading && !error && !entries.length ? <span className="block px-2.5 py-2 text-sm">No skills</span> : null}
    {entries.map((entry, index) => {
      if (!("skill" in entry)) return <button type="button" role="option" aria-selected={false} disabled key={`harness:${entry.identityId}:${entry.commandId}`}
        className="flex w-full items-center justify-between gap-2 rounded px-2.5 py-2 text-left opacity-50">
        <span className="min-w-0 truncate text-sm">{entry.commandId} · {participants.find(p => p.id === entry.identityId)?.displayName ?? entry.identityId}</span>
        <span className="shrink-0 text-xs">Harness · Unavailable</span>
      </button>;
      const { skill } = entry;
      return <button id={`${id}-${index}`} type="button" role="option" tabIndex={-1} aria-selected={index === selectedIndex}
        key={`${skill.source}:${skill.documentId}:${skill.revision}`}
        className={`flex w-full items-center justify-between gap-2 rounded px-2.5 py-2 text-left text-sm ${index === selectedIndex ? "bg-[var(--selected)]" : "hover:bg-[var(--hover)]"}`}
        onMouseDown={event => event.preventDefault()} onMouseMove={() => onHighlight(index)} onClick={() => onSelect(skill)}>
        <span className="min-w-0"><span className="block truncate font-medium">{skill.name}</span><span className="block truncate text-xs text-[var(--muted)]">{skill.description}</span></span>
        <span className="shrink-0 text-xs">{skill.source === "channel" ? "Channel" : "Workspace"} · r{skill.revision} · {skillAvailability(skill, targets, participants, catalog, agents)}</span>
      </button>;
    })}
  </div>;
}
