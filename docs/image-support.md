# Conversation Image Support

**Status:** Stage 1 committed on `feat/local-image-sharing` (`cb5a94a`), reconciled with released main (`4bae1d2`) at `1c6d99f`, and locally verified through full regression and clean-package install/restart checks. See [integration evidence](verification/image-sharing-integrated.json). Reuses the earlier image worktree's storage/API/migration/backup code without replacing current UI files. Image PR CI and independent acceptance remain pending; images have not been merged to main or released. Stage 2 image input is now implemented locally on `feat/conversation-image-vision` with companion Runtime changes; it is controlled-test verified, not genuine-model accepted or released. See [Stage 2 evidence](verification/image-vision-author.json).

## Recommendation

Add image uploads as **structured attachments on Conversation messages**. Keep image bytes outside `messages.body` and outside SQLite; persist only safe attachment metadata and message association in `channels.db`, with the bytes in an owner-private directory under the product data directory. Serve bytes through a stable same-origin Conversation URL. Render only app-owned attachments; continue blocking arbitrary remote Markdown images.

**Stage 2 adds capability-gated image input** without changing Stage 1 sharing. Runtime's text `send`/`startTurn` calls accept optional ordered `RuntimeImageContent` parts; `inputCapabilities` verifies the live adapter/model before Relay fetches bytes. Runtime's normalized message reads remain text-only. No UI claim of universal vision is added.

## What MinuNotes suggests

The useful MinuNotes patterns are:

- Keep binary data out of canonical text; let the application own attachment IDs, metadata, permissions, and stable content URLs. See `MinuNotes/docs/implementation/attachments-and-deployment-storage.md`.
- Separate upload from use: create a pending upload, store the bytes, then finalize only after checking the stored object. MinuNotes implements signed-upload/finalize and a direct-upload fallback in `src/api/routes/attachments.ts` and `src/frontend/lib/api.ts`.
- Validate the bytes, not only the browser-declared MIME type. Its `src/api/attachments/image-validation.ts` permits PNG, JPEG, GIF, and WebP, caps each image at 10 MiB, checks file signatures, and rejects SVG.
- Keep storage keys private behind a narrow object-storage interface (`src/api/storage/object-storage.ts`); filesystem storage guards against path traversal (`filesystem-storage.ts`). MinuNotes uses signed object-storage uploads because it has S3 deployments. Channels can start with local filesystem storage and defer S3 until deployment needs justify it.
- Model pending/ready/deleted states and clean up abandoned or unreferenced uploads (`src/api/attachments/cleanup.ts`). Return stable application URLs instead of bucket paths.
- Resolve only recognized app-owned attachment URLs to the API origin (`src/frontend/lib/resource-urls.ts`), and scope shared-content reads to the exact source resource. Do not turn general Markdown image rendering into unrestricted network loading.

Channels should adopt these boundaries, not copy MinuNotes' user/note/folder schema or its hosted-storage complexity. A chat message is not a mutable note, so structured message attachments are a better fit than inserting image Markdown into `body`.

## Channels-specific constraints

- `ConversationMessage.body` is Markdown; `MessageMarkdown` currently replaces every image with a text placeholder. Raw HTML is skipped and remote images are intentionally not loaded (`packages/web/src/components/message-markdown.tsx`, `docs/web-client-mvp.md`).
- The composer preserves text drafts and idempotency keys across ambiguous send failures (`conversation-composer.tsx`). Attachment references must follow the same retry behavior; image bytes must never go in the draft's `localStorage` value.
- The core message API currently has a 64 KiB body limit, message idempotency, SSE creation events, and text-only context construction. Attachments need to be hydrated consistently in message reads, create responses, and `message.created` events; the binary must not be copied into JSON or SSE.
- The product is local-first. Conversations APIs currently do not provide hosted, per-participant authorization, so image URLs must not claim to be private against a hosted/multi-user threat model. See `docs/product-boundary.md`.

## Stage 1: local sharing

### User flow

1. In an active Conversation, choose an image, paste one from the clipboard, or drop one into the composer. Show an ordered thumbnail/filename queue with remove controls and upload progress; retain the text composer and existing mention/send behavior.
2. Upload each selected image to a server-generated attachment ID. Preview it locally while uploading. Persist only ready attachment metadata in the draft; pending file bytes cannot survive navigation and are never stored in browser storage.
3. Send text plus the ready attachment IDs. Render the images with the resulting message, in attachment order, with alt text/filename, bounded dimensions, lazy loading, and an accessible open-image action.
4. Reloading or navigating away and back must render the same message and images. A failed send preserves the text, selected attachment IDs, and retry key; retry must not upload or create duplicates.

### Contract sketch

```ts
interface MessageAttachment {
  id: string;
  filename: string;
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  size: number;
  altText?: string;
  contentUrl: string; // stable same-origin route; never a filesystem/storage key
}

interface CreateMessageInput {
  // existing fields...
  attachmentIds?: string[];
}

interface ConversationMessage {
  // existing fields...
  attachments: MessageAttachment[]; // [] when there are none
}
```

