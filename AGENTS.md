# Development verification

## Focused by default

- During development, run the affected test file(s), preferably filtered to the changed behavior, plus relevant type checks. Do not run workspace-wide tests, the entire web unit suite, or the full browser suite after every edit or small implementation slice.
- Before testing, briefly identify the changed behavior and the smallest useful check. Broaden only for a concrete shared-contract, security, persistence, dependency/toolchain, packaging, or integration risk; state that reason first.
- Documentation-only changes normally need content/command/link review, not application tests.
- After a fix, rerun the failing or newly affected checks. Do not repeat broad passing suites unless the delta could invalidate their evidence.
- Prefer existing unit/contract coverage for logic. Use browsers for interaction, layout, browser APIs, and actual UI wiring; do not repeat a whole behavior matrix at every layer or across every viewport.
- Do not add full desktop/mobile or layout/action cross-products without a distinct risk. Keep representative layout checks and action-specific checks at the lowest useful layer.

## Integration and release

- Use required CI for broad integration verification once the combined change is ready. Reuse applicable same-target CI results rather than automatically repeating them locally.
- A focused pass is not a full-suite pass. Report what ran and what remains for CI.
- Required merge/release gates still apply. Follow `docs/releasing.md`; do not run `release:check`, tag dry-runs, or packaging smoke as routine development checks.
- Keep browser workers at one per fixture instance. CI shards have separate runners and fixture data; increasing local workers is not a safe shortcut.

## Focused commands

Run these from the repository root, substituting the affected package/file/test name:

```bash
# Backend: compile the affected package and its dependencies, then run one file.
pnpm exec tsc -b packages/control
node --test packages/control/dist/test/agent-actions.test.js
# Narrow one backend file further; Node flags precede the filename.
node --test --test-name-pattern="pending" packages/control/dist/test/agent-actions.test.js

# Web logic: Vitest filename filter, optionally narrowed by test name.
pnpm web:test agent-actions
pnpm web:test agent-actions -t "lost acceptance"
pnpm web:check

# Browser wiring: one spec and, when useful, a title filter.
pnpm web:test:browser participant-sidebar.spec.ts --grep "uncertain participants"
```

No new affected-test framework is required: use explicit files and existing runner filters. Choose checks by behavior/risk, not a target test count.
