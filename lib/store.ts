/**
 * Pluggable persistence layer.
 *
 * Two backends behind one factory:
 *  1. Upstash Redis (REST API, plain fetch — no client library) when
 *     UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set. This is the
 *     recommended production backend (works great on Vercel / any serverless
 *     runtime since it's just HTTP).
 *  2. A JSON-file store when STORE_DIR is set (and Upstash is not). For hosts
 *     with a persistent disk but no Redis — e.g. the "Deploy via your bot" path,
 *     where the bot container bind-mounts STORE_DIR so data survives restarts.
 *  3. An in-memory Map fallback for local dev. Data resets whenever the
 *     process restarts — do NOT use this in production.
 *
 * Every function in the `Store` interface is async so both backends satisfy
 * the same contract.
 */

import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { storeDir, upstash } from "./config";
import {
  defaultAssistantPreferences,
  limitStoredHistory,
  MAX_HISTORY_MESSAGES,
  orderStoredHistory,
  type AssistantPreferences,
  type StoredChatMessage,
} from "./customerWorkspace";

export interface StoredUser {
  id: string;
  email: string;
  passwordHash: string;
  passwordSalt: string;
  createdAt: string;
  /** Stripe customer id, set the first time the user starts checkout. */
  stripeCustomerId?: string;
  /** Checkout/product identifiers bind webhook events to this storefront's
   * configured offer instead of any other product on the Stripe account. */
  stripeCheckoutSessionId?: string;
  stripeSubscriptionId?: string;
  stripePaymentIntentId?: string;
  stripePriceId?: string;
  stripeBillingMode?: "subscription" | "payment";
  /** Billing state gating provisioning. 'active' = paid & entitled; 'canceled'
   *  = was paid, subscription lapsed (access revoked); 'none'/undefined = never
   *  paid. In NO-PAYMENT mode (Stripe unconfigured) this is ignored. */
  billingStatus?: "active" | "canceled" | "none";
  /** Unix-seconds `created` of the last billing event applied from a webhook.
   *  The webhook ignores events older than this, so a replayed/out-of-order
   *  activate can't override a newer revoke. */
  lastBillingEventAt?: number;
  /** sha256 of the outstanding password-reset token. The token itself only ever
   *  exists in the customer's email — a dump of this store must not be usable to
   *  seize an account. Cleared the moment the token is spent. */
  resetTokenHash?: string;
  /** Unix-ms expiry of the reset token. A token past this is refused and treated
   *  as absent. */
  resetTokenExpiresAt?: number;
}

/** Credential fields a password reset rewrites. Deliberately separate from
 *  BillingPatch: nothing in the payment path should be able to touch a
 *  password, and nothing in the reset path should touch billing. */
export type AuthPatch = Partial<Pick<StoredUser,
  "passwordHash" | "passwordSalt" | "resetTokenHash" | "resetTokenExpiresAt"
>>;

export type BillingPatch = Partial<Pick<StoredUser,
  "stripeCustomerId" | "stripeCheckoutSessionId" | "stripeSubscriptionId" |
  "stripePaymentIntentId" | "stripePriceId" | "stripeBillingMode" |
  "billingStatus" | "lastBillingEventAt"
>>;

export interface ChatWriteFence {
  generation: number;
  turnSequence: number;
}

export interface Store {
  getUserByEmail(email: string): Promise<StoredUser | null>;
  getUserById(userId: string): Promise<StoredUser | null>;
  /** Create a user, atomically claiming the email. Returns null if the email was
   *  already taken — this is the authoritative race guard against two concurrent
   *  signups for the same address (a pre-check getUserByEmail alone can race). */
  createUser(user: StoredUser): Promise<StoredUser | null>;
  /** Set the user's Stripe customer id and/or billing status (payment webhook). */
  setUserBilling(
    userId: string,
    patch: BillingPatch
  ): Promise<void>;
  /** Set credential fields (password reset). Pass undefined for a field to
   *  CLEAR it — that is how a spent reset token is retired.
   *
   *  `expectResetTokenHash` makes the write conditional: it applies only if the
   *  stored record still carries that exact hash. Redeeming a reset link is
   *  otherwise a validate-then-write pair with a gap in between, and in that gap
   *  the token can be spent by a concurrent redemption or replaced by a newly
   *  requested one — after which this write would either spend it twice or clear
   *  a link that is legitimately live in the customer's inbox. Returns whether
   *  the write applied. */
  setUserAuth(
    userId: string,
    patch: AuthPatch,
    expectResetTokenHash?: string
  ): Promise<boolean>;
  /** Find the user holding this reset-token hash, or null. */
  getUserByResetTokenHash(tokenHash: string): Promise<StoredUser | null>;
  /** Reverse-lookup a user by Stripe customer id (for subscription lifecycle
   *  events, which reference the customer, not our user id). */
  getUserByStripeCustomerId(customerId: string): Promise<StoredUser | null>;
  /** The end-user's own provisioned bot instance id (one per user). */
  getUserInstance(userId: string): Promise<string | null>;
  setUserInstance(userId: string, instanceId: string): Promise<void>;
  /**
   * The upstream chat session id (from the `x-openclaw-session-id` response
   * header) used to keep multi-turn memory across chat turns. Not to be
   * confused with the browser auth-cookie session in lib/session.ts.
   */
  getUserSession(userId: string): Promise<string | null>;
  /** Version embedded in browser auth cookies. Rotating it revokes every
   * previously issued cookie for the user. */
  getUserSessionVersion(userId: string): Promise<number>;
  rotateUserSessionVersion(userId: string): Promise<number>;
  beginUserChat(userId: string): Promise<ChatWriteFence>;
  setUserSessionIfCurrent(userId: string, sessionId: string, generation: number): Promise<boolean>;
  getUserHistory(userId: string): Promise<StoredChatMessage[]>;
  appendUserHistory(
    userId: string,
    messages: StoredChatMessage[],
    generation: number
  ): Promise<boolean>;
  clearUserConversation(userId: string): Promise<void>;
  getUserPreferences(userId: string): Promise<AssistantPreferences>;
  setUserPreferences(userId: string, preferences: AssistantPreferences): Promise<void>;
  /** Remove the local storefront account and all customer-owned workspace data.
   *  The history generation fence is retained/incremented so an in-flight chat
   *  cannot recreate history after deletion. */
  deleteUserData(userId: string): Promise<void>;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// ── Backend 1: Upstash Redis via REST (plain fetch, no SDK) ──────────────

/** Compare-and-set: write only if the value is byte-for-byte what we read.
 *  `scripts/reset-password.mjs` runs the identical script — the CLI writes the
 *  same records from outside the app and must not clobber them either. */
const UPSTASH_CAS =
  "if redis.call('GET',KEYS[1]) == ARGV[1] then redis.call('SET',KEYS[1],ARGV[2]); return 1 end return 0";

/** Exported for tests. Its compare-and-set path is the only thing standing
 *  between a completed password reset and a concurrent write reverting it, so it
 *  is exercised against a fake Redis that actually evaluates the CAS script. */
export class UpstashStore implements Store {
  private readonly url: string;
  private readonly token: string;

