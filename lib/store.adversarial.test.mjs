// Adversarial review of FileStore's re-read-on-change (`fileStamp` + `loadOnce`)
// and of persist() taking the snapshot as an argument.
//
// These are the interleavings the happy-path reload tests in store.test.mjs do
// not reach: a read that fails for a reason other than the file being wrong, a
// write that fails before the file exists at all, and a foreign rewrite landing
// after a request has already loaded its snapshot.

import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { FileStore } from "./store.ts";

const user = {
  id: "user-1",
  email: "Customer@Example.com",
  passwordHash: "hash",
  passwordSalt: "salt",
  createdAt: "2026-07-19T00:00:00.000Z",
  stripeCustomerId: "cus_test",
  billingStatus: "active",
};

const storePath = (dir) => path.join(dir, "store.json");
const onDisk = async (dir) => JSON.parse(await readFile(storePath(dir), "utf8"));

// ── 1. A read that fails is recorded as if it had succeeded ──────────────

test("a transient read failure does not pin the stale snapshot to the new file", async () => {
  // loadOnce() takes the stamp BEFORE the read and then assigns
  // `this.loadedStamp = stamp` on the way out — including down the catch path,
  // where the read never produced a snapshot. The old snapshot is then labelled
  // with the NEW file's stamp, so every later load sees a match and never reads
  // again. One EMFILE (ordinary under load; the file itself is perfectly fine)
  // is enough to make a completed password reset invisible for the life of the
  // process, which is the exact failure the stamp check exists to prevent.
  const dir = await mkdtemp(path.join(tmpdir(), "adv-read-fail-"));
  const realReadFile = fsp.readFile;
  try {
    const live = new FileStore(dir);
    await live.createUser({ ...user });
    await live.getUserByEmail(user.email); // warm the cache

    // The owner runs `npm run reset-password`; it completes.
    await new FileStore(dir).setUserAuth(user.id, { passwordHash: "rotated-by-cli" });

    let fired = false;
    fsp.readFile = async (target, ...rest) => {
      if (!fired && typeof target === "string" && target.endsWith("store.json")) {
        fired = true;
        throw Object.assign(new Error("too many open files"), { code: "EMFILE" });
      }
      return realReadFile(target, ...rest);
    };
    // Serving the old value for THIS request is fine — the read failed.
    assert.equal((await live.getUserById(user.id)).passwordHash, "hash");
    fsp.readFile = realReadFile;
    assert.equal(fired, true, "the read never failed — the test proves nothing");

    // The file is readable again and still holds the reset.
    assert.equal(
      (await live.getUserById(user.id)).passwordHash,
      "rotated-by-cli",
      "a failed read must not count as having loaded the new file",
    );

    // And the reset must not be serialized away by the next ordinary write.
    await live.setUserInstance(user.id, "instance-1");
    assert.equal((await onDisk(dir)).usersById[user.id].passwordHash, "rotated-by-cli");
  } finally {
    fsp.readFile = realReadFile;
    await rm(dir, { recursive: true, force: true });
  }
});

// ── 2. A failed write before store.json exists ───────────────────────────

test("a first write that fails does not leave a phantom account in memory", async () => {
  // persist() drops the phantom by setting `loadedStamp = null` so the next load
  // re-reads. That works only while a file exists to re-read: with no
  // store.json, fileStamp() returns null and loadOnce()'s `stamp === null` arm
  // hands back the very snapshot the caller already mutated. A signup that
  // errored is then "registered" for the rest of the process's life.
  //
  // This is the first write on a fresh STORE_DIR — exactly the bind-mounted
  // "Deploy via your bot" path, where a wrong-ownership or full volume fails
  // right here.
  const dir = await mkdtemp(path.join(tmpdir(), "adv-first-write-"));
  const realRename = fsp.rename;
  try {
    const store = new FileStore(dir);
    fsp.rename = async () => { throw Object.assign(new Error("no space left"), { code: "ENOSPC" }); };
    await assert.rejects(() => store.createUser({ ...user }));
    fsp.rename = realRename;

    assert.equal(
      await store.getUserByEmail(user.email),
      null,
      "nothing reached disk, so nobody is registered",
    );
    assert.equal(await store.getUserById(user.id), null);
  } finally {
    fsp.rename = realRename;
    await rm(dir, { recursive: true, force: true });
  }
});

