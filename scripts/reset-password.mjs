#!/usr/bin/env node
/**
 * Owner-side password reset — the escape hatch that needs no configuration.
 *
 *   node scripts/reset-password.mjs customer@example.com
 *   node scripts/reset-password.mjs customer@example.com 'their new password'
 *
 * Prefer the first form. A password passed as an argument is visible in `ps` and
 * in /proc/<pid>/cmdline to anything else on the box, and it lands in shell
 * history — and in the chat transcript, if the owner runs this through their
 * bot's exec tool. The generated password never touches argv.
 *
 * WHY THIS IS A STANDALONE SCRIPT AND NOT AN IMPORT OF ./lib/store.ts
 * -------------------------------------------------------------------
 * Storefronts deployed through "Deploy via your bot" run a PREBUILT Next
 * standalone artifact: there is no `lib/*.ts` on disk, no TypeScript loader and
 * no dev dependencies — only `node`, the traced production modules and a
 * generated `.env`. A CLI that imported the store module would work on a
 * from-source install and fail on exactly the installs most likely to need it.
 * So this file speaks the store's on-disk formats directly, using nothing but
 * node builtins. `scripts/reset-password.test.mjs` pins that duplication: it
 * SPAWNS this file the way an owner runs it, then reads the result back through
 * the real `lib/store.ts` + `verifyPassword`, so a divergence fails the test
 * rather than silently corrupting an account.
 *
 * The customer-facing "Forgot password?" flow is the normal route and needs
 * RESEND_API_KEY. This is for the storefront owner when email is not set up,
 * when the customer no longer has the address, or when the owner has locked
 * themselves out of their own test account.
 */

import { promises as fs, realpathSync } from "node:fs";
import path from "node:path";
import { randomBytes, scrypt as scryptCallback } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64; // must match lib/password.ts

/** Trim + lowercase, matching `normalizeEmail` in lib/store.ts. Any drift here
 *  means the lookup misses a user that plainly exists. */
export function normalizeEmail(email) {
  return String(email ?? "").trim().toLowerCase();
}

/**
 * Minimal `.env` reader. Deliberately not a dependency and deliberately not
 * clever: `KEY=value`, WHOLE-LINE `#` comments, optional surrounding quotes,
 * `export` prefix tolerated. A trailing `# comment` after a value is NOT
 * stripped — it becomes part of the value, exactly as in the `start.js` parser
 * the managed installs already run, so both agree on what a generated .env
 * means. Values are otherwise used as-is: an Upstash token can contain `=` and
 * must not be split on every one.
 */
export function parseEnvFile(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    let key = line.slice(0, eq).trim();
    if (key.startsWith("export ")) key = key.slice(7).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** The storefront directory this script was installed into: both the prebuilt
 *  artifact and the source fallback place it at `<appdir>/scripts/`. Returns
 *  null if that shape does not hold, so the caller can fall back to cwd. */
export function appDirFromScript(scriptUrl = import.meta.url) {
  try {
    const dir = path.dirname(fileURLToPath(scriptUrl));
    return path.basename(dir) === "scripts" ? path.resolve(dir, "..") : null;
  } catch {
    return null;
  }
}

/**
 * Real process env wins over the file, so `STORE_DIR=… node scripts/…` works —
 * but only when it actually carries a value. A variable exported as the empty
 * string is "not set" everywhere else in this codebase (config.ts reads
 * `process.env.X || ""`), and letting one shadow a real .env entry would make
 * the script report "no persistent store is configured" while pointing at the
 * storefront directory whose .env configures exactly that.
 */
export async function loadEnv(appDir, processEnv = process.env) {
  let fileEnv = {};
  try {
    fileEnv = parseEnvFile(await fs.readFile(path.join(appDir, ".env"), "utf8"));
  } catch (err) {
    // A missing .env is normal — everything can come through the environment.
    // Anything ELSE (EACCES, EISDIR, EIO) must not be swallowed: it would
    // surface later as "no persistent store is configured", pointing the owner
    // away from the unreadable file that is actually the problem.
    if (err.code !== "ENOENT") {
      throw new Error(`Cannot read ${path.join(appDir, ".env")}: ${err.message}`);
    }
  }
  const merged = { ...fileEnv };
  for (const [key, value] of Object.entries(processEnv)) {
    if (value !== undefined && value !== "") merged[key] = value;
  }
  return merged;
}

export async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = (await scrypt(password, salt, KEY_LENGTH)).toString("hex");
  return { hash, salt };
}

// ── Backends ────────────────────────────────────────────────────────────
// Each exposes find(email) → user|null and commit(user, {hash, salt}).

/** Byte-for-byte the CAS script in lib/store.ts. Both must stay identical, and
 *  `lib/storeUpstash.test.mjs` asserts the app's copy against this text. */
const UPSTASH_CAS =
  "if redis.call('GET',KEYS[1]) == ARGV[1] then redis.call('SET',KEYS[1],ARGV[2]); return 1 end return 0";