  constructor(url: string, token: string) {
    this.url = url;
    this.token = token;
  }

  private async command<T = unknown>(cmd: (string | number)[]): Promise<T> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(cmd),
      cache: "no-store",
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Upstash command failed (${res.status}): ${text}`);
    }
    const data = (await res.json()) as { result: T };
    return data.result;
  }

  async getUserByEmail(email: string): Promise<StoredUser | null> {
    const key = `user:by-email:${normalizeEmail(email)}`;
    const userId = await this.command<string | null>(["GET", key]);
    if (!userId) return null;
    const raw = await this.command<string | null>(["GET", `user:${userId}`]);
    if (!raw) return null;
    return JSON.parse(raw) as StoredUser;
  }

  async getUserById(userId: string): Promise<StoredUser | null> {
    const raw = await this.command<string | null>(["GET", `user:${userId}`]);
    return raw ? (JSON.parse(raw) as StoredUser) : null;
  }

  async createUser(user: StoredUser): Promise<StoredUser | null> {
    const emailKey = `user:by-email:${normalizeEmail(user.email)}`;
    // Write the (uuid-keyed) user record first, then atomically claim the email
    // with SET NX. If the claim loses the race, the record is an unreferenced
    // orphan — harmless (nothing points to it) — and we report the conflict.
    await this.command(["SET", `user:${user.id}`, JSON.stringify(user)]);
    const claimed = await this.command<string | null>(["SET", emailKey, user.id, "NX"]);
    if (claimed === null) return null; // email already taken
    return user;
  }

  /**
   * Apply a patch to the user record without losing a concurrent write.
   *
   * The record is one JSON string, so a read-modify-write over the stateless
   * REST API has a full network round trip between its GET and its SET. Two
   * writers that overlap there both start from the same old value and the later
   * SET silently reverts the earlier one — and these writers are not exotic: a
   * password reset and a Stripe webhook land on the same key. The damage is
   * worse than a lost field. A reset that completes, reports success and rotates
   * the session version can be rolled back to the OLD passwordHash by an
   * overlapping write, leaving the customer signed out, their new password
   * refused, and the old one still working.
   *
   * So: compare-and-set. The script writes only if the value is still exactly
   * what we read, and the whole read-modify-write is retried when it is not.
   * It is deliberately a string comparison — no cjson, no server-side merge — so
   * it cannot reshape the record, and it is short enough to verify by reading.
   *
   * `apply` may return null to refuse, and is re-run against the latest value on
   * every attempt, so a precondition cannot be smuggled past by a retry.
   */
  private async patchUser(
    userId: string,
    apply: (user: StoredUser) => StoredUser | null
  ): Promise<{ before: StoredUser; after: StoredUser } | null> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const raw = await this.command<string | null>(["GET", `user:${userId}`]);
      if (!raw) return null;
      const before = JSON.parse(raw) as StoredUser;
      const after = apply(before);
      if (!after) return null;
      const swapped = await this.command<number>([
        "EVAL", UPSTASH_CAS, 1, `user:${userId}`, raw, JSON.stringify(after),
      ]);
      if (Number(swapped) === 1) return { before, after };
    }
    throw new Error(`Could not update user:${userId} — too much concurrent write contention`);
  }

  /**
   * NOTE on ordering: the `lastBillingEventAt` precondition that keeps an
   * out-of-order Stripe event from overwriting a newer one lives in the webhook
   * route, evaluated before this is called. The CAS below protects against LOST
   * UPDATES; it does not re-evaluate that precondition on a retry, so it neither
   * fixes nor worsens the ordering race. Moving that check in here — as
   * setUserAuth does with expectResetTokenHash — is the real fix, and is
   * deliberately left alone: it changes payment behaviour and belongs in its own
   * change.
   */
  async setUserBilling(
    userId: string,
    patch: BillingPatch
  ): Promise<void> {
    const result = await this.patchUser(userId, (user) => ({ ...user, ...patch }));
    if (!result) return;
    if (patch.stripeCustomerId) {
      await this.command(["SET", `user:by-customer:${patch.stripeCustomerId}`, userId]);
    }
  }

  async setUserAuth(
    userId: string,
    patch: AuthPatch,
    expectResetTokenHash?: string
  ): Promise<boolean> {
    const result = await this.patchUser(userId, (user) => {
      // Re-checked on EVERY CAS attempt, against the value that attempt read.
      if (expectResetTokenHash !== undefined && user.resetTokenHash !== expectResetTokenHash) {
        return null;
      }
      const updated: StoredUser = { ...user, ...patch };
      // JSON.stringify drops undefined keys, so an explicit undefined in the
      // patch removes the field from the stored record — that is how a spent
      // token dies.
      if ("resetTokenHash" in patch && !patch.resetTokenHash) {
        delete updated.resetTokenHash;
        delete updated.resetTokenExpiresAt;
      }
      return updated;
    });
    if (!result) return false;
    const user = result.before;
    // Retire the OLD index entry before writing a new one, or a superseded token
    // keeps resolving to this user. Gated on the patch actually ADDRESSING the
    // token: a patch that only moves the expiry must not tear the index out from
    // under a hash the record still carries, or the two disagree about whether a
    // live token exists.
    if ("resetTokenHash" in patch && user.resetTokenHash && user.resetTokenHash !== patch.resetTokenHash) {
      await this.command(["DEL", `user:by-reset:${user.resetTokenHash}`]);
    }
    if (patch.resetTokenHash) {
      await this.command(["SET", `user:by-reset:${patch.resetTokenHash}`, userId]);
    }
    return true;
  }

  async getUserByResetTokenHash(tokenHash: string): Promise<StoredUser | null> {
    const userId = await this.command<string | null>(["GET", `user:by-reset:${tokenHash}`]);
    return userId ? this.getUserById(userId) : null;
  }

  async getUserByStripeCustomerId(customerId: string): Promise<StoredUser | null> {
    const userId = await this.command<string | null>(["GET", `user:by-customer:${customerId}`]);
    return userId ? this.getUserById(userId) : null;
  }

  async getUserInstance(userId: string): Promise<string | null> {
    return this.command<string | null>(["GET", `instance:${userId}`]);
  }

  async setUserInstance(userId: string, instanceId: string): Promise<void> {
    await this.command(["SET", `instance:${userId}`, instanceId]);
  }

  async getUserSession(userId: string): Promise<string | null> {
    return this.command<string | null>(["GET", `chatsession:${userId}`]);
  }

  async getUserSessionVersion(userId: string): Promise<number> {
    const version = await this.command<string | number | null>(["GET", `authversion:${userId}`]);
    return Number(version ?? 0);
  }

  async rotateUserSessionVersion(userId: string): Promise<number> {
    return Number(await this.command<number>(["INCR", `authversion:${userId}`]));
  }

  async beginUserChat(userId: string): Promise<ChatWriteFence> {
    const result = await this.command<[string | number, number]>([
      "EVAL",
      "local g=redis.call('GET',KEYS[1]) or '0'; local s=redis.call('INCR',KEYS[2]); return {g,s}",
      2,
      `historygen:${userId}`,
      `historyseq:${userId}`,
    ]);
    return { generation: Number(result[0]), turnSequence: Number(result[1]) };
  }

  async setUserSessionIfCurrent(
    userId: string,
    sessionId: string,
    generation: number
  ): Promise<boolean> {
    const changed = await this.command<number>([
      "EVAL",
      "local g=redis.call('GET',KEYS[1]) or '0'; if tostring(g)~=ARGV[1] then return 0 end; redis.call('SET',KEYS[2],ARGV[2]); return 1",
      2,
      `historygen:${userId}`,
      `chatsession:${userId}`,
      generation,
      sessionId,
    ]);
    return changed === 1;
  }

  async getUserHistory(userId: string): Promise<StoredChatMessage[]> {
    const rows = await this.command<string[]>(["LRANGE", `history:${userId}`, 0, -1]);
    return orderStoredHistory(rows.map((row) => JSON.parse(row) as StoredChatMessage));
  }

  async appendUserHistory(
    userId: string,
    messages: StoredChatMessage[],
    generation: number
  ): Promise<boolean> {
    if (!messages.length) return true;
    const changed = await this.command<number>([
      "EVAL",
      "local g=redis.call('GET',KEYS[1]) or '0'; if tostring(g)~=ARGV[1] then return 0 end; for i=3,#ARGV do redis.call('RPUSH',KEYS[2],ARGV[i]) end; local raw=redis.call('LRANGE',KEYS[2],0,-1); local rows={}; for i,v in ipairs(raw) do local m=cjson.decode(v); table.insert(rows,{raw=v,idx=i,seq=m.turnSequence,role=m.role}) end; table.sort(rows,function(a,b) if a.seq==nil and b.seq==nil then return a.idx<b.idx end; if a.seq==nil then return true end; if b.seq==nil then return false end; if a.seq~=b.seq then return a.seq<b.seq end; if a.role~=b.role then return a.role=='user' end; return a.idx<b.idx end); redis.call('DEL',KEYS[2]); local first=math.max(1,#rows-tonumber(ARGV[2])+1); for i=first,#rows do redis.call('RPUSH',KEYS[2],rows[i].raw) end; return 1",
      2,
      `historygen:${userId}`,
      `history:${userId}`,
      generation,
      MAX_HISTORY_MESSAGES,
      ...messages.map((message) => JSON.stringify(message)),
    ]);
    return changed === 1;
  }

  async clearUserConversation(userId: string): Promise<void> {
    await this.command([
      "EVAL",
      "redis.call('DEL',KEYS[1]); redis.call('INCR',KEYS[2]); redis.call('DEL',KEYS[3]); return 1",
      3,
      `chatsession:${userId}`,
      `historygen:${userId}`,
      `history:${userId}`,
    ]);
  }

  async getUserPreferences(userId: string): Promise<AssistantPreferences> {
    const raw = await this.command<string | null>(["GET", `preferences:${userId}`]);
    return raw ? (JSON.parse(raw) as AssistantPreferences) : { ...defaultAssistantPreferences };
  }

  async setUserPreferences(userId: string, preferences: AssistantPreferences): Promise<void> {
    await this.command(["SET", `preferences:${userId}`, JSON.stringify(preferences)]);
  }

  async deleteUserData(userId: string): Promise<void> {
    const user = await this.getUserById(userId);
    if (!user) return;
    const keys = [
      `user:${userId}`,
      `user:by-email:${normalizeEmail(user.email)}`,
      `instance:${userId}`,
      `chatsession:${userId}`,
      `history:${userId}`,
      `historyseq:${userId}`,
      `preferences:${userId}`,
      `authversion:${userId}`,
    ];
    if (user.stripeCustomerId) keys.push(`user:by-customer:${user.stripeCustomerId}`);
    if (user.resetTokenHash) keys.push(`user:by-reset:${user.resetTokenHash}`);
    await this.command([
      "EVAL",
      "redis.call('INCR',KEYS[1]); for i=2,#KEYS do redis.call('DEL',KEYS[i]) end; return 1",
      keys.length + 1,
      `historygen:${userId}`,
      ...keys,
    ]);
  }
}

// ── Backend 2: in-memory fallback for local dev ───────────────────────────

export class MemoryStore implements Store {
  private usersById = new Map<string, StoredUser>();
  private userIdByEmail = new Map<string, string>();
  private instanceByUserId = new Map<string, string>();
  private sessionByUserId = new Map<string, string>();
  private sessionVersionByUserId = new Map<string, number>();
  private historyByUserId = new Map<string, StoredChatMessage[]>();
  private historyGenerationByUserId = new Map<string, number>();
  private historySequenceByUserId = new Map<string, number>();
  private preferencesByUserId = new Map<string, AssistantPreferences>();

  private userIdByCustomer = new Map<string, string>();
  private userIdByResetToken = new Map<string, string>();

  async getUserByEmail(email: string): Promise<StoredUser | null> {
    const userId = this.userIdByEmail.get(normalizeEmail(email));
    if (!userId) return null;
    return this.usersById.get(userId) ?? null;
  }

  async getUserById(userId: string): Promise<StoredUser | null> {
    return this.usersById.get(userId) ?? null;
  }

  async createUser(user: StoredUser): Promise<StoredUser | null> {
    const emailKey = normalizeEmail(user.email);
    // Single process + no await between check and set → atomic. Reject dup email.
    if (this.userIdByEmail.has(emailKey)) return null;
    this.usersById.set(user.id, user);
    this.userIdByEmail.set(emailKey, user.id);
    return user;
  }

  async setUserBilling(
    userId: string,
    patch: BillingPatch
  ): Promise<void> {
    const user = this.usersById.get(userId);
    if (!user) return;
    Object.assign(user, patch);
    if (patch.stripeCustomerId) this.userIdByCustomer.set(patch.stripeCustomerId, userId);
  }

  async setUserAuth(
    userId: string,
    patch: AuthPatch,
    expectResetTokenHash?: string
  ): Promise<boolean> {
    const user = this.usersById.get(userId);
    if (!user) return false;
    if (expectResetTokenHash !== undefined && user.resetTokenHash !== expectResetTokenHash) {
      return false;
    }
    // Retiring the old index entry is gated on the patch actually ADDRESSING the
    // token: a patch that only moves the expiry must not tear the index out from
    // under a hash the record still carries.
    if ("resetTokenHash" in patch && user.resetTokenHash && user.resetTokenHash !== patch.resetTokenHash) {
      this.userIdByResetToken.delete(user.resetTokenHash);
    }
    Object.assign(user, patch);
    if ("resetTokenHash" in patch && !patch.resetTokenHash) {
      delete user.resetTokenHash;
      delete user.resetTokenExpiresAt;
    }
    if (patch.resetTokenHash) this.userIdByResetToken.set(patch.resetTokenHash, userId);
    return true;
  }

  async getUserByResetTokenHash(tokenHash: string): Promise<StoredUser | null> {
    const userId = this.userIdByResetToken.get(tokenHash);
    return userId ? this.usersById.get(userId) ?? null : null;
  }

  async getUserByStripeCustomerId(customerId: string): Promise<StoredUser | null> {
    const userId = this.userIdByCustomer.get(customerId);
    return userId ? this.usersById.get(userId) ?? null : null;
  }

  async getUserInstance(userId: string): Promise<string | null> {
    return this.instanceByUserId.get(userId) ?? null;
  }

  async setUserInstance(userId: string, instanceId: string): Promise<void> {
    this.instanceByUserId.set(userId, instanceId);
  }

  async getUserSession(userId: string): Promise<string | null> {
    return this.sessionByUserId.get(userId) ?? null;
  }
  async getUserSessionVersion(userId: string): Promise<number> {
    return this.sessionVersionByUserId.get(userId) ?? 0;
  }
  async rotateUserSessionVersion(userId: string): Promise<number> {
    const version = (this.sessionVersionByUserId.get(userId) ?? 0) + 1;
    this.sessionVersionByUserId.set(userId, version);
    return version;
  }

  async beginUserChat(userId: string): Promise<ChatWriteFence> {
    const generation = this.historyGenerationByUserId.get(userId) ?? 0;
    const turnSequence = (this.historySequenceByUserId.get(userId) ?? 0) + 1;
    this.historySequenceByUserId.set(userId, turnSequence);
    return { generation, turnSequence };
  }

  async setUserSessionIfCurrent(userId: string, sessionId: string, generation: number): Promise<boolean> {
    if ((this.historyGenerationByUserId.get(userId) ?? 0) !== generation) return false;
    this.sessionByUserId.set(userId, sessionId);
    return true;
  }

  async getUserHistory(userId: string): Promise<StoredChatMessage[]> {
    return orderStoredHistory(this.historyByUserId.get(userId) ?? []);
  }
  async appendUserHistory(
    userId: string,
    messages: StoredChatMessage[],
    generation: number
  ): Promise<boolean> {
    if ((this.historyGenerationByUserId.get(userId) ?? 0) !== generation) return false;
    this.historyByUserId.set(
      userId,
      limitStoredHistory(orderStoredHistory([...(this.historyByUserId.get(userId) ?? []), ...messages]))
    );
    return true;
  }
  async clearUserConversation(userId: string): Promise<void> {
    this.sessionByUserId.delete(userId);
    this.historyGenerationByUserId.set(userId, (this.historyGenerationByUserId.get(userId) ?? 0) + 1);
    this.historyByUserId.delete(userId);
  }
  async getUserPreferences(userId: string): Promise<AssistantPreferences> {
    return this.preferencesByUserId.get(userId) ?? { ...defaultAssistantPreferences };
  }
  async setUserPreferences(userId: string, preferences: AssistantPreferences): Promise<void> {
    this.preferencesByUserId.set(userId, preferences);
  }
  async deleteUserData(userId: string): Promise<void> {
    const user = this.usersById.get(userId);
    if (!user) return;
    this.usersById.delete(userId);
    this.userIdByEmail.delete(normalizeEmail(user.email));
    if (user.stripeCustomerId) this.userIdByCustomer.delete(user.stripeCustomerId);
    if (user.resetTokenHash) this.userIdByResetToken.delete(user.resetTokenHash);
    this.instanceByUserId.delete(userId);
    this.sessionByUserId.delete(userId);
    this.sessionVersionByUserId.delete(userId);
    this.historyByUserId.delete(userId);
    this.historySequenceByUserId.delete(userId);
    this.preferencesByUserId.delete(userId);
    this.historyGenerationByUserId.set(userId, (this.historyGenerationByUserId.get(userId) ?? 0) + 1);
  }
}

// ── Backend 3: JSON-file store (persistent disk, no Redis) ────────────────
//
// The whole dataset is small (one row per signed-up user), so we keep it in
// memory and persist the entire snapshot to a single JSON file on every write.
// Writes are serialized through a promise chain and committed atomically
// (write temp → rename) so a crash mid-write can't corrupt the file. A single
// `next start` process owns the file; do not point two processes at the same
// STORE_DIR.

interface FileSnapshot {
  usersById: Record<string, StoredUser>;
  userIdByEmail: Record<string, string>;
  userIdByCustomer: Record<string, string>;
  /** Optional: absent in snapshots written before password reset existed. */
  userIdByResetToken?: Record<string, string>;
  instanceByUserId: Record<string, string>;
  sessionByUserId: Record<string, string>;
  sessionVersionByUserId: Record<string, number>;
  historyByUserId: Record<string, StoredChatMessage[]>;
  historyGenerationByUserId: Record<string, number>;
  historySequenceByUserId: Record<string, number>;
  preferencesByUserId: Record<string, AssistantPreferences>;
}

function emptySnapshot(): FileSnapshot {
  return {
    usersById: {},
    userIdByEmail: {},
    userIdByCustomer: {},
    instanceByUserId: {},
    sessionByUserId: {},
    sessionVersionByUserId: {},
    historyByUserId: {},
    historyGenerationByUserId: {},
    historySequenceByUserId: {},
    preferencesByUserId: {},
  };
}

/** A file identity, or `null` for "definitely absent". The object form is a
 *  marker that never compares equal to anything, used when we could not find
 *  out — an unreadable stat must never be mistaken for an absent file. */
type Stamp = string | null | { unknown: string };

function sameStamp(a: Stamp, b: Stamp): boolean {
  if (typeof a === "object" && a !== null) return false;
  if (typeof b === "object" && b !== null) return false;
  return a === b;
}

export class FileStore implements Store {
  private readonly dir: string;
  private readonly file: string;
  private snapshot: FileSnapshot | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  /** Serializes load(), so only one reader inspects or replaces `snapshot` at a
   *  time. See the note on load(). */
  private loadChain: Promise<unknown> = Promise.resolve();
  /** Stamp of the contents currently held in `snapshot`, set only from a read
   *  that SUCCEEDED or a write we know landed. */
  private loadedStamp: Stamp = null;

  constructor(dir: string) {
    this.dir = dir;
    this.file = path.join(dir, "store.json");
  }

  /**
   * Identity of the file's current contents: nanosecond mtime, size and inode.
   *
   * Nanoseconds and inode both matter. A password-only rewrite changes neither
   * the size (hashes are fixed-length hex) nor, necessarily, a millisecond
   * timestamp, so `mtimeMs` alone can miss the one edit this exists to catch;
   * and the atomic write-then-rename replaces the file rather than modifying it,
   * which only the inode reveals.
   *
   * `null` means DEFINITELY absent, and nothing else may return it. A stat that
   * fails for any other reason returns an unequal-to-everything marker instead:
   * treating an EIO as "no file" would let a write conclude there is nothing to
   * conflict with and rename over a file that is very much there.
   */
  private async fileStamp(): Promise<Stamp> {
    try {
      const stat = await fs.stat(this.file, { bigint: true });
      return `${stat.mtimeNs}:${stat.size}:${stat.ino}`;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      return { unknown: (err as NodeJS.ErrnoException).code ?? "error" };
    }
  }

  /**
   * The current snapshot, re-read if the file changed underneath us.
   *
   * The snapshot caches a file another process can legitimately rewrite:
   * `npm run reset-password` does exactly that, deliberately, while this server
   * runs. Without the stamp check the reset is invisible — the new password sits
   * on disk while the process serves the old one — and the next write here would
   * serialize the stale snapshot back over it, undoing the reset entirely.
   *
   * Serialized through `loadChain` because the check is not atomic on its own:
   * fileStamp() awaits, so two callers could both observe the change, both drop
   * the cache and both read, ending up with two different snapshot objects
   * parsed from one file.
   */
  private load(): Promise<FileSnapshot> {
    const run = this.loadChain.catch(() => {}).then(() => this.loadOnce());
    this.loadChain = run.catch(() => {});
    return run;
  }

  private async loadOnce(): Promise<FileSnapshot> {
    // Taken BEFORE the read on purpose. A write landing between this stat and
    // the readFile leaves us holding content newer than the stamp we record, so
    // the next load sees a mismatch and re-reads. Stamping AFTER the read would
    // pair new metadata with possibly-old content and hide the staleness.
    const stamp = await this.fileStamp();
    if (this.snapshot && sameStamp(stamp, this.loadedStamp)) return this.snapshot;

    try {
      const raw = await fs.readFile(this.file, "utf8");
      this.snapshot = { ...emptySnapshot(), ...(JSON.parse(raw) as Partial<FileSnapshot>) };
      // Only a successful read earns the stamp. Recording it after a FAILED read
      // would label the snapshot we still hold with the stamp of a file we never
      // managed to read; every later load would then match, never read again, and
      // one transient EMFILE would hide a foreign change for the life of the
      // process.
      this.loadedStamp = stamp;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.snapshot = this.snapshot ?? emptySnapshot();
        this.loadedStamp = null;
      } else {
        console.error(`[store] failed to read ${this.file}:`, err);
        // Keep serving what we have rather than presenting the storefront as
        // empty, and leave the stamp alone so the next operation tries again.
        this.snapshot = this.snapshot ?? emptySnapshot();
      }
    }
    return this.snapshot;
  }

  /**
   * Apply `apply` to the store and commit it, atomically with respect to every
   * other writer — in this process and outside it.
   *
   * Three things make that true, and each one is load-bearing:
   *
   * 1. The load happens INSIDE the write lock. Loading first and writing later
   *    leaves a gap that swallows a reset committed by `npm run reset-password`,
   *    because the request then writes its whole stale snapshot back. On a busy
   *    storefront that gap is open constantly — every chat message persists
   *    twice.
   * 2. The mutation is applied to a COPY, and the copy replaces the cache only
   *    after the bytes are on disk. Mutating the shared snapshot in place would
   *    let a concurrent reader observe a change whose write then fails, and
   *    would leave that phantom in memory to be committed later by an unrelated
   *    successful write.
   * 3. writeSnapshot re-checks the file immediately before renaming and reports
   *    a conflict rather than committing, and the mutation is re-applied to the
   *    new state. `apply` therefore always runs against current state, which is
   *    why re-running it is safe: each attempt recomputes from what it is handed
   *    (a version bump, a turn sequence, an email claim) rather than replaying a
   *    precomputed value. It must stay SYNCHRONOUS for the same reason — an
   *    await inside it would reopen the gap it exists to close.
   *
   * A write is also isolated from its predecessors' outcome: a transient failure
   * (ENOSPC, EACCES) must not poison the chain and silently drop every later
   * write, so the chain is kept resolved while the error goes to this caller.
   */
  private mutate<T>(apply: (snap: FileSnapshot) => T): Promise<T> {
    const run = this.writeChain.catch(() => {}).then(async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const current = await this.load();
        // Capture the stamp that belongs to what we just loaded. Comparing
        // against the mutable field at write time would let a concurrent reader
        // move it and make a stale write look current.
        const stampAtLoad = this.loadedStamp;
        const working = structuredClone(current);
        const result = apply(working);
        if (await this.writeSnapshot(working, stampAtLoad)) return result;
        // Someone rewrote the file while we were writing. Re-read and redo the
        // mutation on top of what they wrote.
        this.loadedStamp = { unknown: "conflict" };
      }
      throw new Error(
        `[store] gave up writing ${this.file}: another process kept rewriting it. Nothing was changed.`
      );
    });
    this.writeChain = run.then(() => {}, () => {});
    return run;
  }

  /** The write half of mutate(); not to be called outside the write lock.
   *  Returns false, having written nothing, if the file changed since it was
   *  loaded. */
  private async writeSnapshot(snap: FileSnapshot, stampAtLoad: Stamp): Promise<boolean> {
    // Random suffix rather than the pid: STORE_DIR can be bind-mounted, so a
    // process on the host and one in the container can share a pid and would
    // otherwise collide on this path.
    const tmp = `${this.file}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await fs.mkdir(this.dir, { recursive: true });
      await fs.writeFile(tmp, JSON.stringify(snap), "utf8");
      const writtenIno = (await fs.stat(tmp, { bigint: true })).ino;

