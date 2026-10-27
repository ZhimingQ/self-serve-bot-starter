"use client";
import { useCallback, useEffect, useRef, useState } from 'react';
import { chinaAppsCopy, safeVendorUrl } from '../../../lib/chinaAppsCopy';
import { SectionState, toolFetch, type SectionProps } from './shared';
interface App { slug: string; name: string; desc: string; connected: boolean; loginFlow?: string; credentialFields: { name: string; label: string; placeholder?: string; maxLength?: number }[] }
interface Login { status: string; attempt_id?: string; qr_image_url?: string; auth_url?: string; user_code?: string }
interface Answer { login?: Login; ready?: string }
interface Active { slug: string; login: Login }
export default function ChinaAppsSection({ locale = 'en', preview }: SectionProps) {
 const t = chinaAppsCopy(locale);
 const [apps, setApps] = useState<App[]>([]), [loading, setLoading] = useState(!preview), [error, setError] = useState('');
 const [query, setQuery] = useState(''), [shown, setShown] = useState(40), [form, setForm] = useState<App | null>(null), [fields, setFields] = useState<Record<string,string>>({});
 const [confirm, setConfirm] = useState<string | null>(null), [busy, setBusy] = useState(false), [active, setActive] = useState<Active | null>(null), [code, setCode] = useState(''), [notice, setNotice] = useState('');
 const mounted = useRef(true), generation = useRef(0);
 const refresh = useCallback(async () => {
   if (preview) return;
   const res = await toolFetch<App[]>('china-apps');
   if (!mounted.current) return;
   if (res.ok && Array.isArray(res.data)) setApps(res.data.filter((app): app is App => Boolean(app)));
   else setError(t.error);
   setLoading(false);
 }, [preview, t.error]);
 useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; generation.current++; }; }, [refresh]);
 function close() { generation.current++; setActive(null); setForm(null); setFields({}); setCode(''); setConfirm(null); }
 const finish = useCallback((answer: Answer) => {
   if (!answer.ready) return false;
   setNotice(answer.ready === 'ready' ? t.ready : answer.ready === 'reloading' ? t.reloading : answer.ready === 'failed' ? t.failed : t.pending);
   setActive(null); setForm(null); setFields({}); setCode(''); void refresh(); return true;
 }, [refresh, t.ready, t.reloading, t.failed, t.pending]);
 useEffect(() => {
   const login = active?.login;
   if (preview || !active || !login?.attempt_id || login.status !== 'scan') return;
   let cancelled = false, misses = 0, polls = 0;
   const controller = new AbortController();
   let timer: ReturnType<typeof setTimeout>;
   const token = generation.current;
   async function poll() {
     if (cancelled || token !== generation.current) return;
     try {
       // Poll directly so unmount/cancel aborts the in-flight request as well.
       const res = await fetch('/api/bot-tools/china-app-status', { method: 'POST', cache: 'no-store', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ attempt_id: login!.attempt_id }) });
       const answer = await res.json() as Answer;
       if (cancelled || token !== generation.current) return;
       if (!res.ok) throw new Error('poll');
       misses = 0;
       if (finish(answer)) return;
       if (['expired','superseded'].includes(answer.login?.status ?? '')) { setError(t.expired); setActive(null); return; }
     } catch {
       if (cancelled || controller.signal.aborted) return;
       if (++misses >= 5) { setError(t.error); setActive(null); return; }
     }
     if (++polls >= 100) { setError(t.expired); setActive(null); return; }
     timer = setTimeout(() => void poll(), 3000 * (1 + misses));
   }
   timer = setTimeout(() => void poll(), 3000);
   return () => { cancelled = true; clearTimeout(timer); controller.abort(); };
 }, [active, preview, finish, t.expired, t.error]);
 async function connect(app: App, payload: Record<string, unknown>) {
   if (preview || busy) return;
   const previous = active;
   const token = ++generation.current;
   setBusy(true); setError(''); setNotice(''); setActive(null);
   const res = await toolFetch<Answer>('china-apps', { method: 'POST', json: { slug: app.slug, fields: payload } });
   if (!mounted.current || token !== generation.current) return;
   setBusy(false);
   if (!res.ok) { setFields({}); setError(t.error); return; }
   setFields({}); setCode('');
   if (finish(res.data)) return;
   if (res.data.login && ['scan','browser'].includes(res.data.login.status)) setActive({ slug: app.slug, login: res.data.login });
   else if (res.data.login?.status === 'pending' && previous?.slug === app.slug) setActive(previous);
   else setError(t.expired);
 }
 async function disconnect(slug: string) {
   if (preview || busy) return;
   setBusy(true); setError('');
   const res = await toolFetch('china-apps', { method: 'DELETE', query: { slug } });
   if (!mounted.current) return;
   setBusy(false); close(); if (res.ok) await refresh(); else setError(t.error);
 }
 const matching = apps.filter(a => `${a.name} ${a.slug} ${a.desc}`.toLowerCase().includes(query.toLowerCase()));
 const loginUrl = safeVendorUrl(active?.login.auth_url), qr = safeVendorUrl(active?.login.qr_image_url);
 return <div className="byok-card bt-catalog"><h3>{t.title}</h3><p>{t.intro}</p>
  {preview && <SectionState kind="note" text={t.preview} />}
  {error && <SectionState kind="error" text={error} onRetry={() => { setError(''); void refresh(); }} retryLabel={t.retry} />}
  {notice && <p role="status">{notice}</p>}
  <input aria-label={t.search} placeholder={t.search} value={query} onChange={e => { setQuery(e.target.value); setShown(40); }} maxLength={200} />
  {loading ? <SectionState kind="loading" text={t.loading} /> : !matching.length ? <p>{t.empty}</p> : matching.slice(0, shown).map(app => <div className="bt-card" key={app.slug}>
   <strong>{app.name}</strong><p>{app.desc}</p>{app.connected && <p>{t.connected}</p>}
   {confirm === app.slug ? <div><p>{t.confirm}</p><button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void disconnect(app.slug)}>{busy ? t.working : t.disconnect}</button><button type="button" className="btn btn-secondary" disabled={busy} onClick={close}>{t.cancel}</button></div> : <div>
    <button type="button" className="btn btn-secondary" disabled={busy || preview} onClick={() => { close(); setForm(app); setNotice(''); if (app.loginFlow === 'baidu_qr') void connect(app, { action: 'start' }); else if (!app.credentialFields.length) void connect(app, {}); }}>{busy ? t.working : t.connect}</button>
    {app.connected && <button type="button" className="btn btn-secondary" disabled={busy || preview} onClick={() => { close(); setConfirm(app.slug); }}>{t.disconnect}</button>}
   </div>}
   {form?.slug === app.slug && <div>
    {app.loginFlow === 'baidu_qr' ? <div>
      <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void connect(app, { action: 'start', mode: 'browser' })}>{t.browser}</button>
      {active?.slug === app.slug && <div><p>{t.waiting}</p>
       {active.login.status === 'scan' && (qr ? <div><p>{t.scan}</p>{/* Vendor-issued QR image; no Next image optimization or platform proxy. */}<img src={qr} alt={t.scan} width={220} height={220} referrerPolicy="no-referrer" />{active.login.user_code && <code>{active.login.user_code}</code>}</div> : <p>{t.unsafe}</p>)}
       {active.login.status === 'browser' && <div>{loginUrl ? <a href={loginUrl} target="_blank" rel="noopener noreferrer">{t.open}</a> : <p>{t.unsafe}</p>}<form onSubmit={e => { e.preventDefault(); void connect(app, { action: 'code', attempt_id: active.login.attempt_id, code }); }}><input type="password" aria-label={t.code} placeholder={t.code} autoComplete="off" value={code} maxLength={128} onChange={e => setCode(e.target.value)} required /><button type="submit" disabled={busy || !code.trim()} className="btn btn-secondary">{t.submit}</button></form></div>}
      </div>}
    </div> : !!app.credentialFields.length && <form onSubmit={e => { e.preventDefault(); void connect(app, fields); }}>{app.credentialFields.map(field => <label key={field.name}>{field.label}<input type="password" autoComplete="new-password" value={fields[field.name] ?? ''} placeholder={field.placeholder} maxLength={field.maxLength ?? 512} onChange={e => setFields(old => ({ ...old, [field.name]: e.target.value }))} required /></label>)}<button type="submit" className="btn btn-secondary" disabled={busy}>{busy ? t.working : t.connect}</button></form>}
    <button type="button" className="btn btn-secondary" disabled={busy} onClick={close}>{t.cancel}</button>
   </div>}
  </div>)}
  {shown < matching.length && <button type="button" className="btn btn-secondary" onClick={() => setShown(shown + 40)}>{t.more}</button>}
 </div>;
}
