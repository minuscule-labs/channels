# Account workspace presets (M4)

## Delivered scope

Account settings has **Workspace presets** with list/create/edit/archive flows. Presets compose:

- Starter agents by account-template reference, local names/handles, and optional shared account-skill selections.
- Conversation presets assigning those starter-agent keys, plus conversation guidance.
- Workspace instructions and idle-sleep/turn-timeout defaults.

Presets do not contain source folders, credentials, connections, access roles, persona file paths, existing workspace/agent identities, Runtime sessions, or conversation history. Template/skill references must be owned by the authenticated human. Preset content has the account library's stable ID, immutable versions, optimistic save/archive checks, and retirement behavior.

**Add Workspace** (including first-workspace onboarding) can select a preset, load a private preview, and review/customize starter agents, their configuration/skill references, conversation presets, defaults, workspace name, and source folder before creation. The source folder is chosen for this creation only, not stored in the reusable preset. Cancel before submission creates nothing.

Creation makes new independent agent identities/configurations and installs workspace-local ConversationPreset records pointing at those fresh identities. Account skills remain shared references; no skill bodies are copied into presets or workspace configuration. The normal M3 launch boundary resolves their latest versions. Later account-template edits do not update existing composed agents.

A new General Conversation contains only its creating human. Starter agents are not implicitly assigned to it and no sessions are started. The installed conversation presets are available for subsequent explicit conversation setup. The new workspace's intentional creator-owner and starter-agent member roles are minimal creation membership, not copied grants from another workspace. No old workspace permissions, model-access policies, notes-folder assignment, credentials, sessions, transcripts, or conversation history are inherited.

## Private API

Preset CRUD uses `/local/account/library`, kind `workspace-preset`, with `name`, `description`, and this allowlisted definition:

```json
{
  "agents": [{"key":"review","templateId":"<own-template-id>","displayName":"Reviewer","mentionHandle":"reviewer","accountSkillIds":["<own-skill-id>"]}],
  "conversationPresets": [{"name":"Review","agentKeys":["review"],"guidance":"Discuss findings"}],
  "instructions":"Workspace defaults",
  "idleSleepTimeoutMs":900000,
  "turnTimeoutMs":7200000
}
```

```text
GET  /local/account/library/:presetId/preview
POST /local/workspace-compositions
GET  /local/workspace-compositions
GET  /local/workspace-compositions/:requestId
```

Preview resolves the current owned templates and supplies their reviewed versions and reusable configuration. The user can customize the resolved plan before submitting:

```text
{ requestId, slug, name, rootUri, plan: <reviewed/customized preview> }
```

New requests check preset/template versions and all skill references before any public resource creation. Stale sources require explicit re-review; unknown/unsafe fields, foreign sources, invalid references, reserved/duplicate handles, and unsupported defaults are rejected. `you` is reserved for the new workspace's human owner. There are at most 16 starters and 16 conversation presets. Existing HTTP JSON size limits still apply. All endpoints require the authenticated local human browser session and retain the existing origin/CSRF boundary; private responses are no-store.

## Durable partial-failure and retry contract

Creation is **not a distributed transaction**. Before the first Core write, Relay atomically reserves an owner/request-scoped immutable intent containing the request hash, normalized execution plan, timestamp, and all resource IDs. It includes stable workspace, General Conversation, agent/config, instruction-document and conversation-preset identities.

- Identical requests reuse that reservation. Changed payloads with the same request ID return 409, not a new allocation.
- Core creates reconcile missing acknowledgments by reading the preallocated IDs; they do not replay a write with a fresh identity.
- Private workspace/config creation uses insert-if-absent. Instructions and conversation presets use existing atomic creation semantics. Existing resources are compared to the frozen plan, not overwritten; conflicting manual edits stop retry for inspection.
- Concurrent same-intent requests serialize in the host and reconcile the same stable resource identities. SQLite reservation and insert-if-absent protect persistent duplicate creation.
- Pending retries do not re-resolve edited/retired source presets/templates. They finish the frozen reviewed intent. Shared skill contents still resolve independently under M3 when sessions later start; retired skills may therefore need explicit selection changes before launch.
- Completed retries return the existing workspace/Conversation after authorization and do not reapply defaults or overwrite later workspace-local edits.
- Authority is rechecked between creation steps and before completion. There is no automatic deletion, rollback, source rebase, permission escalation, or background mutation retry.