      // Last check before committing. Serializing takes real time and a reset
      // can land inside it; renaming over that would erase a reset the owner was
      // already told had succeeded. A sliver remains between this stat and the
      // rename — closing it needs a lock file, and the CLI guards the mirror
      // image of the same window from its side.
      if (!sameStamp(await this.fileStamp(), stampAtLoad)) {
        await fs.rm(tmp, { force: true }).catch(() => {});
        return false;
      }
      await fs.rename(tmp, this.file);

      // Adopt the copy only now that it is durable. If another process replaced
      // the file between our rename and this stat, the inode is not the one we
      // created — trusting that stamp would pin our snapshot to someone else's
      // file and hide their change permanently, so force a re-read instead.
      this.snapshot = snap;
      const stat = await fs.stat(this.file, { bigint: true }).catch(() => null);
      this.loadedStamp =
        stat && stat.ino === writtenIno
          ? `${stat.mtimeNs}:${stat.size}:${stat.ino}`
          : { unknown: "raced" };
      return true;
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  async getUserByEmail(email: string): Promise<StoredUser | null> {
    const snap = await this.load();
    const userId = snap.userIdByEmail[normalizeEmail(email)];
    if (!userId) return null;
    return snap.usersById[userId] ?? null;
  }

  async getUserById(userId: string): Promise<StoredUser | null> {
    const snap = await this.load();
    return snap.usersById[userId] ?? null;
  }

