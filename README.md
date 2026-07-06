# Self-Serve Bot Starter

A standalone Next.js 15 starter for **resellers** of OpenClaw Launch. Deploy this
app, and every one of your end-users signs up and gets their **own** AI
assistant to chat with — powered by OpenClaw Launch's Build & Resell API.

This template is fully self-contained. It does not import anything from the
main OpenClaw Launch app and can be copied out into its own git repo and
deployed on its own.

## How it works

```
  visitor                    your server                  OpenClaw Launch
  -------                    -----------                  ---------------
  1. Sign up  ─────────▶  POST /api/auth/signup
                           (hashes password, sets
                            session cookie)

  2. Land on /app  ────▶  POST /api/provision  ─────────▶  POST /v1/instances
                           (idempotent — creates              (creates a bot,
                            the user's bot on first             ~30-90s to boot)
                            call, polls status on
                            every call after)        ◀─────  {id, status, ...}

  3. Chat  ────────────▶  POST /api/chat  ───────────────▶  POST /v1/responses
                           (looks up the user's                (SSE stream)
                            instance + session id,
                            pipes the SSE stream         ◀─────  data: {...}
                            straight through, persists           data: [DONE]
                            x-openclaw-session-id
                            for the next turn)
```

Every user gets exactly one bot instance (`lib/store.ts` maps
`userId → instanceId`), and every bot conversation keeps multi-turn memory via
the `session_id` returned in the `x-openclaw-session-id` response header,
which is persisted per-user and replayed on the next chat turn.

## Setup (3 steps)

### 1. Get your Build & Resell API key

Grab your `sk_live_...` key from your OpenClaw Launch **Build & Resell**
dashboard and set it as `BUILD_RESELL_API_KEY`. This key is **server-side
only** — it is read exclusively in `lib/buildResell.ts` (a server module) and
is never sent to the browser. Never prefix it with `NEXT_PUBLIC_`.

### 2. Add persistence (Upstash Redis or Vercel KV)

Create a free [Upstash Redis](https://upstash.com) database (Vercel's KV
integration is Upstash under the hood — either works identically here) and
copy its REST URL + token into:

```
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
```

If these are left empty, the app falls back to an **in-memory store** — fine
for `npm run dev`, but data resets every time the process restarts. Do not
run production on the in-memory store.

### 3. Rebrand

Everything user-facing is driven by env vars, read in `lib/config.ts`:

```
BRAND_NAME=YourBrand       # shown in nav, hero, page titles
BRAND_ACCENT=#4f46e5       # single accent color used across the whole UI
BOT_FRAMEWORK=openclaw     # or "hermes" — which framework new bots use
```

No code changes needed to reskin the app for a new reseller.

## Charging your customers (optional payment gate)

By default the app runs in NO-PAYMENT mode: a new signup provisions a bot
immediately (great for demoing). Set your Stripe keys and the app turns
`signup → pay → provision`, charging your end users on YOUR OWN Stripe — the
markup over the ~$6/deploy you pay OpenClaw Launch is yours to keep.

1. Create a Product + Price in your Stripe dashboard. Recurring Price →
   `STRIPE_MODE=subscription`; one-time Price → `STRIPE_MODE=payment`.
2. Set `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `APP_URL` (your storefront's
   public URL), and — for subscription mode — `STRIPE_WEBHOOK_SECRET`.
3. Add a webhook endpoint in Stripe pointing at
   `https://your-storefront/api/stripe/webhook`, subscribed to:
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`, `invoice.paid`,
   `invoice.payment_failed`, `customer.subscription.deleted`. Copy its signing
   secret (`whsec_…`) into `STRIPE_WEBHOOK_SECRET`.
4. To test locally, forward events to your dev server:

   ```bash
   stripe listen --forward-to localhost:3000/api/stripe/webhook
   ```

   Pay with Stripe's test card `4242 4242 4242 4242` (any future expiry / CVC).

Entitlement is enforced server-side: `/api/provision` and `/api/chat` both
return `402` unless the user is `active`, so the paywall can't be bypassed by
crafting requests. Activation happens two ways for robustness — the success-page
redirect verifies the Checkout session server-side (instant, no webhook needed),
and the webhook keeps `billingStatus` in sync on renewals/cancellations.

## Local development

```bash
npm install
cp .env.example .env.local   # then fill in the values above
npm run dev
```

Open http://localhost:3000.

## Deploy to Vercel

1. Push this directory to its own git repo — TODO: (operator to publish the
   canonical starter repo URL here).
2. Import it into [Vercel](https://vercel.com/new).
3. Add the environment variables from `.env.example` in the Vercel project
   settings (Production + Preview).
4. Attach a Vercel KV / Upstash Redis integration for persistence.
5. Deploy.

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `BRAND_NAME` | no (defaults to `YourBrand`) | Shown throughout the UI |
| `BRAND_ACCENT` | no (defaults to `#4f46e5`) | Single accent color, hex |
| `BOT_FRAMEWORK` | no (defaults to `openclaw`) | `openclaw` or `hermes` |
| `BUILD_RESELL_API_BASE` | no (defaults to `https://openclawlaunch.com/api/v1`) | |
| `BUILD_RESELL_API_KEY` | **yes** | Server-side secret. Never exposed to the browser. |
| `SESSION_SECRET` | **yes** | Long random string used to HMAC-sign session cookies. |
| `UPSTASH_REDIS_REST_URL` | prod (or `STORE_DIR`) | Persistent store + shared rate-limit counter. Falls back to in-memory if unset. |
| `UPSTASH_REDIS_REST_TOKEN` | prod (or `STORE_DIR`) | Pairs with the URL above. |
| `STORE_DIR` | alt to Upstash | Writable dir for the JSON-file store, for a persistent-disk host with no Redis. One process per dir. |
| `STRIPE_SECRET_KEY` | for payments | Your Stripe secret (`sk_live_…`/`sk_test_…`). Unset + `STRIPE_PRICE_ID` unset ⇒ NO-PAYMENT demo mode. |
| `STRIPE_PRICE_ID` | for payments | The Stripe Price your customers buy (`price_…`). |
| `STRIPE_MODE` | no (defaults to `subscription`) | `subscription` (recurring) or `payment` (one-time). Must match the Price. |
| `STRIPE_WEBHOOK_SECRET` | subscription mode | `whsec_…` — required so renewals/cancellations sync. |
| `APP_URL` | for payments | This storefront's public URL, for Stripe redirect URLs. |

