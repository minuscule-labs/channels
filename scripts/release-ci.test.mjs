import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
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

const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const ciJob = (name) => {
  const block = ci.split(/\n(?=  [a-z][a-z-]*:\n)/).find((part) => part.startsWith(`  ${name}:\n`));
  assert.ok(block, `Missing CI job: ${name}`);
  return block;
};
const jobCondition = (name) => {
  const match = ciJob(name).match(/^    if: \$\{\{ (.+) \}\}$/m);
  assert.ok(match, `Missing condition for CI job: ${name}`);
  return match[1];
};
const evaluateCondition = (condition, eventName, draft, os = "ubuntu-latest") => runInNewContext(condition, {
  github: { event_name: eventName, event: eventName === "pull_request" ? { pull_request: { draft } } : {} },
  matrix: { os },
  always: () => true,
});

test("CI responds to PR readiness changes and cancels superseded PR runs", () => {
  const types = ci.match(/  pull_request:\n    types: \[([^\]]+)\]/)?.[1].split(/,\s*/);
  assert.deepEqual(types, ["opened", "synchronize", "reopened", "ready_for_review", "converted_to_draft"]);
  assert.match(ci, /cancel-in-progress: \$\{\{ github.event_name == 'pull_request' \}\}/);
});

test("all CI jobs skip draft PRs and retain full verification for ready PRs and main", () => {
  const jobs = [...ci.slice(ci.indexOf("\njobs:\n")).matchAll(/^  ([a-z][a-z-]*):\n/gm)].map((match) => match[1]);
  assert.deepEqual(jobs, ["verify", "browser-shards", "browser", "release-package"]);
  assert.match(ciJob("verify"), /- run: pnpm check\n/);
  assert.match(ciJob("verify"), /- run: pnpm test\n        env:/);
  for (const [eventName, draft, expected] of [["pull_request", true, false], ["pull_request", false, true], ["push", undefined, true]]) {
    for (const name of jobs) {
      const condition = jobCondition(name);
      assert.equal(evaluateCondition(condition, eventName, draft), expected, `${name}, ${eventName}, draft=${draft}: ${condition}`);
    }
  }
});

test("web type and unit checks run on Linux only during full verification", () => {
  for (const command of ["web:check", "web:test"]) {
    const condition = ciJob("verify").match(new RegExp(`- run: pnpm ${command}\\n        if: \\$\\{\\{ (.+) \\}\\}`))?.[1];
    assert.ok(condition, `Missing platform condition for ${command}`);
    for (const eventName of ["pull_request", "push"]) {
      assert.equal(evaluateCondition(condition, eventName, false), true);
      assert.equal(evaluateCondition(condition, eventName, false, "macos-latest"), false);
    }
  }
});

test("browser aggregation remains fail-closed for full verification", () => {
  assert.match(jobCondition("browser"), /^always\(\) &&/);
  assert.match(ciJob("browser"), /needs: browser-shards/);
  assert.match(ciJob("browser"), /SHARDS_RESULT: \$\{\{ needs\.browser-shards\.result \}\}/);
  assert.match(ciJob("browser"), /run: test "\$SHARDS_RESULT" = success/);
});

test("browser image matches locked Playwright and avoids OS/browser installation", () => {
  const lockfile = readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");
  const version = lockfile.match(/'@playwright\/test':\n\s+specifier: [^\n]+\n\s+version: ([\d.]+)/)?.[1];
  assert.ok(version, "Missing locked Playwright version");
  assert.ok(ciJob("browser-shards").includes(`image: mcr.microsoft.com/playwright:v${version}-noble`));
  assert.match(ciJob("browser-shards"), /options: --ipc=host/);
  assert.doesNotMatch(ciJob("browser-shards"), /playwright install/);
  assert.match(ciJob("browser-shards"), /shard: \[1, 2, 3\]/);
  const config = readFileSync(new URL("../packages/web/playwright.config.ts", import.meta.url), "utf8");
  assert.match(config, /workers: 1/);
});