  async createUser(user: StoredUser): Promise<StoredUser | null> {
    // The duplicate check and the claim both happen inside mutate(), against a
    // snapshot loaded under the write lock, so they are atomic against every
    // other writer — including a concurrent signup for the same address. The
    // verdict is RETURNED rather than captured in an outer variable, because a
    // retry re-runs this against fresh state and must be able to reach a
    // different answer.
    return this.mutate((snap) => {
      const emailKey = normalizeEmail(user.email);
      if (snap.userIdByEmail[emailKey]) return null;
      snap.usersById[user.id] = user;
      snap.userIdByEmail[emailKey] = user.id;
      return user;
    });
  }

  async setUserBilling(
    userId: string,
    patch: BillingPatch
  ): Promise<void> {
    await this.mutate((snap) => {
      const user = snap.usersById[userId];
      if (!user) return;
      snap.usersById[userId] = { ...user, ...patch };
      if (patch.stripeCustomerId) snap.userIdByCustomer[patch.stripeCustomerId] = userId;
    });
  }

  async setUserAuth(
    userId: string,
    patch: AuthPatch,
    expectResetTokenHash?: string
  ): Promise<boolean> {
    return this.mutate((snap) => {
      const user = snap.usersById[userId];
      if (!user) return false;
      // Evaluated against the snapshot loaded under the write lock, so the token
      // cannot be spent or replaced between this check and the write.
      if (expectResetTokenHash !== undefined && user.resetTokenHash !== expectResetTokenHash) {
        return false;
      }
      const updated: StoredUser = { ...user, ...patch };
      if ("resetTokenHash" in patch && !patch.resetTokenHash) {
        delete updated.resetTokenHash;
        delete updated.resetTokenExpiresAt;
      }
      snap.usersById[userId] = updated;
      if ("resetTokenHash" in patch && user.resetTokenHash && user.resetTokenHash !== patch.resetTokenHash) {
        delete snap.userIdByResetToken?.[user.resetTokenHash];
      }
      if (patch.resetTokenHash) {
        snap.userIdByResetToken = snap.userIdByResetToken || {};
        snap.userIdByResetToken[patch.resetTokenHash] = userId;
      }
      return true;
    });
  }

