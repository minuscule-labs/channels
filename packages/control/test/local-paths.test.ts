import assert from "node:assert/strict";
import { fork } from "node:child_process";
import fs, { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acquireConversationsDataDirectoryLock,
  prepareConversationsDataDirectory,
  type ProductDirectoryLock,
} from "../src/local-paths.ts";

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

test("a delayed stale-lock inspection cannot reclaim a replacement live owner", { timeout: 5_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "minu-lock-replacement-"));
  const lockPath = join(directory, "run", "instance.lock");
  const ownerPath = join(lockPath, "owner.json");
  const inspected = barrier();
  const resumeInspection = barrier();
  let contender: PromiseSettledResult<ProductDirectoryLock>[] = [];
  let delayed: Promise<PromiseSettledResult<ProductDirectoryLock>[]> | undefined;
  try {
    await prepareConversationsDataDirectory(directory);
    await mkdir(lockPath);
    await writeFile(ownerPath, JSON.stringify({ pid: 999999, token: "stale" }));

    const originalReadFile = fs.readFile;
    let pause = true;
    t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
      const contents = await originalReadFile(...args);
      if (args[0] === ownerPath && pause) {
        pause = false;
        // Keep the old observation pending while another contender replaces the directory.
        inspected.release();
        await resumeInspection.promise;
      }
      return contents;
    });
    syncBuiltinESMExports();

    delayed = Promise.allSettled([acquireConversationsDataDirectoryLock(directory)]);
    await inspected.promise;
    contender = await Promise.allSettled([acquireConversationsDataDirectoryLock(directory)]);
    resumeInspection.release();
    const results = [...await delayed, ...contender];
    const holders = results.filter((result) => result.status === "fulfilled");
    assert.equal(holders.length, 1, "stale-lock recovery must never admit two holders");
    const liveOwner = await readFile(ownerPath, "utf8");
    await assert.rejects(acquireConversationsDataDirectoryLock(directory), /already using data directory/);
    assert.equal(await readFile(ownerPath, "utf8"), liveOwner, "the current owner's marker must remain intact");
  } finally {
    resumeInspection.release();
    const results = await delayed;
    for (const result of [...results ?? [], ...contender]) {
      if (result.status === "fulfilled") await result.value.release();
    }
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a partially initialized marker remains exclusive even after the legacy grace period", { timeout: 5_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "minu-lock-initializing-"));
  const lockPath = join(directory, "run", "instance.lock");
  const writing = barrier();
  const resume = barrier();
  let acquisition: Promise<PromiseSettledResult<ProductDirectoryLock>[]> | undefined;
  try {
    await prepareConversationsDataDirectory(directory);
    const originalWriteFile = fs.writeFile;
    let pause = true;
    t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
      await originalWriteFile(...args);
      if (typeof args[0] === "string" && args[0].startsWith(join(lockPath, ".owner-")) && pause) {
        pause = false;
        writing.release();
        await resume.promise;
      }
    });
    syncBuiltinESMExports();
    acquisition = Promise.allSettled([acquireConversationsDataDirectoryLock(directory)]);
    await writing.promise;
    await utimes(lockPath, new Date(0), new Date(0));
    await assert.rejects(acquireConversationsDataDirectoryLock(directory), /already using data directory/);
    resume.release();
    const [result] = await acquisition;
    assert.equal(result!.status, "fulfilled");
  } finally {
    resume.release();
    for (const result of await acquisition ?? []) {
      if (result.status === "fulfilled") await result.value.release();
    }
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(directory, { recursive: true, force: true });
  }
});

