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

export interface StoredUser {
  id: string;
  email: string;
  passwordHash: string;
  passwordSalt: string;
  createdAt: string;
  /** Stripe customer id, set the first time the user starts checkout. */
  stripeCustomerId?: string;
  /** Billing state gating provisioning. 'active' = paid & entitled; 'canceled'
   *  = was paid, subscription lapsed (access revoked); 'none'/undefined = never
   *  paid. In NO-PAYMENT mode (Stripe unconfigured) this is ignored. */
  billingStatus?: "active" | "canceled" | "none";
  /** Unix-seconds `created` of the last billing event applied from a webhook.
   *  The webhook ignores events older than this, so a replayed/out-of-order
   *  activate can't override a newer revoke. */
  lastBillingEventAt?: number;
}

export interface Store {
  getUserByEmail(email: string): Promise<StoredUser | null>;
  getUserById(userId: string): Promise<StoredUser | null>;
  createUser(user: StoredUser): Promise<StoredUser>;
  /** Set the user's Stripe customer id and/or billing status (payment webhook). */
  setUserBilling(
    userId: string,
    patch: Partial<Pick<StoredUser, "stripeCustomerId" | "billingStatus" | "lastBillingEventAt">>
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
  setUserSession(userId: string, sessionId: string): Promise<void>;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// ── Backend 1: Upstash Redis via REST (plain fetch, no SDK) ──────────────

class UpstashStore implements Store {
  constructor(
    private readonly url: string,
    private readonly token: string
  ) {}

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

  async createUser(user: StoredUser): Promise<StoredUser> {
    const emailKey = `user:by-email:${normalizeEmail(user.email)}`;
    await this.command(["SET", `user:${user.id}`, JSON.stringify(user)]);
    await this.command(["SET", emailKey, user.id]);
    return user;
  }

  async setUserBilling(
    userId: string,
    patch: Partial<Pick<StoredUser, "stripeCustomerId" | "billingStatus" | "lastBillingEventAt">>
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

  async setUserSession(userId: string, sessionId: string): Promise<void> {
    await this.command(["SET", `chatsession:${userId}`, sessionId]);
  }
}

// ── Backend 2: in-memory fallback for local dev ───────────────────────────

class MemoryStore implements Store {
  private usersById = new Map<string, StoredUser>();
  private userIdByEmail = new Map<string, string>();
  private instanceByUserId = new Map<string, string>();
  private sessionByUserId = new Map<string, string>();

  private userIdByCustomer = new Map<string, string>();

  async getUserByEmail(email: string): Promise<StoredUser | null> {
    const userId = this.userIdByEmail.get(normalizeEmail(email));
    if (!userId) return null;
    return this.usersById.get(userId) ?? null;
  }

  async getUserById(userId: string): Promise<StoredUser | null> {
    return this.usersById.get(userId) ?? null;
  }

  async createUser(user: StoredUser): Promise<StoredUser> {
    this.usersById.set(user.id, user);
    this.userIdByEmail.set(normalizeEmail(user.email), user.id);
    return user;
  }

  async setUserBilling(
    userId: string,
    patch: Partial<Pick<StoredUser, "stripeCustomerId" | "billingStatus" | "lastBillingEventAt">>
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

  async setUserSession(userId: string, sessionId: string): Promise<void> {
    this.sessionByUserId.set(userId, sessionId);
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
}

function emptySnapshot(): FileSnapshot {
  return { usersById: {}, userIdByEmail: {}, userIdByCustomer: {}, instanceByUserId: {}, sessionByUserId: {} };
}

class FileStore implements Store {
  private readonly file: string;
  private snapshot: FileSnapshot | null = null;
  private loadPromise: Promise<FileSnapshot> | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string) {
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

  async createUser(user: StoredUser): Promise<StoredUser> {
    const snap = await this.load();
    snap.usersById[user.id] = user;
    snap.userIdByEmail[normalizeEmail(user.email)] = user.id;
    await this.persist();
    return user;
  }

  async setUserBilling(
    userId: string,
    patch: Partial<Pick<StoredUser, "stripeCustomerId" | "billingStatus" | "lastBillingEventAt">>
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

  async setUserSession(userId: string, sessionId: string): Promise<void> {
    const snap = await this.load();
    snap.sessionByUserId[userId] = sessionId;
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
