"use client";

import { useEffect, useState } from "react";

// The resell API only reports "starting" until the bot is ready, so the steps
// advance on the clock and the bar eases toward 95% without ever claiming to
// be done. A first bot takes anywhere from a few seconds (a warm claim) to a
// minute or two, so the last step is reached well inside the slow case.
const STEP_STARTS_SEC = [0, 8, 40];
const EASE_SEC = 40;

export default function SetupProgress({
  label,
  steps,
  startedAt,
}: {
  label: string;
  steps: readonly string[];
  startedAt: number;
}) {
  const [elapsed, setElapsed] = useState(() => (Date.now() - startedAt) / 1000);

  useEffect(() => {
    const tick = () => setElapsed((Date.now() - startedAt) / 1000);
    tick();
    const timer = window.setInterval(tick, 500);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  const progress = 0.95 * (1 - Math.exp(-elapsed / EASE_SEC));
  let active = 0;
  STEP_STARTS_SEC.forEach((start, index) => {
    if (elapsed >= start && index < steps.length) active = index;
  });

  return (
    <div className="setup-progress">
      <div
        className="setup-bar"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
      >
        <span style={{ transform: `scaleX(${progress})` }} />
      </div>
      <ol className="setup-steps">
        {steps.map((step, index) => {
          const state = index < active ? "done" : index === active ? "active" : "todo";
          return (
            <li key={step} className={state} aria-current={state === "active" ? "step" : undefined}>
              <i aria-hidden="true" />
              {step}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
