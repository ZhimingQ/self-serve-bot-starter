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
}

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

class UpstashStore implements Store {
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

  async setUserBilling(
    userId: string,
    patch: BillingPatch
  ): Promise<void> {
    const user = await this.getUserById(userId);
    if (!user) return;
    const updated: StoredUser = { ...user, ...patch };
    await this.command(["SET", `user:${userId}`, JSON.stringify(updated)]);
    if (patch.stripeCustomerId) {
      await this.command(["SET", `user:by-customer:${patch.stripeCustomerId}`, userId]);
    }
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

export class FileStore implements Store {
  private readonly dir: string;
  private readonly file: string;
  private snapshot: FileSnapshot | null = null;
  private loadPromise: Promise<FileSnapshot> | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(dir: string) {
    this.dir = dir;
    this.file = path.join(dir, "store.json");
  }

  private async load(): Promise<FileSnapshot> {
    if (this.snapshot) return this.snapshot;
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        try {
          const raw = await fs.readFile(this.file, "utf8");
          this.snapshot = { ...emptySnapshot(), ...(JSON.parse(raw) as Partial<FileSnapshot>) };
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            console.error(`[store] failed to read ${this.file}, starting empty:`, err);
          }
          this.snapshot = emptySnapshot();
        }
        return this.snapshot;
      })();
    }
    return this.loadPromise;
  }

  /** Serialize + atomically persist the current snapshot. Each write waits for
   *  the previous one but is isolated from its outcome — a transient failure
   *  (e.g. ENOSPC) must NOT poison the chain and silently drop every later
   *  write. `run` surfaces THIS write's own error to its caller; the chain
   *  itself is kept resolved for the next writer. */
  private persist(): Promise<void> {
    const run = this.writeChain.catch(() => {}).then(async () => {
      const snap = this.snapshot ?? emptySnapshot();
      await fs.mkdir(this.dir, { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(snap), "utf8");
      await fs.rename(tmp, this.file);
    });
    this.writeChain = run.catch(() => {});
    return run;
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
    const snap = await this.load();
    const emailKey = normalizeEmail(user.email);
    // Single process owns the file; the check + mutate below run without an
    // intervening await, so they're atomic. Reject a duplicate email.
    if (snap.userIdByEmail[emailKey]) return null;
    snap.usersById[user.id] = user;
    snap.userIdByEmail[emailKey] = user.id;
    await this.persist();
    return user;
  }

  async setUserBilling(
    userId: string,
    patch: BillingPatch
  ): Promise<void> {
    const snap = await this.load();
    const user = snap.usersById[userId];
    if (!user) return;
    snap.usersById[userId] = { ...user, ...patch };
    if (patch.stripeCustomerId) snap.userIdByCustomer[patch.stripeCustomerId] = userId;
    await this.persist();
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
    const snap = await this.load();
    snap.instanceByUserId[userId] = instanceId;
    await this.persist();
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
    const snap = await this.load();
    const version = (snap.sessionVersionByUserId[userId] ?? 0) + 1;
    snap.sessionVersionByUserId[userId] = version;
    await this.persist();
    return version;
  }

  async beginUserChat(userId: string): Promise<ChatWriteFence> {
    const snap = await this.load();
    const generation = snap.historyGenerationByUserId[userId] ?? 0;
    const turnSequence = (snap.historySequenceByUserId[userId] ?? 0) + 1;
    snap.historySequenceByUserId[userId] = turnSequence;
    await this.persist();
    return { generation, turnSequence };
  }

  async setUserSessionIfCurrent(
    userId: string,
    sessionId: string,
    generation: number
  ): Promise<boolean> {
    const snap = await this.load();
    if ((snap.historyGenerationByUserId[userId] ?? 0) !== generation) return false;
    snap.sessionByUserId[userId] = sessionId;
    await this.persist();
    return true;
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
    const snap = await this.load();
    if ((snap.historyGenerationByUserId[userId] ?? 0) !== generation) return false;
    snap.historyByUserId[userId] = limitStoredHistory(orderStoredHistory([
      ...(snap.historyByUserId[userId] ?? []),
      ...messages,
    ]));
    await this.persist();
    return true;
  }

  async clearUserConversation(userId: string): Promise<void> {
    const snap = await this.load();
    delete snap.sessionByUserId[userId];
    snap.historyGenerationByUserId[userId] = (snap.historyGenerationByUserId[userId] ?? 0) + 1;
    delete snap.historyByUserId[userId];
    await this.persist();
  }

  async getUserPreferences(userId: string): Promise<AssistantPreferences> {
    const snap = await this.load();
    return snap.preferencesByUserId[userId] ?? { ...defaultAssistantPreferences };
  }

  async setUserPreferences(userId: string, preferences: AssistantPreferences): Promise<void> {
    const snap = await this.load();
    snap.preferencesByUserId[userId] = preferences;
    await this.persist();
  }

  async deleteUserData(userId: string): Promise<void> {
    const snap = await this.load();
    const user = snap.usersById[userId];
    if (!user) return;
    delete snap.usersById[userId];
    delete snap.userIdByEmail[normalizeEmail(user.email)];
    if (user.stripeCustomerId) delete snap.userIdByCustomer[user.stripeCustomerId];
    delete snap.instanceByUserId[userId];
    delete snap.sessionByUserId[userId];
    delete snap.sessionVersionByUserId[userId];
    delete snap.historyByUserId[userId];
    delete snap.historySequenceByUserId[userId];
    delete snap.preferencesByUserId[userId];
    snap.historyGenerationByUserId[userId] = (snap.historyGenerationByUserId[userId] ?? 0) + 1;
    await this.persist();
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
