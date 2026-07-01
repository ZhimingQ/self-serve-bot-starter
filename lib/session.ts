/**
 * Hand-rolled session cookie — no auth library.
 *
 * The cookie value is `${base64url(payload)}.${hmacSignature}`, signed with
 * HMAC-SHA256 over SESSION_SECRET (node:crypto). httpOnly + sameSite=lax so
 * it's never readable from client JS and safe against basic CSRF vectors.
 */

import { cookies } from "next/headers";
import { createHmac, timingSafeEqual } from "node:crypto";
import { sessionSecret } from "./config";

const COOKIE_NAME = "session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

export interface SessionPayload {
  userId: string;
  email: string;
  iat: number;
}

function base64url(input: Buffer): string {
  return input.toString("base64url");
}

function sign(value: string): string {
  if (!sessionSecret) {
    throw new Error(
      "SESSION_SECRET is not set. Add it to your .env before starting the app."
    );
  }
  return createHmac("sha256", sessionSecret).update(value).digest("base64url");
}

function encode(payload: SessionPayload): string {
  const body = base64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const signature = sign(body);
  return `${body}.${signature}`;
}

function decode(token: string): SessionPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, signature] = parts;

  let expectedSignature: string;
  try {
    expectedSignature = sign(body);
  } catch {
    return null;
  }

  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expectedSignature);
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!timingSafeEqual(sigBuf, expectedBuf)) return null;

  try {
    const json = Buffer.from(body, "base64url").toString("utf8");
    const payload = JSON.parse(json) as SessionPayload;
    if (!payload.userId || !payload.email) return null;
    // Reject an expired token server-side: the signature never expires on its
    // own, so an old signed cookie must be aged out by iat (not just the
    // browser-side maxAge).
    if (typeof payload.iat !== "number" || Date.now() - payload.iat > MAX_AGE_SECONDS * 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Read + verify the current request's session cookie (Server Components, Route Handlers). */
export async function getSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (!token) return null;
  return decode(token);
}

/** Set the signed session cookie. Call from a Route Handler or Server Action. */
export async function setSession(payload: Omit<SessionPayload, "iat">): Promise<void> {
  const store = await cookies();
  const token = encode({ ...payload, iat: Date.now() });
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
}

export async function clearSession(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}
