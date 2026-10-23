/** "0:07", "1:42", "12:03": how long a reply has been running, for the
 *  chat's waiting indicator. Negative or non-finite input reads as 0:00. */
export function formatElapsed(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** The counter appears only once a reply is clearly not instant, so a quick
 *  answer never flashes a "0:01". */
export const ELAPSED_SHOW_AFTER_MS = 5_000;
