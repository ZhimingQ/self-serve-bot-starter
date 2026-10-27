import { test } from 'node:test';
import assert from 'node:assert/strict';
import { websitesCopy, safeWebsiteUrl } from './websitesCopy.ts';
test('website links only allow credential-free HTTPS URLs', () => {
  for (const value of ['javascript:alert(1)', 'data:text/html,x', 'http://example.com', 'https://user:secret@example.com', 'not a url', null]) assert.equal(safeWebsiteUrl(value), null);
  assert.equal(safeWebsiteUrl('https://example.readyhermes.com'), 'https://example.readyhermes.com/');
});
test('all website copy locales provide every label and support regional tags', () => {
  const english = websitesCopy('en');
  for (const locale of ['en', 'zh', 'es', 'fr', 'pt', 'de']) {
    const copy = websitesCopy(locale);
    assert.deepEqual(Object.keys(copy).sort(), Object.keys(english).sort());
    for (const value of Object.values(copy)) assert.ok(typeof value === 'string' && value.length > 0);
  }
  assert.equal(websitesCopy('pt-BR').title, websitesCopy('pt').title);
  assert.equal(websitesCopy('zh-Hans').title, websitesCopy('zh').title);
  assert.deepEqual(websitesCopy('unknown'), english);
});
