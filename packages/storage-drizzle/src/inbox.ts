import type { Client } from "@libsql/client";
import { activityBoundary, activityCursor } from "@minu/channels-core";
import type { ActivityItem, ActivityPage, ActivityView, ConversationUnreadSummary } from "@minu/channels-core";

// Apply current access at read time, including after membership/roster revocation.
const access = `
 JOIN participants p ON p.conversation_id = coalesce(c.parent_conversation_id, c.id) AND p.id = :identity AND p.status = 'active'
 JOIN workspace_members wm ON wm.workspace_id = c.workspace_id AND wm.identity_id = :identity AND wm.status = 'active'
 JOIN identities human ON human.id = :identity AND human.type = 'human' AND human.status = 'active'
 LEFT JOIN human_read_cursors r ON r.conversation_id = c.id AND r.identity_id = :identity`;
const mention = `EXISTS (SELECT 1 FROM json_each(m.targets_json) WHERE value = :identity)`;
const notificationMention = `EXISTS (SELECT 1 FROM json_each(m.targets_json) WHERE value IN (:identity, '@conversation'))`;
const relevant = `m.participant_id != :identity AND (${notificationMention} OR (
 c.parent_conversation_id IS NOT NULL AND (root.participant_id = :identity OR EXISTS (
 SELECT 1 FROM messages previous WHERE previous.conversation_id = c.id
 AND previous.participant_id = :identity AND previous.sequence < m.sequence))))`;
const activityFrom = `FROM messages m JOIN conversations c ON c.id = m.conversation_id ${access}
 LEFT JOIN conversations parent ON parent.id = c.parent_conversation_id
 LEFT JOIN messages root ON root.id = c.root_message_id
 LEFT JOIN identities author ON author.id = m.participant_id`;

export async function listInbox(client: Client, identityId: string): Promise<ConversationUnreadSummary[]> {
  const unread = `m.sequence > coalesce(r.sequence, 0) AND m.participant_id != :identity`;
  const { rows } = await client.execute({ sql: `SELECT c.id, c.workspace_id, c.parent_conversation_id,
    r.sequence AS read_sequence, c.next_sequence - 1 AS latest_sequence,
    sum(CASE WHEN ${unread} THEN 1 ELSE 0 END) AS count,
    sum(CASE WHEN ${unread} AND ${mention} THEN 1 ELSE 0 END) AS mention_count,
    sum(CASE WHEN ${unread} AND ${relevant} THEN 1 ELSE 0 END) AS activity_count,
    min(CASE WHEN ${unread} THEN m.sequence END) AS first_unread
    FROM conversations c ${access} LEFT JOIN messages m ON m.conversation_id = c.id
    AND m.sequence > coalesce(r.sequence, 0) AND m.participant_id != :identity
    LEFT JOIN messages root ON root.id = c.root_message_id GROUP BY c.id`,
    args: { identity: identityId } });
  return rows.map(row => ({ conversationId: String(row.id), workspaceId: String(row.workspace_id),
    parentConversationId: row.parent_conversation_id == null ? undefined : String(row.parent_conversation_id),
    readSequence: row.read_sequence == null ? undefined : Number(row.read_sequence),
    latestSequence: Number(row.latest_sequence), count: Number(row.count), mentionCount: Number(row.mention_count), activityCount: Number(row.activity_count),
    firstUnreadSequence: row.first_unread == null ? undefined : Number(row.first_unread) }));
}

export async function listActivity(client: Client, identityId: string, before?: string, workspaceId?: string, view?: ActivityView): Promise<ActivityPage> {
  const cursor = activityBoundary(before);
  const alias = view === undefined ? "m" : "ranked";
  const boundary = cursor ? `AND (${alias}.created_at, ${alias}.id) < (:beforeTime, :beforeId)` : "";
  const workspaceFilter = workspaceId === undefined ? "" : "AND c.workspace_id = :workspaceId";
  const args = { identity: identityId, ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(cursor ? { beforeId: cursor.id, beforeTime: cursor.createdAt } : {}) };
  const viewFilter = view === "mentions" ? `AND ${notificationMention}` : view === "threads" ? "AND c.parent_conversation_id IS NOT NULL" : "";
  const eligible = `SELECT m.id, m.conversation_id, m.sequence, m.created_at,
    m.participant_id AS author_id, CASE WHEN c.parent_conversation_id IS NULL THEN m.id ELSE c.id END AS group_key,
    substr(m.body, 1, 256) AS preview, c.workspace_id, c.name, coalesce(parent.name, c.name) AS channel_name,
    c.parent_conversation_id, root.sequence AS root_sequence,
    substr(root.body, 1, 256) AS thread_preview, coalesce(author.display_name, m.participant_id) AS author_name,
    ${notificationMention} AS is_mention, m.sequence > coalesce(r.sequence, 0) AS unread,
    (SELECT min(unseen.sequence) FROM messages unseen WHERE unseen.conversation_id = c.id
      AND unseen.sequence > coalesce(r.sequence, 0) AND unseen.participant_id != :identity) AS first_unread
    ${activityFrom} WHERE ${relevant} ${workspaceFilter} ${viewFilter}`;
  // Aggregate complete matching threads before applying keyset pagination. Omitted view retains the flat API.
  const sql = view === undefined ? `${eligible} ${boundary} ORDER BY m.created_at DESC, m.id DESC LIMIT 51` : `
    WITH eligible AS (${eligible}),
    totals AS (SELECT group_key, sum(unread) AS unread_count, count(DISTINCT author_id) AS author_count FROM eligible GROUP BY group_key),
    ranked AS (SELECT eligible.*, row_number() OVER (PARTITION BY group_key ORDER BY created_at DESC, id DESC) AS position FROM eligible)
    SELECT ranked.*, totals.unread_count, totals.author_count FROM ranked JOIN totals ON totals.group_key = ranked.group_key
    WHERE ranked.position = 1 ${boundary} ORDER BY ranked.created_at DESC, ranked.id DESC LIMIT 51`;
  const { rows } = await client.execute({ sql, args });
  const items: ActivityItem[] = rows.slice(0, 50).map(row => ({ id: String(row.id), conversationId: String(row.conversation_id),
    workspaceId: String(row.workspace_id),
    parentConversationId: row.parent_conversation_id == null ? undefined : String(row.parent_conversation_id),
    rootSequence: row.root_sequence == null ? undefined : Number(row.root_sequence), conversationName: String(row.name), channelName: String(row.channel_name),
    threadPreview: row.thread_preview == null ? undefined : String(row.thread_preview), authorName: String(row.author_name),
    preview: String(row.preview), sequence: Number(row.sequence), createdAt: String(row.created_at),
    kind: Number(row.is_mention) ? "mention" : "thread-reply",
    unread: view === undefined ? Boolean(row.unread) : Number(row.unread_count) > 0,
    ...(view === undefined ? {} : { unreadCount: Number(row.unread_count), authorCount: Number(row.author_count) }),
    firstUnreadSequence: row.first_unread == null ? undefined : Number(row.first_unread) }));
  return { items, ...(rows.length > 50 ? { nextCursor: activityCursor(items.at(-1)!) } : {}) };
}
