"use client";

import { useEffect, useState } from "react";
import { ELAPSED_SHOW_AFTER_MS, formatElapsed } from "../../lib/elapsed";

/** Shown in the assistant's bubble while a reply is on its way. A static "…"
 *  read as a frozen page on long research turns, so the dots move and, once
 *  the reply is clearly not instant, a counter shows time is passing. It
 *  counts from when the bubble appeared, not from a server timestamp, so a
 *  wrong device clock can never show a misleading number. */
export default function WorkingIndicator({ label }: { label?: string }) {
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(startedAt);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const elapsed = now - startedAt;
  return (
    <span className="working-indicator">
      {label ? <span>{label}</span> : <span className="sr-only">Working</span>}
      <span className="working-dots" aria-hidden="true"><i /><i /><i /></span>
      {elapsed >= ELAPSED_SHOW_AFTER_MS && (
        <span className="working-elapsed" aria-hidden="true">{formatElapsed(elapsed)}</span>
      )}
    </span>
  );
}