function upstashBackend(url, token) {
  async function command(cmd) {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(cmd),
      cache: "no-store",
    });
    if (!res.ok) {
      throw new Error(`Upstash command failed (${res.status}): ${(await res.text().catch(() => "")).slice(0, 200)}`);
    }
    return (await res.json()).result;
  }

  return {
    label: "Upstash Redis",
    async find(email) {
      const userId = await command(["GET", `user:by-email:${normalizeEmail(email)}`]);
      if (!userId) return null;
      const raw = await command(["GET", `user:${userId}`]);
      return raw ? JSON.parse(raw) : null;
    },
    async commit(user, creds) {
      // Rotating the session version signs out every device holding a cookie
      // minted under the old password. It goes FIRST for the same reason as in
      // lib/passwordReset.ts: these are separate requests with no transaction
      // around them, and if only one lands, "signed out but password unchanged"
      // is recoverable whereas "password changed but old sessions still valid"
      // quietly defeats the reset.
      await command(["INCR", `authversion:${user.id}`]);

      // Compare-and-set, matching UpstashStore.patchUser. A plain SET here would
      // write a record read seconds ago, silently reverting any Stripe webhook or
      // password change the storefront committed in between. Re-read and re-apply
      // on the loser of each race so both changes survive.
      let retired = null;
      for (let attempt = 0; ; attempt += 1) {
        const raw = await command(["GET", `user:${user.id}`]);
        if (!raw) throw new Error(`The account disappeared while resetting it (user:${user.id}).`);
        const current = JSON.parse(raw);
        const updated = { ...current, passwordHash: creds.hash, passwordSalt: creds.salt };
        // An outstanding reset token must die with the old password — otherwise a
        // link already in an inbox still overwrites what the owner just set.
        retired = current.resetTokenHash ?? null;
        delete updated.resetTokenHash;
        delete updated.resetTokenExpiresAt;

        const swapped = await command(["EVAL", UPSTASH_CAS, 1, `user:${user.id}`, raw, JSON.stringify(updated)]);
        if (Number(swapped) === 1) break;
        if (attempt >= 4) {
          throw new Error(`Could not update user:${user.id} — too much concurrent write contention. Nothing was changed; try again.`);
        }
      }
      if (retired) await command(["DEL", `user:by-reset:${retired}`]);
    },
  };
}

/** Same shape lib/store.ts uses to notice a foreign edit: ns mtime + size + inode.
 *  Null when the file does not exist. */
async function fileStamp(file) {
  try {
    const stat = await fs.stat(file, { bigint: true });
    return `${stat.mtimeNs}:${stat.size}:${stat.ino}`;
  } catch {
    return null;
  }
}

function fileBackend(dir) {
  const file = path.join(dir, "store.json");
  return {
    label: `JSON file store at ${file}`,
    async find(email) {
      let raw;
      // Stamp BEFORE the read, so content that arrives from a write racing this
      // read is paired with the OLDER stamp and the commit check below refuses.
      // Stamping afterwards would pair new metadata with possibly-old content and
      // the check would pass while quietly discarding the app's write.
      this._stamp = await fileStamp(file);
      try {
        raw = await fs.readFile(file, "utf8");
      } catch (err) {
        // No store.json yet just means nobody has signed up. That is "no such
        // account", not a crash — and it is the state of every storefront on the
        // day it launches, so a raw ENOENT stack here would be the first thing a
        // new reseller sees.
        if (err.code === "ENOENT") return null;
        throw err;
      }
      const snap = JSON.parse(raw);
      this._snap = snap;
      const userId = snap.userIdByEmail?.[normalizeEmail(email)];
      return userId ? snap.usersById?.[userId] ?? null : null;
    },
    async commit(user, creds) {
      const snap = this._snap;
      const updated = { ...snap.usersById[user.id], passwordHash: creds.hash, passwordSalt: creds.salt };
      delete updated.resetTokenHash;
      delete updated.resetTokenExpiresAt;
      snap.usersById[user.id] = updated;
      if (user.resetTokenHash && snap.userIdByResetToken) {
        delete snap.userIdByResetToken[user.resetTokenHash];
      }
      snap.sessionVersionByUserId = snap.sessionVersionByUserId || {};
      snap.sessionVersionByUserId[user.id] = (snap.sessionVersionByUserId[user.id] ?? 0) + 1;

      // This process is the SECOND writer of a file the store documents as
      // single-owner. We rewrite the whole snapshot, so anything the storefront
      // wrote since our read — a signup, a chat turn, a Stripe webhook — would be
      // erased by our commit. Refuse rather than destroy: re-run and it succeeds.
      if (await fileStamp(file) !== this._stamp) {
        throw new Error(
          "The storefront wrote to store.json while this was running, and completing " +
          "would erase that write. Nothing was changed — run the command again.",
        );
      }

      // Temp-then-rename, like the app, so an interrupted run cannot leave a
      // half-written store.json behind. The suffix is random rather than the pid:
      // STORE_DIR is bind-mounted, so a run on the host and a run in the container
      // can hold the same pid and would otherwise share a temp path.
      const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
      try {
        await fs.writeFile(tmp, JSON.stringify(snap), "utf8");
        await fs.rename(tmp, file);
      } catch (err) {
        await fs.rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
    },
  };
}

export function resolveBackend(env) {
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
    return upstashBackend(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN);
  }
  if (env.STORE_DIR) return fileBackend(env.STORE_DIR);
  // The in-memory backend holds accounts only for the life of the process, so
  // there is nothing on disk for this script to rewrite.
  return null;
}

