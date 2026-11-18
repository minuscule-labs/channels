import type { ConversationSetup } from "@minu/channels-control/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { localControl } from "../lib/api";
import { queryKeys } from "../lib/query-keys";

export function copySetup(setup: ConversationSetup): ConversationSetup {
  return { participants: setup.participants.map((entry) => ({ ...entry })),
    ...(setup.model ? { model: { ...setup.model } } : {}),
    ...(setup.reasoningLevel ? { reasoningLevel: setup.reasoningLevel } : {}),
    ...(setup.guidance ? { guidance: setup.guidance } : {}) };
}

export function ConversationPresetPicker({ workspaceId, onChange }: { workspaceId: string; onChange(setup: ConversationSetup): void }) {
  const [selection, setSelection] = useState("");
  const presets = useQuery({ queryKey: queryKeys.conversationPresets(workspaceId), queryFn: () => localControl.listConversationPresets(workspaceId) });
  return <div>
    <label className="block text-xs font-medium">Preset (optional)
      <select aria-label="Preset (optional)" className="settings-input mt-1.5" value={selection} onChange={(event) => {
        setSelection(event.target.value);
        const preset = presets.data?.presets.find(({ id }) => id === event.target.value);
        onChange(preset ? copySetup(preset) : { participants: [] });
      }}>
        <option value="">Choose participants yourself</option>
        {presets.data?.presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
      </select>
    </label>
    {presets.error ? <p role="alert" className="mt-2 text-xs">Presets couldn’t be loaded. <button type="button" className="underline" onClick={() => void presets.refetch()}>Retry presets</button></p> : null}
  </div>;
}
