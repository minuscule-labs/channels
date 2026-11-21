# Account libraries (M1)

Account libraries are private Relay data, separate from workspace authored documents. In the current local product, an account is the authenticated **human identity** bound to the browser session. This is not a new login system or a cross-device account service. Workspace owners/admins cannot read another human identity's library.

## Records and boundaries

- `skill`: name, description, Markdown content.
- `agent-template`: name, description, allowlisted configuration: persona prompt, runtime adapter, model provider/id, reasoning level, account skill IDs.
- The server assigns the owner, stable UUID, timestamps and initial version. Clients cannot supply ownership, workspace identities or runtime state.
- Template skill references must point to active skills owned by that same account. References remain stable when the skill is edited.
- Template configuration does not accept credentials, access grants, sessions, history, workspace paths, persona file references, or harness/workspace skill IDs. Library operations never create workspace memberships, agents or sessions.
- Every save immediately creates an immutable content version. There is no draft/publication distinction in account libraries. Existing workspace authored documents retain their existing behavior.
- Retirement is archival, not hard deletion: it increments the version and prevents further edits, preserving prior versions for future session/reference consumers. List/read include retired records; consumers must check `state`.

## Local HTTP contract

All routes require a browser session and retain existing local origin/CSRF protection. Owner identity is derived from that session, never URL/body input. Responses use `Cache-Control: no-store`.

```text
GET   /local/account/library
POST  /local/account/library
GET   /local/account/library/:itemId
PATCH /local/account/library/:itemId
GET   /local/account/library/:itemId/versions
```

Create a skill:

```json
{"kind":"skill","name":"Review","description":"Review a change","content":"Read the diff"}
```

Create a template:

```json
{"kind":"agent-template","name":"Reviewer","description":"A reviewer","configuration":{"personaPrompt":"Review carefully","runtimeAdapter":"pi","accountSkillIds":[]}}
```

Save requires complete replacement content of the same kind, plus a concurrency token:

```json
{"action":"save","expectedVersion":1,"content":{"kind":"skill","name":"Review","description":"Review a change","content":"Updated instructions"}}
```

Retire with `{"action":"archive","expectedVersion":2}`. Stale writes or edits to archived items return 409; foreign/missing item IDs return the same 404. Invalid fields/content return 400. No automatic retries, especially after uncertain creates. LocalControlClient exposes typed methods for each route.

## Delivery scope

Implemented here: models, in-memory/SQLite storage, additive migration, immutable versions, owner checks, HTTP routes, typed client APIs, and account settings list/create/edit/archive flows.

Open **Account settings** from the main navigation (or the first-workspace dialog before any workspaces exist). Its Agent templates and Skills tabs each provide a metadata-only list and separate editors. Template forms expose the reusable configuration allowlist and account skill selection, without workspace permissions or runtime state. Failed/stale saves retain local drafts. Review latest explicitly loads the current saved version; Use latest replaces the draft, while Keep my edits adopts the reviewed token without changing the local draft. Retired records disappear from active lists; immutable history remains stored. Drafts and library content are not persisted in browser localStorage.

This document records M1. Workspace agent instantiation is now implemented separately in [M2: account agent templates](account-agent-templates.md). [Shared-skill selection/session snapshots and independent copies (M3)](shared-account-skills.md) have been accepted after review/QA. [Workspace presets (M4)](workspace-presets.md) are now implemented, pending independent review/QA.

The intended follow-on behavior remains: agents are copied on add; skills are shared references resolved for new/replacement sessions, with running snapshots unchanged. Account-library versions provide immutable source material but do not themselves implement session snapshots.

## Focused verification

```sh
pnpm exec tsc -b packages/control --pretty false
node --test packages/control/dist/test/account-library.test.js packages/relay-storage-drizzle/dist/test/account-library.test.js
```

Tests exercise real HTTP/browser-session authorization, owner isolation, input allowlists, identity stability, CAS, retirement, in-memory/SQLite parity, competing writers, transaction rollback, migration preservation, and reopen persistence. Browser tests cover actual typed API wiring through the existing in-memory fixture server; durable SQLite behavior is covered by backend tests. Full regression and release gates remain for integrated delivery.

Author verification on the uncommitted backend patch based on `7b6c07f` (`feat/account-wide-libraries`):

- `pnpm exec tsc -b packages/control --pretty false` — passed.
- Five affected test files (control account-library/authored-documents; relay-storage account-library/authored-documents/storage) — initial run 81 passed, one new rollback assertion failed because Drizzle wraps the injected SQLite error in `cause`. Updated only the assertion to inspect that cause; reran the affected storage account-library file — 4/4 passed, including rollback. Other passing evidence remains applicable; production code did not change after that run.
- `git diff --check` — passed.

## M1 UI completion verification

