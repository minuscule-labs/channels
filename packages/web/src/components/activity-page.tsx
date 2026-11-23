import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useLocation, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { conversations, localControl } from "../lib/api";
import { activityKey } from "../lib/inbox";
import { queryKeys } from "../lib/query-keys";

type ActivityView = { key: string; identityId: string; workspaceId: string; pages: number; top: number };

export function ActivityPage() {
  const location = useLocation();
  const scrollRef = useRef<HTMLElement>(null);
  const viewRef = useRef<{ key: string; saved?: ActivityView; restored: boolean } | undefined>(undefined);
  const { workspaceId } = useParams({ from: "/app/workspaces/$workspaceId/activity" });
  const session = useQuery({ queryKey: queryKeys.localCurrentSession(), queryFn: () => localControl.currentSession(), retry: false });
  const identityId = session.data?.identityId;
  const activity = useInfiniteQuery({
    queryKey: [...activityKey(identityId), workspaceId], enabled: Boolean(identityId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => conversations.listActivity(pageParam, workspaceId),
    getNextPageParam: page => page.nextCursor,
    refetchOnWindowFocus: "always", refetchOnReconnect: "always", refetchInterval: 30_000, retry: false,
  });
  const items = [...new Map((activity.data?.pages.flatMap(page => page.items) ?? []).map(item => [item.id, item])).values()];
  // Per-tab history coordinates survive a reload; notification bodies stay in the query cache.
  const historyKey = location.state.__TSR_key ?? location.href;
  const viewKey = `minu-channels:activity-view:${JSON.stringify([historyKey, identityId, workspaceId])}`;
  if (viewRef.current?.key !== viewKey) {
    let saved: Partial<ActivityView> | undefined;
    try { saved = JSON.parse(sessionStorage.getItem(viewKey) ?? "null") ?? undefined; } catch { /* View state is optional. */ }
    const valid = saved?.key === historyKey && saved.identityId === identityId && saved.workspaceId === workspaceId
      && typeof saved.pages === "number" && Number.isSafeInteger(saved.pages) && saved.pages > 0
      && typeof saved.top === "number" && Number.isFinite(saved.top) && saved.top >= 0;
    viewRef.current = { key: viewKey, saved: valid ? saved as ActivityView : undefined, restored: false };
  }
  const pageCount = activity.data?.pages.length ?? 0;
  const needsMore = pageCount < (viewRef.current.saved?.pages ?? 1) && activity.hasNextPage;
  const saveView = useCallback(() => {
    if (!identityId || !scrollRef.current || !session.isSuccess || !activity.isSuccess || needsMore || !viewRef.current?.restored) return;
    try {
      sessionStorage.setItem(viewKey, JSON.stringify({
        key: historyKey, identityId, workspaceId, pages: pageCount, top: scrollRef.current.scrollTop,
      } satisfies ActivityView));
    } catch { /* Unavailable view storage must not block navigation. */ }
  }, [viewKey, historyKey, identityId, workspaceId, pageCount, needsMore, session.isSuccess, activity.isSuccess]);
  useEffect(() => {
    if (needsMore && !activity.isFetching && !activity.isError) void activity.fetchNextPage();
  }, [needsMore, activity.isFetching, activity.isError, activity.fetchNextPage]);
  useLayoutEffect(() => {
    if (!scrollRef.current || !session.isSuccess || !activity.isSuccess || needsMore) return;
    if (!viewRef.current!.restored) {
      scrollRef.current.scrollTop = viewRef.current!.saved?.top ?? 0;
      viewRef.current!.restored = true;
    }
    saveView();
  }, [viewKey, pageCount, needsMore, session.isSuccess, activity.isSuccess, saveView]);
  return <section ref={scrollRef} onScroll={saveView} className="minu-scroll h-full overflow-y-auto p-5" aria-labelledby="activity-heading">
    <h1 id="activity-heading" className="mb-5 pl-9 text-xl font-semibold md:pl-0">Activity</h1>
    {session.isError || activity.isError ? <div role="alert">
      <p>Unable to load Activity.</p>
      <button className="button-secondary" onClick={() => void (session.isError ? session.refetch() : activity.refetch())}>Retry</button>
    </div> : session.isPending || activity.isPending ? <p role="status">Loading Activity…</p> : <>
      {!items.length ? <p className="text-sm text-[var(--muted)]">No activity yet.</p> : <ul className="divide-y divide-[var(--border)]">
        {items.map(item => <li key={item.id} data-activity-id={item.id}>
          <Link onClick={saveView} to="/app/workspaces/$workspaceId/conversations/$conversationId"
            params={{ workspaceId: item.workspaceId, conversationId: item.parentConversationId ?? item.conversationId }}
            search={{ threadId: item.parentConversationId ? item.conversationId : null,
              threadMessage: item.parentConversationId ? item.firstUnreadSequence ?? item.sequence : undefined }}
            hash={item.parentConversationId ? (item.rootSequence ? `message-${item.rootSequence}` : "")
              : `message-${item.firstUnreadSequence ?? item.sequence}`}
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
