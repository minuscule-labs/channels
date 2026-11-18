import { createContext, useContext } from "react";
import type { NotificationSound } from "../lib/conversation-notifications";
export const NotificationPreferencesContext = createContext<{ sound: NotificationSound; onSoundChange(sound: NotificationSound): void } | null>(null);
export function NotificationPreferences() {
  const preferences = useContext(NotificationPreferencesContext);
  if (!preferences) return null;
  return <section aria-label="Notifications" className="rounded-lg border border-[var(--border)] bg-[var(--bg)] p-5">
    <h2 className="text-sm font-semibold">Notifications</h2>
    <p className="mt-1 text-xs text-[var(--muted)]">Your notification preference on this device.</p>
    <label className="mt-4 flex flex-wrap items-center gap-3 text-xs">Notification sound
      <select aria-label="Notification sound" className="settings-input ml-auto max-w-64" value={preferences.sound}
        onChange={(event) => preferences.onSoundChange(event.target.value as NotificationSound)}>
        <option value="off">Off</option><option value="mentions">Mentions and agent replies</option><option value="all">All new messages</option>
      </select>
    </label>
  </section>;
}
