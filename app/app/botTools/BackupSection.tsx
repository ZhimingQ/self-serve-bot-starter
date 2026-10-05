"use client";

import { useState } from "react";
import { errorText, startDownload, type SectionProps } from "./shared";

/** The platform's own default backup: how the assistant is set up, nothing
 *  that was said to it. */
const DEFAULT_SELECTED = ["config", "agents"];
/** Categories that can contain what the customer said to the assistant. */
const SENSITIVE = ["sessions", "knowledge", "skills"];

export default function BackupSection({ copy, preview, backupCategories }: SectionProps) {
  const t = copy.botTools.backup;
  const labels = t.categories as Record<string, string>;
  const [selected, setSelected] = useState<string[]>(DEFAULT_SELECTED.filter((c) => backupCategories.includes(c)));
  const [state, setState] = useState<"idle" | "started" | "error">("idle");
  const [error, setError] = useState("");

  function toggle(id: string) {
    setState("idle");
    setSelected((current) => (current.includes(id) ? current.filter((c) => c !== id) : [...current, id]));
  }

  function download() {
    if (preview || selected.length === 0) return;
    // Keep the platform's display order regardless of click order.
    const categories = backupCategories.filter((c) => selected.includes(c));
    setState("started");
    setError("");
    startDownload(`/api/bot-tools/backup?${new URLSearchParams({ categories: categories.join(",") }).toString()}`, (code) => {
      setState("error");
      setError(errorText(copy, code));
    });
  }

  const includesSensitive = selected.some((c) => SENSITIVE.includes(c));

  return (
    <section className="byok-card">
      <header>
        <div>
          <h2>{t.title}</h2>
          <p>{t.body}</p>
        </div>
      </header>

      <fieldset className="bt-checks">
        <legend>{t.whatToInclude}</legend>
        {backupCategories.map((id) => (
          <label key={id}>
            <input type="checkbox" checked={selected.includes(id)} onChange={() => toggle(id)} />
            <span>{labels[id] ?? id}</span>
          </label>
        ))}
      </fieldset>

      {includesSensitive && <p className="byok-note">{t.sensitiveNote}</p>}

      <div className="byok-actions">
        <button type="button" className="btn btn-primary" disabled={preview || selected.length === 0} onClick={download}>
          {t.download}
        </button>
      </div>

      {preview && <p className="byok-note">{copy.botTools.previewNote}</p>}
      {state === "started" && <p className="panel-success" role="status">{t.starting}</p>}
      {state === "error" && <p className="panel-error" role="alert">{error}</p>}
    </section>
  );
}