In production the app validates these at startup (`lib/config.ts` → `instrumentation.ts`) and refuses to boot with a clear error if a required one is missing.

## Project structure

```
app/
  page.tsx                 Landing page (Option A: clean minimal SaaS)
  signup/page.tsx           Sign-up form
  login/page.tsx            Log-in form
  app/page.tsx               Authed area (server guard) → ChatApp.tsx (client)
  app/ChatApp.tsx            Provisioning + streaming chat UI
  api/auth/signup/route.ts   Create account + session cookie
  api/auth/login/route.ts    Verify credentials + session cookie
  api/auth/logout/route.ts   Clear session cookie
  api/provision/route.ts     Idempotent bot creation + status polling (payment-gated)
  api/chat/route.ts          SSE passthrough to the Build & Resell API (payment-gated)
  api/checkout/route.ts      Start a Stripe Checkout session
  api/stripe/webhook/route.ts  Stripe webhook → keeps billingStatus in sync
lib/
  config.ts                 Brand + API wiring + startup env validation, all from env
  session.ts                 Hand-rolled HMAC-signed cookie session
  password.ts                 scrypt password hashing
  store.ts                     Pluggable persistence (Upstash / JSON-file / in-memory)
  buildResell.ts                Server-only Build & Resell API client
  billing.ts                    Verify a Checkout session + activate the user
  rateLimit.ts                  Fixed-window limiter (Upstash / in-memory)
instrumentation.ts          Boot hook → validates env in production
```

## Security notes

- `BUILD_RESELL_API_KEY` is read only inside `lib/buildResell.ts`, which is
  only ever imported from Route Handlers (server code) — it never reaches
  client bundles.
- Sessions are signed httpOnly cookies (HMAC-SHA256 via `node:crypto`), not
  JWTs from a third-party library — no extra dependency, no attack surface
  beyond what's in this repo.
- Passwords are hashed with `scrypt` + a random salt per user (also
  `node:crypto`, no external dependency).
- Public routes are rate-limited (`lib/rateLimit.ts`): login/signup by IP, and
  provision/chat/checkout by user id — so a script can't brute-force logins,
  spam signups, or run up your bot/LLM bill. Backed by Upstash when configured
  (shared across serverless instances), in-memory otherwise.

## Production checklist

Before pointing real customers at your storefront:

- [ ] `SESSION_SECRET` set to a long random string (not the placeholder).
- [ ] A persistent store configured — Upstash (`UPSTASH_REDIS_REST_*`) or
      `STORE_DIR`. The in-memory fallback loses every account on restart.
- [ ] `APP_URL` set to your real public URL.
- [ ] Upstash configured if you run more than one process/instance, so the
      rate-limit counter is shared (in-memory limits are per-process).
- [ ] Payments (if used): `STRIPE_SECRET_KEY` + `STRIPE_PRICE_ID` set, the
      webhook endpoint added with `STRIPE_WEBHOOK_SECRET`, and a real test
      purchase completed end-to-end.
- [ ] Your own Privacy Policy + Terms linked (you are the merchant of record for
      your customers' payments).

In production the app validates the first three (and the Stripe webhook secret in
subscription mode) at startup and refuses to boot with a clear error if any are
missing.
