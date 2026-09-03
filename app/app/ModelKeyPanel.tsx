"use client";

import { useCallback, useEffect, useState } from "react";
import type { Messages } from "../../lib/i18n";

/**
 * "Model key" panel — the customer points their assistant at their OWN provider
 * account instead of spending the reseller's model credits.
 *
 * Rendered only when the reseller sets ALLOW_END_USER_BYOK=1. Everything it can
 * do goes through /api/model-key, which resolves the bot from the SESSION — this
 * component never learns an instance id and could not act on another customer's
 * bot even if it tried.
 *
 * The key is write-only from here on: once saved, the panel shows a masked
 * preview and offers replacement. There is deliberately no "remove" — an
 * assistant whose funding is pulled keeps running and stops answering, which is
 * a worse outcome than any it would solve.
 */

const PROVIDERS = [
  { id: "openrouter", label: "OpenRouter", keysUrl: "https://openrouter.ai/keys" },
  { id: "anthropic", label: "Anthropic", keysUrl: "https://console.anthropic.com/settings/keys" },
  { id: "openai", label: "OpenAI", keysUrl: "https://platform.openai.com/api-keys" },
  { id: "groq", label: "Groq", keysUrl: "https://console.groq.com/keys" },
  { id: "deepseek", label: "DeepSeek", keysUrl: "https://platform.deepseek.com/api_keys" },
  { id: "qwen", label: "Qwen", keysUrl: "https://bailian.console.aliyun.com/" },
  { id: "zai", label: "Z.AI", keysUrl: "https://z.ai/manage-apikey/apikey-list" },
  { id: "minimax", label: "MiniMax", keysUrl: "https://platform.minimax.io/user-center/basic-information/interface-key" },
  { id: "moonshot", label: "Moonshot", keysUrl: "https://platform.moonshot.ai/console/api-keys" },
  { id: "xai", label: "xAI", keysUrl: "https://console.x.ai" },
  { id: "google", label: "Google Gemini", keysUrl: "https://aistudio.google.com/apikey" },
  { id: "nousportal", label: "Nous Portal", keysUrl: "https://portal.nousresearch.com/" },
  { id: "opencode-go", label: "OpenCode Go", keysUrl: "https://opencode.ai/go" },
] as const;

type ProviderId = (typeof PROVIDERS)[number]["id"];

interface KeyStatus {
  hasKey: boolean;
  provider: string | null;
  keyPreview: string | null;
}

const PREVIEW_STATUS: KeyStatus = { hasKey: false, provider: null, keyPreview: null };

