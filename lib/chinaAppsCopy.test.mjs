import assert from 'node:assert/strict';
import test from 'node:test';
import { safeVendorUrl, chinaAppsCopy } from './chinaAppsCopy.ts';
test('authorization links require HTTPS without embedded credentials', () => {
 for (const url of ['javascript:alert(1)', 'data:text/html,test', 'http://pan.baidu.com', 'https://secret@pan.baidu.com/', '/relative', null]) assert.equal(safeVendorUrl(url), null);
 assert.equal(safeVendorUrl('https://pan.baidu.com/oauth?code=123'), 'https://pan.baidu.com/oauth?code=123');
});
test('all six languages have complete connection and login controls', () => {
 const keys = Object.keys(chinaAppsCopy('en')).sort();
 for (const locale of ['en','zh','es','fr','pt','de']) {
  const copy = chinaAppsCopy(locale);
  assert.deepEqual(Object.keys(copy).sort(), keys);
  for (const text of Object.values(copy)) assert.ok(text.length > 0);
 }
 assert.equal(chinaAppsCopy('pt-BR').title, chinaAppsCopy('pt').title);
});