Target: same uncommitted worktree, `feat/account-wide-libraries`, based on `7b6c07f`. Backend source is unchanged since the checks above, so that backend evidence is reused.

- `pnpm web:check` — passed.
- `pnpm web:build` — passed (Vite reports its >500 kB chunk-size advisory; no build errors).
- `pnpm build` — passed as part of the browser command.
- `MINU_TEST_CHANNELS_PORT=58540 MINU_TEST_CONTROL_PORT=58541 MINU_TEST_WEB_PORT=58542 MINU_TEST_FIXTURE_PORT=58543 pnpm web:test:browser account-library.spec.ts` — **7/7 passed** on the final UI patch, one Chromium worker. Covers both CRUD flows, reload, immutable identity/version behavior, template configuration and skill selection, failed/stale saves and explicit review, archive from list/editor, late create after Cancel, member-vs-owner isolation, denied-write teardown, and mobile/no-workspace access.
- Same isolated ports, `pnpm web:test:browser account-library.spec.ts sidebar-settings.spec.ts --grep 'before the first workspace|sidebar Settings actions'` — desktop/mobile sidebar settings regressions **2/2 passed**. The new no-workspace test initially exposed the onboarding modal hiding the entry link; the link was moved into that modal and the new test subsequently passed, including the final 7-test run.
- Early browser failures exposed ambiguous exact label targeting and a test-only `.localhost` DNS lookup; explicit control labels and the fixture's established loopback route-fetch pattern fixed them. Mobile screenshot inspection also caught title/navigation overlap; matching the existing settings-page top inset fixed it, with a bounding-box regression assertion now passing.
- `git diff --check` — passed.

M1 implementation is ready for milestone review, not accepted or release-ready. Changes remain uncommitted and unpublished. M2–M4 have not been started.

## Coworker rework — preserve drafts on failed library refresh

Coworker identified that a non-authorization background library refresh failure replaced the editor with an error view, unmounting and losing local edits. The UI now retains cached library data and the mounted editor while displaying the refresh error alongside it. Initial-load errors without cached data still show the error/reload view. The existing 401/403 access-denied branch still tears down private editor state.

Delta files: `packages/web/src/components/account-library-page.tsx`, `packages/web/test-browser/account-library.spec.ts`, and this record. No backend changes.

- `pnpm web:check` — passed.
- Isolated ports 58540–58543, `pnpm web:test:browser account-library.spec.ts --grep 'refresh failure and reload'` — **2/2 passed**, one Chromium worker. Both skill and agent-template editors preserve unsaved name, description, and instructions through a background 503 and successful Reload library; persisted records remain unchanged. Follow-on refresh responses of 401 (skill) and 403 (template) remove the editor.
- Regression harness explicitly advances the browser clock beyond the shared five-second query freshness window and dispatches visibilitychange on window (where TanStack subscribes). Earlier harness attempts did not trigger the refresh; these were test-trigger errors, not passing draft-retention evidence.
- `pnpm build` (browser command prerequisite) and `git diff --check` — passed. Prior backend and broader UI evidence above is reused; no new backend/full-suite/build-package cycle was needed for this isolated error-rendering fix.

This library-refresh fix was subsequently approved by coworker. Verifier QA then identified the separate session-refresh issue below; M1 is not yet accepted.

## Verifier rework — preserve drafts on transient session refresh failure

Verifier reproduced draft loss in both editor types when `/local/session` returned 503: the page's session-error branch unmounted the entire account library. The page now renders the session error/Retry alongside the existing library when a cached session identity is available. Initial-load failures without an identity still show only the error. Session 401/403 responses still unmount the library, and the identity-keyed library still remounts when the session identity changes.

Delta files: `packages/web/src/components/account-library-page.tsx`, `packages/web/test-browser/account-library.spec.ts`, and this record. No backend changes.

- `pnpm web:check` — passed.
- Isolated ports 58540–58543, `pnpm web:test:browser account-library.spec.ts --grep 'session-query failure|session identity changes'` — **3/3 passed**, one Chromium worker. Both skill and template drafts retain name, description and instructions across a session 503 and successful Retry, with saved server records unchanged. Follow-on session 401/403 responses remove the editor; a successful session Retry starts with saved content rather than retaining the denied draft. A separate mocked session-identity transition without navigation replaces the old draft with the new identity's editor state (server-side ownership isolation remains covered separately).
- `pnpm build` (browser command prerequisite) and `git diff --check` — passed. Earlier backend/build evidence is reused; no backend or packaging source changed.

The session-refresh delta was subsequently approved by coworker and passed verifier revalidation; Foreman accepted M1 and marked its task Done. Full CI/release gates remain pending. The following M2 implementation and its separate verification record are in [account-agent-templates.md](account-agent-templates.md). Changes remain uncommitted.
