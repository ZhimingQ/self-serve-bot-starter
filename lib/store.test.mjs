import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
