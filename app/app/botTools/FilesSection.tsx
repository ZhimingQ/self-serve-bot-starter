"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SectionState, errorText, formatBytes, startDownload, toolFetch, type SectionProps } from "./shared";

interface Entry {
  name: string;
  isDir: boolean;
  size: number | null;
  modifiedAt: string | null;
}

/** Platform limits: one file in either direction. Checked here so a customer
 *  is told before a long upload, not after. */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

const PREVIEW_TREE: Record<string, Entry[]> = {
  "": [
    { name: "workspace", isDir: true, size: null, modifiedAt: "2026-06-01T12:00:00.000Z" },
    { name: "notes.md", isDir: false, size: 2048, modifiedAt: "2026-06-02T09:30:00.000Z" },
  ],
  workspace: [{ name: "plan.md", isDir: false, size: 812, modifiedAt: "2026-06-03T15:10:00.000Z" }],
};

/** A single file or folder name typed by the customer: no slashes, no dots-only. */
function validName(name: string): boolean {
  const n = name.trim();
  // eslint-disable-next-line no-control-regex
  return Boolean(n) && n.length <= 255 && !/[/\\\u0000-\u001f\u007f]/.test(n) && n !== "." && n !== "..";
}

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

type Pending =
  | { kind: "rename"; name: string; value: string }
  | { kind: "delete"; name: string }
  | { kind: "mkdir"; value: string }
  | { kind: "overwrite"; file: File };

