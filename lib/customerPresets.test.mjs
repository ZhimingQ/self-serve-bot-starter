import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CUSTOMER_PRESET_IDS, customerPreviewHref, getCustomerPreset, isCustomerPresetId, resolveCustomerPreset } from './customerPresets.ts';

const configFile = fileURLToPath(new URL('./config.ts', import.meta.url));
function configWith(values = {}) {
  const env = { ...process.env };
  for (const key of ['CUSTOMER_TEMPLATE', 'ASSISTANT_INSTRUCTIONS', 'ASSISTANT_INSTRUCTIONS_FILE', 'WORKSPACE_MODE', 'BRAND_ACCENT', 'STOREFRONT_BRANDING_FILE']) delete env[key];
  Object.assign(env, values);
  const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    const mod = await import(${JSON.stringify(configFile)});
    const c = mod.default ?? mod;
    console.log(JSON.stringify({ id: c.customerTemplate, instructions: c.assistantInstructions(), accent: c.brand.accent, mode: c.workspaceMode, students: c.studentWorkspace }));
  `], { env, encoding: 'utf8' });
  return JSON.parse(output.trim());
}

test('all profiles have complete original bilingual starting points and bounded guidance', () => {
  for (const id of CUSTOMER_PRESET_IDS) {
    const preset = getCustomerPreset(id);
    assert.equal(preset.id, id);
    assert.match(preset.accent, /^#[a-f0-9]{6}$/i);
    assert.ok(preset.instructions.length <= 2000);
    if (id !== 'general') assert.ok(preset.instructions.length > 100);
    for (const locale of ['en', 'zh']) {
      const copy = preset[locale];
      for (const field of ['name', 'description', 'heroTitle', 'heroBody', 'greeting']) assert.ok(copy[field].trim(), `${id}.${locale}.${field}`);
      assert.equal(copy.prompts.length, 3);
      assert.equal(new Set(copy.prompts).size, 3);
      assert.equal(copy.workflows.length, 3);
      assert.deepEqual(copy.prompts, copy.workflows.map((w) => w.prompt));
      for (const text of Object.values(copy.example)) assert.ok(text.trim());
    }
  }
  assert.equal(getCustomerPreset('general').instructions, '');
});

test('only demo previews accept an allowlisted query; hostile and repeated values cannot override', () => {
  assert.equal(resolveCustomerPreset('office', 'creator', true), 'creator');
  assert.equal(resolveCustomerPreset('office', 'creator', false), 'office');
  for (const input of ['__proto__', 'constructor', '../../creator', 'CREATOR', '<script>', ['creator'], null, {}, 1]) {
    assert.equal(isCustomerPresetId(input), false);
    assert.equal(resolveCustomerPreset('office', input, true), 'office');
    assert.equal(resolveCustomerPreset(input), 'general');
  }
  for (const locale of ['en', 'zh']) {
    const href = new URL(customerPreviewHref('/demo', 'study', locale), 'https://example.test');
    assert.equal(href.pathname, '/demo');
    assert.equal(href.searchParams.get('preset'), 'study');
    assert.equal(href.searchParams.get('locale'), locale);
  }
});

test('live config defaults safely; study does not enable the gated student workspace', () => {
  assert.deepEqual(configWith(), { id: 'general', instructions: '', accent: '#777e69', mode: 'full', students: false });
  const study = configWith({ CUSTOMER_TEMPLATE: 'study' });
  assert.equal(study.instructions, getCustomerPreset('study').instructions);
  assert.equal(study.accent, getCustomerPreset('study').accent);
  assert.equal(study.mode, 'full');
  assert.equal(study.students, false);
  assert.equal(configWith({ CUSTOMER_TEMPLATE: 'bad-value' }).id, 'general');
  const dedicatedStudent = configWith({ CUSTOMER_TEMPLATE: 'creator', WORKSPACE_MODE: 'students' });
  assert.equal(dedicatedStudent.students, true);
  assert.equal(dedicatedStudent.id, 'general');
  assert.equal(dedicatedStudent.instructions, '');
});

test('owner guidance and branding win, including explicit empty guidance and file precedence', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'customer-preset-'));
  const filename = path.join(dir, 'instructions.txt');
  const branding = path.join(dir, 'branding.json');
  try {
    assert.equal(configWith({ CUSTOMER_TEMPLATE: 'office', ASSISTANT_INSTRUCTIONS: '' }).instructions, '');
    assert.equal(configWith({ CUSTOMER_TEMPLATE: 'office', ASSISTANT_INSTRUCTIONS: 'Owner guidance' }).instructions, 'Owner guidance');
    writeFileSync(filename, 'File guidance');
    const values = { CUSTOMER_TEMPLATE: 'office', ASSISTANT_INSTRUCTIONS: 'Env guidance', ASSISTANT_INSTRUCTIONS_FILE: filename };
    assert.equal(configWith(values).instructions, 'File guidance');
    writeFileSync(filename, '');
    assert.equal(configWith(values).instructions, '');
    rmSync(filename);
    assert.equal(configWith(values).instructions, 'Env guidance');
    delete values.ASSISTANT_INSTRUCTIONS;
    assert.equal(configWith(values).instructions, getCustomerPreset('office').instructions);
    writeFileSync(branding, JSON.stringify({ accent: '#123456' }));
    assert.equal(configWith({ CUSTOMER_TEMPLATE: 'creator', BRAND_ACCENT: '#abcdef', STOREFRONT_BRANDING_FILE: branding }).accent, '#123456');
    assert.equal(configWith({ CUSTOMER_TEMPLATE: 'creator', BRAND_ACCENT: '#abcdef' }).accent, '#abcdef');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('downloaded example config leaves guidance unset so changing the profile works', () => {
  const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  assert.match(example, /^CUSTOMER_TEMPLATE=general$/m);
  assert.doesNotMatch(example, /^ASSISTANT_INSTRUCTIONS=/m);
});
