import { pathToFileURL } from "node:url";

export function successfulMainCiRun(runs, { repository, sha }) {
  if (!Array.isArray(runs)) throw new Error("Invalid CI workflow-run response.");
  const matching = runs.filter((run) => run.head_sha === sha && run.head_branch === "main"
    && run.event === "push" && run.path === ".github/workflows/ci.yml"
    && run.repository?.full_name === repository && run.head_repository?.full_name === repository);
  if (!matching.length) throw new Error("No main push CI run exists for the exact tagged commit.");
  if (matching.some((run) => !Number.isSafeInteger(run.id) || run.id <= 0)) {
    throw new Error("Invalid CI workflow-run identity.");
  }
  const latest = matching.reduce((a, b) => a.id > b.id ? a : b);
  if (latest.status !== "completed" || latest.conclusion !== "success") {
    throw new Error("The latest main CI run for the exact tagged commit must complete successfully. Wait for or fix CI before rerunning the release workflow.");
  }
  return latest;
}

export async function checkReleaseCi({
  repository = process.env.GITHUB_REPOSITORY,
  sha = process.env.GITHUB_SHA,
  token = process.env.GH_TOKEN,
  apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com",
  fetcher = fetch,
} = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(repository ?? "")
    || !/^[a-f0-9]{40}$/.test(sha ?? "") || !token) {
    throw new Error("GITHUB_REPOSITORY, full GITHUB_SHA and GH_TOKEN are required for release CI verification.");
  }
  const url = new URL(`${apiUrl.replace(/\/$/, "")}/repos/${repository}/actions/workflows/ci.yml/runs`);
  url.search = new URLSearchParams({ head_sha: sha, event: "push", branch: "main", per_page: "100" });
  const response = await fetcher(url, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`CI verification request failed with HTTP ${response.status}.`);
  const run = successfulMainCiRun((await response.json()).workflow_runs, { repository, sha });
  return { runId: run.id, sha };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { runId, sha } = await checkReleaseCi();
    console.log(`release: main CI run ${runId} passed for exact tagged commit ${sha}.`);
  } catch (error) {
    console.error(`release: ${error.message}`);
    process.exitCode = 1;
  }
}
