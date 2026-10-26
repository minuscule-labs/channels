# Conversation image sharing: continuation checkpoint

Recorded 2026-10-26T15:56:21Z. This is the historical pre-commit checkpoint; Stage 1 was uncommitted and unreleased at that point. For subsequent commits, reconciliation with main and clean-package verification, see [integration evidence](image-sharing-integrated.json).

## Scope and target

- Images attached to channel/Conversation messages: picker/paste/drop, optional text, ordered images, history/live rendering, durable local storage and retry-safe sends.
- No public links, anonymous access, hosted/multi-user service, generic files, audio, external Markdown images or Stage 2 agent vision. Relay's text marker explicitly says pixels are unavailable.
- Reviewed target: tracked working-tree diff against `cd8b08afd9f2eddabb6a4ef25bbe308975a14bd0` plus the image source/tests/migration/docs that were untracked at handoff. Branch: `feat/local-image-sharing`.
- Existing implementation was preserved, not restarted or replaced with the older draft. No other worktree was modified. No files were staged; no commit, push, publication, installed-app update or real-agent operation occurred.
- Guidance: global AGENTS.md, code-review and risk-based-verification skills, `docs/image-support.md`, product-boundary documentation, existing tests and CI configuration.

## Review result

One HIGH data-loss defect was reproduced and fixed. No other actionable defect was identified in this review; this is not independent validation or integration/release approval.

**Standalone databases shared an orphan sweep.** `packages/storage-drizzle/src/cli.ts` previously selected the same sibling `attachments/` directory for every database filename. Starting `other.db` beside `channels.db` deleted the latter's attached image bytes once their modification time was older than 24 hours, because the new database had no matching metadata.

The actual-process regression first failed with ENOENT when checking the first database's image immediately after starting the second database. The fix preserves the product-compatible `channels.db` → `attachments/` layout and isolates other filenames under `attachments/<database-filename>/`. Orphan cleanup ignores directories, so the product/default database does not sweep these nested stores. The regression now ages attached images from both databases and verifies history and exact content bytes after both restart. The earlier restart/orphan-recovery case remains covered.

Reviewed boundaries included image validation and private filesystem storage; HTTP actor/proxy/content serving; database migration, metadata hydration and transactional claims/idempotency; draft persistence, navigation keying, send retry and image rendering; Relay's text-only envelope; cleanup, migration backup and packaging inputs. Container validation remains intentionally short of full pixel decoding.

## Observed checks

- Before edits: `pnpm check` and focused core/Drizzle/standalone attachment tests — 11 passed.
- Added regression before the fix: `pnpm check && node --test packages/storage-drizzle/dist/test/attachment-cli.test.js` — restart case passed; cross-database image-preservation case failed with ENOENT, reproducing deletion.
- After the fix: `pnpm check && node --test packages/core/dist/test/attachments.test.js packages/storage-drizzle/dist/test/attachments.test.js packages/storage-drizzle/dist/test/attachment-cli.test.js packages/storage-drizzle/dist/test/storage.test.js && git diff --check` — 23 tests passed; type/build and whitespace checks passed.
- `pnpm web:check` — passed.
- `pnpm --filter @minu/channels-web exec vitest run test/image-attachments.test.tsx` — 3 passed.
- `pnpm --filter @minu/channels-web exec playwright test test-browser/image-attachments.spec.ts` — 2 Chromium tests passed against disposable fixture services. Covers lost responses after real commit, exact retry key/payload across reload, no duplicate upload, image-only messages, another tab, missing-image fallback, mobile paste/drop/removal, blocked external images and settled composer.
- After the final test-helper idempotent-close adjustment: `pnpm check && node --test packages/storage-drizzle/dist/test/attachment-cli.test.js && git diff --check` — 2 passed; type/build and whitespace checks passed.

Final delta SHA-256:

- `packages/storage-drizzle/src/cli.ts`: `02540fc966a8364f3ae82c410bb8f0d1fdeddd7f246cda26da52dc43b24c6992`
- `packages/storage-drizzle/test/attachment-cli.test.ts`: `5bc692815e0af1270984c9e34b2251419eecd0256a6d01f2015b94e5e83526be`

The historical broad author results in `image-sharing-author.json` are retained, not relabeled as new passes: 296 backend tests, 160 web tests, 113 Chromium tests and web production build. This continuation changed only standalone CLI path selection, its tests and image documentation. Broad UI/product regression was not repeated for that isolated delta.

## Released main and next integration steps

Read-only `git ls-remote` and GitHub compare inspection confirmed remote main at `4bae1d25403e71d5cd79232ed2d6e1087de29247`. Its changes from this branch's HEAD are confined to `package.json` (0.0.16), `CHANGELOG.md`, `README.md`, `docs/message-delivery-diagnostics.md` and new `docs/releases/v0.0.16.md`. There is no image source-file overlap. Local `origin/main` is stale at `cd8b08a`; the release-preparation commit is not in the local object database. No fetch/merge/reset/stash was performed on the dirty checkout.

v0.0.16 is published and includes the earlier Bell fifth sound changes, but contains no image support. Publication did not update or restart the installed app. The older author evidence's `releasePublished: false` is historical diagnostics status.

Next safe action: obtain approval to commit the bounded image feature, then fetch/reconcile released main without losing its version/documentation changes. Run the required image PR CI and clean-source package verification against that integrated target. Clean-package verification is deferred rather than bypassing the dirty-source release guard. Independent review, genuine-agent/installed-artifact acceptance and publication remain separate and unclaimed; do not start real agents or publish without scoped approval.

Pending upload bytes still cannot survive navigation; only completed metadata persists, and abandoned ready drafts expire after 24 hours. The older `conversation-image-attachments` worktree remains untouched. The lasting specification and original author evidence are `docs/image-support.md` and `docs/verification/image-sharing-author.json`; this checkpoint records the subsequent fix and current integration boundary without depending on the temporary handoff file.
