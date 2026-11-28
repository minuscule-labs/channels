# Agent API key UI verification

Local implementation review completed on 2026-11-28 against released main `57b3b79`. Required combined CI remains a separate gate; the focused runs below are not a full-suite pass.

The Workspace Settings Integrations page follows the Notes key-table/dialog pattern, adapted to explicit Conversation/thread grants and the existing `conversation.inspect` capability. It uses the current human's owner/admin credential routes. No schema, credential authorization, Runtime, dependency or MCP change is included. The sole server addition is optional inspection-URL metadata on the existing authenticated capabilities response, derived from the bound listener.

## Focused checks

Implementation checks, run against disposable fixtures:

- `pnpm exec tsc -b packages/control` — passed after the final control metadata change.
- `node --test packages/control/dist/test/agent-credentials.test.js` — 9/9 passed, including the typed browser-client admin round trip and no automatic mutation retries.
- `node --test --test-name-pattern="capabilities advertise|production daemon round trip" packages/control/dist/test/agent-inspection-http.test.js` — 2/2 selected checks passed. Covers actual bound ports, spoofed Host rejection as an advertised-address source, omission without inspection, IPv6 formatting and authenticated daemon metadata.
- `pnpm web:check` — passed after the final edits.
- `pnpm web:test agent-credentials` — 14/14 passed. Covers targets, expiry, minimal update payloads, preserving concurrent permission reductions, and distinguishing a denied response from proof of a noncommitted write.
- `integrations.spec.ts` — 4/4 passed after the denial/conflict/lazy-catalog fixes. Real SQLite admin routes cover create/copy/edit/rotate/revoke, lost or denied create responses after persistence, and denied rotation after persistence. The lifecycle case passed again after wiring advertised control-URL metadata.
- `sidebar-settings.spec.ts` — 6/6 passed after adding Integrations navigation; later changes did not alter this navigation. The shared fixture's final inspection wiring is left to CI's browser shards.

Browser checks used one worker and isolated ports 59610–59614. Representative command from `packages/web`:

```sh
MINU_TEST_CHANNELS_PORT=59610 MINU_TEST_CONTROL_PORT=59611 \
MINU_TEST_WEB_PORT=59612 MINU_TEST_FIXTURE_PORT=59613 \
MINU_TEST_GATEWAY_PORT=59614 \
pnpm exec playwright test integrations.spec.ts --workers=1
```

## Coordinator integration and visual review

`pnpm web:build` passed on the combined implementation. The built frontend was served by the current compiled source product/control/web servers, with disposable databases, human-only target Conversations and no Runtime sessions/model calls.

The final headless browser check passed: create a key in the UI, read the advertised custom-port inspection URL, call it using only the new bearer key, close the secret dialog, verify no secret remains in browser storage or the URL, revoke through the UI, and verify that the bearer request now returns 401. There were no browser page errors. This checks the complete UI-to-HTTP connection, not live agent behavior or a released package.

Desktop and mobile key-list screenshots, the selected-access dialog, a masked one-time-secret panel, and two accessibility snapshots were captured using the existing Testkit Kit helpers. The secret was explicitly masked; accessibility captures were taken before issuance. Artifact hashes and assertions are retained with the captures outside the source checkout. Captures were visually reviewed and posted to the implementation Conversation. Testkit was used ad hoc; no MinuTest acceptance suite or new test framework was added.

## Limits

- Non-secret unresolved mutation intents survive dialog close and route remount only within the live page. Full refresh loses them; current metadata must be reviewed before a new action. Raw secrets are never journaled or replayed.
- Denied update/revoke orchestration shares the tested classification and review logic, but those two exact browser scenarios were not separately exercised.
- Older servers or failed capability reads retain an explicit `$CONTROL_ORIGIN` fallback.
- Broad backend/web/browser integration and release-package verification belong to required CI. No release or installed-app upgrade is implied by local preview evidence.