The dialog freezes a submitted preset intent. On uncertainty, **Inspect creation** reads its receipt and **Retry workspace creation** explicitly repeats that intent. Closing/reopening preserves it. Before dispatch, the dialog persists only the opaque request ID under an account-scoped browser key. Reload/remount restores that identity and locks setup even if the receipt is still absent. The private payload stays only in memory or the owned server receipt: after reload, **Inspect creation** (or **Resume …** once the pending receipt is discoverable) must load it before explicit Retry is enabled. Missing receipts leave creation blocked; there is no automatic reset, new ID, or replay. An unavailable/corrupt identity store also fails closed. Loading a receipt is read-only and still requires an explicit Retry to mutate. A receipt 404 never settles an uncertain mutation: the original request may still reserve or commit later. The server explicitly marks known validation rejections with `compositionOutcome: "rejected-before-reservation"`; only this marker on an intent with no prior uncertainty unlocks review. Once any dispatch is uncertain, even a later retry's definitive rejection cannot erase the original uncertainty. Unknown receipt reads keep the intent frozen. Auth denial removes private setup state. No plan bodies or instructions are persisted to browser localStorage.

## Source map

- `packages/relay/src/workspace-presets.ts`: reusable definitions, reviewed plan, private creation intent.
- `packages/relay/src/account-library.ts`: new fixed resource kind using existing immutable version lifecycle.
- `packages/relay/src/binding-store.ts`, `packages/relay-storage-drizzle/src/{schema,storage}.ts`, `0028_workspace_compositions.sql`: reservation, owner-scoped receipts, completion, insert-only config creation.
- `packages/control/src/configuration.ts`: source/reference/default validation, preview, intent reservation and scoped execution serialization.
- `packages/control/src/workspace-composition.ts`: reconciliation and minimal fresh resource creation; never updates existing partial resources.
- `packages/control/src/{contracts,client,server}.ts`: typed private HTTP surface and browser-session response revalidation.
- `packages/web/src/components/{workspace-preset-editor,workspace-preset-fields,workspace-create-dialog,account-library-page}.tsx`, `router.tsx`: management, reviewed customization, frozen retry/inspection/resume UI.
- `packages/web/src/lib/workspace-creation-intent.ts`: account-scoped opaque recovery marker; no private payload persistence.

## Author verification

Target: uncommitted `feat/account-wide-libraries` worktree at `/Users/davidkennedy/Workspaces/minuscule-labs/worktrees/channels/account-wide-libraries`, based on `7b6c07f`, layered on accepted M1–M3. No commit or push made.

- `pnpm exec tsc -b packages/control --pretty false`, `pnpm web:check`, and `pnpm build` — passed.
- Focused backend integration — **44/44 passed** across control `workspace-presets`, `account-library`, `account-agent-templates`, `conversation-presets`, and relay-storage `account-library`, `agent-account-skills`, `storage`. Log: `/tmp/channels-m4-backend-tests.log`.
- The six M4 backend tests cover owned versioned CRUD/retirement, unsafe fields, customized composition, independent agents, no sensitive-state/public-body leakage, shared references, installed channel presets/defaults, M3 launch resolution after source-skill edits, completed retry preserving local edits, concurrent requests, lost acknowledgments, SQLite reopen after partial failure, source retirement after reservation, changed-intent refusal, and refusal to overwrite edited partial resources.
- `pnpm web:build` — passed, with Vite's chunk-size advisory only. Log: `/tmp/channels-m4-web-build.log`.
- Isolated ports 58540–58543, `pnpm web:test:browser workspace-presets.spec.ts account-library.spec.ts account-agent-templates.spec.ts shared-account-skills.spec.ts` — **23/23 passed**, one Chromium worker. Log: `/tmp/channels-m4-browser-tests.log`. Four M4 flows cover account preset CRUD, review/customization, cancel with no mutation, durable partial resume after reload/source retirement, and lost-response inspect/retry without duplicate resources. M1–M3 account UI flows remain passing.
- The fixture's one-shot composition config failure is test-only. It exercises a real partial Core/Relay write, not a mocked successful receipt.
- Early browser checks caught a test reading a summary endpoint as a full body and a real UI retry-validation bug for canonical file-URI receipts. The test now reads the document body endpoint; retry validates/reuses the frozen request instead of requiring its read-only canonical URI to look like a newly typed filesystem path. All affected checks pass after correction.
- Existing historical migration simulations remove the new composition table before replaying earlier migrations; their preservation checks remain passing.
- `git diff --check` — passed.

Full repository CI/regression/release gates and live-provider behavior remain pending. Login/sync, credential management, automatic agent propagation, and upstream skill-copy synchronization remain excluded.

