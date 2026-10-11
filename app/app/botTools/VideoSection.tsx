"use client";

import { useCallback, useEffect, useState } from "react";
import { SectionState, errorText, toolFetch, type SectionProps } from "./shared";

interface VideoModel {
  id: string;
  label: string;
  provider: "fal" | "google";
  price: string | null;
}

interface VideoState {
  model: string | null;
  keyPreviews: { fal: string | null; google: string | null };
  models: VideoModel[];
}

const PREVIEW_STATE: VideoState = {
  model: null,
  keyPreviews: { fal: null, google: null },
  models: [
    { id: "google/veo-3.1-fast-generate-preview", label: "Veo 3.1 Fast", provider: "google", price: null },
    { id: "fal/fal-ai/kling-video/v2.1/master/text-to-video", label: "Kling 2.1 Master", provider: "fal", price: null },
  ],
};

const KEY_PAGES = {
  fal: "https://fal.ai/dashboard/keys",
  google: "https://aistudio.google.com/apikey",
} as const;

/**
 * Video generation with the customer's OWN provider key (fal or Google Veo).
 * Their key pays for their videos; the platform validates it before the
 * assistant is touched and only ever hands back a masked preview. Only some
 * assistants support this — the platform answers 404 for the rest, which is
 * shown as "not available".
 */
export default function VideoSection({ copy, preview, status }: SectionProps) {
  const t = copy.botTools.video;
  const [state, setState] = useState<VideoState | null>(preview ? PREVIEW_STATE : null);
  const [load, setLoad] = useState<"loading" | "ready" | "error" | "unavailable">(preview ? "ready" : "loading");
  const [loadError, setLoadError] = useState("");
  const [choice, setChoice] = useState<string>("off");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const refresh = useCallback(async () => {
    if (preview) return;
    setLoad("loading");
    const res = await toolFetch<VideoState>("video");
    if (res.ok) {
      const next: VideoState = {
        model: typeof res.data.model === "string" ? res.data.model : null,
        keyPreviews: {
          fal: res.data.keyPreviews?.fal ?? null,
          google: res.data.keyPreviews?.google ?? null,
        },
        models: Array.isArray(res.data.models) ? res.data.models : [],
      };
      setState(next);
      setChoice(next.model && next.models.some((m) => m.id === next.model) ? next.model : "off");
      setLoad("ready");
    } else if (res.status === 404) {
      setLoad("unavailable");
    } else {
      setLoadError(errorText(copy, res.data.error));
      setLoad("error");
    }
  }, [preview, copy]);

  useEffect(() => { void refresh(); }, [refresh]);

  const selected = state?.models.find((m) => m.id === choice) ?? null;
  const storedKey = selected && state ? state.keyPreviews[selected.provider] : null;
  const current = state?.model ?? null;
  const unchanged = choice === (current ?? "off") && !key.trim();
  const needsKey = !!selected && !storedKey && !key.trim();

  async function save() {
    setError("");
    setSaved(false);
    if (preview) {
      setState((s) => (s ? { ...s, model: choice === "off" ? null : choice } : s));
      setKey("");
      setSaved(true);
      return;
    }
    setBusy(true);
    const body = choice === "off" ? { model: "off" } : key.trim() ? { model: choice, key: key.trim() } : { model: choice };
    const res = await toolFetch<{ model: string | null }>("video", { method: "PUT", json: body });
    setBusy(false);
    if (!res.ok) {
      setError(errorText(copy, res.data.error));
      return;
    }
    setKey("");
    setSaved(true);
    await refresh();
  }

  return (
    <section className="byok-card">
      <header>
        <div>
          <h2>{t.title}</h2>
          <p>{t.body}</p>
        </div>
        {load === "ready" && state && (
          <span className={current ? "byok-badge is-own" : "byok-badge"}>{current ? t.on : t.off}</span>
        )}
      </header>

      {load === "loading" && <SectionState kind="loading" text={copy.botTools.loading} />}
      {load === "unavailable" && <SectionState kind="note" text={errorText(copy, "not_available")} />}
      {load === "error" && <SectionState kind="error" text={loadError} onRetry={() => void refresh()} retryLabel={copy.tryAgain} />}

      {load === "ready" && state && (
        <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <div className="byok-field">
            <label htmlFor="bt-video-model">{t.modelLabel}</label>
            <select
              id="bt-video-model"
              value={choice}
              onChange={(e) => { setChoice(e.target.value); setKey(""); setError(""); setSaved(false); }}
            >
              <option value="off">{t.offOption}</option>
              {state.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} — {m.provider === "fal" ? "fal" : "Google"}{m.price ? ` · ${m.price}` : ""}
                </option>
              ))}
            </select>
          </div>

          {selected && (
            <div className="byok-field">
              <label htmlFor="bt-video-key">{selected.provider === "fal" ? t.falKeyLabel : t.googleKeyLabel}</label>
              <input
                id="bt-video-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                maxLength={512}
                placeholder={storedKey ? `${t.keyOnFile} ${storedKey}` : ""}
                value={key}
                onChange={(e) => { setKey(e.target.value); setError(""); setSaved(false); }}
              />
              <p className="byok-note">
                {storedKey ? t.keyReplaceHint : t.keyHint}{" "}
                <a href={KEY_PAGES[selected.provider]} target="_blank" rel="noreferrer">{t.getKey}</a>
              </p>
            </div>
          )}

          {status !== "running" && !preview && <p className="byok-note">{copy.botTools.needsRunning}</p>}
          <div className="byok-actions">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy || unchanged || needsKey || (!preview && status !== "running")}
            >
              {busy ? copy.botTools.working : t.save}
            </button>
            <span className="byok-effect">{busy ? t.restartNote : t.billingNote}</span>
          </div>
          {saved && <p className="byok-note" role="status">{t.saved}</p>}
        </form>
      )}

      {error && <p className="panel-error" role="alert">{error}</p>}
    </section>
  );
}