export default function ModelKeyPanel({
  copy,
  brandName,
  preview,
}: {
  copy: Messages;
  brandName: string;
  preview: boolean;
}) {
  const [status, setStatus] = useState<KeyStatus | null>(preview ? PREVIEW_STATUS : null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">(preview ? "ready" : "loading");
  const [provider, setProvider] = useState<ProviderId>("openrouter");
  const [keyInput, setKeyInput] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  // The platform can switch the bot onto the new key and still fail to record it.
  // That is a success the customer must act on again, not a plain success.
  const [recorded, setRecorded] = useState(true);
  // Two error slots on purpose: `errorText` is a sentence the platform wrote for
  // the person holding the key ("the account has no credit") and is worth showing
  // verbatim; `errorCode` falls back to our own localized line when there is none.
  const [errorText, setErrorText] = useState("");
  const [errorCode, setErrorCode] = useState("");
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    if (preview) return;
    setLoadState("loading");
    try {
      const res = await fetch("/api/model-key", { cache: "no-store" });
      if (!res.ok) throw new Error("load failed");
      const data = (await res.json()) as KeyStatus;
      setStatus(data);
      if (data.provider && PROVIDERS.some((p) => p.id === data.provider)) {
        setProvider(data.provider as ProviderId);
      }
      setLoadState("ready");
    } catch {
      setLoadState("error");
    }
  }, [preview]);

  useEffect(() => { void load(); }, [load]);

  const spec = PROVIDERS.find((p) => p.id === provider) ?? PROVIDERS[0];
  const showForm = editing || !status?.hasKey;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const modelKey = keyInput.trim();
    if (!modelKey || saveState === "saving") return;
    setSaveState("saving");
    setErrorText("");
    setErrorCode("");

    if (preview) {
      // The public demo storefront must never send a key anywhere.
      setSaveState("saved");
      setRecorded(true);
      setStatus({ hasKey: true, provider, keyPreview: `${modelKey.slice(0, 6)}…${modelKey.slice(-4)}` });
      setKeyInput("");
      setEditing(false);
      return;
    }

    try {
      const res = await fetch("/api/model-key", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelKey, provider }),
      });
      if (res.ok) {
        const body = (await res.json().catch(() => ({}))) as { recorded?: boolean };
        setRecorded(body.recorded !== false);
        setSaveState("saved");
        setKeyInput("");
        setEditing(false);
        await load();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      setSaveState("idle");
      if (res.status === 429) { setErrorCode(copy.modelKeyErrorRateLimited); return; }
      if (body.message) { setErrorText(body.message); return; }
      setErrorCode(body.error === "invalid_model_key" ? copy.modelKeyRejected : copy.modelKeyErrorGeneric);
    } catch {
      setSaveState("idle");
      setErrorCode(copy.modelKeyErrorGeneric);
    }
  }

  return (
    <div className="control-content">
      <section className="control-heading">
        <span>{copy.modelKeyKicker}</span>
        <h1>{copy.modelKeyTitle}</h1>
        <p>{copy.modelKeyBody(brandName)}</p>
      </section>

      {loadState === "loading" && (
        <div className="settings-state" role="status">
          <span className="mini-spinner" aria-hidden="true" />
          {copy.loadingPreferences}
        </div>
      )}

      {loadState === "error" && (
        <div className="settings-state panel-error" role="alert">
          <span>{copy.modelKeyLoadError}</span>
          <button type="button" onClick={() => void load()}>{copy.tryAgain}</button>
        </div>
      )}

      {loadState === "ready" && (
        <section className="byok-card">
          <header>
            <div>
              <h2>{copy.modelKeyProviderTitle}</h2>
              <p>{copy.modelKeyProviderBody}</p>
            </div>
            <span className={status?.hasKey ? "byok-badge is-own" : "byok-badge"}>
              {status?.hasKey ? copy.modelKeyUsingOwn : copy.modelKeyUsingBrand(brandName)}
            </span>
          </header>

          {status?.hasKey && !editing && (
            <>
              <p className="byok-onfile">{copy.modelKeyOnFile(status.keyPreview ?? "••••")}</p>
              <div className="byok-actions">
                <button type="button" className="btn btn-secondary" onClick={() => { setEditing(true); setSaveState("idle"); }}>
                  {copy.modelKeyReplace}
                </button>
              </div>
              <p className="byok-note">{copy.modelKeyNoRemove}</p>
            </>
          )}

          {showForm && (
            <form onSubmit={save}>
              <div className="byok-providers" role="radiogroup" aria-label={copy.modelKeyProviderTitle}>
                {PROVIDERS.map((option) => (
                  <label key={option.id} className={option.id === provider ? "selected" : ""}>
                    <input
                      type="radio"
                      name="provider"
                      value={option.id}
                      checked={option.id === provider}
                      onChange={() => { setProvider(option.id); setErrorText(""); setErrorCode(""); }}
                    />
                    <strong>{option.label}</strong>
                    <span>{copy.providerNote[option.id]}</span>
                  </label>
                ))}
              </div>

              <div className="byok-field">
                <label htmlFor="model-key">{copy.modelKeyFieldLabel(spec.label)}</label>
                <input
                  id="model-key"
                  name="model-key"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={keyInput}
                  maxLength={400}
                  placeholder={spec.id === "openrouter" ? "sk-or-v1-…" : "sk-…"}
                  onChange={(event) => { setKeyInput(event.target.value); setErrorText(""); setErrorCode(""); }}
                />
                <small>
                  {copy.modelKeyHint(spec.label)}{" "}
                  <a href={spec.keysUrl} target="_blank" rel="noopener noreferrer">{copy.modelKeyGetOne}</a>
                </small>
              </div>

              <div className="byok-actions">
                <button type="submit" className="btn btn-primary" disabled={!keyInput.trim() || saveState === "saving"}>
                  {saveState === "saving" ? copy.modelKeySaving : copy.modelKeySave}
                </button>
                {status?.hasKey && (
                  <button
                    type="button"
                    className="settings-reset"
                    onClick={() => { setEditing(false); setKeyInput(""); setErrorText(""); setErrorCode(""); }}
                  >
                    {copy.modelKeyCancel}
                  </button>
                )}
                <span className="byok-effect">{copy.modelKeyEffect}</span>
              </div>

              {(errorText || errorCode) && (
                <p className="panel-error" role="alert">{errorText || errorCode}</p>
              )}
            </form>
          )}

          {/* Not gated on the form being hidden. The unrecorded case is exactly
              the one where the reloaded status still says "no key on file", so
              the form is back on screen — and that is precisely when the customer
              needs to be told why, and to save again. */}
          {saveState === "saved" && (
            recorded
              ? <p className="panel-success" role="status">✓ {copy.modelKeySaved}</p>
              : <p className="byok-note" role="status">{copy.modelKeyPartial}</p>
          )}
        </section>
      )}
    </div>
  );
}
