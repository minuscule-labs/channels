import type { ActivityItem, ActivityView } from "@minu/channels-core";

export function activitySearch(search: Record<string, unknown>): { view?: ActivityView } {
  return search.view === "mentions" || search.view === "threads" ? { view: search.view } : {};
}

/** A refreshed group can move to an earlier page before the old page has refreshed. Keep its newest copy. */
export function uniqueActivityItems(items: ActivityItem[]): ActivityItem[] {
  const groups = new Map<string, ActivityItem>();
  for (const item of items) {
    const key = item.parentConversationId ? item.conversationId : item.id;
    const previous = groups.get(key);
    if (!previous || item.createdAt > previous.createdAt || (item.createdAt === previous.createdAt && item.id > previous.id)) groups.set(key, item);
  }
  return [...groups.values()];
}