Implemented endpoints:

```http
POST /conversations/:conversationId/attachments?filename=... # raw raster bytes + image Content-Type; authenticated actor; returns staged metadata
GET  /conversations/:conversationId/attachments/:id/content
POST /conversations/:conversationId/messages           # existing endpoint + attachmentIds
```

Use an internal storage key derived only from generated IDs; never return it to the browser. For local filesystem uploads, enforce size limits while reading the request, write atomically, and set private directory/file permissions. If object storage is later introduced, use a signed-upload plus server-side completion/validation flow like MinuNotes.

### Data and delivery semantics

- Add attachment metadata associated with a Conversation, staged before send and bound to exactly one message after commit. Store `filename`, verified `mimeType`, byte size, content hash, status, timestamps, and an internal storage key. Keep the image bytes outside SQLite.
- In the same write transaction that commits a new message, verify every ID is ready, staged for that Conversation, not already claimed, and within count/aggregate limits; then bind it to the message and persist the idempotency record. Include the ordered attachment IDs in the idempotency fingerprint. A replay with the same key and same payload returns the original message; reusing the key with different text or attachments conflicts.
- Hydrate attachment metadata on history reads and include it in both the successful POST response and SSE event, so the browser does not race a separate metadata request. Content reads must check that the attachment is ready and belongs to the Conversation/message before reading bytes.
- Keep message text unchanged and accessible to agents. In Stage 1, Relay adds a safe filename marker explicitly saying that pixels are unavailable to this Runtime. There is no vision claim or explanatory UI helper text.
- Sweep unclaimed uploads after 24 hours, at startup and every six hours. Cleanup claims metadata as `deleting` before file removal, retains failed deletions for retry, and recovers old orphan/temporary files left by interrupted uploads. Do not delete attached files just because they are not referenced by Markdown; they are owned by their message. When message/Conversation deletion is added, coordinate metadata and file cleanup with retryable deletion rather than assuming a SQL cascade deletes bytes.

### Initial limits and safety defaults

- Images only: PNG, JPEG, GIF, WebP (including animated containers); reject SVG and unknown formats. Verify signatures, container structure/truncation, and claimed MIME on the server. This is not full pixel decoding; decoder-level corruption can still cause the accessible unavailable-image fallback.
- Limits: 10 MiB per image, four images and 20 MiB combined per message. Enforce both client-side for feedback and server-side as authority.
- Normalize display filenames; storage paths use generated IDs, never user filenames. Never expose absolute host paths, object keys, or image bytes in normal API metadata, audit values, or SSE.
- Serve verified raster content with `Content-Type`, `X-Content-Type-Options: nosniff`, and a restrictive CSP/cache policy appropriate to local data. Use same-origin URLs and do not load arbitrary `http(s)` Markdown `img` sources. External links can remain links.
- Attachment bytes are collaboration data, not Relay/Runtime state. Store under the product data directory beside (not inside) the private Relay database, with owner-only permissions, and include the directory in backup/restore, data-path reporting, and dev-data reset behavior.
- Until hosted Conversations authorization exists, keep this explicitly local-only. Before any hosted/multi-user release, require authenticated per-request read/upload checks and revocation semantics for both metadata and content; a random attachment ID is not authorization.

## Delivery phases

1. **Human-visible attachments:** local file storage, upload/finalize API, safe serving, composer picker/paste/drop, retry-safe message association, rendering, cleanup, backup/reset integration, and browser/core tests. Keep remote images blocked.
2. **Agent vision (Stage 2 implemented locally):** optional typed Runtime image input, live adapter/model capability checks, bounded byte delivery and Relay-to-Runtime mapping. Owned Pi workers pass base64 raster parts to native RPC and require the active model to advertise image input. No host paths, browser URL fetches, generic attachments, pixel decoder or new image transform is added. Genuine-model acceptance remains outstanding.
3. **Remote or hosted storage (deferred):** add an object-store adapter and signed upload flow only when Channels has a real deployment requirement; add authenticated sharing/access policy before exposing attachments beyond the local product boundary.

## Acceptance tests to plan

- Valid image uploads render after a full reload and in another open browser session; metadata and bytes remain separate from message text/SSE.
- Spoofed MIME, malformed bytes, SVG, empty files, over-limit images/counts, path-traversal filenames, cross-Conversation IDs, unready IDs, and already-claimed IDs are rejected.
- Upload/send failure, navigation, and retry preserve or clear text and attachment references intentionally; identical retries create one message/association, changed payloads conflict, and abandoned staged uploads are cleaned.
- Remote Markdown images still cause no network request; unrelated URLs, raw HTML, and invalid attachment URLs do not render as images. Missing/deleted content has a safe accessible fallback.
- Desktop/mobile composer behavior, keyboard operation, alt text, progress/error states, read-only/settled Conversations, SSE updates, and latest-message anchoring remain correct.
- Backup/restore and dev reset account for stored bytes, not only `channels.db` and `relay.db`.
- Starting/restarting standalone databases in the same directory cannot sweep each other's attached images, including images older than the staged-expiry cutoff.

