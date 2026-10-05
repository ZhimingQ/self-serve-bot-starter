"use client";

import { useState } from "react";
import type { Messages } from "../../../lib/i18n";

/**
 * Shared plumbing for the Bot tools sections.
 *
 * Every section talks to /api/bot-tools/{action} and nothing else. That route
 * resolves the customer's bot from the session, so no component here ever
 * knows or sends an instance id.
 */

export type BotToolsCopy = Messages["botTools"];

/** What every section receives from the panel shell. */
export interface SectionProps {
  copy: Messages;
  /** Public demo: render canned state and never call the API. */
  preview: boolean;
  /** Live status of the assistant ("running", "stopped", ...). */
  status: string;
  /** Sections that change the status (power) report it back. */
  onStatus: (status: string) => void;
  /** Backup categories this assistant supports, in display order. */
  backupCategories: string[];
}

export interface ToolResult<T> {
  ok: boolean;
  status: number;
  data: Partial<T> & { error?: string; [key: string]: unknown };
}

/** Call one bot-tools action. Never throws: a network failure is reported as
 *  status 0 with error "network". */
export async function toolFetch<T = Record<string, unknown>>(
  action: string,
  init: { method?: "GET" | "POST" | "PUT" | "DELETE"; query?: Record<string, string>; json?: unknown; body?: Blob } = {},
): Promise<ToolResult<T>> {
  const qs = init.query ? `?${new URLSearchParams(init.query).toString()}` : "";
  try {
    const res = await fetch(`/api/bot-tools/${action}${qs}`, {
      method: init.method ?? "GET",
      cache: "no-store",
      headers: init.json !== undefined ? { "Content-Type": "application/json" } : init.body ? { "Content-Type": "application/octet-stream" } : undefined,
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
    });
    const data = (await res.json().catch(() => ({}))) as ToolResult<T>["data"];
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: "network" } as ToolResult<T>["data"] };
  }
}

/** A localized sentence for an error code from /api/bot-tools. */
export function errorText(copy: Messages, code: unknown): string {
  const errors = copy.botTools.errors as Record<string, string>;
  return (typeof code === "string" && errors[code]) || errors.generic;
}

/** "Running", "Stopped", ... for a raw status. */
export function statusText(copy: Messages, status: string): string {
  const labels = copy.botTools.status as Record<string, string>;
  return labels[status] ?? labels.unknown;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

/**
 * Start a file download without leaving the page and without buffering it in
 * the browser.
 *
 * A hidden same-origin iframe is pointed at the download URL. A successful
 * response is an attachment, which the browser hands to its download manager
 * (the iframe never fires `load`). An error is a small JSON body, which the
 * iframe renders — so `load` fires, and its text is read back as the error
 * code. This keeps a multi-hundred-MB backup out of page memory, which a
 * fetch()-to-Blob download could not.
 */
export function startDownload(url: string, onError: (code: string) => void): void {
  const frame = document.createElement("iframe");
  frame.style.display = "none";
  frame.setAttribute("aria-hidden", "true");
  let settled = false;
  const cleanup = () => {
    if (frame.parentNode) frame.parentNode.removeChild(frame);
  };
  frame.addEventListener("load", () => {
    if (settled) return;
    settled = true;
    let code = "generic";
    try {
      const text = frame.contentDocument?.body?.innerText ?? "";
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed.error === "string") code = parsed.error;
    } catch {
      // Not JSON: keep the generic message.
    }
    onError(code);
    cleanup();
  });
  frame.src = url;
  document.body.appendChild(frame);
  // A download continues in the browser's download manager once it has
  // started; the frame itself can go. Long enough for a slow backup to begin.
  window.setTimeout(() => {
    settled = true;
    cleanup();
  }, 10 * 60 * 1000);
}

/** A read-only value with a copy button: commands, URLs, keys. */
export function CopyField({ label, value, copy, multiline = false, secret = false }: {
  label: string;
  value: string;
  copy: Messages;
  multiline?: boolean;
  secret?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  async function doCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className={secret ? "bt-copy is-secret" : "bt-copy"}>
      <span>{label}</span>
      <div>
        {multiline ? <pre>{value}</pre> : <code>{value}</code>}
        <button type="button" className="btn btn-secondary" onClick={() => void doCopy()}>
          {copied ? copy.botTools.copied : copy.botTools.copyButton}
        </button>
      </div>
    </div>
  );
}

/** Loading / error / "start your assistant first" lines, in the panel's look. */
export function SectionState({ kind, text, onRetry, retryLabel }: {
  kind: "loading" | "error" | "note";
  text: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div className={kind === "error" ? "settings-state panel-error" : "settings-state"} role={kind === "error" ? "alert" : "status"}>
      {kind === "loading" && <span className="mini-spinner" aria-hidden="true" />}
      <span>{text}</span>
      {onRetry && retryLabel && <button type="button" onClick={onRetry}>{retryLabel}</button>}
    </div>
  );
}
