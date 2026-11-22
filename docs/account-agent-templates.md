# Workspace use of account agent templates (M2)

## Behavior

Workspace agent creation now offers **New agent** and **Add from account agents**. The account flow selects an active template owned by the current human, sets a workspace display name/mention handle, and opens the new agent's existing editor after successful addition.

Each addition creates a fresh agent identity, a basic `member` workspace membership, and a separate private agent configuration. The copy includes only inline instructions, runtime adapter, model provider/id, reasoning level, and account skill references. Template descriptions are private library metadata and are not copied to public identity profiles, roles, or membership profiles. There is no link that propagates later template edits into existing agent configurations.

No credentials, persona file references, elevated workspace access, conversation assignments, sessions/bindings, model-access policies, or conversation history are copied or created. The explicitly requested basic workspace membership is necessary to add the new agent; it is not copied from another agent or account.

Account skills are retained in a separate private `accountSkills: { ownerIdentityId, skillIds }` field on the workspace agent configuration. These are references, not skill content copies and not harness skill IDs. They survive local configuration edits and persistence. M2 does **not** resolve or activate them in sessions; that remains M3. Harness skill selection starts empty when the template specifies an adapter, rather than implicitly selecting discovered workspace skills. No shared-skill runtime capability or permission grant is implemented here.

## API and safety boundaries

```text
POST /local/workspaces/:workspaceId/agents/from-account-template
```

```json
{"templateId":"<account-template-id>","expectedTemplateVersion":1,"displayName":"Workspace reviewer","mentionHandle":"reviewer"}
```

The authenticated browser identity must be an active human owner/admin of the destination workspace and own the selected active template. The template's reusable allowlist is revalidated before public resources are created. Retired/foreign templates, unavailable account skill references, invalid/reserved/duplicate handles, missing workspace configuration, and destination-disabled models are rejected before creation. A stale template version returns 409; the UI retains entered fields and offers an explicit reload before the next Add. Template edits made before subsequent reviewed additions affect those additions only.

Only the four request fields above are accepted. Ownership, credentials, access roles, existing target agent IDs, runtime session IDs and configuration overrides cannot be supplied. The response contains the new identity, member, and copied template version, with `Cache-Control: no-store`. Authority is rechecked around source reads and between Core/Relay writes. The HTTP response rechecks the browser session before returning private results.

Core identity/membership and Relay configuration are separate stores, not one distributed transaction. A failure after creation dispatch may leave an identity/member or an unconfigured workspace agent. The API reports this as potentially incomplete, tells the user to inspect workspace agents, and never automatically retries, deletes resources, rolls back memberships, or claims no effect. A demotion stops subsequent authorized steps and withholds results. Clients must not automatically retry uncertain additions; use the existing workspace agent editor to inspect/recover an unconfigured member rather than blindly adding again.

## Implementation scope

- `packages/control/src/{configuration,contracts,client,server}.ts`: owner-authorized creation route and typed client/receipt.
- `packages/relay/src/binding-store.ts`: separate account references on private configs; preserve them through local edits and deep-copy them in the in-memory store.
- `packages/relay-storage-drizzle/src/{schema,storage}.ts` and migration `0026_agent_account_skills.sql`: nullable JSON reference metadata; old configs retain no selection.
- `packages/web/src/components/add-account-agent-form.tsx` and `agent-management-page.tsx`: select/add UI, stale-source handling, existing local editor navigation, guarded late completions. Cached agent-creation forms remain mounted across non-auth parent query errors; denied access removes them.
- M3 session snapshots, workspace skill selection/customization, workspace presets, login/sync, and live upstream propagation remain excluded.

## Author verification

Target: uncommitted `feat/account-wide-libraries` worktree at `/Users/davidkennedy/Workspaces/minuscule-labs/worktrees/channels/account-wide-libraries`, based on `7b6c07f`, layered on accepted M1. No commit or push made.

- `pnpm exec tsc -b packages/control --pretty false` — passed.
- `pnpm web:check` — passed.
- `pnpm web:build` — passed; log `/tmp/channels-account-m2-web-build.log` (Vite chunk-size advisory only).
- Focused backend tests — **25/25 passed** across control `account-agent-templates`/`account-library` and relay-storage `agent-account-skills`/`account-library`/`storage`. Covers real HTTP copy isolation, later source edits, workspace-local edits, owner vs other-account isolation, workspace authority, forbidden fields, stale/archive rejection, sensitive-data exclusion, destination model policy, authority loss during source I/O, partial failure without replay, immutable account versions, reference copy isolation/migration/reopen, and existing storage regressions.
- After strengthening the source-skill-selection isolation assertions, reran control `account-agent-templates` — **5/5 passed**; no production code changed after the 25-test run.
- `MINU_TEST_CHANNELS_PORT=58540 MINU_TEST_CONTROL_PORT=58541 MINU_TEST_WEB_PORT=58542 MINU_TEST_FIXTURE_PORT=58543 pnpm web:test:browser account-agent-templates.spec.ts account-library.spec.ts` — **14/14 passed**, one Chromium worker. Two M2 tests cover real selection/add/edit wiring, independent identities/configs, current-source subsequent additions, reload, and stale-source explicit recovery on mobile; the 12 M1 account-library browser regressions also pass.
- `pnpm build` — passed as the browser prerequisite.
- `git diff --check` — passed.

The initial demotion test used an admin to demote a workspace owner, which Core correctly refused. The fixture now gives the second human owner authority before the demotion probe; the intended pre-creation authorization rejection passes. The pre-M1 migration simulation was updated to remove M2's additive column/marker before replaying migrations, and still passes.

This section records author verification. Coworker subsequently approved M2 and verifier reported QA PASS; Foreman accepted it and marked its task Done. Full CI/regression/release gates remain pending. The following [M3 shared-skill milestone](shared-account-skills.md) implements runtime resolution and independent copies separately.
