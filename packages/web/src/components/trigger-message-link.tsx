export function TriggerLink({ sequence, loaded, onView }: { sequence: number; loaded: boolean; onView(sequence: number): void }) {
  return loaded ? <button type="button" className="underline underline-offset-2" onClick={() => onView(sequence)}>View triggering message #{sequence}</button>
    : <p className="text-[var(--muted)]">Triggering message #{sequence} is not in loaded history.</p>;
}
