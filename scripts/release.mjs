#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = metadata.version;
const tag = `v${version}`;
const argumentsSet = new Set(process.argv.slice(2));
const push = argumentsSet.has("--push");
const dryRun = argumentsSet.has("--dry-run");

function run(command, args, capture = false) {
  return execFileSync(command, args, {
    cwd: root,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: capture ? "utf8" : undefined,
  });
}

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

function tagExists(reference) {
  try {
    run("git", ["rev-parse", "-q", "--verify", reference], true);
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`unsupported package version: ${version}`);
if (run("git", ["status", "--porcelain", "--untracked-files=all"], true).trim()) {
  fail("working tree is not clean. Commit or stash changes before tagging a release.");
}
if (tagExists(`refs/tags/${tag}`)) fail(`tag ${tag} already exists locally.`);
const remoteTags = run("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`], true).trim();
if (remoteTags) fail(`tag ${tag} already exists on origin.`);
if (!existsSync(join(root, "LICENSE"))) fail("LICENSE is required before the first public release.");
if (typeof metadata.license !== "string" || !metadata.license) fail("package.json license metadata is required.");
const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
if (!changelog.includes(`## ${version}`)) fail(`CHANGELOG.md is missing a ${version} section.`);

const branch = run("git", ["branch", "--show-current"], true).trim();
console.log(`release: validating ${tag} from ${branch || "detached HEAD"}`);
run("pnpm", ["release:check"]);

if (dryRun) {
  console.log(`release: dry run complete. ${tag} was not created.`);
  process.exit(0);
}
if (branch !== "main") fail("release tags must be created from main.");
const head = run("git", ["rev-parse", "HEAD"], true).trim();
const originMain = run("git", ["rev-parse", "origin/main"], true).trim();
if (head !== originMain) fail("main must exactly match origin/main before tagging.");

run("git", ["tag", "-a", tag, "-m", `MinuChannels ${tag}`]);
if (push) {
  run("git", ["push", "origin", "main"]);
  run("git", ["push", "origin", tag]);
  console.log(`release: pushed ${tag}; GitHub Actions will publish the release artifacts.`);
} else {
  console.log(`release: created ${tag}. Push it with: git push origin ${tag}`);
}