## Coworker rework — delayed reservation after client timeout

Coworker reproduced a duplicate-workspace defect: the dialog treated a receipt 404 after timeout as proof that the creation had not committed, unlocked the draft, and generated a second request ID while the first dispatch was still in flight.

Delta:
- Removed receipt-absence-based unlocking. The original request ID and complete payload remain frozen after transport/timeouts and other uncertain outcomes.
- Added an explicit typed `compositionOutcome: "rejected-before-reservation"` error marker from known pre-reservation validation (including JSON size/parser rejection). Existing records, reservation dispatch failures, and post-reservation failures are never marked this way. It describes the rejected dispatch, not a guarantee that an earlier dispatch cannot commit.
- The dialog tracks prior uncertainty per intent. A later retry's rejection cannot unlock an earlier uncertain intent. A first, known pre-reservation rejection still permits explicit source re-review.
- The browser fixture can hold reservation before its durable write, allowing the real client deadline to expire while the server request continues.

Verification on the delta:
- `pnpm exec tsc -b packages/control --pretty false` and `pnpm web:check` — passed.
- `node --test packages/control/dist/test/workspace-presets.test.js` — **7/7 passed**. New assertions distinguish stale-source/oversize pre-reservation rejection from lost reservation acknowledgment and changed-intent errors after reservation.
- Isolated ports 58540–58543, `pnpm web:test:browser workspace-presets.spec.ts` — **6/6 passed**. The new delayed-reservation regression expires the real client request, observes receipt 404, retries while the first dispatch is held, receives a later definitive rejection after source editing, and confirms that every submission keeps the exact original payload. Releasing the original request produces exactly one workspace; the final explicit retry returns that same workspace. A separate regression confirms that an initial definitive rejection unlocks re-review.
- `pnpm build` (browser prerequisite) and `git diff --check` — passed.

Earlier unaffected M1–M3 and broader M4 evidence above is reused. Changes remain uncommitted. Ready for coworker's delta review; verifier QA remains pending approval. No full integration/release acceptance is claimed.

## Verifier rework — reload before reservation becomes visible

Verifier reproduced a second duplicate-creation path: reload discarded the in-memory intent before its receipt existed, allowing a different ID for the same intended workspace.

Delta (frontend only):
- Persist only the opaque request ID in `minu-channels:workspace-creation-intent:<human identity>` **before** composition dispatch. Names, folders, instructions, agents and private plan bodies are not persisted.
- Reload/remount restores the unresolved identity with prior uncertainty set, freezes setup and disables submission until the owned receipt supplies the frozen server-normalized request. Receipt 404 does not remove the marker or permit a new ID. If a receipt never becomes available, creation stays blocked rather than silently abandoning the original dispatch.
- The dispatch guard also checks existing markers before ordinary workspace creation or composition, preventing another dialog from bypassing unresolved recovery. Marker write/read failures prevent dispatch. Corrupt markers are not silently dropped.
- Completed creation or a known initial pre-reservation rejection removes only its matching marker. Authentication/identity teardown retains the scoped recovery marker while clearing private UI state. Inspecting a pending receipt also preserves its identity before loading the private request into memory.
- No server/storage schema changes, automatic mutation retries, private localStorage bodies, cancellation endpoint or implicit abandonment were added.

Observed checks against this uncommitted delta:
- `pnpm web:check` — passed.
- `pnpm web:test workspace-creation-intent` — **4/4 passed**: identifier-only/account-scoped storage, refusal to replace/clear another intent, unavailable storage, and corrupt markers.
- Isolated ports 58540–58543, `pnpm web:test:browser workspace-presets.spec.ts` — **8/8 passed**. New real-timeout regression reloads while reservation is held, verifies locked setup and the retained ID through receipt 404, confirms private instructions are absent from localStorage, then releases/inspects/resumes to exactly one workspace. Another regression confirms no composition POST is dispatched when identity persistence fails. Existing delayed/rejected-retry, definitive initial rejection, partial receipt resume and lost-response flows remain passing.
- Same ports, `pnpm web:test:browser collaboration.spec.ts --grep 'creates and renames a Workspace with a private source path'` — **1/1 passed**, covering the changed shared success handler's ordinary non-preset creation path.
- `pnpm build` (browser prerequisite) and `git diff --check` — passed.

Backend behavior is unchanged; prior verifier's 45 passing backend checks remain applicable to this frontend-only delta. Broader M1–M3 browser evidence is reused where unchanged. Coworker delta review and verifier revalidation remain pending; full integration/release gates remain deferred. No commit or publication made.
