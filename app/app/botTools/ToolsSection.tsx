"use client";
import { useCallback, useEffect, useRef, useState } from 'react';
import { catalogToolsCopy } from '../../../lib/catalogToolsCopy';
import { SectionState, errorText, toolFetch, type SectionProps } from './shared';
type State = 'installed' | 'installing' | 'uninstalling' | 'not_installed' | 'failed' | 'unavailable';
type Tool = { id: string; name: string; description: string; status: State; installable: boolean; connector?: { endpointPlaceholder?: string; defaultEndpoint?: string; defaultAuthMode?: string } };
const active = (s: State) => s === 'installing' || s === 'uninstalling';
export default function ToolsSection({ copy, preview, status, locale }: SectionProps & { locale?: string }) {
  const t = catalogToolsCopy(locale);
  const [tools, setTools] = useState<Tool[]>(preview ? [{ id: 'pandoc', name: 'Pandoc', description: '', status: 'not_installed', installable: true }] : []);
  const [loading, setLoading] = useState(!preview);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [form, setForm] = useState<Tool | null>(null);
  const [endpoint, setEndpoint] = useState('');
  const [authMode, setAuthMode] = useState('bearer');
  const [token, setToken] = useState('');
  const [confirm, setConfirm] = useState<Tool | null>(null);
  const [busy, setBusy] = useState(false);
  const [poll, setPoll] = useState(0);
  const misses = useRef(0);
  const rounds = useRef(0);
  const refresh = useCallback(async () => {
    if (preview) return true;
    const res = await toolFetch<{ tools: Tool[] }>('catalog-tools');
    if (!res.ok || !Array.isArray(res.data.tools)) { setError(errorText(copy, res.data.error)); setLoading(false); return false; }
    setTools(res.data.tools); setError(''); setLoading(false); return true;
  }, [preview, copy]);
  useEffect(() => { void refresh(); }, [refresh]);
  const working = tools.some(tool => active(tool.status));
  useEffect(() => {
    if (preview || !working) return;
    const timer = window.setTimeout(async () => {
      const ok = await refresh();
      misses.current = ok ? 0 : misses.current + 1;
      rounds.current += 1;
      if (misses.current >= 10 || rounds.current >= 600) { setError(t.lost); return; }
      setPoll(n => n + 1);
    }, Math.min(3000 * (1 + misses.current), 30000));
    return () => window.clearTimeout(timer);
  }, [preview, working, poll, refresh, t.lost]);
  function closeForm() { setToken(''); setForm(null); }
  function open(tool: Tool) { setError(''); setConfirm(null); setToken(''); setEndpoint(tool.connector?.defaultEndpoint ?? ''); setAuthMode(tool.connector?.defaultAuthMode ?? 'bearer'); setForm(tool); }
  async function change(tool: Tool, remove: boolean) {
    if (busy) return;
    setError(''); setBusy(true); setConfirm(null);
    if (preview) { setTools(list => list.map(item => item.id === tool.id ? { ...item, status: remove ? 'not_installed' : 'installed' } : item)); closeForm(); setBusy(false); return; }
    const credentials = tool.connector && !remove ? { endpoint, authMode, ...(authMode === 'none' ? {} : { token }) } : {};
    const res = await toolFetch<{ status: State }>('catalog-tools', { method: remove ? 'DELETE' : 'POST', json: { tool_id: tool.id, ...credentials } });
    setToken(''); setBusy(false);
    if (!res.ok) { setError(errorText(copy, res.data.error)); return; }
    closeForm(); misses.current = 0; rounds.current = 0;
    setTools(list => list.map(item => item.id === tool.id ? { ...item, status: res.data.status ?? (remove ? 'uninstalling' : 'installing') } : item));
    setPoll(n => n + 1);
  }
  return <section className="byok-card bt-catalog">
    <header><div><h2>{t.title}</h2><p>{t.body}</p></div><button type="button" className="btn btn-secondary" disabled={busy} onClick={() => { misses.current = 0; rounds.current = 0; setError(''); setPoll(n => n + 1); void refresh(); }}>{t.refresh}</button></header>
    {loading && <SectionState kind="loading" text={copy.botTools.loading} />}
    {!preview && status !== 'running' && <p className="byok-note">{copy.botTools.needsRunning}</p>}
    <div className="bt-toolbar"><input type="search" value={query} maxLength={80} placeholder={t.search} aria-label={t.search} onChange={e => setQuery(e.target.value)} /></div>
    <ul className="bt-connections">{tools.filter(tool => `${tool.name} ${tool.description}`.toLowerCase().includes(query.toLowerCase())).map(tool => <li key={tool.id}><div><strong>{tool.name}</strong><span>{tool.description}</span><span role="status">{t.states[tool.status] ?? t.states.unavailable}</span>{tool.status === 'failed' && <span role="alert">{t.failed}</span>}</div><div className="bt-row-actions"><button type="button" className="btn btn-secondary" disabled={busy || working || (!preview && status !== 'running') || !tool.installable || tool.status === 'unavailable'} onClick={() => tool.status === 'installed' ? (closeForm(), setConfirm(tool)) : tool.connector ? open(tool) : void change(tool, false)}>{tool.status === 'installed' ? t.remove : tool.connector ? t.connect : t.install}</button></div></li>)}</ul>
    {!loading && !tools.some(tool => `${tool.name} ${tool.description}`.toLowerCase().includes(query.toLowerCase())) && <p>{t.empty}</p>}
    {confirm && <div className="bt-confirm" role="alertdialog" aria-label={t.remove}><p>{confirm.name}: {t.confirm}</p><button type="button" className="btn btn-danger" disabled={busy} onClick={() => void change(confirm, true)}>{t.remove}</button><button type="button" className="settings-reset" onClick={() => setConfirm(null)}>{copy.botTools.cancel}</button></div>}
    {form && <form className="bt-keybox" onSubmit={e => { e.preventDefault(); void change(form, false); }}><h3>{form.name}</h3><p>{t.note}</p><div className="byok-field"><label htmlFor="catalog-endpoint">{t.endpoint}</label><input id="catalog-endpoint" type="url" required pattern="https://.*" maxLength={2048} value={endpoint} placeholder={form.connector?.endpointPlaceholder} onChange={e => setEndpoint(e.target.value)} /></div><div className="byok-field"><label htmlFor="catalog-auth">{t.auth}</label><select id="catalog-auth" value={authMode} onChange={e => { setAuthMode(e.target.value); setToken(''); }}>{['none', 'bearer', 'basic', 'x-api-key', 'api-key'].map(mode => <option key={mode} value={mode}>{mode === 'none' ? t.none : mode}</option>)}</select></div>{authMode !== 'none' && <div className="byok-field"><label htmlFor="catalog-token">{t.token}</label><input id="catalog-token" type="password" required autoComplete="off" spellCheck={false} maxLength={8192} value={token} onChange={e => setToken(e.target.value)} /></div>}<div className="byok-actions"><button type="submit" className="btn btn-primary" disabled={busy || working}>{t.connect}</button><button type="button" className="settings-reset" disabled={busy} onClick={closeForm}>{copy.botTools.cancel}</button></div></form>}
    {error && <p className="panel-error" role="alert">{error}</p>}
  </section>;
}
