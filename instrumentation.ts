/**
 * Next.js boot hook. `register()` runs once when the server starts (both
 * `next dev` and `next start`). We use it to validate the environment up front
 * so a production deploy with a missing secret / no persistence / broken Stripe
 * config fails loudly at startup instead of silently misbehaving per-request.
 */
export async function register() {
  // Only the Node.js runtime — skip the Edge runtime pass (validateEnv is a no-op
  // outside production anyway).
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { validateEnv } = await import("./lib/config");
  validateEnv();
}
