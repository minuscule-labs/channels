# Shared account skills and independent workspace copies (M3)

## Delivered behavior

Configured workspace agents have an **Account and workspace skills** section. Account checkboxes select shared references owned by the authenticated human. Workspace checkboxes select active published workspace skills, including explicit independent copies. Saving a selection changes future launch configuration only; it does not mutate account skills, agent templates, running Runtime sessions, or existing session manifests.

Selected procedures are supplied as labeled instruction context in `appendSystemPrompt` when a Runtime is created. Account procedures are not installed as files or mixed into harness-discovered `skillIds`; no Runtime/harness integration, tool access grant, automatic skill execution, or new composer invocation catalog is introduced. Existing authored-skill invocation behavior remains separate.

**Make independent copy** creates a new active/published workspace authored skill and opens its existing editor. Copying does not silently change the agent's selection. After customization, explicitly deselect the account reference, select the workspace copy, and save. The source and copy have distinct stable IDs, independent content/history, and no upstream-update linkage.

## Session boundaries

- First/new sessions capture current selected skill versions and exact hashes before Runtime creation.
- Explicit New session replacements (including Fresh) resolve current selections and latest versions.
- Same-session stop/start resume and host reattachment preserve the original Runtime and its immutable manifest; they do not adopt edits.
- Recovery that must create a replacement Runtime also resolves latest selected skills. It still retains pinned workspace/channel instruction defaults, preserving existing recovery safeguards. Legacy recovery without any selected skills remains legacy rather than adopting newly published workspace instructions.
- Account source retirement prevents new launches that still select it. Running sessions keep their original snapshot; old immutable versions remain resolvable. Deselect or copy/customize deliberately before the next new session.

Private `AuthoredContextSnapshot` has additive optional `accountSkills` references (owner, stable ID, version, hash) and `selectedWorkspaceSkills` IDs. Workspace copies reference the existing immutable authored-publication records in that same manifest. Versions are resolved and hash-validated; missing, corrupt, foreign, duplicate, or ambiguous references fail closed rather than falling back to a newer version. Skill bodies are not stored in public Conversation metadata or browser localStorage.

## API and ownership

The existing agent configuration PATCH endpoint accepts complete replacement arrays:

```json
{"accountSkillIds":["<own-account-skill-id>"],"workspaceSkillIds":["<published-workspace-skill-id>"]}
```

Omitted arrays preserve their selections; empty arrays explicitly clear. Account ownership is assigned from the authenticated human, never a supplied owner ID. Workspace skills must belong to the destination workspace, be active/published, and not be channel-scoped. Destination owner/admin authorization is rechecked after reference I/O and before configuration writes. Authored-selection-only updates do not require harness discovery: they change no harness selection or runtime adapter.

References retained from a template owned by another account remain private and are preserved when only workspace selections are edited. The UI does not enumerate that account's library or expose its skill bodies. Selecting this human's account skills explicitly replaces the account selection; **Clear account skill selection** explicitly clears a foreign-owned selection.

```text
POST /local/workspaces/:workspaceId/account-skills/:skillId/copy
Body: {"expectedVersion":1}
```

Copy requires ownership of the account skill and owner/admin access to the workspace. Stale sources return 409; foreign/retired sources return 404. Unsupported fields are rejected. Copy creates an independent workspace authored document with an atomic initial publication and no credentials, permissions, sessions, or history copied from another resource. Creation is not an idempotent retry API; the UI never automatically replays it after uncertainty. Inspect workspace skills before explicitly creating again after an unknown outcome.

Transient session/library/config query failures retain mounted selection drafts and display errors alongside them. Authentication/authorization failures remove private controls. Failed saves retain selections; stale source copies require explicit reload before copying again.

## Source map

- `packages/relay/src/authored-context.ts`: capture/validate exact selected references and resolve immutable procedure text.
- `packages/control/src/agent-host.ts`: new-session, explicit replacement, and new recovery Runtime launch boundaries.
- `packages/control/src/{configuration,contracts,client,server}.ts`: selection validation, copy authorization/API/client, private selection summaries.
- `packages/relay/src/binding-store.ts`, `packages/relay-storage-drizzle/src/{schema,storage}.ts`, migration `0027_workspace_skill_selection.sql`: preserve local selections and existing account references through persistence and edits.
- `packages/web/src/components/workspace-agent-skills.tsx`, `agent-management-page.tsx`: selection/copy UI and transient-error draft preservation.

Workspace presets, account login/sync, automatic forks, automatic template propagation, and upstream copy synchronization remain excluded.

## Author verification

Target: uncommitted `feat/account-wide-libraries` worktree based on `7b6c07f`, layered on accepted M1/M2. No commit or push made.

- Backend typecheck: `pnpm exec tsc -b packages/control --pretty false` — passed.
- `pnpm web:check` and `pnpm web:build` — passed. Build log: `/tmp/channels-m3-web-build.log` (Vite chunk-size advisory only).
- Focused lifecycle checks initially **5/5 passed**, including memory/SQLite new-session/latest-version resolution, running/resumed snapshot stability, explicit Fresh replacement, new recovery Runtime refresh, independent-copy selection/customization, and unchanged legacy recovery.
- Affected backend integration run: **93 passed, one historical migration fixture failed** across 94 checks. Log: `/tmp/channels-m3-backend-tests.log`. Passing scope includes full agent lifecycle diagnostics, authored context, account template/selection/copy API authorization, authored skill catalog, thread agent integration, account-library/reference migrations, and session inspection. The old-schema fixture tried to seed/read pre-0018 data using the current writer, which now names additive columns absent from that historical schema. Updated only that test to seed/read its historical columns directly and compare their preservation, then use the current decoder after migration. Reran `packages/relay-storage-drizzle/dist/test/authored-documents.test.js` — **11/11 passed**, including that migration. Production code did not change after the 94-check run; unaffected passing evidence is reused.
- `MINU_TEST_CHANNELS_PORT=58540 MINU_TEST_CONTROL_PORT=58541 MINU_TEST_WEB_PORT=58542 MINU_TEST_FIXTURE_PORT=58543 pnpm web:test:browser shared-account-skills.spec.ts account-agent-templates.spec.ts` — **7/7 passed**, one Chromium worker. Five new M3 tests cover selection/copy/edit isolation, persisted selection, transient session/account/config refresh failures, failed saves and stale-copy recovery; two M2 flows remain passing. Browser fixtures exercise actual typed HTTP APIs with in-memory storage; lifecycle/API tests cover durable SQLite boundaries separately.
- `pnpm build` — passed as browser prerequisite.
- `git diff --check` — passed.

This record describes author verification. Coworker subsequently approved M3 and verifier reported QA PASS; Foreman accepted it and marked its task Done. Full repository CI/regression/release gates remain pending. The following [M4 workspace-preset implementation](workspace-presets.md) has its own review/verification record.