test("exclusion lasts through marker removal, and release never replaces the lock database", { timeout: 5_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "minu-lock-release-"));
  const lockPath = join(directory, "run", "instance.lock");
  const databasePath = join(directory, "run", "instance-lock.sqlite");
  const removed = barrier();
  const resume = barrier();
  let lock: ProductDirectoryLock | undefined;
  let successor: ProductDirectoryLock | undefined;
  let releasing: Promise<void> | undefined;
  try {
    await prepareConversationsDataDirectory(directory);
    lock = await acquireConversationsDataDirectoryLock(directory);
    const originalDatabase = await stat(databasePath);
    assert.equal(originalDatabase.mode & 0o777, 0o600);
    const originalRm = fs.rm;
    let pause = true;
    t.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
      await originalRm(...args);
      if (args[0] === lockPath && pause) {
        pause = false;
        removed.release();
        await resume.promise;
      }
    });
    syncBuiltinESMExports();
    releasing = lock.release();
    await removed.promise;
    await assert.rejects(stat(lockPath), { code: "ENOENT" });
    await assert.rejects(acquireConversationsDataDirectoryLock(directory), /already using data directory/);
    resume.release();
    await releasing;
    successor = await acquireConversationsDataDirectoryLock(directory);
    await lock.release();
    const currentDatabase = await stat(databasePath);
    assert.equal(currentDatabase.ino, originalDatabase.ino);
    assert.equal(currentDatabase.dev, originalDatabase.dev);
    await assert.rejects(acquireConversationsDataDirectoryLock(directory), /already using data directory/);
  } finally {
    resume.release();
    await releasing;
    await lock?.release();
    await successor?.release();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed marker publication releases the database lock and removes its unfinished marker", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "minu-lock-failure-"));
  const lockPath = join(directory, "run", "instance.lock");
  let lock: ProductDirectoryLock | undefined;
  try {
    await prepareConversationsDataDirectory(directory);
    const originalWriteFile = fs.writeFile;
    t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
      if (typeof args[0] === "string" && args[0].startsWith(join(lockPath, ".owner-"))) {
        throw new Error("forced owner publication failure");
      }
      await originalWriteFile(...args);
    });
    syncBuiltinESMExports();
    await assert.rejects(acquireConversationsDataDirectoryLock(directory), /forced owner publication failure/);
    await assert.rejects(stat(lockPath), { code: "ENOENT" });
    t.mock.restoreAll();
    syncBuiltinESMExports();
    lock = await acquireConversationsDataDirectoryLock(directory);
  } finally {
    await lock?.release();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(directory, { recursive: true, force: true });
  }
});

test("live legacy file/directory markers and recent unfinished markers remain protected", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minu-lock-legacy-"));
  const lockPath = join(directory, "run", "instance.lock");
  let lock: ProductDirectoryLock | undefined;
  try {
    await prepareConversationsDataDirectory(directory);
    const owner = JSON.stringify({ pid: process.pid, token: "legacy" });
    await writeFile(lockPath, owner);
    await assert.rejects(acquireConversationsDataDirectoryLock(directory), /already using data directory/);
    assert.equal(await readFile(lockPath, "utf8"), owner);
    await rm(lockPath);
    await mkdir(lockPath);
    await writeFile(join(lockPath, "owner.json"), owner);
    await assert.rejects(acquireConversationsDataDirectoryLock(directory), /already using data directory/);
    assert.equal(await readFile(join(lockPath, "owner.json"), "utf8"), owner);
    await rm(join(lockPath, "owner.json"));
    await assert.rejects(acquireConversationsDataDirectoryLock(directory), /already using data directory/);
    await utimes(lockPath, new Date(0), new Date(0));
    lock = await acquireConversationsDataDirectoryLock(directory);
  } finally {
    await lock?.release();
    await rm(directory, { recursive: true, force: true });
  }
});

