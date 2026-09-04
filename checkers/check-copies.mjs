#!/usr/bin/env node
// check-copies.mjs — compares mirror copies of a canonical file section by section.
//
//   check-copies.mjs --config <file>   sweep the configured copies
//   check-copies.mjs --selftest        plant known drifts and prove they are caught
//
// WHY THIS EXISTS
// ---------------
// Consuming repositories kept their own baked copy of one canonical standards
// document. Four manual resyncs of one file in one day were not enough; each
// copy drifted silently until something downstream broke. This checker reads the
// canonical file and every configured mirror, compares the named sections, and
// reports drift as a finding rather than letting a stale copy pass.
//
// Exit 0 clean, 1 findings, 2 broken or misconfigured.

import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { configFrom, configPath, section, fatal, ConfigError, parseConfig } from './config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

function normalizeLine(s) { return s.trim().replace(/\s+/g, ' '); }

function parseSections(text) {
  const sections = new Map();
  let heading = null;
  let body = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      if (heading) sections.set(heading, body);
      heading = line.slice(3).trim();
      body = [];
    } else if (heading) body.push(line);
  }
  if (heading) sections.set(heading, body);
  return sections;
}

function sectionDiff(a, b) {
  const ca = a.map(normalizeLine);
  const cb = b.map(normalizeLine);
  const n = Math.max(ca.length, cb.length);
  let d = 0;
  for (let i = 0; i < n; i += 1) if (ca[i] !== cb[i]) d += 1;
  return { diff: d, total: n };
}

function validate(cfg) {
  if (!cfg.id) throw new ConfigError('copies entry missing id');
  if (!cfg.canonical) throw new ConfigError(`copies entry ${cfg.id} missing canonical`);
  if (!Array.isArray(cfg.mirrors) || !cfg.mirrors.length) throw new ConfigError(`copies entry ${cfg.id} missing mirrors`);
  if (!Array.isArray(cfg.sections) || !cfg.sections.length) throw new ConfigError(`copies entry ${cfg.id} missing sections`);
}

function checkCopy(doc, cfg) {
  const out = [];
  let text;
  try { text = readFileSync(configPath(doc, cfg.canonical), 'utf8'); }
  catch (e) { throw new ConfigError(`cannot read canonical ${cfg.canonical} (${e.code ?? e.message})`); }
  const can = parseSections(text);
  for (const h of cfg.sections) if (!can.has(h)) throw new ConfigError(`canonical ${cfg.canonical} missing section "## ${h}"`);
  for (const m of cfg.mirrors) {
    let mirrorText;
    try { mirrorText = readFileSync(configPath(doc, m), 'utf8'); }
    catch (_e) { out.push(`DRIFT ${cfg.id} ${m} file UNREADABLE`); continue; }
    const mir = parseSections(mirrorText);
    for (const h of cfg.sections) {
      if (!mir.has(h)) { out.push(`DRIFT ${cfg.id} ${m} section "${h}" 1/1 differ`); continue; }
      const d = sectionDiff(can.get(h), mir.get(h));
      if (d.diff) out.push(`DRIFT ${cfg.id} ${m} section "${h}" ${d.diff}/${d.total} differ`);
    }
  }
  return out;
}

async function main() {
  const doc = configFrom(args, here);
  const copies = section(doc, 'copies');
  const findings = [];
  for (const cfg of copies) { validate(cfg); findings.push(...checkCopy(doc, cfg)); }
  for (const f of findings) console.log(f);
  console.log(`== ${findings.length} drift finding(s) across ${copies.length} copy set(s)`);
  return findings.length ? 1 : 0;
}

function selftest() {
  let fail = 0;
  const ck = (name, want, got) => {
    const ok = String(want) === String(got);
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — want ${want}, got ${got}`}`);
    if (!ok) fail += 1;
  };
  const threw = (fn) => { try { fn(); return false; } catch { return true; } };

  const dir = mkdtempSync(join(tmpdir(), 'check-copies-'));
  const write = (f, c) => writeFileSync(join(dir, f), c, 'utf8');
  const doc = { _dir: dir };
  const cfg = (mirrors) => ({ id: 'standards', canonical: 'canonical.md', mirrors, sections: ['Scope', 'Method'] });

  write('canonical.md', '## Scope\n\nThis is the scope.\n\n## Method\n\nEvery run uses a seed.\n');
  write('mirror-clean.md', '## Scope\n\nThis is the scope.\n\n## Method\n\nEvery run uses a seed.\n');
  write('mirror-drifted.md', '## Scope\n\nThis is the scope.\n\n## Method\n\nEvery run uses a seed sometimes.\n');

  ck('identical pair is clean', 0, checkCopy(doc, cfg(['mirror-clean.md'])).length);
  const drifted = checkCopy(doc, cfg(['mirror-drifted.md']));
  ck('drifted pair produces exactly one finding', 1, drifted.length);
  ck('drifted finding carries the configured id', true, drifted[0].startsWith('DRIFT standards'));
  ck('positive control finds the planted drift in the Method section', true, drifted[0].includes('Method'));

  ck('missing mirror is a finding', 1, checkCopy(doc, cfg(['mirror-missing.md'])).length);

  ck('malformed config text is ConfigError', true, threw(() => parseConfig('{not json}', 'test.json')));

  // THE FAULT CASE. Broken config input must hard-fail rather than sweep clean.
  ck('empty copies section is fatal', true, threw(() => section({ copies: [] }, 'copies')));
  ck('config entry with zero mirrors is fatal', true,
    threw(() => validate({ id: 'x', canonical: 'c.md', mirrors: [], sections: ['A'] })));

  rmSync(dir, { recursive: true, force: true });
  return fail;
}

if (args.includes('--selftest')) {
  process.exit(selftest() === 0 ? 0 : 1);
} else if (process.argv[1]?.endsWith('check-copies.mjs')) {
  main().then((c) => process.exit(c)).catch(fatal);
}
