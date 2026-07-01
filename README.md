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
| `SESSION_SECRET` | **yes** | Random string used to HMAC-sign session cookies. |
| `UPSTASH_REDIS_REST_URL` | recommended for prod | Falls back to in-memory store if unset |
| `UPSTASH_REDIS_REST_TOKEN` | recommended for prod | Falls back to in-memory store if unset |

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
  api/provision/route.ts     Idempotent bot creation + status polling
  api/chat/route.ts          SSE passthrough to the Build & Resell API
lib/
  config.ts                 Brand + API wiring, all from env
  session.ts                 Hand-rolled HMAC-signed cookie session
  password.ts                 scrypt password hashing
  store.ts                     Pluggable persistence (Upstash / in-memory)
  buildResell.ts                Server-only Build & Resell API client
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