  async getUserByResetTokenHash(tokenHash: string): Promise<StoredUser | null> {
    const snap = await this.load();
    const userId = snap.userIdByResetToken?.[tokenHash];
    return userId ? snap.usersById[userId] ?? null : null;
  }

  async getUserByStripeCustomerId(customerId: string): Promise<StoredUser | null> {
    const snap = await this.load();
    const userId = snap.userIdByCustomer[customerId];
    return userId ? snap.usersById[userId] ?? null : null;
  }

  async getUserInstance(userId: string): Promise<string | null> {
    const snap = await this.load();
    return snap.instanceByUserId[userId] ?? null;
  }

  async setUserInstance(userId: string, instanceId: string): Promise<void> {
    await this.mutate((snap) => { snap.instanceByUserId[userId] = instanceId; });
  }

  async getUserSession(userId: string): Promise<string | null> {
    const snap = await this.load();
    return snap.sessionByUserId[userId] ?? null;
  }

  async getUserSessionVersion(userId: string): Promise<number> {
    const snap = await this.load();
    return snap.sessionVersionByUserId[userId] ?? 0;
  }

  async rotateUserSessionVersion(userId: string): Promise<number> {
    return this.mutate((snap) => {
      const version = (snap.sessionVersionByUserId[userId] ?? 0) + 1;
      snap.sessionVersionByUserId[userId] = version;
      return version;
    });
  }

