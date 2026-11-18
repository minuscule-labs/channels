import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { conversations, localControl } from "../lib/api";
import { activityKey } from "../lib/inbox";
import { queryKeys } from "../lib/query-keys";

export function ActivityPage() {
  const session = useQuery({ queryKey: queryKeys.localCurrentSession(), queryFn: () => localControl.currentSession(), retry: false });
  const identityId = session.data?.identityId;
  const activity = useInfiniteQuery({
    queryKey: activityKey(identityId), enabled: Boolean(identityId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => conversations.listActivity(pageParam),
    getNextPageParam: page => page.nextCursor,
    refetchOnWindowFocus: "always", refetchOnReconnect: "always", refetchInterval: 30_000, retry: false,
  });
  const items = [...new Map((activity.data?.pages.flatMap(page => page.items) ?? []).map(item => [item.id, item])).values()];
  return <section className="minu-scroll h-full overflow-y-auto p-5" aria-labelledby="activity-heading">
    <h1 id="activity-heading" className="mb-5 text-xl font-semibold">Activity</h1>
    {session.isError || activity.isError ? <div role="alert">
      <p>Unable to load Activity.</p>
      <button className="button-secondary" onClick={() => void (session.isError ? session.refetch() : activity.refetch())}>Retry</button>
    </div> : session.isPending || activity.isPending ? <p role="status">Loading Activity…</p> : <>
      {!items.length ? <p className="text-sm text-[var(--muted)]">No activity yet.</p> : <ul className="divide-y divide-[var(--border)]">
        {items.map(item => <li key={item.id} data-activity-id={item.id}>
          <Link to="/app/workspaces/$workspaceId/conversations/$conversationId"
            params={{ workspaceId: item.workspaceId, conversationId: item.conversationId }}
            hash={`message-${item.firstUnreadSequence ?? item.sequence}`}
            className="block rounded p-3 hover:bg-[var(--hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]">
            <div className="flex items-center gap-2 text-sm">
              {item.unread ? <span aria-label="Unread" className="h-2 w-2 shrink-0 rounded-full bg-[var(--accent)]" /> : null}
              <span className={item.unread ? "font-semibold" : ""}>{item.authorName}</span>
              <time dateTime={item.createdAt} className="text-xs text-[var(--muted)]">{new Date(item.createdAt).toLocaleString()}</time>
            </div>
            <p className="mt-1 text-xs text-[var(--muted)]">{item.kind === "mention" ? "Mention" : "Thread reply"} · {item.channelName}{item.threadPreview !== undefined ? ` · ${item.threadPreview || item.conversationName}` : ""}</p>
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">{item.preview}</p>
          </Link>
        </li>)}
      </ul>}
      {activity.hasNextPage ? <button type="button" className="button-secondary mt-4" disabled={activity.isFetchingNextPage}
        onClick={() => void activity.fetchNextPage()}>Load more</button> : null}
    </>}
  </section>;
}
