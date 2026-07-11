import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getStore } from "../../../../lib/store";
import { hashPassword } from "../../../../lib/password";
import { setSession } from "../../../../lib/session";
import { rateLimit, clientIp } from "../../../../lib/rateLimit";
import { demoMode } from "../../../../lib/config";

export async function POST(request: NextRequest) {
  // Live-demo guard: in DEMO_MODE this storefront is a public showcase, so signup
  // is hard-off — no account is ever created, so no bot is ever provisioned.
  if (demoMode) {
    return NextResponse.json(
      { error: "demo_mode", message: "Sign-ups are turned off in this live demo." },
      { status: 403 }
    );
  }

  // Throttle signup spam per IP (5 accounts / hour). Public route → keyed by IP.
  const rl = await rateLimit("signup", clientIp(request), 5, 3600);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited", message: "Too many signups from this network. Please try again later." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
    );
  }

  let body: { email?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const email = body.email?.trim().toLowerCase();
  const password = body.password;

  if (!email || email.length > 254 || !email.includes("@")) {
    return NextResponse.json({ error: "A valid email is required" }, { status: 400 });
  }
  if (!password || password.length < 8 || password.length > 200) {
    return NextResponse.json(
      { error: "Password must be between 8 and 200 characters" },
      { status: 400 }
    );
  }

  const store = getStore();
  const existing = await store.getUserByEmail(email);
  if (existing) {
    return NextResponse.json(
      { error: "An account with this email already exists" },
      { status: 409 }
    );
  }

  const { hash, salt } = await hashPassword(password);
  // createUser atomically claims the email; null → another signup won the race.
  const user = await store.createUser({
    id: randomUUID(),
    email,
    passwordHash: hash,
    passwordSalt: salt,
    createdAt: new Date().toISOString(),
  });
  if (!user) {
    return NextResponse.json(
      { error: "An account with this email already exists" },
      { status: 409 }
    );
  }

  await setSession({ userId: user.id, email: user.email });

  return NextResponse.json({ ok: true });
}
