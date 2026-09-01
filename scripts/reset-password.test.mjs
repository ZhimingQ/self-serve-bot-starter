import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { FileStore } from "../lib/store.ts";
import { hashPassword, verifyPassword } from "../lib/password.ts";
import { hashToken } from "../lib/passwordReset.ts";
import {
  generatePassword,
  loadEnv,
  normalizeEmail,
  parseEnvFile,
  resetPassword,
  resolveBackend,
} from "./reset-password.mjs";

/**
 * The CLI re-implements the store's on-disk format because it has to run inside
 * a prebuilt artifact where lib/*.ts does not exist. These tests are what stop
 * that copy from drifting: every assertion reads the result back through the
 * REAL FileStore and the REAL verifyPassword, so a format change in store.ts
 * that the CLI misses fails here instead of corrupting a live account.
 */

const EMAIL = "Owner@Example.com";

async function seedStore(dir, password) {
  const store = new FileStore(dir);
  const { hash, salt } = await hashPassword(password);
  await store.createUser({
    id: "user-1",
    email: EMAIL,
    passwordHash: hash,
    passwordSalt: salt,
    createdAt: "2026-09-01T00:00:00.000Z",
  });
  return store;
}

async function withTempStore(run) {
  const dir = await mkdtemp(path.join(tmpdir(), "reset-cli-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("resets the password so the real verifyPassword accepts the new one", async () => {
  await withTempStore(async (dir) => {
    await seedStore(dir, "old-password-1");

    const result = await resetPassword({
      env: { STORE_DIR: dir },
      email: EMAIL,
      password: "brand-new-password",
    });
    assert.equal(result.ok, true);
    assert.equal(result.userId, "user-1");

    // Fresh instance: proves the change was persisted, not just held in memory.
    const reloaded = await new FileStore(dir).getUserByEmail(EMAIL);
    assert.ok(reloaded);
    assert.equal(
      await verifyPassword("brand-new-password", reloaded.passwordHash, reloaded.passwordSalt),
      true,
    );
    assert.equal(
      await verifyPassword("old-password-1", reloaded.passwordHash, reloaded.passwordSalt),
      false,
    );
  });
});

test("finds the account regardless of the case the email is typed in", async () => {
  await withTempStore(async (dir) => {
    await seedStore(dir, "old-password-1");
    const result = await resetPassword({
      env: { STORE_DIR: dir },
      email: "  OWNER@EXAMPLE.COM  ",
      password: "another-password",
    });
    assert.equal(result.ok, true);
  });
});

test("signs out every existing session by rotating the session version", async () => {
  await withTempStore(async (dir) => {
    const store = await seedStore(dir, "old-password-1");
    await store.rotateUserSessionVersion("user-1");
    assert.equal(await new FileStore(dir).getUserSessionVersion("user-1"), 1);

    await resetPassword({ env: { STORE_DIR: dir }, email: EMAIL, password: "new-password-x" });

    assert.equal(await new FileStore(dir).getUserSessionVersion("user-1"), 2);
  });
});

test("kills an outstanding email reset token, so a link already sent is dead", async () => {
  await withTempStore(async (dir) => {
    const store = await seedStore(dir, "old-password-1");
    const token = "a".repeat(64);
    await store.setUserAuth("user-1", {
      resetTokenHash: hashToken(token),
      resetTokenExpiresAt: Date.now() + 60 * 60 * 1000,
    });
    assert.ok(await new FileStore(dir).getUserByResetTokenHash(hashToken(token)));

    await resetPassword({ env: { STORE_DIR: dir }, email: EMAIL, password: "new-password-y" });

    const after = new FileStore(dir);
    assert.equal(await after.getUserByResetTokenHash(hashToken(token)), null);
    const user = await after.getUserByEmail(EMAIL);
    assert.equal(user.resetTokenHash, undefined);
    assert.equal(user.resetTokenExpiresAt, undefined);
  });
});

test("leaves the rest of the account untouched", async () => {
  await withTempStore(async (dir) => {
    const store = await seedStore(dir, "old-password-1");
    await store.setUserBilling("user-1", { stripeCustomerId: "cus_1", billingStatus: "active" });
    await store.setUserInstance("user-1", "instance-1");

    await resetPassword({ env: { STORE_DIR: dir }, email: EMAIL, password: "new-password-z" });

    const after = new FileStore(dir);
    const user = await after.getUserByEmail(EMAIL);
    assert.equal(user.billingStatus, "active");
    assert.equal(user.stripeCustomerId, "cus_1");
    assert.equal(user.createdAt, "2026-09-01T00:00:00.000Z");
    assert.equal(await after.getUserInstance("user-1"), "instance-1");
    assert.ok(await after.getUserByStripeCustomerId("cus_1"));
  });
});

test("reports a missing account instead of creating one", async () => {
  await withTempStore(async (dir) => {
    await seedStore(dir, "old-password-1");
    const result = await resetPassword({
      env: { STORE_DIR: dir },
      email: "stranger@example.com",
      password: "irrelevant",
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "no_user");
    const raw = JSON.parse(await readFile(path.join(dir, "store.json"), "utf8"));
    assert.equal(Object.keys(raw.usersById).length, 1);
  });
});

test("refuses when no persistent store is configured", async () => {
  assert.equal(resolveBackend({}), null);
  const result = await resetPassword({ env: {}, email: EMAIL, password: "whatever" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "no_backend");
});

test("prefers Upstash when both backends are configured, matching getStore()", async () => {
  const backend = resolveBackend({
    UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
    UPSTASH_REDIS_REST_TOKEN: "token",
    STORE_DIR: "/tmp/should-not-be-used",
  });
  assert.match(backend.label, /Upstash/);
});

test("parses a generated .env, including values that contain '='", async () => {
  const env = parseEnvFile([
    "# a comment",
    "",
    "STORE_DIR=/data/store",
    'BRAND_NAME="My Shop"',
    "export UPSTASH_REDIS_REST_TOKEN=abc=def==",
    "NOT A KEY",
  ].join("\n"));
  assert.equal(env.STORE_DIR, "/data/store");
  assert.equal(env.BRAND_NAME, "My Shop");
  assert.equal(env.UPSTASH_REDIS_REST_TOKEN, "abc=def==");
  assert.equal(Object.keys(env).length, 3);
});

test("reads the storefront's own .env, and a real process env value still wins", async () => {
  await withTempStore(async (dir) => {
    await writeFile(path.join(dir, ".env"), "STORE_DIR=/from-file\nBRAND_NAME=FromFile\n");
    const env = await loadEnv(dir, { STORE_DIR: "/from-process" });
    assert.equal(env.STORE_DIR, "/from-process");
    assert.equal(env.BRAND_NAME, "FromFile");
  });
});

test("a blank process env var does not shadow the .env", async () => {
  // Exporting X="" means "unset" everywhere else here; letting it win would make
  // the script deny a store that the .env it just read plainly configures.
  await withTempStore(async (dir) => {
    await writeFile(path.join(dir, ".env"), "STORE_DIR=/from-file\n");
    const env = await loadEnv(dir, { STORE_DIR: "" });
    assert.equal(env.STORE_DIR, "/from-file");
  });
});

test("a missing .env is not an error", async () => {
  await withTempStore(async (dir) => {
    const env = await loadEnv(dir, { STORE_DIR: dir });
    assert.equal(env.STORE_DIR, dir);
  });
});

test("generated passwords clear the signup length rule and are not repeated", () => {
  const seen = new Set();
  for (let i = 0; i < 50; i += 1) {
    const password = generatePassword();
    assert.ok(password.length >= 8, `too short: ${password}`);
    assert.match(password, /^[A-Za-z0-9_-]+$/, "must survive being pasted into a shell or chat");
    seen.add(password);
  }
  assert.equal(seen.size, 50);
});

test("normalizeEmail matches the store's own normalisation", async () => {
  await withTempStore(async (dir) => {
    const store = new FileStore(dir);
    await store.createUser({
      id: "user-2",
      email: "  MiXeD@Example.COM ",
      passwordHash: "h",
      passwordSalt: "s",
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    const raw = JSON.parse(await readFile(path.join(dir, "store.json"), "utf8"));
    assert.ok(
      raw.userIdByEmail[normalizeEmail("  MiXeD@Example.COM ")],
      "the CLI's normalizeEmail must produce the same index key the store wrote",
    );
  });
});

test("a storefront with no signups yet reports no account, not a crash", async () => {
  await withTempStore(async (dir) => {
    // No store.json at all — the state of every storefront on launch day.
    const result = await resetPassword({
      env: { STORE_DIR: dir },
      email: "first@example.com",
      password: "irrelevant",
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "no_user");
  });
});

// ── The CLI entrypoint, actually executed ───────────────────────────────
// Everything above imports the module's exports. That leaves main(), argv
// handling, exit codes and the direct-invocation guard uncovered — and a review
// found three real defects living in exactly that gap, including one where a
// symlinked path made the script exit 0 having done nothing at all. These cases
// spawn the file the way an owner runs it.

const CLI = path.join(path.dirname(new URL(import.meta.url).pathname), "reset-password.mjs");

function runCli(args, { cwd, env } = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd: cwd ?? path.dirname(CLI),
    env: { ...process.env, STORE_DIR: "", UPSTASH_REDIS_REST_URL: "", UPSTASH_REDIS_REST_TOKEN: "", ...env },
    encoding: "utf8",
  });
  return { code: res.status, out: res.stdout ?? "", err: res.stderr ?? "" };
}

/** A storefront laid out the way both install paths lay one out. */
async function makeAppDir(seedPassword = "old-password-1") {
  const base = await mkdtemp(path.join(tmpdir(), "reset-app-"));
  const app = path.join(base, "storefront");
  await mkdir(path.join(app, "scripts"), { recursive: true });
  await mkdir(path.join(app, "data"), { recursive: true });
  await copyFile(CLI, path.join(app, "scripts", "reset-password.mjs"));
  await writeFile(path.join(app, ".env"), `STORE_DIR=${path.join(app, "data")}\nSESSION_SECRET=x\n`);
  const store = new FileStore(path.join(app, "data"));
  const { hash, salt } = await hashPassword(seedPassword);
  await store.createUser({
    id: "user-1", email: EMAIL, passwordHash: hash, passwordSalt: salt,
    createdAt: "2026-09-01T00:00:00.000Z",
  });
  return { base, app, cli: path.join(app, "scripts", "reset-password.mjs") };
}

test("run end to end, it sets a password the real verifyPassword accepts", async () => {
  const { base, app, cli } = await makeAppDir();
  try {
    const res = spawnSync(process.execPath, [cli, EMAIL], { cwd: "/", encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
    const generated = res.stdout.match(/New password: (\S+)/)?.[1];
    assert.ok(generated, `no password in output: ${res.stdout}`);

    const user = await new FileStore(path.join(app, "data")).getUserByEmail(EMAIL);
    assert.equal(await verifyPassword(generated, user.passwordHash, user.passwordSalt), true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("finds the storefront's .env from any working directory", async () => {
  // `docker exec` starts in the image WORKDIR, never the storefront directory.
  const { base, app, cli } = await makeAppDir();
  try {
    const res = spawnSync(process.execPath, [cli, EMAIL], {
      cwd: "/",
      env: { ...process.env, STORE_DIR: "", UPSTASH_REDIS_REST_URL: "", UPSTASH_REDIS_REST_TOKEN: "" },
      encoding: "utf8",
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, new RegExp(path.join(app, "data").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("still runs when invoked through a symlinked path", async () => {
  // Node realpaths import.meta.url but not argv[1]; comparing them unresolved
  // made the script exit 0 without doing anything.
  const { base, app, cli } = await makeAppDir();
  try {
    const link = path.join(base, "link");
    await symlink(app, link);
    const res = spawnSync(process.execPath, [path.join(link, "scripts", "reset-password.mjs"), EMAIL], {
      cwd: "/", encoding: "utf8",
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /New password: /);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("refuses an unquoted multi-word password instead of silently taking the first word", async () => {
  const { base, app, cli } = await makeAppDir();
  try {
    const res = spawnSync(process.execPath, [cli, EMAIL, "correct", "horse", "battery"], {
      cwd: "/", encoding: "utf8",
    });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Too many arguments/);
    // Nothing was written: the seeded password still verifies.
    const user = await new FileStore(path.join(app, "data")).getUserByEmail(EMAIL);
    assert.equal(await verifyPassword("old-password-1", user.passwordHash, user.passwordSalt), true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("enforces the same 8-200 length rule the sign-in page does", async () => {
  const { base, cli } = await makeAppDir();
  try {
    for (const bad of ["short", "x".repeat(201)]) {
      const res = spawnSync(process.execPath, [cli, EMAIL, bad], { cwd: "/", encoding: "utf8" });
      assert.equal(res.status, 2, `should have refused a ${bad.length}-char password`);
      assert.match(res.stderr, /8 and 200/);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("exits non-zero with usage when given no arguments", () => {
  const res = runCli([]);
  assert.equal(res.code, 2);
  assert.match(res.err, /usage:/);
});

test("exits non-zero, and says where it looked, when no store is configured", () => {
  const res = runCli(["someone@example.com"]);
  assert.equal(res.code, 1);
  assert.match(res.err, /No persistent store is configured/);
});

test("refuses rather than erase a write the storefront made mid-run", async () => {
  await withTempStore(async (dir) => {
    const store = await seedStore(dir, "old-password-1");
    const backend = resolveBackend({ STORE_DIR: dir });
    const user = await backend.find(EMAIL);
    assert.ok(user);

    // The live app persists something between our read and our commit.
    await store.setUserInstance("user-1", "instance-1");

    await assert.rejects(
      () => backend.commit(user, { hash: "h".repeat(128), salt: "s" }),
      /wrote to store\.json while this was running/,
    );
    // The app's write survived and ours was not applied.
    const after = new FileStore(dir);
    assert.equal(await after.getUserInstance("user-1"), "instance-1");
    const stored = await after.getUserByEmail(EMAIL);
    assert.equal(await verifyPassword("old-password-1", stored.passwordHash, stored.passwordSalt), true);
  });
});

test("the Upstash path survives a concurrent write instead of reverting it", async () => {
  // The CLI rewrites a whole user record it read moments earlier. A plain SET
  // would silently revert anything the storefront committed in between — a
  // Stripe webhook, or the customer's own reset. It uses the same compare-and-set
  // as lib/store.ts, so the fake below evaluates that script for real.
  const CAS = "if redis.call('GET',KEYS[1]) == ARGV[1] then redis.call('SET',KEYS[1],ARGV[2]); return 1 end return 0";
  const data = new Map();
  data.set("user:by-email:owner@example.com", "u1");
  data.set("user:u1", JSON.stringify({
    id: "u1", email: "owner@example.com", passwordHash: "OLD", passwordSalt: "OLDS",
    resetTokenHash: "TOKENHASH", resetTokenExpiresAt: 123,
  }));

  const exec = (cmd) => {
    const [op, ...rest] = cmd;
    if (op === "GET") return data.has(rest[0]) ? data.get(rest[0]) : null;
    if (op === "SET") { data.set(rest[0], String(rest[1])); return "OK"; }
    if (op === "DEL") return data.delete(rest[0]) ? 1 : 0;
    if (op === "INCR") { const n = Number(data.get(rest[0]) ?? 0) + 1; data.set(rest[0], String(n)); return n; }
    if (op === "EVAL") {
      const [script, numKeys, ...args] = rest;
      assert.equal(script, CAS, "the CLI must run the same CAS script as lib/store.ts");
      const keys = args.slice(0, Number(numKeys));
      const argv = args.slice(Number(numKeys));
      if ((data.has(keys[0]) ? data.get(keys[0]) : null) === argv[0]) { data.set(keys[0], argv[1]); return 1; }
      return 0;
    }
    throw new Error(`unsupported ${op}`);
  };

  const sent = [];
  let raced = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const cmd = JSON.parse(init.body);
    sent.push(cmd);
    if (cmd[0] === "EVAL" && !raced) {
      raced = true;
      // The storefront commits a billing change in the CAS window.
      const current = JSON.parse(data.get("user:u1"));
      data.set("user:u1", JSON.stringify({ ...current, billingStatus: "active" }));
    }
    return { ok: true, status: 200, json: async () => ({ result: exec(cmd) }), text: async () => "" };
  };

  try {
    const result = await resetPassword({
      env: { UPSTASH_REDIS_REST_URL: "https://fake.upstash.io", UPSTASH_REDIS_REST_TOKEN: "tok" },
      email: "Owner@Example.com",
      password: "a-brand-new-password",
    });
    assert.equal(result.ok, true);
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(raced, true, "the race window was never reached — the test proves nothing");
  const stored = JSON.parse(data.get("user:u1"));
  assert.notEqual(stored.passwordHash, "OLD", "the reset must have been applied");
  assert.equal(stored.billingStatus, "active", "the concurrent write must survive");
  assert.equal(stored.email, "owner@example.com");
  assert.equal("resetTokenHash" in stored, false, "an emailed link must not outlive the reset");
  assert.equal(data.has("user:by-reset:TOKENHASH"), false);
  assert.equal(data.get("authversion:u1"), "1", "every existing session must be signed out");
  // Rotation must precede the credential write: if only one of the two lands,
  // "signed out but password unchanged" is recoverable, the reverse is not.
  const incrAt = sent.findIndex((c) => c[0] === "INCR");
  const evalAt = sent.findIndex((c) => c[0] === "EVAL");
  assert.ok(incrAt >= 0 && evalAt >= 0, `expected both INCR and EVAL in ${JSON.stringify(sent)}`);
  assert.ok(incrAt < evalAt, "session rotation must be issued before the password write");
});

test("refuses when a write lands between reading the store and stamping it", async () => {
  // The stamp is taken BEFORE the read for this exact case. Taken afterwards, it
  // would pair the app's NEW file metadata with the OLD contents this process
  // read — the change check would then pass and the commit would erase whatever
  // the storefront just saved.
  await withTempStore(async (dir) => {
    await seedStore(dir, "old-password-1");
    const file = path.join(dir, "store.json");
    const realReadFile = fsp.readFile;
    let fired = false;
    try {
      fsp.readFile = async (target, opts) => {
        const content = await realReadFile(target, opts);
        if (!fired && typeof target === "string" && target.endsWith("store.json")) {
          fired = true;
          // The storefront commits AFTER we have the old bytes in hand.
          const snap = JSON.parse(await realReadFile(file, "utf8"));
          snap.instanceByUserId = { "user-1": "instance-1" };
          await writeFile(file, JSON.stringify(snap));
        }
        return content; // deliberately the pre-write contents
      };

      const backend = resolveBackend({ STORE_DIR: dir });
      const user = await backend.find(EMAIL);
      fsp.readFile = realReadFile;
      assert.equal(fired, true, "the race window was never reached — the test proves nothing");
      assert.ok(user);

      await assert.rejects(
        () => backend.commit(user, { hash: "h".repeat(128), salt: "s" }),
        /wrote to store\.json while this was running/,
      );
    } finally {
      fsp.readFile = realReadFile;
    }

    // The app's write survived and the password was not touched.
    const after = new FileStore(dir);
    assert.equal(await after.getUserInstance("user-1"), "instance-1");
    const stored = await after.getUserByEmail(EMAIL);
    assert.equal(await verifyPassword("old-password-1", stored.passwordHash, stored.passwordSalt), true);
  });
});
