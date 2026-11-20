const HARNESSES = [
  { value: "pi", label: "Pi" },
  { value: "codex", label: "Codex" },
  { value: "claude-code", label: "Claude Code" },
] as const;

/** Harness choice. An unset value shows the default (Pi); an unrecognized saved value stays selectable instead of being lost. */
export function HarnessSelect({ value, onChange, disabled, id }: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  id?: string;
}) {
  const current = value.trim() || "pi";
  const known = HARNESSES.some((harness) => harness.value === current);
  return (
    <select
      id={id}
      aria-label="Harness"
      value={current}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled}
      className="settings-input mt-1.5"
    >
      {HARNESSES.map((harness) => <option key={harness.value} value={harness.value}>{harness.label}</option>)}
      {known ? null : <option value={current}>{current}</option>}
    </select>
  );
}