export default function FilesSection({ copy, preview, status }: SectionProps) {
  const t = copy.botTools.files;
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [load, setLoad] = useState<"loading" | "ready" | "error" | "unavailable">("loading");
  const [loadError, setLoadError] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error" | "note"; text: string } | null>(null);
  const uploadRef = useRef<HTMLInputElement | null>(null);
  // A slow listing must not overwrite the folder the customer has since opened.
  const generationRef = useRef(0);

  const list = useCallback(async (dir: string) => {
    const generation = ++generationRef.current;
    setLoad("loading");
    if (preview) {
      setPath(dir);
      setEntries(PREVIEW_TREE[dir] ?? []);
      setLoad("ready");
      return;
    }
    const res = await toolFetch<{ path: string; entries: Entry[] }>("files", { query: { path: dir } });
    if (generation !== generationRef.current) return;
    if (res.ok) {
      setPath(typeof res.data.path === "string" ? res.data.path : dir);
      setEntries(Array.isArray(res.data.entries) ? res.data.entries : []);
      setLoad("ready");
    } else if (res.status === 404 && res.data.error !== "file_not_found") {
      setLoad("unavailable");
    } else {
      setLoadError(errorText(copy, res.data.error));
      setLoad("error");
    }
  }, [preview, copy]);

  useEffect(() => { void list(""); }, [list]);

  function open(dir: string) {
    setPending(null);
    setMessage(null);
    void list(dir);
  }

  /** Every mutation reports through here: a managed file reads as "read-only",
   *  which is a fact about that file rather than a failure. */
  function report(res: { ok: boolean; data: { error?: string } }, okText: string): boolean {
    if (res.ok) {
      setMessage({ kind: "ok", text: okText });
      return true;
    }
    setMessage({ kind: res.data.error === "managed_file" ? "note" : "error", text: errorText(copy, res.data.error) });
    // A read-only file will refuse a retry too, so close whatever was asked.
    if (res.data.error === "managed_file") setPending(null);
    return false;
  }

  async function mutate(run: () => Promise<{ ok: boolean; data: { error?: string } }>, okText: string) {
    setBusy(true);
    setMessage(null);
    const res = preview ? { ok: true, data: {} } : await run();
    setBusy(false);
    if (report(res, okText)) {
      setPending(null);
      if (!preview) await list(path);
    }
  }

  function remove(name: string) {
    if (preview) {
      setEntries((current) => current.filter((e) => e.name !== name));
    }
    void mutate(() => toolFetch("files", { method: "DELETE", query: { path: join(path, name) } }), copy.botTools.done);
  }

  function rename(from: string, to: string) {
    if (!validName(to)) {
      setMessage({ kind: "error", text: errorText(copy, "bad_path") });
      return;
    }
    if (preview) {
      setEntries((current) => current.map((e) => (e.name === from ? { ...e, name: to.trim() } : e)));
    }
    void mutate(() => toolFetch("rename", { method: "POST", json: { from: join(path, from), to: join(path, to.trim()) } }), copy.botTools.done);
  }

  function mkdir(name: string) {
    if (!validName(name)) {
      setMessage({ kind: "error", text: errorText(copy, "bad_path") });
      return;
    }
    if (preview) {
      setEntries((current) => [...current, { name: name.trim(), isDir: true, size: null, modifiedAt: new Date().toISOString() }]);
    }
    void mutate(() => toolFetch("mkdir", { method: "POST", json: { path: join(path, name.trim()) } }), copy.botTools.done);
  }

  function upload(file: File) {
    setPending(null);
    if (file.size > MAX_UPLOAD_BYTES) {
      setMessage({ kind: "error", text: t.tooLarge });
      return;
    }
    if (!validName(file.name)) {
      setMessage({ kind: "error", text: errorText(copy, "bad_path") });
      return;
    }
    if (preview) {
      setEntries((current) => [...current.filter((e) => e.name !== file.name), { name: file.name, isDir: false, size: file.size, modifiedAt: new Date().toISOString() }]);
    }
    setMessage({ kind: "note", text: t.uploading(file.name) });
    // The raw bytes go up; the storefront encodes them for the platform on the
    // way through.
    void mutate(() => toolFetch("file", { method: "PUT", query: { path: join(path, file.name) }, body: file }), t.uploaded(file.name));
  }

  function pickedFile(file: File | undefined) {
    if (uploadRef.current) uploadRef.current.value = "";
    if (!file) return;
    if (entries.some((e) => e.name === file.name)) {
      setPending({ kind: "overwrite", file });
      return;
    }
    upload(file);
  }

  function download(name: string) {
    setMessage(null);
    if (preview) {
      setMessage({ kind: "note", text: copy.botTools.previewNote });
      return;
    }
    setMessage({ kind: "ok", text: t.downloadStarting });
    startDownload(`/api/bot-tools/file?${new URLSearchParams({ path: join(path, name) }).toString()}`, (code) => {
      setMessage({ kind: code === "managed_file" ? "note" : "error", text: errorText(copy, code) });
    });
  }

  const crumbs = path ? path.split("/") : [];
  const sorted = [...entries].sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

  return (
    <section className="byok-card">
      <header>
        <div>
          <h2>{t.title}</h2>
          <p>{t.body}</p>
        </div>
      </header>

      {status !== "running" && !preview && <p className="byok-note">{copy.botTools.needsRunning}</p>}

      <nav className="bt-crumbs" aria-label={t.title}>
        <button type="button" onClick={() => open("")} disabled={!path}>{t.root}</button>
        {crumbs.map((part, i) => {
          const target = crumbs.slice(0, i + 1).join("/");
          return (
            <span key={target}>
              <b aria-hidden="true">/</b>
              <button type="button" onClick={() => open(target)} disabled={target === path}>{part}</button>
            </span>
          );
        })}
      </nav>

      <div className="bt-toolbar">
        <button type="button" className="btn btn-secondary" disabled={!path || busy} onClick={() => open(crumbs.slice(0, -1).join("/"))}>{t.up}</button>
        <button type="button" className="btn btn-secondary" disabled={busy || load !== "ready"} onClick={() => setPending({ kind: "mkdir", value: "" })}>{t.newFolder}</button>
        <button type="button" className="btn btn-secondary" disabled={busy || load !== "ready"} onClick={() => uploadRef.current?.click()}>{t.upload}</button>
        <input ref={uploadRef} type="file" hidden onChange={(e) => pickedFile(e.target.files?.[0])} />
        <button type="button" className="settings-reset" disabled={busy} onClick={() => open(path)}>{copy.botTools.refresh}</button>
        <span className="byok-effect">{t.uploadLimit}</span>
      </div>

      {pending?.kind === "mkdir" && (
        <form className="bt-inline" onSubmit={(e) => { e.preventDefault(); mkdir(pending.value); }}>
          <label htmlFor="bt-mkdir">{t.folderName}</label>
          <input id="bt-mkdir" autoFocus maxLength={255} value={pending.value} onChange={(e) => setPending({ kind: "mkdir", value: e.target.value })} />
          <button type="submit" className="btn btn-primary" disabled={busy || !pending.value.trim()}>{t.create}</button>
          <button type="button" className="settings-reset" onClick={() => setPending(null)}>{copy.botTools.cancel}</button>
        </form>
      )}

      {pending?.kind === "overwrite" && (
        <div className="bt-confirm" role="alertdialog" aria-label={t.replace}>
          <p>{t.overwriteConfirm(pending.file.name)}</p>
          <div className="byok-actions">
            <button type="button" className="btn btn-primary" onClick={() => upload(pending.file)}>{t.replace}</button>
            <button type="button" className="settings-reset" onClick={() => setPending(null)}>{copy.botTools.cancel}</button>
          </div>
        </div>
      )}

      {load === "loading" && <SectionState kind="loading" text={copy.botTools.loading} />}
      {load === "unavailable" && <SectionState kind="note" text={errorText(copy, "not_available")} />}
      {load === "error" && <SectionState kind="error" text={loadError} onRetry={() => open(path)} retryLabel={copy.tryAgain} />}

      {load === "ready" && (
        sorted.length === 0 ? (
          <p className="byok-note">{t.empty}</p>
        ) : (
          <div className="bt-table-wrap">
            <table className="bt-files">
              <thead>
                <tr><th scope="col">{t.name}</th><th scope="col">{t.size}</th><th scope="col">{t.modified}</th><th scope="col"><span className="sr-only">{t.actions}</span></th></tr>
              </thead>
              <tbody>
                {sorted.map((entry) => {
                  const renaming = pending?.kind === "rename" && pending.name === entry.name;
                  const deleting = pending?.kind === "delete" && pending.name === entry.name;
                  const tooBig = !entry.isDir && (entry.size ?? 0) > MAX_DOWNLOAD_BYTES;
                  return (
                    <tr key={entry.name}>
                      <td>
                        {renaming ? (
                          <form className="bt-inline is-row" onSubmit={(e) => { e.preventDefault(); rename(entry.name, pending.value); }}>
                            <label className="sr-only" htmlFor="bt-rename">{t.renameLabel}</label>
                            <input id="bt-rename" autoFocus maxLength={255} value={pending.value} onChange={(e) => setPending({ kind: "rename", name: entry.name, value: e.target.value })} />
                            <button type="submit" className="btn btn-primary" disabled={busy || !pending.value.trim() || pending.value.trim() === entry.name}>{t.save}</button>
                            <button type="button" className="settings-reset" onClick={() => setPending(null)}>{copy.botTools.cancel}</button>
                          </form>
                        ) : entry.isDir ? (
                          <button type="button" className="bt-entry is-dir" onClick={() => open(join(path, entry.name))}>
                            <i aria-hidden="true">▸</i>{entry.name}
                          </button>
                        ) : (
                          <span className="bt-entry"><i aria-hidden="true">·</i>{entry.name}</span>
                        )}
                        {deleting && (
                          <div className="bt-confirm" role="alertdialog" aria-label={t.delete}>
                            <p>{t.deleteConfirm(entry.name)}</p>
                            <div className="byok-actions">
                              <button type="button" className="btn btn-danger" disabled={busy} onClick={() => remove(entry.name)}>{t.delete}</button>
                              <button type="button" className="settings-reset" onClick={() => setPending(null)}>{copy.botTools.cancel}</button>
                            </div>
                          </div>
                        )}
                      </td>
                      <td>{entry.isDir ? "—" : formatBytes(entry.size)}</td>
                      <td>{entry.modifiedAt ? dateFormat.format(new Date(entry.modifiedAt)) : "—"}</td>
                      <td>
                        <div className="bt-row-actions">
                        {!entry.isDir && (
                          <button type="button" className="settings-reset" disabled={tooBig} title={tooBig ? t.downloadTooLarge : undefined} onClick={() => download(entry.name)}>
                            {t.download}
                          </button>
                        )}
                        <button type="button" className="settings-reset" disabled={busy} onClick={() => setPending({ kind: "rename", name: entry.name, value: entry.name })}>{t.rename}</button>
                        <button type="button" className="settings-reset" disabled={busy} onClick={() => setPending({ kind: "delete", name: entry.name })}>{t.delete}</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      )}

      {message && (
        <p
          className={message.kind === "error" ? "panel-error" : message.kind === "ok" ? "panel-success" : "byok-note"}
          role={message.kind === "error" ? "alert" : "status"}
        >
          {message.text}
        </p>
      )}
    </section>
  );
}
