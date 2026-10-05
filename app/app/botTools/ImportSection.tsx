"use client";

import { useRef, useState } from "react";
import { SectionState, errorText, formatBytes, toolFetch, type SectionProps } from "./shared";

/** The platform's import ceiling. Checked before uploading anything. */
const MAX_IMPORT_BYTES = 500 * 1024 * 1024;

interface PreviewResult {
  categories: string[];
  importableCategories: string[];
  fileCount: number | null;
  totalSize: number | null;
  exportedAt: string | null;
}

interface ApplyResult {
  applied: number | null;
  skipped: number | null;
  settingsKept: boolean;
  restarted: boolean;
}

type Step = "choose" | "checking" | "pick" | "applying" | "done";

const PREVIEW_RESULT: PreviewResult = {
  categories: ["config", "agents", "sessions"],
  importableCategories: ["config", "agents", "sessions"],
  fileCount: 42,
  totalSize: 1_250_000,
  exportedAt: "2026-06-01T12:00:00.000Z",
};

export default function ImportSection({ copy, preview, status }: SectionProps) {
  const t = copy.botTools.import;
  const labels = copy.botTools.backup.categories as Record<string, string>;
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [step, setStep] = useState<Step>("choose");
  const [found, setFound] = useState<PreviewResult | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [error, setError] = useState("");

  function reset() {
    setFile(null);
    setFound(null);
    setSelected([]);
    setResult(null);
    setConfirming(false);
    setError("");
    setStep("choose");
    if (fileRef.current) fileRef.current.value = "";
  }

  function picked(next: File | undefined) {
    setError("");
    setFound(null);
    setResult(null);
    setStep("choose");
    if (!next) {
      setFile(null);
      return;
    }
    if (next.size > MAX_IMPORT_BYTES) {
      setFile(null);
      setError(t.tooLarge);
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    setFile(next);
  }

  async function check() {
    if (!file) return;
    setError("");
    setStep("checking");
    if (preview) {
      setFound(PREVIEW_RESULT);
      setSelected(PREVIEW_RESULT.importableCategories);
      setStep("pick");
      return;
    }
    // The raw zip goes up; the storefront wraps it for the platform as it
    // streams through, so even a large backup is never held whole in memory.
    const res = await toolFetch<PreviewResult>("import-preview", { method: "POST", body: file });
    if (!res.ok) {
      setStep("choose");
      setError(errorText(copy, res.data.error));
      return;
    }
    const data: PreviewResult = {
      categories: Array.isArray(res.data.categories) ? res.data.categories : [],
      importableCategories: Array.isArray(res.data.importableCategories) ? res.data.importableCategories : [],
      fileCount: typeof res.data.fileCount === "number" ? res.data.fileCount : null,
      totalSize: typeof res.data.totalSize === "number" ? res.data.totalSize : null,
      exportedAt: typeof res.data.exportedAt === "string" ? res.data.exportedAt : null,
    };
    setFound(data);
    setSelected(data.importableCategories);
    setStep("pick");
  }

  async function apply() {
    if (!file || selected.length === 0) return;
    setConfirming(false);
    setError("");
    setStep("applying");
    if (preview) {
      setResult({ applied: 42, skipped: 0, settingsKept: true, restarted: true });
      setStep("done");
      return;
    }
    const categories = (found?.importableCategories ?? selected).filter((c) => selected.includes(c));
    const res = await toolFetch<ApplyResult>("import-apply", {
      method: "POST",
      query: { categories: categories.join(",") },
      body: file,
    });
    if (!res.ok) {
      setStep("pick");
      setError(res.data.error === "import_rolled_back" && res.data.rollbackComplete === false ? t.rollbackPartial : errorText(copy, res.data.error));
      return;
    }
    setResult({
      applied: typeof res.data.applied === "number" ? res.data.applied : null,
      skipped: typeof res.data.skipped === "number" ? res.data.skipped : null,
      settingsKept: res.data.settingsKept === true,
      restarted: res.data.restarted === true,
    });
    setStep("done");
  }

  const exportedAt = found?.exportedAt ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(found.exportedAt)) : null;

  return (
    <section className="byok-card">
      <header>
        <div>
          <h2>{t.title}</h2>
          <p>{t.body}</p>
        </div>
      </header>

      {status !== "running" && !preview && step !== "done" && <p className="byok-note">{copy.botTools.needsRunning}</p>}

      {(step === "choose" || step === "checking") && (
        <>
          <div className="byok-field">
            <label htmlFor="bt-import-file">{t.chooseFile}</label>
            <input
              id="bt-import-file"
              ref={fileRef}
              type="file"
              accept=".zip,application/zip"
              disabled={step === "checking"}
              onChange={(e) => picked(e.target.files?.[0])}
            />
            <small>{t.limit}</small>
          </div>
          <div className="byok-actions">
            <button type="button" className="btn btn-primary" disabled={!file || step === "checking" || (!preview && status !== "running")} onClick={() => void check()}>
              {t.check}
            </button>
          </div>
          {step === "checking" && <SectionState kind="loading" text={t.checking} />}
        </>
      )}

      {(step === "pick" || step === "applying") && found && (
        <>
          <div className="bt-found">
            <h3 className="bt-subhead">{t.foundTitle}</h3>
            <p>
              {file?.name}
              {found.fileCount != null && <> · {t.fileCount(String(found.fileCount))}</>}
              {found.totalSize != null && <> · {formatBytes(found.totalSize)}</>}
              {exportedAt && <> · {t.exportedAt(exportedAt)}</>}
            </p>
          </div>

          {found.importableCategories.length === 0 ? (
            <p className="byok-note">{t.nothingImportable}</p>
          ) : (
            <fieldset className="bt-checks" disabled={step === "applying"}>
              <legend>{t.pick}</legend>
              {found.importableCategories.map((id) => (
                <label key={id}>
                  <input
                    type="checkbox"
                    checked={selected.includes(id)}
                    onChange={() => setSelected((current) => (current.includes(id) ? current.filter((c) => c !== id) : [...current, id]))}
                  />
                  <span>{labels[id] ?? id}</span>
                </label>
              ))}
            </fieldset>
          )}

          <p className="byok-note">{t.managedNote}</p>

          {confirming ? (
            <div className="bt-confirm" role="alertdialog" aria-label={t.apply}>
              <p>{t.overwriteNote}</p>
              <div className="byok-actions">
                <button type="button" className="btn btn-danger" onClick={() => void apply()}>{t.apply}</button>
                <button type="button" className="settings-reset" onClick={() => setConfirming(false)}>{copy.botTools.cancel}</button>
              </div>
            </div>
          ) : (
            <div className="byok-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={step === "applying" || selected.length === 0 || (!preview && status !== "running")}
                onClick={() => setConfirming(true)}
              >
                {t.apply}
              </button>
              <button type="button" className="settings-reset" disabled={step === "applying"} onClick={reset}>{copy.botTools.cancel}</button>
            </div>
          )}
          {step === "applying" && <SectionState kind="loading" text={t.applying} />}
        </>
      )}

      {step === "done" && result && (
        <>
          <p className="panel-success" role="status">
            ✓ {t.doneApplied(String(result.applied ?? 0))}
            {result.skipped ? ` ${t.doneSkipped(String(result.skipped))}` : ""}
          </p>
          <p className="byok-note">{result.restarted ? t.restarted : t.notRestarted}</p>
          {result.settingsKept && <p className="byok-note">{t.settingsKept}</p>}
          <div className="byok-actions">
            <button type="button" className="btn btn-secondary" onClick={reset}>{t.another}</button>
          </div>
        </>
      )}

      {error && <p className="panel-error" role="alert">{error}</p>}
    </section>
  );
}
