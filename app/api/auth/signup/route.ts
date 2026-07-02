import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getStore } from "../../../../lib/store";
import { hashPassword } from "../../../../lib/password";
import { setSession } from "../../../../lib/session";

export async function POST(request: NextRequest) {
  let body: { email?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const email = body.email?.trim().toLowerCase();
  const password = body.password;

  if (!email || !email.includes("@")) {
    return NextResponse.json({ error: "A valid email is required" }, { status: 400 });
  }
  if (!password || password.length < 8) {
    return NextResponse.json(
      { error: "Password must be at least 8 characters" },
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
  const user = await store.createUser({
    id: randomUUID(),
    email,
    passwordHash: hash,
    passwordSalt: salt,
    createdAt: new Date().toISOString(),
  });

  await setSession({ userId: user.id, email: user.email });

  return NextResponse.json({ ok: true });
}
