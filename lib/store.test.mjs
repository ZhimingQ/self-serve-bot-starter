import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { FileStore, MemoryStore } from "./store.ts";

const user = {
  id: "user-1",
  email: "Customer@Example.com",
  passwordHash: "hash",
  passwordSalt: "salt",
  createdAt: "2026-07-19T00:00:00.000Z",
  stripeCustomerId: "cus_test",
  billingStatus: "active",
};

async function seed(store) {
  await store.createUser({ ...user });
  await store.setUserInstance(user.id, "instance-1");
  const fence = await store.beginUserChat(user.id);
  await store.setUserSessionIfCurrent(user.id, "session-1", fence.generation);
  await store.appendUserHistory(user.id, [{
    id: "message-1",
    role: "user",
    content: "hello",
    createdAt: "2026-07-19T00:00:00.000Z",
    turnSequence: fence.turnSequence,
  }], fence.generation);
  await store.setUserPreferences(user.id, { responseStyle: "concise", customInstructions: "Be direct." });
  return fence;
}

async function assertDeleted(store, staleFence) {
  assert.equal(await store.getUserById(user.id), null);
  assert.equal(await store.getUserByEmail(user.email), null);
  assert.equal(await store.getUserByStripeCustomerId(user.stripeCustomerId), null);
  assert.equal(await store.getUserInstance(user.id), null);
  assert.equal(await store.getUserSession(user.id), null);
  assert.equal(await store.getUserSessionVersion(user.id), 0);
  assert.deepEqual(await store.getUserHistory(user.id), []);
  assert.equal(await store.appendUserHistory(user.id, [{
    id: "late-message",
    role: "assistant",
    content: "late",
    createdAt: "2026-07-19T00:00:01.000Z",
    turnSequence: staleFence.turnSequence,
  }], staleFence.generation), false);
  assert.deepEqual(await store.getUserHistory(user.id), []);
}

test("memory store deletes the account and fences an in-flight chat", async () => {
  const store = new MemoryStore();
  const fence = await seed(store);
  await store.deleteUserData(user.id);
  await assertDeleted(store, fence);
  await store.deleteUserData(user.id);
});

test("memory store rotates browser session versions", async () => {
  const store = new MemoryStore();
  assert.equal(await store.getUserSessionVersion(user.id), 0);
  assert.equal(await store.rotateUserSessionVersion(user.id), 1);
  assert.equal(await store.rotateUserSessionVersion(user.id), 2);
  assert.equal(await store.getUserSessionVersion(user.id), 2);
  await store.clearUserConversation(user.id);
  assert.equal(await store.getUserSessionVersion(user.id), 2);
});