  async beginUserChat(userId: string): Promise<ChatWriteFence> {
    return this.mutate((snap) => {
      const generation = snap.historyGenerationByUserId[userId] ?? 0;
      const turnSequence = (snap.historySequenceByUserId[userId] ?? 0) + 1;
      snap.historySequenceByUserId[userId] = turnSequence;
      return { generation, turnSequence };
    });
  }

  async setUserSessionIfCurrent(
    userId: string,
    sessionId: string,
    generation: number
  ): Promise<boolean> {
    return this.mutate((snap) => {
      if ((snap.historyGenerationByUserId[userId] ?? 0) !== generation) return false;
      snap.sessionByUserId[userId] = sessionId;
      return true;
    });
  }

  async getUserHistory(userId: string): Promise<StoredChatMessage[]> {
    const snap = await this.load();
    return orderStoredHistory(snap.historyByUserId[userId] ?? []);
  }

  async appendUserHistory(
    userId: string,
    messages: StoredChatMessage[],
    generation: number
  ): Promise<boolean> {
    return this.mutate((snap) => {
      if ((snap.historyGenerationByUserId[userId] ?? 0) !== generation) return false;
      snap.historyByUserId[userId] = limitStoredHistory(orderStoredHistory([
        ...(snap.historyByUserId[userId] ?? []),
        ...messages,
      ]));
      return true;
    });
  }

