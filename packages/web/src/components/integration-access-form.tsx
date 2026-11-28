import { Plus, X } from "lucide-react";
import { useMemo, useState } from "react";
import {
  addGrant, customExpiryBounds, DEFAULT_EXPIRY_DAYS, EXPIRY_PRESET_DAYS, MAX_EXPIRY_DAYS, searchTargets, setIncludeThreads, targetLabel,
  type AccessDraft, type CredentialTarget, type ExpiryChoice,
} from "../lib/agent-credentials";

export interface TargetCatalogState {
  targets: CredentialTarget[];
  pending: boolean;
  failed: boolean;
}

function expiryValue(choice: ExpiryChoice): string {
  return choice.kind === "keep" ? "keep" : choice.kind === "days" ? String(choice.days) : "date";
}

function dayLabel(days: number, creating: boolean): string {
  const base = `${days} days`;
  if (creating && days === DEFAULT_EXPIRY_DAYS) return `${base} (default)`;
  if (days === MAX_EXPIRY_DAYS) return `${base} (maximum)`;
  return base;
}

export function IntegrationAccessForm({ draft, onChange, catalog, currentExpiresAt, disabled = false }: {
  draft: AccessDraft;
  onChange(next: AccessDraft): void;
  catalog: TargetCatalogState;
  /** Present when editing; the current expiry is kept unless the human explicitly picks another. */
  currentExpiresAt?: string;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const creating = currentExpiresAt === undefined;
  const byId = useMemo(() => new Map(catalog.targets.map(target => [target.id, target])), [catalog.targets]);
  const selectedIds = useMemo(() => new Set(draft.grants.map(grant => grant.conversationId)), [draft.grants]);
  const options = useMemo(() => searchTargets(catalog.targets, query, selectedIds), [catalog.targets, query, selectedIds]);
  const locked = draft.mode === "locked";
  const searchAvailable = !(locked && draft.grants.length >= 1);
  const bounds = customExpiryBounds(Date.now());
  const update = (patch: Partial<AccessDraft>) => onChange({ ...draft, ...patch });

  return <fieldset disabled={disabled} className="min-w-0">
    <legend className="sr-only">Access</legend>
    <div className="mt-4">
      <p className="text-sm font-medium">Scope</p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {(["generic", "locked"] as const).map(mode => <label key={mode} className="flex items-start gap-2 rounded-md border border-[var(--border)] p-3 text-sm">
          <input className="mt-1" type="radio" name="api-key-scope" checked={draft.mode === mode} onChange={() => update({ mode })} />
          <span>
            <span className="block font-medium">{mode === "generic" ? "Specific targets" : "Single target"}</span>
            <span className="text-xs text-[var(--muted)]">{mode === "generic" ? "Selected Conversations and threads." : "Locked to one Conversation or thread."}</span>
          </span>
        </label>)}
      </div>
    </div>

    <div className="mt-4 rounded-md border border-[var(--border)] p-3">
      <p className="text-sm font-medium">Permissions</p>
      <label className="mt-3 flex items-center gap-1.5 text-xs text-[var(--muted)]">
        <input type="checkbox" checked={draft.inspect} onChange={event => update({ inspect: event.target.checked })} />
        Inspect status
      </label>
    </div>

    <div className="mt-4 rounded-md border border-[var(--border)] p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">{locked ? "Single target" : "Specific targets"}</p>
      {searchAvailable ? <>
        <input className="settings-input mt-2" aria-label="Search Conversations and threads" placeholder="Search Conversations and threads…"
          value={query} onChange={event => setQuery(event.target.value)} />
        {catalog.pending ? <p role="status" className="mt-2 text-xs text-[var(--muted)]">Loading Conversations…</p> : null}
        {catalog.failed ? <p role="alert" className="mt-2 text-xs text-[var(--danger)]">Some Conversations or threads couldn’t be loaded. Existing targets are kept.</p> : null}
        {options.length > 0 ? <div className="mt-2 overflow-hidden rounded-md border border-[var(--border)]">
          {options.map(target => <button key={target.id} type="button" aria-label={`Add ${targetLabel(target)}`}
            className="flex w-full items-center justify-between gap-3 border-b border-[var(--border)] px-3 py-2 text-left text-sm last:border-b-0 hover:bg-[var(--hover)]"
            onClick={() => { update({ grants: addGrant(draft.grants, target) }); setQuery(""); }}>
            <span className="min-w-0">
              <span className="block truncate font-medium">{target.kind === "thread" ? target.name : `#${target.name}`}</span>
              <span className="block truncate text-xs text-[var(--muted)]">{target.kind === "thread" ? `Thread in #${target.parentName ?? "Conversation"}` : "Conversation"}</span>
            </span>
            <Plus className="h-4 w-4 shrink-0 text-[var(--muted)]" aria-hidden="true" />
          </button>)}
        </div> : query.trim() && !catalog.pending ? <p className="mt-2 text-xs text-[var(--muted)]">No matching Conversations or threads.</p> : null}
      </> : null}
      <div className="mt-3 space-y-2">
        {draft.grants.map(grant => {
          const target = byId.get(grant.conversationId);
          const label = target ? targetLabel(target) : "Unavailable target";
          return <div key={grant.conversationId} className="rounded-md border border-[var(--border)] px-3 py-2 text-sm" data-testid="api-key-target">
            <div className="flex items-start justify-between gap-3">
              <span className="min-w-0">
                <span className="block truncate font-medium">{target ? (target.kind === "thread" ? target.name : `#${target.name}`) : label}</span>
                <span className="block truncate text-xs text-[var(--muted)]">
                  {target ? (target.kind === "thread" ? `Thread in #${target.parentName ?? "Conversation"}` : "Conversation")
                    : `${catalog.pending ? "Loading" : "Not currently listed"} · ${grant.conversationId}`}
                </span>
              </span>
              <button type="button" className="icon-button inline-flex shrink-0 hover:text-[var(--danger)]" aria-label={`Remove ${label}`}
                onClick={() => update({ grants: draft.grants.filter(item => item.conversationId !== grant.conversationId) })}>
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            {target?.kind === "conversation" || (!target && grant.includeThreads) ? <div className="mt-2 border-t border-[var(--border)] pt-2">
              <label className="flex items-center gap-1.5 text-xs text-[var(--muted)]">
                <input type="checkbox" checked={grant.includeThreads} disabled={!target && !grant.includeThreads}
                  onChange={event => update({ grants: setIncludeThreads(draft.grants, grant.conversationId, event.target.checked, target) })} />
                Include existing and future threads
              </label>
            </div> : null}
          </div>;
        })}
        {draft.grants.length === 0 ? <p className="rounded-md border border-dashed border-[var(--border)] p-3 text-sm text-[var(--muted)]">No targets selected.</p> : null}
      </div>
    </div>

    <div className="mt-4 grid gap-2 sm:grid-cols-2">
      <label className="block text-xs font-medium">Expiry
        <select aria-label="Expiry" className="settings-input mt-1.5" value={expiryValue(draft.expiry)} onChange={event => {
          const value = event.target.value;
          update({ expiry: value === "keep" ? { kind: "keep" } : value === "date" ? { kind: "date", date: bounds.max } : { kind: "days", days: Number(value) } });
        }}>
          {currentExpiresAt ? <option value="keep">Keep {new Date(currentExpiresAt).toLocaleDateString()}</option> : null}
          {EXPIRY_PRESET_DAYS.map(days => <option key={days} value={days}>{creating ? dayLabel(days, true) : `${dayLabel(days, false)} from now`}</option>)}
          <option value="date">Custom date</option>
        </select>
      </label>
      {draft.expiry.kind === "date" ? <label className="block text-xs font-medium">Expires on
        <input type="date" aria-label="Expiry date" className="settings-input mt-1.5" min={bounds.min} max={bounds.max} value={draft.expiry.date}
          onChange={event => update({ expiry: { kind: "date", date: event.target.value } })} />
      </label> : null}
    </div>
  </fieldset>;
}