test("a customer whose first signup errored can sign up again", async () => {
  // The user-visible half of the same defect: the phantom holds the email claim,
  // so the retry of a signup that failed with a 500 is refused as a duplicate
  // while no account exists anywhere.
  const dir = await mkdtemp(path.join(tmpdir(), "adv-first-retry-"));
  const realRename = fsp.rename;
  try {
    const store = new FileStore(dir);
    fsp.rename = async () => { throw Object.assign(new Error("no space left"), { code: "ENOSPC" }); };
    await assert.rejects(() => store.createUser({ ...user }));
    fsp.rename = realRename;

    assert.notEqual(
      await store.createUser({ ...user }),
      null,
      "the retry must not be rejected as a duplicate email",
    );
    assert.equal((await onDisk(dir)).userIdByEmail[user.email.toLowerCase()], user.id);
  } finally {
    fsp.rename = realRename;
    await rm(dir, { recursive: true, force: true });
  }
});

test("a signup that failed is not committed by someone else's successful one", async () => {
  // Worse than a stale read: the phantom lives in the shared snapshot, so the
  // next customer who signs up successfully writes the failed account to disk
  // along with their own.
  const dir = await mkdtemp(path.join(tmpdir(), "adv-first-ride-"));
  const realRename = fsp.rename;
  try {
    const store = new FileStore(dir);
    fsp.rename = async () => { throw Object.assign(new Error("no space left"), { code: "ENOSPC" }); };
    await assert.rejects(() => store.createUser({ ...user }));
    fsp.rename = realRename;

    const second = { ...user, id: "user-2", email: "second@example.com", stripeCustomerId: undefined };
    assert.notEqual(await store.createUser(second), null);

    const snap = await onDisk(dir);
    assert.equal(snap.usersById["user-2"].email, "second@example.com");
    assert.equal(
      snap.usersById[user.id],
      undefined,
      "the account whose write failed must not ride along on a later write",
    );
  } finally {
    fsp.rename = realRename;
    await rm(dir, { recursive: true, force: true });
  }
});

// ── 3. A foreign rewrite landing after a request loaded its snapshot ─────

test("an app write already in flight does not revert a completed reset", async () => {
  // The stamp check is taken at load() time only. A request that has already
  // loaded its snapshot writes the whole thing back unconditionally, so a reset
  // that finished — the owner was told the password changed — is erased by any
  // request that was mid-flight. Chat alone persists twice per message
  // (beginUserChat, appendUserHistory), so this window is open constantly on a
  // storefront with traffic.
  //
  // mkdir is persist()'s first step, which places the foreign write in the gap
  // between the caller's load()+mutate and its own writeFile.
  const dir = await mkdtemp(path.join(tmpdir(), "adv-inflight-revert-"));
  const realMkdir = fsp.mkdir;
  try {
    const live = new FileStore(dir);
    await live.createUser({ ...user });
    await live.getUserByEmail(user.email); // warm the cache

    let fired = false;
    fsp.mkdir = async (...args) => {
      const result = await realMkdir(...args);
      if (!fired) {
        fired = true;
        await new FileStore(dir).setUserAuth(user.id, { passwordHash: "rotated-by-cli" });
      }
      return result;
    };
    await live.setUserInstance(user.id, "instance-1");
    fsp.mkdir = realMkdir;
    assert.equal(fired, true, "the window was never reached — the test proves nothing");

    const snap = await onDisk(dir);
    assert.equal(snap.instanceByUserId[user.id], "instance-1");
    assert.equal(
      snap.usersById[user.id].passwordHash,
      "rotated-by-cli",
      "a reset that already completed must survive a concurrent app write",
    );
  } finally {
    fsp.mkdir = realMkdir;
    await rm(dir, { recursive: true, force: true });
  }
});