/** A password the owner can paste into a chat without it being guessable.
 *  base64url of 12 random bytes — 96 bits, no ambiguous quoting characters. */
export function generatePassword() {
  return randomBytes(12).toString("base64url");
}

export async function resetPassword({ env, email, password }) {
  const backend = resolveBackend(env);
  if (!backend) {
    return { ok: false, error: "no_backend" };
  }
  const user = await backend.find(email);
  if (!user) return { ok: false, error: "no_user", backend: backend.label };
  const creds = await hashPassword(password);
  await backend.commit(user, creds);
  return { ok: true, backend: backend.label, email: user.email, userId: user.id };
}

// ── CLI ─────────────────────────────────────────────────────────────────

async function main(argv) {
  const [email, explicitPassword] = argv;
  if (!email) {
    console.error("usage: node scripts/reset-password.mjs <email> ['new password']");
    console.error("Omit the password and one is generated for you — which also keeps it out of your shell history.");
    return 2;
  }
  // An unquoted passphrase is the natural thing to type, and destructuring would
  // silently take only its first word: the owner would be told the reset
  // succeeded and hand the customer a password that was never set.
  if (argv.length > 2) {
    console.error(`Too many arguments. Quote the password as one argument: reset-password.mjs ${email} '${argv.slice(1).join(" ")}'`);
    return 2;
  }
  // Both bounds must match app/api/auth/{signup,login}/route.ts. The upper one is
  // not cosmetic: login rejects anything over 200 characters BEFORE verifying it,
  // so a longer password here would be written successfully and then refused at
  // every sign-in — locking the customer out by way of the tool meant to let them
  // back in.
  if (explicitPassword !== undefined && (explicitPassword.length < 8 || explicitPassword.length > 200)) {
    console.error("Password must be between 8 and 200 characters (the same rule the sign-in page enforces).");
    return 2;
  }

  // The app dir is derived from where THIS FILE sits, not from the working
  // directory. Both install paths — the prebuilt artifact and the source
  // fallback — put the script at <appdir>/scripts/reset-password.mjs, whereas
  // `docker exec` starts in the image's WORKDIR, which is never the storefront
  // directory. Resolving from cwd meant the documented invocation found no .env
  // and reported "no persistent store is configured" for a perfectly good
  // install. cwd stays as a fallback for anyone running a copy from elsewhere.
  const appDir = appDirFromScript() ?? process.cwd();
  const env = await loadEnv(appDir);
  const password = explicitPassword ?? generatePassword();
  const generated = explicitPassword === undefined;

  let result;
  try {
    result = await resetPassword({ env, email, password });
  } catch (err) {
    console.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  if (!result.ok && result.error === "no_backend") {
    console.error(
      "No persistent store is configured, so there are no accounts to reset.\n" +
        "Set STORE_DIR (file store) or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN,\n" +
        `or run this from the storefront's app directory so its .env is picked up (looked in ${appDir}).`,
    );
    return 1;
  }
  if (!result.ok && result.error === "no_user") {
    console.error(`No account for ${normalizeEmail(email)} in ${result.backend}.`);
    return 1;
  }

  console.log(`Password reset for ${result.email} (${result.backend}).`);
  console.log("Every existing sign-in for that account has been signed out.");
  if (generated) {
    console.log("");
    console.log(`  New password: ${password}`);
    console.log("");
    console.log("Send it to them over a channel you trust and have them change it after signing in.");
  }
  return 0;
}

// `import.meta.main` is not available on every Node 20/22 line, so compare paths.
//
// realpathSync on BOTH sides, and that is not defensive padding. Node's ESM
// loader resolves symlinks when it computes import.meta.url, while process.argv[1]
// is whatever the caller typed. Compare them unresolved and the check fails
// whenever any component of the invocation path is a symlink — the script then
// exits 0, prints nothing, and resets nothing, which is the worst possible way
// for this particular tool to fail. fileURLToPath rather than `new URL().pathname`
// for the same class of reason: the latter leaves %20 in place under any
// directory with a space in its name.
function isDirectInvocation() {
  if (!process.argv[1]) return false;
  const real = (p) => { try { return realpathSync(p); } catch { return path.resolve(p); } };
  return real(process.argv[1]) === real(fileURLToPath(import.meta.url));
}

if (isDirectInvocation()) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