  async clearUserConversation(userId: string): Promise<void> {
    await this.mutate((snap) => {
      delete snap.sessionByUserId[userId];
      snap.historyGenerationByUserId[userId] = (snap.historyGenerationByUserId[userId] ?? 0) + 1;
      delete snap.historyByUserId[userId];
    });
  }

  async getUserPreferences(userId: string): Promise<AssistantPreferences> {
    const snap = await this.load();
    return snap.preferencesByUserId[userId] ?? { ...defaultAssistantPreferences };
  }

  async setUserPreferences(userId: string, preferences: AssistantPreferences): Promise<void> {
    await this.mutate((snap) => { snap.preferencesByUserId[userId] = preferences; });
  }

  async deleteUserData(userId: string): Promise<void> {
    await this.mutate((snap) => {
      const user = snap.usersById[userId];
      if (!user) return;
      delete snap.usersById[userId];
      delete snap.userIdByEmail[normalizeEmail(user.email)];
      if (user.stripeCustomerId) delete snap.userIdByCustomer[user.stripeCustomerId];
      if (user.resetTokenHash) delete snap.userIdByResetToken?.[user.resetTokenHash];
      delete snap.instanceByUserId[userId];
      delete snap.sessionByUserId[userId];
      delete snap.sessionVersionByUserId[userId];
      delete snap.historyByUserId[userId];
      delete snap.historySequenceByUserId[userId];
      delete snap.preferencesByUserId[userId];
      snap.historyGenerationByUserId[userId] =
        (snap.historyGenerationByUserId[userId] ?? 0) + 1;
    });
  }
}

// ── Factory ────────────────────────────────────────────────────────────

let cachedStore: Store | null = null;

export function getStore(): Store {
  if (cachedStore) return cachedStore;

  if (upstash.url && upstash.token) {
    cachedStore = new UpstashStore(upstash.url, upstash.token);
  } else if (storeDir) {
    cachedStore = new FileStore(storeDir);
  } else {
    console.warn(
      "[store] Using in-memory store — data resets on restart; set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (or STORE_DIR) for production."
    );
    cachedStore = new MemoryStore();
  }

  return cachedStore;
}