test("file store persists account deletion and keeps the generation fence", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "launchbot-store-test-"));
  try {
    const store = new FileStore(dir);
    const fence = await seed(store);
    assert.equal(await store.rotateUserSessionVersion(user.id), 1);
    assert.equal(await new FileStore(dir).getUserSessionVersion(user.id), 1);
    await store.clearUserConversation(user.id);
    assert.equal(await new FileStore(dir).getUserSessionVersion(user.id), 1);
    await store.deleteUserData(user.id);
    await assertDeleted(store, fence);

    const reloaded = new FileStore(dir);
    await assertDeleted(reloaded, fence);
    const snapshot = JSON.parse(await readFile(path.join(dir, "store.json"), "utf8"));
    assert.equal(snapshot.historyGenerationByUserId[user.id], fence.generation + 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Password-reset token index ──────────────────────────────────────────
// The index (hash → user) and the user record's own resetTokenHash are two
// copies of one fact. Every one of these tests exists to keep them agreeing.

const RESET_A = "a".repeat(64);
const RESET_B = "b".repeat(64);

async function withBackends(run) {
  await run(new MemoryStore(), "memory");
  const dir = await mkdtemp(path.join(tmpdir(), "launchbot-reset-test-"));
  try {
    await run(new FileStore(dir), "file");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("setUserAuth indexes a reset token and finds the user by its hash", async () => {
  await withBackends(async (store, label) => {
    await store.createUser({ ...user });
    await store.setUserAuth(user.id, { resetTokenHash: RESET_A, resetTokenExpiresAt: 123 });
    assert.equal((await store.getUserByResetTokenHash(RESET_A))?.id, user.id, label);
  });
});

test("a replacement token retires the previous one", async () => {
  await withBackends(async (store, label) => {
    await store.createUser({ ...user });
    await store.setUserAuth(user.id, { resetTokenHash: RESET_A, resetTokenExpiresAt: 123 });
    await store.setUserAuth(user.id, { resetTokenHash: RESET_B, resetTokenExpiresAt: 456 });
    assert.equal(await store.getUserByResetTokenHash(RESET_A), null, label);
    assert.equal((await store.getUserByResetTokenHash(RESET_B))?.id, user.id, label);
  });
});

test("clearing the token removes both the field and the index entry", async () => {
  await withBackends(async (store, label) => {
    await store.createUser({ ...user });
    await store.setUserAuth(user.id, { resetTokenHash: RESET_A, resetTokenExpiresAt: 123 });
    await store.setUserAuth(user.id, { resetTokenHash: undefined, resetTokenExpiresAt: undefined });
    assert.equal(await store.getUserByResetTokenHash(RESET_A), null, label);
    const stored = await store.getUserById(user.id);
    assert.equal(stored.resetTokenHash, undefined, label);
    assert.equal(stored.resetTokenExpiresAt, undefined, label);
  });
});

test("a patch that does not mention the token leaves the index intact", async () => {
  // Regression: the retire branch used to fire on any patch whose
  // resetTokenHash was absent, so touching only the expiry (or only the
  // password) deleted the index entry while the record kept the hash — the two
  // then disagreed about whether a live token existed.
  await withBackends(async (store, label) => {
    await store.createUser({ ...user });
    await store.setUserAuth(user.id, { resetTokenHash: RESET_A, resetTokenExpiresAt: 123 });
    await store.setUserAuth(user.id, { resetTokenExpiresAt: 999 });
    assert.equal((await store.getUserByResetTokenHash(RESET_A))?.id, user.id, label);
    assert.equal((await store.getUserById(user.id)).resetTokenExpiresAt, 999, label);
  });
});

test("deleting the account drops its reset token index entry", async () => {
  await withBackends(async (store, label) => {
    await store.createUser({ ...user });
    await store.setUserAuth(user.id, { resetTokenHash: RESET_A, resetTokenExpiresAt: 123 });
    await store.deleteUserData(user.id);
    assert.equal(await store.getUserByResetTokenHash(RESET_A), null, label);
  });
});

test("a reset token survives a file store restart", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "launchbot-reset-persist-"));
  try {
    const store = new FileStore(dir);
    await store.createUser({ ...user });
    await store.setUserAuth(user.id, { resetTokenHash: RESET_A, resetTokenExpiresAt: 123 });
    assert.equal((await new FileStore(dir).getUserByResetTokenHash(RESET_A))?.id, user.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a snapshot written before password reset existed still loads", async () => {
  // Real storefronts have store.json files with no userIdByResetToken key.
  const dir = await mkdtemp(path.join(tmpdir(), "launchbot-reset-legacy-"));
  try {
    await writeFile(path.join(dir, "store.json"), JSON.stringify({
      usersById: { [user.id]: { ...user } },
      userIdByEmail: { [user.email.toLowerCase()]: user.id },
      userIdByCustomer: {},
      instanceByUserId: {},
      sessionByUserId: {},
      sessionVersionByUserId: {},
      historyByUserId: {},
      historyGenerationByUserId: {},
      historySequenceByUserId: {},
      preferencesByUserId: {},
    }));
    const store = new FileStore(dir);
    assert.equal(await store.getUserByResetTokenHash(RESET_A), null);
    await store.setUserAuth(user.id, { resetTokenHash: RESET_A, resetTokenExpiresAt: 123 });
    assert.equal((await new FileStore(dir).getUserByResetTokenHash(RESET_A))?.id, user.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Picking up a foreign write to store.json ────────────────────────────
// `npm run reset-password` rewrites this file on purpose while the app runs.
// Before FileStore re-read on change, that reset was invisible to the running
// process and the next app write erased it from disk.

test("file store notices a change another process made", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "launchbot-reload-"));
  try {
    const live = new FileStore(dir);
    await live.createUser({ ...user });
    assert.equal((await live.getUserByEmail(user.email)).passwordHash, "hash");

    // A second process (the CLI) rewrites the file.
    const other = new FileStore(dir);
    await other.setUserAuth(user.id, { passwordHash: "rotated-by-cli", passwordSalt: "s2" });

    const seen = await live.getUserByEmail(user.email);
    assert.equal(seen.passwordHash, "rotated-by-cli");
    assert.equal(seen.passwordSalt, "s2");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a later app write does not revert the foreign change", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "launchbot-reload-keep-"));
  try {
    const live = new FileStore(dir);
    await live.createUser({ ...user });
    await live.getUserByEmail(user.email); // warm the cache

    await new FileStore(dir).setUserAuth(user.id, { passwordHash: "rotated-by-cli" });

    // Any ordinary app write serializes the whole snapshot back to disk.
    await live.setUserInstance(user.id, "instance-1");

    const onDisk = JSON.parse(await readFile(path.join(dir, "store.json"), "utf8"));
    assert.equal(onDisk.usersById[user.id].passwordHash, "rotated-by-cli");
    assert.equal(onDisk.instanceByUserId[user.id], "instance-1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a foreign session-version bump is seen too, so the reset really signs out", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "launchbot-reload-ver-"));
  try {
    const live = new FileStore(dir);
    await live.createUser({ ...user });
    assert.equal(await live.getUserSessionVersion(user.id), 0);

    await new FileStore(dir).rotateUserSessionVersion(user.id);

    assert.equal(await live.getUserSessionVersion(user.id), 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("its own writes do not make it re-read, and stay readable", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "launchbot-reload-self-"));
  try {
    const store = new FileStore(dir);
    await store.createUser({ ...user });
    for (let i = 0; i < 5; i += 1) {
      await store.setUserInstance(user.id, `instance-${i}`);
      assert.equal(await store.getUserInstance(user.id), `instance-${i}`);
    }
    // Deleting the file must not wipe live state — a read failure is not a
    // reason to throw away the snapshot we already serve from.
    await rm(path.join(dir, "store.json"));
    assert.equal((await store.getUserByEmail(user.email))?.id, user.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an empty store does not thrash before anything is written", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "launchbot-reload-empty-"));
  try {
    const store = new FileStore(dir);
    assert.equal(await store.getUserById("nobody"), null);
    assert.equal(await store.getUserByEmail("nobody@example.com"), null);
    assert.equal(await store.getUserSessionVersion("nobody"), 0);
    // First write creates the file; reads after it must still work.
    await store.createUser({ ...user });
    assert.equal((await store.getUserByEmail(user.email))?.id, user.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent reads across a foreign change all agree", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "launchbot-reload-race-"));
  try {
    const live = new FileStore(dir);
    await live.createUser({ ...user });
    await live.getUserByEmail(user.email);
    await new FileStore(dir).setUserAuth(user.id, { passwordHash: "rotated-by-cli" });

    const results = await Promise.all(
      Array.from({ length: 12 }, () => live.getUserById(user.id)),
    );
    for (const r of results) assert.equal(r.passwordHash, "rotated-by-cli");
    // All callers must share one object, or two mutations could each persist a
    // snapshot missing the other's change.
    assert.equal(new Set(results).size, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a concurrent write from the app still lands after a foreign change", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "launchbot-reload-mix-"));
  try {
    const live = new FileStore(dir);
    await live.createUser({ ...user });
    await live.getUserByEmail(user.email);
    await new FileStore(dir).setUserAuth(user.id, { passwordHash: "rotated-by-cli" });

    await Promise.all([
      live.setUserInstance(user.id, "instance-1"),
      live.setUserPreferences(user.id, { responseStyle: "concise", customInstructions: "" }),
    ]);

    const reloaded = new FileStore(dir);
    assert.equal((await reloaded.getUserById(user.id)).passwordHash, "rotated-by-cli");
    assert.equal(await reloaded.getUserInstance(user.id), "instance-1");
    assert.equal((await reloaded.getUserPreferences(user.id)).responseStyle, "concise");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a corrupt store.json does not wipe the state already in memory", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "launchbot-reload-corrupt-"));
  try {
    const live = new FileStore(dir);
    await live.createUser({ ...user });
    await live.getUserByEmail(user.email);

    // Something truncates or garbles the file. Re-reading it fails to parse; a
    // storefront must keep serving the customers it already has rather than
    // presenting itself as empty and letting the next write make that permanent.
    await writeFile(path.join(dir, "store.json"), "{ this is not json");

    assert.equal((await live.getUserByEmail(user.email))?.id, user.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a foreign write during our own write is re-applied over, not clobbered", async () => {
  // The write itself takes real time, so a reset can land after the mutation was
  // computed but before it commits. The pre-rename check must catch that and the
  // mutation must be redone on top of the new contents — losing either change is
  // a silent data loss that still returns success to the caller.
  const dir = await mkdtemp(path.join(tmpdir(), "launchbot-write-retry-"));
  const realWriteFile = fsp.writeFile;
  try {
    const live = new FileStore(dir);
    await live.createUser({ ...user });
    await live.getUserByEmail(user.email);

    let fired = false;
    fsp.writeFile = async (target, ...rest) => {
      const result = await realWriteFile(target, ...rest);
      if (!fired && typeof target === "string" && target.endsWith(".tmp")) {
        fired = true;
        // The CLI commits between our serialize and our rename.
        await new FileStore(dir).setUserAuth(user.id, { passwordHash: "rotated-by-cli" });
      }
      return result;
    };
    await live.setUserInstance(user.id, "instance-1");
    fsp.writeFile = realWriteFile;
    assert.equal(fired, true, "the race window was never reached — the test proves nothing");

    const snap = JSON.parse(await readFile(path.join(dir, "store.json"), "utf8"));
    assert.equal(snap.usersById[user.id].passwordHash, "rotated-by-cli", "the reset must survive");
    assert.equal(snap.instanceByUserId[user.id], "instance-1", "our own write must also land");
  } finally {
    fsp.writeFile = realWriteFile;
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed write does not leave a phantom change in memory", async () => {
  // The caller mutates the cached snapshot before persist() runs, so a write
  // that fails leaves memory holding a change that never reached disk. Serving
  // it would let a password "change" that actually errored appear to work until
  // the next restart — and a later unrelated write could commit it for real.
  const dir = await mkdtemp(path.join(tmpdir(), "launchbot-persist-fail-"));
  const realRename = fsp.rename;
  try {
    const store = new FileStore(dir);
    await store.createUser({ ...user });

    fsp.rename = async () => { throw Object.assign(new Error("no space left"), { code: "ENOSPC" }); };
    await assert.rejects(() => store.setUserAuth(user.id, { passwordHash: "never-committed" }));
    fsp.rename = realRename;

    assert.equal((await store.getUserById(user.id)).passwordHash, "hash");

    // And it must not ride along on the next successful write.
    await store.setUserInstance(user.id, "instance-1");
    const onDisk = JSON.parse(await readFile(path.join(dir, "store.json"), "utf8"));
    assert.equal(onDisk.usersById[user.id].passwordHash, "hash");
    assert.equal(onDisk.instanceByUserId[user.id], "instance-1");
  } finally {
    fsp.rename = realRename;
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed write leaves no temp file behind", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "launchbot-persist-tmp-"));
  const realRename = fsp.rename;
  try {
    const store = new FileStore(dir);
    await store.createUser({ ...user });
    fsp.rename = async () => { throw Object.assign(new Error("boom"), { code: "EIO" }); };
    await assert.rejects(() => store.setUserInstance(user.id, "instance-1"));
    fsp.rename = realRename;
    const leftovers = (await readdir(dir)).filter((f) => f.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  } finally {
    fsp.rename = realRename;
    await rm(dir, { recursive: true, force: true });
  }
});

test("a foreign replacement racing our own write is not mistaken for our file", async () => {
  // If another process renames its version in between our rename and the stat we
  // take to record it, trusting that stamp would pin our snapshot to THEIR file
  // and hide their change for good.
  const dir = await mkdtemp(path.join(tmpdir(), "launchbot-persist-race-"));
  const realStat = fsp.stat;
  const realRename = fsp.rename;
  try {
    const store = new FileStore(dir);
    await store.createUser({ ...user });

    // Arm only AFTER our own rename, so the foreign write lands in the exact
    // window between that rename and the stat that records it. Arming on the
    // first stat instead would fire during load(), which proves nothing.
    let armed = false;
    let fired = false;
    fsp.rename = async (...args) => {
      const result = await realRename(...args);
      if (String(args[1]).endsWith("store.json")) armed = true;
      return result;
    };
    fsp.stat = async (target, opts) => {
      if (armed && !fired && typeof target === "string" && target.endsWith("store.json")) {
        fired = true;
        armed = false;
        const snap = JSON.parse(await readFile(path.join(dir, "store.json"), "utf8"));
        snap.usersById[user.id].passwordHash = "written-by-the-other-process";
        await writeFile(path.join(dir, "store.json.other"), JSON.stringify(snap));
        await realRename(path.join(dir, "store.json.other"), path.join(dir, "store.json"));
      }
      return realStat(target, opts);
    };

    await store.setUserInstance(user.id, "instance-1");
    fsp.stat = realStat;
    fsp.rename = realRename;
    assert.equal(fired, true, "the race window was never reached — the test proves nothing");

    assert.equal(
      (await store.getUserById(user.id)).passwordHash,
      "written-by-the-other-process",
      "the foreign write must still be noticed on the next read",
    );
  } finally {
    fsp.stat = realStat;
    fsp.rename = realRename;
    await rm(dir, { recursive: true, force: true });
  }
});

test("setUserAuth can be made conditional on the token it is spending", async () => {
  // Finding a reset token and spending it are two steps. Without a precondition,
  // two redemptions of one link both pass step one and both set a password, and
  // a slow redemption can clear a NEWER token the customer just requested.
  await withBackends(async (store, label) => {
    await store.createUser({ ...user });
    await store.setUserAuth(user.id, { resetTokenHash: RESET_A, resetTokenExpiresAt: 1 });

    // A second request supersedes it.
    await store.setUserAuth(user.id, { resetTokenHash: RESET_B, resetTokenExpiresAt: 2 });

    // The first redemption finally lands. It must not spend the newer token.
    const stale = await store.setUserAuth(
      user.id, { passwordHash: "set-by-stale-link", resetTokenHash: undefined, resetTokenExpiresAt: undefined }, RESET_A,
    );
    assert.equal(stale, false, label);
    assert.equal((await store.getUserById(user.id)).passwordHash, "hash", label);
    assert.equal((await store.getUserByResetTokenHash(RESET_B))?.id, user.id, label);

    // Redeeming the CURRENT token works, exactly once.
    const first = await store.setUserAuth(
      user.id, { passwordHash: "set-by-current-link", resetTokenHash: undefined, resetTokenExpiresAt: undefined }, RESET_B,
    );
    assert.equal(first, true, label);
    assert.equal((await store.getUserById(user.id)).passwordHash, "set-by-current-link", label);

    const replay = await store.setUserAuth(
      user.id, { passwordHash: "replayed", resetTokenHash: undefined, resetTokenExpiresAt: undefined }, RESET_B,
    );
    assert.equal(replay, false, label);
    assert.equal((await store.getUserById(user.id)).passwordHash, "set-by-current-link", label);
  });
});

test("an unconditional setUserAuth still applies", async () => {
  await withBackends(async (store, label) => {
    await store.createUser({ ...user });
    assert.equal(await store.setUserAuth(user.id, { passwordHash: "h2" }), true, label);
    assert.equal((await store.getUserById(user.id)).passwordHash, "h2", label);
    assert.equal(await store.setUserAuth("ghost", { passwordHash: "h3" }), false, label);
  });
});
