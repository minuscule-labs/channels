import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { checkReleaseCi, successfulMainCiRun } from "./check-release-ci.mjs";

const expected = { repository: "minuscule-labs/channels", sha: "a".repeat(40) };
const run = (overrides = {}) => ({ id: 10, head_sha: expected.sha, head_branch: "main", event: "push",
  path: ".github/workflows/ci.yml", repository: { full_name: expected.repository },
  head_repository: { full_name: expected.repository }, status: "completed", conclusion: "success", ...overrides });

test("accepts successful exact-commit main CI and rejects missing or malformed evidence", () => {
  assert.equal(successfulMainCiRun([run()], expected).id, 10);
  for (const value of [[], undefined, null, {}]) assert.throws(() => successfulMainCiRun(value, expected));
  assert.throws(() => successfulMainCiRun([run({ id: undefined })], expected), /identity/);
});

for (const [description, overrides] of Object.entries({
  "another commit": { head_sha: "b".repeat(40) },
  "another branch": { head_branch: "feature" },
  "a pull request": { event: "pull_request" },
  "a manual workflow": { event: "workflow_dispatch" },
  "another workflow": { path: ".github/workflows/release.yml" },
  "another repository": { repository: { full_name: "someone/channels" } },
  "a fork head": { head_repository: { full_name: "someone/channels" } },
})) {
  test(`rejects a green run belonging to ${description}`, () => {
    assert.throws(() => successfulMainCiRun([run(overrides)], expected), /No main push CI run/);
  });
}

for (const status of ["queued", "in_progress", "waiting"]) {
  test(`fails closed while CI is ${status}`, () => {
    assert.throws(() => successfulMainCiRun([run({ status, conclusion: null })], expected), /must complete successfully/);
  });
}
for (const conclusion of ["failure", "cancelled", "timed_out", "action_required", "neutral", "skipped", null]) {
  test(`fails closed on completed CI with conclusion ${conclusion}`, () => {
    assert.throws(() => successfulMainCiRun([run({ conclusion })], expected), /must complete successfully/);
  });
}

test("does not fall back to an older success when newer matching CI fails or is pending", () => {
  for (const newer of [run({ id: 11, conclusion: "failure" }), run({ id: 11, status: "in_progress", conclusion: null })]) {
    assert.throws(() => successfulMainCiRun([run(), newer], expected), /must complete successfully/);
  }
  assert.equal(successfulMainCiRun([run({ conclusion: "failure" }), run({ id: 11 })], expected).id, 11);
});

test("queries the correct workflow, main push and exact SHA with bounded authenticated HTTP", async () => {
  const result = await checkReleaseCi({ ...expected, token: "test-token", apiUrl: "https://api.github.com", fetcher: async (url, options) => {
    assert.equal(url.origin, "https://api.github.com");
    assert.equal(url.pathname, "/repos/minuscule-labs/channels/actions/workflows/ci.yml/runs");
    assert.equal(url.searchParams.get("head_sha"), expected.sha);
    assert.equal(url.searchParams.get("event"), "push");
    assert.equal(url.searchParams.get("branch"), "main");
    assert.equal(options.headers.authorization, "Bearer test-token");
    assert.ok(options.signal instanceof AbortSignal);
    return { ok: true, json: async () => ({ workflow_runs: [run()] }) };
  } });
  assert.deepEqual(result, { runId: 10, sha: expected.sha });
});

test("rejects missing configuration, HTTP errors, malformed JSON and network failures", async () => {
  for (const overrides of [{ token: "" }, { sha: "short" }, { repository: "not-a-repository" }]) {
    await assert.rejects(checkReleaseCi({ ...expected, token: "test", ...overrides, fetcher: () => assert.fail("must not fetch") }));
  }
  for (const status of [403, 404, 500]) {
    await assert.rejects(checkReleaseCi({ ...expected, token: "test", fetcher: async () => ({ ok: false, status }) }), new RegExp(`HTTP ${status}`));
  }
  await assert.rejects(checkReleaseCi({ ...expected, token: "test", fetcher: async () => ({ ok: true, json: async () => ({}) }) }), /Invalid CI/);
  await assert.rejects(checkReleaseCi({ ...expected, token: "test", fetcher: async () => { throw new Error("network unavailable"); } }), /network unavailable/);
});

test("release workflow gates before installation/build and keeps packaging, draft and token protections", () => {
  const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const gate = workflow.indexOf("run: node scripts/check-release-ci.mjs");
  assert.ok(gate > 0 && gate < workflow.indexOf("run: pnpm install"));
  assert.match(workflow, /actions: read/);
  assert.match(workflow, /GH_TOKEN: \$\{\{ github.token \}\}/);
  assert.doesNotMatch(workflow, /run: pnpm (test|check)\b/);
  for (const command of ["run: pnpm release:pack", "run: pnpm release:smoke", "--verify-tag", "--draft"]) assert.ok(workflow.includes(command));
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.ok(ci.includes("node --test scripts/release*.test.mjs"));
  assert.match(ci, /run: pnpm test/);
  assert.match(ci, /run: pnpm web:test/);
});
