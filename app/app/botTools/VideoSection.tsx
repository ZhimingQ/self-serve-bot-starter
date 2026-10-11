"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SectionState, errorText, toolFetch, type SectionProps } from "./shared";

interface VideoModel {
  id: string;
  label: string;
  provider: "fal" | "google" | "openrouter";
  price: string | null;
}

interface VideoState {
  model: string | null;
  /** A switch is still being applied (the assistant is restarting). */
  applying: boolean;
  /** The last switch failed after the save was answered. */
  applyFailed: boolean;
  keyPreviews: { fal: string | null; google: string | null };
  models: VideoModel[];
  /** Video the seller pays for, when they turned it on for this assistant. */
  included: { models: VideoModel[]; usedPercent: number } | null;
}

const PREVIEW_STATE: VideoState = {
  model: null,
  applying: false,
  applyFailed: false,
  keyPreviews: { fal: null, google: null },
  models: [
    { id: "google/veo-3.1-fast-generate-preview", label: "Veo 3.1 Fast", provider: "google", price: null },
    { id: "fal/fal-ai/kling-video/v2.1/master/text-to-video", label: "Kling 2.1 Master", provider: "fal", price: null },
  ],
  included: null,
};

/** How long the panel follows a switch that is still restarting the assistant. */
const APPLY_POLL_MS = 5_000;
const APPLY_POLL_LIMIT_MS = 5 * 60_000;

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
  const pollUntil = useRef(0);

  /** quiet: a background re-read while a switch applies, which keeps the form. */
  const refresh = useCallback(async (quiet = false): Promise<VideoState | null> => {
    if (preview) return null;
    if (!quiet) setLoad("loading");
    const res = await toolFetch<VideoState>("video");
    if (res.ok) {
      const next: VideoState = {
        model: typeof res.data.model === "string" ? res.data.model : null,
        applying: res.data.applying === true,
        applyFailed: res.data.applyFailed === true,
        keyPreviews: {
          fal: res.data.keyPreviews?.fal ?? null,
          google: res.data.keyPreviews?.google ?? null,
        },
        models: Array.isArray(res.data.models) ? res.data.models : [],
        included: res.data.included && Array.isArray(res.data.included.models) ? res.data.included : null,
      };
      setState(next);
      const known = [...next.models, ...(next.included?.models ?? [])];
      if (!quiet) setChoice(next.model && known.some((m) => m.id === next.model) ? next.model : "off");
      setLoad("ready");
      return next;
    }
    if (quiet) return null;
    if (res.status === 404) {
      setLoad("unavailable");
    } else {
      setLoadError(errorText(copy, res.data.error));
      setLoad("error");
    }
    return null;
  }, [preview, copy]);

  useEffect(() => { void refresh(); }, [refresh]);

  // While the assistant restarts onto a new setting, re-read until it lands.
  const applying = !!state?.applying;
  useEffect(() => {
    if (!applying || preview) return;
    if (!pollUntil.current) pollUntil.current = Date.now() + APPLY_POLL_LIMIT_MS;
    const id = setTimeout(async () => {
      const next = await refresh(true);
      if (next && !next.applying) {
        pollUntil.current = 0;
        if (next.applyFailed) { setSaved(false); setError(errorText(copy, "video_failed")); }
        const known = [...next.models, ...(next.included?.models ?? [])];
        setChoice(next.model && known.some((m) => m.id === next.model) ? next.model : "off");
      } else if (Date.now() > pollUntil.current) {
        pollUntil.current = 0;
        setState((s) => (s ? { ...s, applying: false } : s));
      }
    }, APPLY_POLL_MS);
    return () => clearTimeout(id);
  }, [applying, preview, refresh, copy, state]);

  const selected = [...(state?.models ?? []), ...(state?.included?.models ?? [])].find((m) => m.id === choice) ?? null;
  // Included models are paid by the seller and take no key.
  const keyProvider = selected && selected.provider !== "openrouter" ? selected.provider : null;
  const storedKey = keyProvider && state ? state.keyPreviews[keyProvider] : null;
  const current = state?.model ?? null;
  const unchanged = choice === (current ?? "off") && !key.trim();
  const needsKey = !!keyProvider && !storedKey && !key.trim();

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
    const body = choice === "off" ? { model: "off" } : keyProvider && key.trim() ? { model: choice, key: key.trim() } : { model: choice };
    const res = await toolFetch<{ model: string | null; applying?: boolean }>("video", { method: "PUT", json: body });
    setBusy(false);
    if (!res.ok) {
      setError(errorText(copy, res.data.error));
      return;
    }
    setKey("");
    setSaved(true);
    if (res.data.applying) {
      // Still restarting: show the chosen setting as applying and follow it.
      pollUntil.current = 0;
      setState((s) => (s ? { ...s, model: res.data.model ?? null, applying: true, applyFailed: false } : s));
      return;
    }
    await refresh();
  }

  return (
    <section className="byok-card">
      <header>
        <div>
          <h2>{t.title}</h2>
          <p>{state?.included && state.included.models.length > 0 ? t.bodyIncluded : t.body}</p>
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
              {state.included && state.included.models.length > 0 && (
                <optgroup label={t.includedGroup}>
                  {state.included.models.map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </optgroup>
              )}
              {state.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} — {m.provider === "fal" ? "fal" : "Google"}{m.price ? ` · ${m.price}` : ""}
                </option>
              ))}
            </select>
          </div>

          {state.included && (
            <p className="byok-note">{t.includedUsage.replace("{percent}", String(state.included.usedPercent))}</p>
          )}

          {keyProvider && (
            <div className="byok-field">
              <label htmlFor="bt-video-key">{keyProvider === "fal" ? t.falKeyLabel : t.googleKeyLabel}</label>
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
                <a href={KEY_PAGES[keyProvider]} target="_blank" rel="noreferrer">{t.getKey}</a>
              </p>
            </div>
          )}

          {status !== "running" && !preview && !applying && <p className="byok-note">{copy.botTools.needsRunning}</p>}
          <div className="byok-actions">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy || applying || unchanged || needsKey || (!preview && status !== "running")}
            >
              {busy ? copy.botTools.working : t.save}
            </button>
            <span className="byok-effect">{busy ? t.restartNote : selected?.provider === "openrouter" ? t.includedNote : t.billingNote}</span>
          </div>
          {applying && <p className="byok-note" role="status">{t.applying}</p>}
          {saved && !applying && <p className="byok-note" role="status">{t.saved}</p>}
        </form>
      )}

      {error && <p className="panel-error" role="alert">{error}</p>}
    </section>
  );
}
