"use client";
import { useCallback, useEffect, useState } from 'react';
import { websitesCopy, safeWebsiteUrl } from '../../../lib/websitesCopy';
import { toolFetch, SectionState, type SectionProps } from './shared';
type Domain = { id: string; domain: string; status: string; verificationToken?: string | null };
type Site = { id: string; slug: string; url: string; status: string; domains: Domain[] };
type State = { sites: Site[]; limits: { sites: number }; originHost: string; serverIp: string };
export default function WebsitesSection({ copy, preview, status, locale }: SectionProps & { locale?: string }) {
  const t = websitesCopy(locale);
  const [data, setData] = useState<State>({ sites: [], limits: { sites: 3 }, originHost: '', serverIp: '' });
  const [loading, setLoading] = useState(!preview);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [slug, setSlug] = useState('');
  const [domains, setDomains] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<{ siteId: string; domainId?: string } | null>(null);
  const refresh = useCallback(async () => {
    if (preview) return;
    setLoading(true);
    const res = await toolFetch<State>('websites');
    setLoading(false);
    if (res.ok && Array.isArray(res.data.sites)) {
      setData({ sites: res.data.sites, limits: res.data.limits || { sites: 3 }, originHost: res.data.originHost || '', serverIp: res.data.serverIp || '' });
      setError('');
    } else setError(t.error);
  }, [preview, t.error]);
  useEffect(() => { void refresh(); }, [refresh]);
  async function mutate(method: 'POST' | 'PUT' | 'DELETE', json: Record<string, unknown>) {
    if (busy) return;
    setError(''); setNotice('');
    if (preview) { setNotice(t.done); setConfirm(null); return; }
    setBusy(true);
    const res = await toolFetch('websites', { method, json });
    if (res.ok) { setSlug(''); setConfirm(null); await refresh(); setNotice(t.done); }
    else setError(t.error);
    setBusy(false);
  }
  const canCreate = status === 'running' || status === 'sleeping';
  const label = (value: string) => value === 'active' ? t.active : value === 'pending' ? t.pending : value === 'creating' ? t.creating : value === 'deleting' ? t.deleting : t.unknown;
  return <section className="byok-card bt-catalog">
    <header><div><h2>{t.title}</h2><p>{t.body}</p></div><button className="btn btn-secondary" disabled={busy || loading} onClick={() => void refresh()}>{t.refresh}</button></header>
    {loading && <SectionState kind="loading" text={copy.botTools.loading} />}
    {error && <SectionState kind="error" text={error} />}
    {notice && <p role="status">{notice}</p>}
    {!canCreate && <p className="byok-note">{t.start}</p>}
    <p className="byok-note">{t.limit}: {data.sites.length}/{data.limits.sites}</p>
    <form className="bt-keybox" onSubmit={event => { event.preventDefault(); void mutate('POST', { slug }); }}>
      <label htmlFor="bt-website-name">{t.name}</label>
      <input id="bt-website-name" value={slug} onChange={event => setSlug(event.target.value.toLowerCase())} minLength={3} maxLength={63} pattern="[a-z0-9]+(-[a-z0-9]+)*" required autoComplete="off" />
      <button className="btn btn-primary" disabled={busy || loading || !canCreate || data.sites.length >= data.limits.sites}>{t.create}</button>
    </form>
    {!loading && data.sites.length === 0 && <p>{t.empty}</p>}
    {data.sites.map(site => {
      const url = safeWebsiteUrl(site.url);
      return <article key={site.id} className="bt-keybox">
        <h3>{site.slug} · {label(site.status)}</h3>
        {url && <a href={url} target="_blank" rel="noopener noreferrer">{t.open} ↗</a>}
        <div className="byok-actions"><button className="btn btn-secondary" disabled={busy || status !== 'running' || site.status !== 'active'} onClick={() => void mutate('PUT', { siteId: site.id, action: 'redeploy' })}>{t.redeploy}</button><button className="btn btn-secondary" disabled={busy} onClick={() => setConfirm({ siteId: site.id })}>{t.remove}</button></div>
        {(site.domains || []).map(domain => <div key={domain.id} className="bt-keybox">
          <strong>{domain.domain} · {label(domain.status)}</strong>
          {domain.status !== 'active' && <><h4>{t.dns}</h4><p>{t.dnsNote}</p><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{`CNAME ${domain.domain} → ${data.originHost}\n\nA ${domain.domain} → ${data.serverIp}\nTXT _openclaw-verify.${domain.domain} → ${domain.verificationToken || ''}`}</pre><div className="byok-actions"><button className="btn btn-secondary" disabled={busy} onClick={() => void mutate('POST', { action: 'verify_domain', siteId: site.id, domainId: domain.id, method: 'cname' })}>{t.cname}</button><button className="btn btn-secondary" disabled={busy} onClick={() => void mutate('POST', { action: 'verify_domain', siteId: site.id, domainId: domain.id, method: 'txt' })}>{t.txt}</button></div></>}
          <button className="btn btn-secondary" disabled={busy} onClick={() => setConfirm({ siteId: site.id, domainId: domain.id })}>{t.remove}</button>
        </div>)}
        <form onSubmit={event => { event.preventDefault(); void mutate('POST', { action: 'add_domain', siteId: site.id, domain: domains[site.id] || '' }); }}>
          <label htmlFor={`domain-${site.id}`}>{t.domain}</label><input id={`domain-${site.id}`} required maxLength={253} value={domains[site.id] || ''} onChange={event => setDomains(current => ({ ...current, [site.id]: event.target.value }))} /><button className="btn btn-secondary" disabled={busy || site.status !== 'active'}>{t.addDomain}</button>
        </form>
      </article>;
    })}
    {confirm && <div className="bt-confirm" role="alertdialog" aria-label={t.remove}><p>{t.confirm}</p><div className="byok-actions"><button className="btn btn-danger" disabled={busy} onClick={() => void mutate('DELETE', confirm)}>{t.remove}</button><button className="btn btn-secondary" disabled={busy} onClick={() => setConfirm(null)}>{t.cancel}</button></div></div>}
  </section>;
}