## Agreed delivery boundaries

- Stage 1 includes picker, clipboard paste, drag/drop, persisted ready-image drafts and retry payloads, local file storage, rendering, cleanup, migration backup copies, data-path reporting, and existing whole-directory dev reset.
- Production defaults to `~/.minu/channels/attachments/`; `--data-dir` relocates it with both databases. The standalone local database CLI uses `attachments/` beside `channels.db`; other database filenames use `attachments/<database-filename>/` beside their database. Separate databases must not share an orphan sweep: each checks references only in its own metadata. Persistent metadata without a configured content store rejects uploads rather than silently losing bytes on restart.
- Back up and restore the entire stopped product data directory, including `attachments/`. Database-only migration snapshots now also copy attachment files; they are not a general user-facing backup/restore feature.
- External Markdown images, generic files, audio, hosted/object storage, and hosted authorization remain out of scope. Stage 2 uses a separate optional Runtime image contract and live capability checks, not a host path or unauthenticated URL.
- Keep the old `feat/conversation-image-attachments` worktree untouched; it remains an earlier independent draft, not the integration branch.

## Stage 2: bounded agent image input

- Only images attached to messages selected by the existing context budget and Fresh-session sequence floor are candidates. Prefer the trigger/recent context, at most four images and 20 MiB per turn (10 MiB each); preserve chronological message and attachment order in the payload. Pixel tokens are not estimated by the existing text-token heuristic.
- Query the bound Runtime's optional live `inputCapabilities`. Missing, failed, unknown, text-only and attached-TUI capability evidence leaves explicit unavailable-image markers and performs no byte read. Owned Pi checks the currently reachable model's `input` field for `image` and rechecks before dispatch.
- Read bytes through the authenticated Conversation client, using generated IDs and the fixed Conversation content route. Enforce streamed byte limits, exact size/MIME and container validation; never follow metadata URLs or redirects. Network reads have a turn/request deadline. Missing, unreadable, over-budget and excluded images remain honest text markers; successful markers identify the corresponding numbered image part.
- Pass `{ type: "image", mimeType, data }` parts through Runtime's authenticated HTTP transport to native Pi RPC `prompt.images`. Runtime validates canonical base64, allowed MIME, image count and byte limits on both client and bridge. Its JSON transport cap accommodates base64/text escaping; it performs no URL fetch or pixel decoding/resizing.
- Stable turn identity covers text plus ordered image bytes/MIME. Recovery first looks up an accepted Runtime turn and does not refetch pixels or redispatch it. Cancellation and binding-lease loss during pixel loading fence new dispatch. Text-only lifecycle behavior stays unchanged.
- Image parts are not copied into public message bodies, SSE, Relay journals, Runtime turn polling, normalized transcript projections or structured diagnostic events. **Native Pi may persist image parts in its owner-private prompt transcript and send them to the selected provider**, as for other prompts. Resume retains that native context; the Conversation attachment store remains authoritative. No secure erasure or universal provider compatibility is claimed.
- `node scripts/smoke-image-vision.mjs` is the controlled cross-repository check after both builds. It overrides `PI_COMMAND` with a disposable fake executable, exercising Conversation HTTP/SQLite/files → Relay → Runtime HTTP/owned worker → native-shaped Pi RPC, then database reopen and managed suspend/resume. It does not call a model or installed Pi. The release-package CI job runs it against the pinned Runtime.

## Source pointers reviewed

- Channels: `packages/web/src/components/message-markdown.tsx`, `conversation-composer.tsx`; `packages/core/src/types.ts`, `conversation-service.ts`, `http-server.ts`; `packages/storage-drizzle/src/schema.ts`, `storage.ts`; `packages/relay/src/relay.ts`; `docs/product-boundary.md`, `docs/web-client-mvp.md`.
- MinuNotes sibling repository: `docs/implementation/attachments-and-deployment-storage.md`; `src/api/routes/attachments.ts`; `src/api/attachments/image-validation.ts`, `references.ts`, `cleanup.ts`; `src/api/storage/object-storage.ts`, `filesystem-storage.ts`, `s3-storage.ts`; `src/frontend/lib/api.ts`, `resource-urls.ts`, `components/note-editor.tsx`; `tests/attachments.test.ts`, `attachment-references.test.ts`, `attachment-cleanup.test.ts`, and browser note-editor upload tests.
- MinuRuntime: `packages/core/src/{index,input}.ts` defines the additive image-input contract; `packages/pi/src/{client,server,owned-worker}.ts` carries it to native RPC. Normalized `RuntimeMessage.content` stays text-only. Pi's RPC and message-type documentation define `prompt.images` and the active model's `input` capability.
