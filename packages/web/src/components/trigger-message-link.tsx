export function TriggerLink({ sequence, loaded, onView, kind }: { sequence: number; loaded: boolean; onView(sequence: number): void; kind?: "activation" }) {
  const label = kind === "activation" ? "activation boundary message" : "triggering message";
  return loaded ? <button type="button" className="underline underline-offset-2" onClick={() => onView(sequence)}>View {label} #{sequence}</button>
    : <p className="text-[var(--muted)]">{kind === "activation" ? "Activation boundary message" : "Triggering message"} #{sequence} is not in loaded history.</p>;
}