test("independent data directories can hold locks concurrently", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minu-lock-independent-"));
  const first = join(directory, "first");
  const second = join(directory, "second");
  const locks: ProductDirectoryLock[] = [];
  try {
    for (const path of [first, second]) {
      await prepareConversationsDataDirectory(path);
      locks.push(await acquireConversationsDataDirectoryLock(path));
    }
    for (const path of [first, second]) {
      await assert.rejects(acquireConversationsDataDirectoryLock(path), /already using data directory/);
    }
  } finally {
    for (const lock of locks) await lock.release();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const redirect of ["symlink", "hardlink", "directory"] as const) {
  test(`refuses a ${redirect} at the lock database path without changing its target`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "minu-lock-redirect-"));
    const databasePath = join(directory, "run", "instance-lock.sqlite");
    const target = join(directory, "target");
    try {
      await prepareConversationsDataDirectory(directory);
      await writeFile(target, "must remain intact", { mode: 0o644 });
      if (redirect === "symlink") await symlink(target, databasePath);
      else if (redirect === "hardlink") await link(target, databasePath);
      else await mkdir(databasePath);
      await assert.rejects(acquireConversationsDataDirectoryLock(directory), /lock database is redirected/);
      assert.equal(await readFile(target, "utf8"), "must remain intact");
      assert.equal((await stat(target)).mode & 0o777, 0o644);
      await rm(databasePath, { recursive: true });
      const lock = await acquireConversationsDataDirectoryLock(directory);
      await lock.release();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}

test("normalizes an existing lock database to owner-only permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minu-lock-permissions-"));
  const databasePath = join(directory, "run", "instance-lock.sqlite");
  let lock: ProductDirectoryLock | undefined;
  try {
    await prepareConversationsDataDirectory(directory);
    await writeFile(databasePath, "");
    await chmod(databasePath, 0o644);
    lock = await acquireConversationsDataDirectoryLock(directory);
    assert.equal((await stat(databasePath)).mode & 0o777, 0o600);
  } finally {
    await lock?.release();
    await rm(directory, { recursive: true, force: true });
  }
});

test("same-process contenders cannot pass unfinished lock-database initialization", { timeout: 5_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "minu-lock-database-init-"));
  const opened = barrier();
  const resume = barrier();
  let first: Promise<PromiseSettledResult<ProductDirectoryLock>[]> | undefined;
  let contender: PromiseSettledResult<ProductDirectoryLock>[] = [];
  try {
    await prepareConversationsDataDirectory(directory);
    const originalOpen = fs.open;
    let pause = true;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (typeof args[0] === "string" && args[0].endsWith("/instance-lock.sqlite") && pause) {
        pause = false;
        opened.release();
        await resume.promise;
      }
      return handle;
    });
    syncBuiltinESMExports();
    first = Promise.allSettled([acquireConversationsDataDirectoryLock(directory)]);
    await opened.promise;
    contender = await Promise.allSettled([acquireConversationsDataDirectoryLock(directory)]);
    assert.equal(contender[0]!.status, "rejected");
    resume.release();
    assert.equal((await first)[0]!.status, "fulfilled");
  } finally {
    resume.release();
    for (const result of [...await first ?? [], ...contender]) {
      if (result.status === "fulfilled") await result.value.release();
    }
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(directory, { recursive: true, force: true });
  }
});

test("data-directory aliases share same-process ownership before filesystem descriptors are opened", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "minu-lock-alias-"));
  const data = join(directory, "data");
  const alias = join(directory, "alias");
  let lock: ProductDirectoryLock | undefined;
  try {
    await prepareConversationsDataDirectory(data);
    await symlink(data, alias);
    lock = await acquireConversationsDataDirectoryLock(data);
    t.mock.method(fs, "open", async () => { throw new Error("unexpected filesystem open for a held database"); });
    syncBuiltinESMExports();
    await assert.rejects(acquireConversationsDataDirectoryLock(alias), /already using data directory/);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await lock?.release();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a corrupt lock database fails closed without changing its contents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minu-lock-corrupt-"));
  const databasePath = join(directory, "run", "instance-lock.sqlite");
  let lock: ProductDirectoryLock | undefined;
  try {
    await prepareConversationsDataDirectory(directory);
    await writeFile(databasePath, "not a SQLite database");
    await assert.rejects(acquireConversationsDataDirectoryLock(directory), /not a database/);
    assert.equal(await readFile(databasePath, "utf8"), "not a SQLite database");
    await rm(databasePath);
    lock = await acquireConversationsDataDirectoryLock(directory);
  } finally {
    await lock?.release();
    await rm(directory, { recursive: true, force: true });
  }
});

