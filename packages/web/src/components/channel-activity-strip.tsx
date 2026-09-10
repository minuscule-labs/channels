import type { LocalChannelAgent } from "@minu/channels-control/contracts";
import type { Participant } from "@minu/channels-core/types";
import { LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { shortId } from "../lib/messages";

function elapsed(startedAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1_000));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

export function activitySummaryItems(
  agents: readonly LocalChannelAgent[],
  participants: readonly Participant[],
  now: number,
): string[] {
  return agents.flatMap((agent) => {
    const activity = agent.activity;
    if (!activity) return [];
    const participant = participants.find(({ id }) => id === agent.identityId);
    const handle = `@${participant?.handle ?? shortId(agent.identityId)}`;
    const phase = activity.phase === "retrying"
      ? `is retrying (attempt ${activity.retryAttempt ?? 1})`
      : activity.phase === "canceling" ? "is canceling" : "is working";
    const queue = activity.queuedTurns > 0
      ? ` · ${activity.queuedTurns} ${activity.queuedTurns === 1 ? "turn" : "turns"} queued`
      : "";
    return [`${handle} ${phase} · ${elapsed(activity.startedAt, now)}${queue}`];
  });
}

export function ChannelActivityStrip({
  agents,
  participants,
}: {
  agents: readonly LocalChannelAgent[];
  participants: readonly Participant[];
}) {
  const active = agents.some(({ activity }) => activity);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [active]);
  const items = useMemo(() => activitySummaryItems(agents, participants, now), [agents, participants, now]);
  if (!items.length) return null;
  return (
    <section className="flex shrink-0 items-start gap-2 border-t border-[var(--border)] bg-[var(--panel)] px-4 py-2 text-xs" aria-label="Channel agent activity">
      <LoaderCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-[var(--accent)]" aria-hidden="true" />
      <ul className="flex min-w-0 flex-wrap gap-x-2 gap-y-1">
        {items.map((item, index) => <li key={agents.filter(({ activity }) => activity)[index]?.identityId ?? item}>{item}</li>)}
      </ul>
    </section>
  );
}
