import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "channels-release-guard-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, "repo"), remote = join(directory, "origin.git"), bin = join(directory, "bin");
  mkdirSync(root); mkdirSync(bin); mkdirSync(join(root, "scripts"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--bare", "--initial-branch=main", remote);
  git("init", "--initial-branch=main");
  git("config", "user.name", "Release guard test");
  git("config", "user.email", "release-test@example.invalid");
  git("remote", "add", "origin", remote);
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.2.3", license: "Apache-2.0" }));
  writeFileSync(join(root, "LICENSE"), "Test license\n");
  writeFileSync(join(root, "CHANGELOG.md"), "## 1.2.3\nTest release\n");
  writeFileSync(join(root, "runtime-source.json"), JSON.stringify({ repository: "minuscule-labs/runtime", commit: "b".repeat(40) }));
  copyFileSync(new URL("./release.mjs", import.meta.url), join(root, "scripts/release.mjs"));
  writeFileSync(join(bin, "pnpm"), "#!/bin/sh\necho 'must not rerun source tests or packaging' >&2\nexit 99\n");
  chmodSync(join(bin, "pnpm"), 0o755);
  const commit = (push = true) => {
    git("add", "."); git("commit", "-m", "fixture");
    if (push) git("push", "origin", "main");
  };
  commit();
  const run = (args = ["--dry-run"]) => spawnSync(process.execPath, [join(root, "scripts/release.mjs"), ...args], {
    cwd: root, encoding: "utf8", timeout: 20_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  return { root, remote, bin, git, commit, run };
}
function rejected(result, message) {
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, message);
}

test("metadata dry run requires no pnpm or Runtime checkout and creates no tag", (t) => {
  const f = fixture(t), result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /metadata dry run complete/);
  assert.equal(f.git("tag", "--list"), "");
});

test("clean main creates an annotated tag without rebuilding", (t) => {
  const f = fixture(t), result = f.run([]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.git("cat-file", "-t", "refs/tags/v1.2.3"), "tag");
  assert.equal(f.git("rev-parse", "v1.2.3^{}"), f.git("rev-parse", "HEAD"));
  assert.equal(f.git("ls-remote", "--tags", "origin"), "");
});

test("push uses only the disposable Git remote and preserves the exact tagged commit", (t) => {
  const f = fixture(t), result = f.run(["--push"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(f.git("ls-remote", "--tags", "origin", "refs/tags/v1.2.3^{}"), new RegExp(`^${f.git("rev-parse", "HEAD")}\\s`));
});

test("rejects dirty work without invoking source tests", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "untracked.txt"), "not committed");
  rejected(f.run(), /working tree is not clean/);
});

for (const [name, change, message] of [
  ["missing license", f => rmSync(join(f.root, "LICENSE")), /LICENSE is required/],
  ["missing license metadata", f => writeFileSync(join(f.root, "package.json"), JSON.stringify({ version: "1.2.3" })), /license metadata/],
  ["missing changelog section", f => writeFileSync(join(f.root, "CHANGELOG.md"), "## Unreleased\n"), /missing a 1.2.3 section/],
  ["invalid Runtime pin", f => writeFileSync(join(f.root, "runtime-source.json"), JSON.stringify({ repository: "minuscule-labs/runtime", commit: "short" })), /must pin/],
  ["invalid Runtime repository", f => writeFileSync(join(f.root, "runtime-source.json"), JSON.stringify({ repository: "not-a-repository", commit: "b".repeat(40) })), /must pin/],
]) {
  test(`rejects ${name}`, (t) => {
    const f = fixture(t); change(f); f.commit(); rejected(f.run(), message);
  });
}

test("rejects existing local and remote tags without replacing them", (t) => {
  const f = fixture(t);
  f.git("tag", "-a", "v1.2.3", "-m", "existing");
  const original = f.git("rev-parse", "v1.2.3");
  rejected(f.run(), /already exists locally/);
  f.git("push", "origin", "v1.2.3"); f.git("tag", "-d", "v1.2.3");
  rejected(f.run(), /already exists on origin/);
  assert.match(f.git("ls-remote", "--tags", "origin", "refs/tags/v1.2.3"), new RegExp(`^${original}\\s`));
});

test("rejects committed work ahead of freshly fetched main", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "new.txt"), "not on origin main"); f.commit(false);
  rejected(f.run(), /must exactly match the freshly fetched origin\/main/);
});

test("rejects tag creation from a non-main branch even at the same commit", (t) => {
  const f = fixture(t); f.git("switch", "-c", "feature");
  rejected(f.run([]), /must be created from main/);
  assert.equal(f.git("tag", "--list"), "");
});

test("refuses HEAD movement during the final fetch", (t) => {
  const f = fixture(t);
  const next = f.git("commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "concurrent change");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  writeFileSync(join(f.bin, "git"), `#!/bin/sh\nif [ "$1" = fetch ]; then\n  "${realGit}" update-ref refs/heads/main ${next}\nfi\nexec "${realGit}" "$@"\n`);
  chmodSync(join(f.bin, "git"), 0o755);
  rejected(f.run(), /HEAD changed during release validation/);
});