test("a reload between a caller's load and its persist does not drop the caller's write", async () => {
  // The other horn of the same problem. Once a foreign write makes load()
  // re-read, two app callers hold two DIFFERENT snapshot objects parsed from one
  // file. persist() writes whichever object it was handed, so the second write
  // to reach disk silently drops the first one's change and still resolves
  // successfully — the request returns 200 for a write that no longer exists.
  const dir = await mkdtemp(path.join(tmpdir(), "adv-reload-drop-"));
  const realMkdir = fsp.mkdir;
  try {
    const live = new FileStore(dir);
    await live.createUser({ ...user });
    await live.getUserByEmail(user.email); // warm the cache

    let fired = false;
    let secondOp = null;
    fsp.mkdir = async (...args) => {
      const result = await realMkdir(...args);
      if (!fired) {
        fired = true;
        // The CLI finishes...
        await new FileStore(dir).setUserAuth(user.id, { passwordHash: "rotated-by-cli" });
        // ...and a second request re-reads it and queues its own write behind
        // the one currently in flight.
        secondOp = live.setUserPreferences(user.id, {
          responseStyle: "concise",
          customInstructions: "",
        });
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return result;
    };
    await live.setUserInstance(user.id, "instance-1");
    await secondOp;
    fsp.mkdir = realMkdir;
    assert.equal(fired, true, "the window was never reached — the test proves nothing");

    const snap = await onDisk(dir);
    assert.equal(
      snap.preferencesByUserId[user.id]?.responseStyle,
      "concise",
      "the later write must land",
    );
    assert.equal(
      snap.instanceByUserId[user.id],
      "instance-1",
      "the earlier write resolved successfully, so it must not be dropped",
    );
  } finally {
    fsp.mkdir = realMkdir;
    await rm(dir, { recursive: true, force: true });
  }
});

// ── 4. Control tests: behaviour that must NOT regress ────────────────────

test("a missing store.json is read once, then cached", async () => {
  // Bullet-check on the `stamp === null` arm: an empty storefront must not
  // re-read (or stat more than once) per operation.
  const dir = await mkdtemp(path.join(tmpdir(), "adv-missing-"));
  const realReadFile = fsp.readFile;
  const realStat = fsp.stat;
  let reads = 0;
  let stats = 0;
  try {
    fsp.readFile = async (target, ...rest) => {
      if (typeof target === "string" && target.endsWith("store.json")) reads += 1;
      return realReadFile(target, ...rest);
    };
    fsp.stat = async (target, ...rest) => {
      if (typeof target === "string" && target.endsWith("store.json")) stats += 1;
      return realStat(target, ...rest);
    };
    const store = new FileStore(dir);
    for (let i = 0; i < 6; i += 1) {
      assert.equal(await store.getUserById("nobody"), null);
    }
    assert.equal(reads, 1, "the missing file must be read once, not once per operation");
    assert.equal(stats, 6, "one stat per operation, no more");
  } finally {
    fsp.readFile = realReadFile;
    fsp.stat = realStat;
    await rm(dir, { recursive: true, force: true });
  }
});

test("a burst of writes does not re-read the store on every operation", async () => {
  // The store's own writes must not look like foreign edits.
  const dir = await mkdtemp(path.join(tmpdir(), "adv-selfwrite-"));
  const realReadFile = fsp.readFile;
  try {
    const store = new FileStore(dir);
    await store.createUser({ ...user });
    let reads = 0;
    fsp.readFile = async (target, ...rest) => {
      if (typeof target === "string" && target.endsWith("store.json")) reads += 1;
      return realReadFile(target, ...rest);
    };
    for (let i = 0; i < 10; i += 1) {
      await store.setUserInstance(user.id, `instance-${i}`);
      assert.equal(await store.getUserInstance(user.id), `instance-${i}`);
    }
    fsp.readFile = realReadFile;
    assert.equal(reads, 0, "our own writes must never trigger a re-read");
  } finally {
    fsp.readFile = realReadFile;
    await rm(dir, { recursive: true, force: true });
  }
});

test("the generation fence survives a foreign rewrite of the file", async () => {
  // deleteUserData bumps historyGeneration so an in-flight chat cannot recreate
  // history. If a reload could hand a chat turn a pre-delete generation, the
  // fence would open again.
  const dir = await mkdtemp(path.join(tmpdir(), "adv-fence-"));
  try {
    const live = new FileStore(dir);
    await live.createUser({ ...user });
    const fence = await live.beginUserChat(user.id);

    // A foreign process rewrites the file (an unrelated field).
    await new FileStore(dir).setUserAuth(user.id, { passwordHash: "rotated-by-cli" });

    await live.deleteUserData(user.id);
    assert.equal(
      await live.appendUserHistory(
        user.id,
        [{ id: "late", role: "assistant", content: "late", createdAt: "2026-07-19T00:00:01.000Z", turnSequence: fence.turnSequence }],
        fence.generation,
      ),
      false,
      "a chat turn started before the delete must stay fenced out",
    );
    assert.deepEqual(await live.getUserHistory(user.id), []);
    assert.equal((await onDisk(dir)).usersById[user.id], undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("consecutive turn fences stay unique across a foreign rewrite", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "adv-turnseq-"));
  try {
    const live = new FileStore(dir);
    await live.createUser({ ...user });
    const first = await live.beginUserChat(user.id);
    await new FileStore(dir).setUserAuth(user.id, { passwordHash: "rotated-by-cli" });
    const second = await live.beginUserChat(user.id);
    assert.equal(second.turnSequence, first.turnSequence + 1);
    assert.equal(second.generation, first.generation);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Copy-on-write: a failed write must leave no trace ───────────────────

test("a reader never observes a mutation whose write then failed", async () => {
  // The mutation is applied to a COPY and the copy replaces the cache only once
  // the bytes are on disk. Mutating the shared snapshot in place would let a
  // concurrent request read a change that never commits — and no amount of
  // invalidating afterwards can retract a response already sent.
  const dir = await mkdtemp(path.join(tmpdir(), "adv-cow-read-"));
  const realRename = fsp.rename;
  try {
    const store = new FileStore(dir);
    await store.createUser({ ...user });

    let observed = "not-read";
    fsp.rename = async () => {
      // A request reads while our write is in flight.
      observed = (await store.getUserById(user.id)).passwordHash;
      throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
    };
    await assert.rejects(() => store.setUserAuth(user.id, { passwordHash: "never-committed" }));
    fsp.rename = realRename;

    assert.equal(observed, "hash", "an uncommitted mutation must not be visible to readers");
    assert.equal((await store.getUserById(user.id)).passwordHash, "hash");
    assert.equal((await onDisk(dir)).usersById[user.id].passwordHash, "hash");
  } finally {
    fsp.rename = realRename;
    await rm(dir, { recursive: true, force: true });
  }
});

test("a write that fails before the temp file is even created leaves nothing behind", async () => {
  // mkdir is the first I/O in the write. It has to be inside the guarded region
  // too, or an EACCES there leaves the mutation applied but uncommitted.
  const dir = await mkdtemp(path.join(tmpdir(), "adv-cow-mkdir-"));
  const realMkdir = fsp.mkdir;
  try {
    const store = new FileStore(dir);
    await store.createUser({ ...user });
    fsp.mkdir = async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); };
    await assert.rejects(() => store.setUserAuth(user.id, { passwordHash: "never-committed" }));
    fsp.mkdir = realMkdir;

    assert.equal((await store.getUserById(user.id)).passwordHash, "hash");
    await store.setUserInstance(user.id, "instance-1");
    assert.equal((await onDisk(dir)).usersById[user.id].passwordHash, "hash");
  } finally {
    fsp.mkdir = realMkdir;
    await rm(dir, { recursive: true, force: true });
  }
});

test("a retried signup reports the verdict of the attempt that actually committed", async () => {
  // The mutation is re-run on a conflict, so its answer has to come from the
  // attempt that won. Carrying a verdict computed on attempt one across a retry
  // returns "email taken" for an account this call has just created.
  const dir = await mkdtemp(path.join(tmpdir(), "adv-retry-verdict-"));
  const realWriteFile = fsp.writeFile;
  try {
    const store = new FileStore(dir);
    // Seed the address, so attempt one legitimately sees it as taken.
    await store.createUser({ ...user, id: "squatter" });

    let fired = false;
    fsp.writeFile = async (target, ...rest) => {
      const result = await realWriteFile(target, ...rest);
      if (!fired && typeof target === "string" && target.endsWith(".tmp")) {
        fired = true;
        // Another process removes the squatter, forcing a retry that should now
        // succeed.
        await new FileStore(dir).deleteUserData("squatter");
      }
      return result;
    };
    const created = await store.createUser({ ...user });
    fsp.writeFile = realWriteFile;
    assert.equal(fired, true, "the retry was never triggered — the test proves nothing");

    const snap = await onDisk(dir);
    const onDiskUser = snap.usersById[user.id];
    // Whatever the verdict is, it must agree with what ended up on disk.
    assert.equal(
      Boolean(created),
      Boolean(onDiskUser),
      "the returned verdict must match what was actually committed",
    );
  } finally {
    fsp.writeFile = realWriteFile;
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unreadable file is not mistaken for an absent one", async () => {
  // fileStamp() returns null only for ENOENT. If any stat error collapsed to
  // null, a write could conclude there is nothing to conflict with and rename
  // over a file that is very much there.
  const dir = await mkdtemp(path.join(tmpdir(), "adv-stat-eio-"));
  const realStat = fsp.stat;
  try {
    const store = new FileStore(dir);
    await store.createUser({ ...user });

    const absent = await store.fileStamp();
    assert.notEqual(absent, undefined);

    fsp.stat = async () => { throw Object.assign(new Error("io error"), { code: "EIO" }); };
    const unknown = await store.fileStamp();
    fsp.stat = realStat;

    assert.notEqual(unknown, null, "an EIO must not read as 'file absent'");
    assert.equal(typeof unknown, "object");
  } finally {
    fsp.stat = realStat;
    await rm(dir, { recursive: true, force: true });
  }
});

test("a concurrent reader cannot make a stale write look current", async () => {
  // The pre-rename check compares against the stamp captured when THIS mutation
  // loaded, not against the shared field. The field is mutable: a reader that
  // reloads after a foreign write moves it forward, and comparing to it would
  // make an in-flight stale write conclude nothing had changed and rename over
  // the reset it was supposed to protect.
  const dir = await mkdtemp(path.join(tmpdir(), "adv-reader-stamp-"));
  const realWriteFile = fsp.writeFile;
  try {
    const live = new FileStore(dir);
    await live.createUser({ ...user });
    await live.getUserByEmail(user.email); // warm the cache

    let fired = false;
    fsp.writeFile = async (target, ...rest) => {
      const result = await realWriteFile(target, ...rest);
      if (!fired && typeof target === "string" && target.endsWith(".tmp")) {
        fired = true;
        // The CLI commits a reset...
        await new FileStore(dir).setUserAuth(user.id, { passwordHash: "rotated-by-cli" });
        // ...and an ordinary read picks it up, advancing the shared stamp.
        await live.getUserById(user.id);
      }
      return result;
    };
    await live.setUserInstance(user.id, "instance-1");
    fsp.writeFile = realWriteFile;
    assert.equal(fired, true, "the window was never reached — the test proves nothing");

    const snap = await onDisk(dir);
    assert.equal(
      snap.usersById[user.id].passwordHash,
      "rotated-by-cli",
      "the reset must survive a write that was already in flight",
    );
    assert.equal(snap.instanceByUserId[user.id], "instance-1", "our own write must also land");
  } finally {
    fsp.writeFile = realWriteFile;
    await rm(dir, { recursive: true, force: true });
  }
});