type WorkerReply = { type: "ready" | "held" | "rejected" | "released"; message?: string };

function lockWorker(directory: string) {
  const child = fork(new URL("./fixtures/product-lock-worker.js", import.meta.url), [directory], {
    silent: true,
    execArgv: process.execArgv.filter((argument) => argument === "--experimental-sqlite"),
  });
  const queued: WorkerReply[] = [];
  const waiting: Array<{ resolve(value: WorkerReply): void; reject(error: Error): void }> = [];
  let failure: Error | undefined;
  let stderr = "";
  child.stderr!.on("data", (chunk) => { stderr += chunk; });
  child.on("message", (message) => {
    const waiter = waiting.shift();
    if (waiter) waiter.resolve(message as WorkerReply);
    else queued.push(message as WorkerReply);
  });
  let exited!: () => void;
  const exit = new Promise<void>((resolve) => { exited = resolve; });
  const fail = (error: Error) => {
    failure = error;
    for (const waiter of waiting.splice(0)) waiter.reject(error);
    exited();
  };
  child.on("error", fail);
  child.on("exit", (code, signal) => fail(new Error(`Lock worker exited (${code ?? signal}): ${stderr}`)));
  return {
    child,
    exit,
    next(): Promise<WorkerReply> {
      const message = queued.shift();
      if (message) return Promise.resolve(message);
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exit;
    },
  };
}

test("cross-process stale recovery admits one holder and SIGKILL releases its SQLite lock", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "minu-lock-processes-"));
  const lockPath = join(directory, "run", "instance.lock");
  const databasePath = join(directory, "run", "instance-lock.sqlite");
  const workers: ReturnType<typeof lockWorker>[] = [];
  let recovered: ProductDirectoryLock | undefined;
  try {
    await prepareConversationsDataDirectory(directory);
    await mkdir(lockPath);
    await writeFile(join(lockPath, "owner.json"), JSON.stringify({ pid: 999999, token: "stale" }));
    await writeFile(join(lockPath, "recovery.claim"), "abandoned old recovery");
    for (let index = 0; index < 4; index++) workers.push(lockWorker(directory));
    for (const reply of await Promise.all(workers.map((worker) => worker.next()))) assert.equal(reply.type, "ready");
    for (const worker of workers) worker.child.send("acquire");
    const results = await Promise.all(workers.map((worker) => worker.next()));
    assert.equal(results.filter((result) => result.type === "held").length, 1);
    for (const result of results.filter((result) => result.type !== "held")) {
      assert.equal(result.type, "rejected");
      assert.match(result.message!, /already using data directory/);
    }
    const holder = workers[results.findIndex((result) => result.type === "held")]!;
    const owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as { pid: number };
    assert.equal(owner.pid, holder.child.pid);
    const database = await stat(databasePath);
    await assert.rejects(acquireConversationsDataDirectoryLock(directory), /already using data directory/);
    await holder.stop();
    recovered = await acquireConversationsDataDirectoryLock(directory);
    const currentDatabase = await stat(databasePath);
    assert.equal(currentDatabase.ino, database.ino);
    assert.equal(currentDatabase.dev, database.dev);
    assert.equal(JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")).pid, process.pid);
    await assert.rejects(acquireConversationsDataDirectoryLock(directory), /already using data directory/);
  } finally {
    await recovered?.release();
    await Promise.all(workers.map((worker) => worker.stop()));
    await rm(directory, { recursive: true, force: true });
  }
});
