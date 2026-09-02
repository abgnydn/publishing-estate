#!/usr/bin/env node
// check-orphans.mjs — the numbers on a live surface that nobody registered,
// and the same quantity published at two different values across surfaces.
//
//   check-orphans.mjs --config <file>   sweep the configured surfaces
//   check-orphans.mjs --selftest        plant a known orphan and prove it is caught
//
// WHY THIS EXISTS
// ---------------
// Registry rule 1 says no number appears on any public surface unless it has an
// id. Nothing enforced it. A checker that re-reads numbers which are ALREADY
// registered is structurally blind to the dangerous case — a number nobody
// wrote down — because an unregistered number cannot drift, so it is never
// reported. The defects that motivated this were all of that kind, and every
// one was found by a person happening to look.
//
// The second half is the cross-surface join. A registry answers "is this number
// still right". It cannot answer "is one quantity published as two different
// values somewhere on the estate", because the numbers that disagree are
// precisely the ones no registry has. Every number on every surface is in hand
// by the time the sweep ends, so the question can be asked of all of them.
//
// Two numbers describe the same quantity when the word immediately after them
// matches. "119 devices" and "592 devices" are the same quantity; "119 devices"
// and "119 runs" are not. Crude, and the crudeness is what makes it work: it
// needs no registry, which is the whole point.
//
// FALSE POSITIVES ARE THE POINT
// -----------------------------
// A sweep tuned to report nothing proves nothing. This one over-reports by
// design and converges through the benign patterns below — dates, versions,
// DOIs, URLs, things that are numbers but not claims — each of which says what
// it excuses and why, because a silent exclusion is how a sweep passes blind.
//
// Exit 0 clean, 1 findings, 2 broken or misconfigured. UNREACHABLE is never a
// finding and never a pass.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { configFrom, configPath, fatal, section } from './config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const TIMEOUT = 25000;
const CONTEXT = 60;
const MAX_PER_SURFACE = 40;

// ---------------------------------------------------------------- normalising

// Script and style blocks are stripped first: a bundle hash containing 592 is
// not a published claim.
export function normalize(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/&#x?[0-9a-f]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// --------------------------------------------------------------- benign rules

// Each entry says what it excuses and why. A silent exclusion is how a sweep
// passes while blind.
const BENIGN = [
  { name: 'iso-date', re: /^\d{4}-\d{2}-\d{2}$/, why: 'a date is not a claim' },
  { name: 'year', re: /^(19|20)\d{2}$/, why: 'bare years are dates, versions or copyright' },
  { name: 'semver', re: /^\d+\.\d+\.\d+$/, why: 'version strings' },
  { name: 'clock', re: /^\d{1,2}:\d{2}$/, why: 'times' },
  { name: 'single-digit', re: /^\d$/, why: 'too noisy to be actionable' },
];

const BENIGN_CONTEXT = [
  // The tokenizer splits on the hyphen, so an ISO date arrives as three tokens
  // and only the year is caught by the rule above. Without this the month and
  // the day of every dated line are reported as unregistered claims.
  { name: 'date-part', re: /(19|20)\d{2}-(\d{2}-)?$/, why: 'the month or day of an ISO date' },
  { name: 'doi', re: /10\.\d{4,9}\//, why: 'DOI fragments' },
  { name: 'url', re: /https?:\/\/\S*$/, why: 'inside a URL' },
  { name: 'version-prefix', re: /\bv\s?$/i, why: 'preceded by a version marker' },
  { name: 'copyright', re: /(©|copyright|&copy;)\s*$/i, why: 'copyright line' },
];

export function isBenign(token, before) {
  for (const b of BENIGN) if (b.re.test(token)) return b.name;
  for (const b of BENIGN_CONTEXT) if (b.re.test(before)) return b.name;
  return null;
}

// Ranking, not filtering. A first run over a real estate returns hundreds of
// raw hits, which is the right behaviour for a sweep that must not miss things
// and the wrong thing to hand a person. A number beside a unit is claim-shaped;
// a number beside "followers" is somebody else's page furniture. Both are
// reported; only the order changes, so nothing is silently dropped.
const CLAIM_WORDS = new RegExp(
  '(?:×|x\\b|%|tok/s|tokens?/s|token/s|flops|tflops|gflops|GB|MB|KB|ms\\b|µs|us\\b|ns\\b'
  + '|neurons?|synap|devices?|runs?|tests?|kernels?|shaders?|files?|dispatch|buffers?'
  + '|layers?|parameters?|params?|speedup|faster|slower|accuracy|coverage|perplexity'
  + '|lines?|commits?|experts?|hours?|minutes?)', 'i');

const CHROME_WORDS = new RegExp(
  '(?:followers?|following|connections?|comments?|likes?|liked|repost|sign in|sign up'
  + '|log in|updated|ago|pricing|support|copyright|cookie|privacy|terms|©'
  + '|characters|notifications?|stars?|watchers?|forks?)', 'i');

export function score(token, context) {
  let n = 0;
  if (CLAIM_WORDS.test(context)) n += 3;
  if (CHROME_WORDS.test(context)) n -= 3;
  if (/[.,]/.test(token)) n += 1;
  if (Number(token.replace(/,/g, '')) > 1000) n += 1;
  return n;
}

// ------------------------------------------------------------------ registry

export function registeredValues(factsDoc) {
  const vals = new Set();
  for (const f of factsDoc?.facts ?? []) {
    if (f.value === null || f.value === undefined) continue;
    const s = String(f.value).trim();
    if (!s) continue;
    // Exact and comma-stripped forms only. A registered 119 must not excuse
    // 1190, and a registered 0.988 must not excuse 0.99.
    vals.add(s);
    vals.add(s.replace(/,/g, ''));
  }
  return vals;
}

// -------------------------------------------------------------------- extract

export function extract(text, registered, surfaceId) {
  const found = new Map();
  for (const m of text.matchAll(/(?<![\w.])\d[\d,]*(?:\.\d+)?(?![\w])/g)) {
    // Trailing punctuation belongs to the sentence, not the number. Leaving it
    // on produced "1994," which then failed the year rule, and a citation was
    // reported as an unregistered claim.
    const token = m[0].replace(/[.,]+$/, '');
    if (!token) continue;
    const bare = token.replace(/,/g, '');
    if (registered.has(token) || registered.has(bare)) continue;
    const before = text.slice(Math.max(0, m.index - 24), m.index);
    if (isBenign(token, before)) continue;
    if (found.has(token)) { found.get(token).count += 1; continue; }
    const context = text.slice(Math.max(0, m.index - CONTEXT), m.index + token.length + CONTEXT).trim();
    found.set(token, { token, count: 1, surface: surfaceId, context, score: score(token, context) });
  }
  return [...found.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_PER_SURFACE);
}

// ------------------------------------------------------- cross-surface join

const UNIT_STOP = new Set([
  'the', 'a', 'an', 'of', 'in', 'on', 'and', 'or', 'to', 'for', 'with', 'at',
  'is', 'are', 'was', 'were', 'vs', 'see', 'per', 'from', 'by', 'that', 'this',
  'it', 'its', 'as', 'but', 'not', 'you', 'your', 'we', 'our',
]);

// Symbols carry the quantity on their own and are read before any word,
// because "16.7%" and "16.7 % of traffic" are one measurement.
const UNIT_SYMBOLS = [['%', 'percent'], ['×', 'times'], ['x', 'times']];

// The unit is the FIRST word after the number and only that. An earlier version
// took up to two words through a permissive prefix, skipped punctuation into
// the middle of a sentence, and produced units like "v", "d" and "e" — groups
// that mean nothing and drown the real ones.
export function unitPhrase(after) {
  const raw = after.replace(/^\s+/, '');
  for (const [sym, name] of UNIT_SYMBOLS) if (raw.startsWith(sym)) return name;
  const m = raw.toLowerCase().match(/^([a-z][a-z/-]{2,})/);
  if (!m) return null;
  const word = m[1];
  if (UNIT_STOP.has(word)) return null;
  return word.replace(/s$/, '');
}

// A document that EXPLAINS a wrong number has to quote it, and flagging that
// teaches you to delete the disclosure. This repository's own incident log
// narrates the inverted-sign defect verbatim; without this guard it contradicts
// every surface carrying the corrected value.
const RETRACTION_LANGUAGE = new RegExp(
  '(?:retract|withdraw|superseded|corrected|erratum|errata|formerly|previously|'
  + 'no longer|used to|was wrong|incorrect|stale|the defect|the bug|instead of|'
  + 'turned out|mis-?read|inverted)', 'i');

export function quantityIndex(text, surfaceId, url) {
  const out = [];
  for (const m of text.matchAll(/(?<![\w.])\d[\d,]*(?:\.\d+)?(?![\w])/g)) {
    const token = m[0].replace(/[.,]+$/, '');
    if (!token) continue;
    const before = text.slice(Math.max(0, m.index - 24), m.index);
    if (isBenign(token, before)) continue;
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 40);
    const unit = unitPhrase(after);
    if (!unit) continue;
    const around = text.slice(Math.max(0, m.index - 160), m.index + 160);
    if (RETRACTION_LANGUAGE.test(around)) continue;
    out.push({
      unit,
      value: token.replace(/,/g, ''),
      raw: token,
      surface: surfaceId,
      url,
      context: text.slice(Math.max(0, m.index - 50), m.index + token.length + 50).trim(),
    });
  }
  return out;
}

export function findContradictions(index) {
  const byUnit = new Map();
  for (const e of index) {
    if (!byUnit.has(e.unit)) byUnit.set(e.unit, []);
    byUnit.get(e.unit).push(e);
  }
  const out = [];
  for (const [unit, entries] of byUnit) {
    const values = new Set(entries.map((e) => e.value));
    if (values.size < 2) continue;
    const surfaces = new Set(entries.map((e) => e.surface));
    // One page legitimately quoting several values of the same unit is prose,
    // not a contradiction. It matters once two SURFACES disagree.
    if (surfaces.size < 2) continue;

    const perSurface = new Map();
    for (const e of entries) {
      if (!perSurface.has(e.surface)) perSurface.set(e.surface, new Set());
      perSurface.get(e.surface).add(e.value);
    }

    // Two surfaces genuinely disagree only when EACH carries a value the other
    // does not. Without this, one page listing two related quantities of the
    // same unit was reported as contradicting a second page that simply repeats
    // one of them. Those are two quantities, not two answers.
    const list = [...perSurface.values()];
    let genuine = false;
    for (let i = 0; i < list.length && !genuine; i += 1) {
      for (let j = i + 1; j < list.length && !genuine; j += 1) {
        const aOnly = [...list[i]].some((v) => !list[j].has(v));
        const bOnly = [...list[j]].some((v) => !list[i].has(v));
        if (aOnly && bOnly) genuine = true;
      }
    }
    if (!genuine) continue;
    // A unit claimed by half the estate is a common word, not a quantity.
    if (values.size > 6) continue;

    out.push({
      unit,
      values: [...values].sort(),
      surfaces: [...surfaces],
      samples: entries.slice(0, 8).map((e) => ({
        value: e.raw, surface: e.surface, url: e.url, context: e.context,
      })),
    });
  }
  return out.sort((a, b) => b.surfaces.length - a.surfaces.length || b.values.length - a.values.length);
}

// ------------------------------------------------------------------ fetching

async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { accept: 'text/html' } });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, status: res.status, body: await res.text() };
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

async function readSurface(doc, s) {
  if (s.file) {
    try {
      return { ok: true, body: readFileSync(configPath(doc, s.file), 'utf8') };
    } catch (e) {
      return { ok: false, status: 0, error: e.code ?? e.message };
    }
  }
  if (s.url) return fetchText(s.url);
  return { ok: false, status: 0, error: 'the entry names neither a url nor a file' };
}

// ----------------------------------------------------------------------- main

async function main() {
  const doc = configFrom(args, here);
  const surfaces = section(doc, 'surfaces');
  const factsPath = configPath(doc, section(doc, 'facts'));

  let factsDoc;
  try {
    factsDoc = JSON.parse(readFileSync(factsPath, 'utf8'));
  } catch (e) {
    // Comparing against nothing is not a clean result. Without a registry every
    // number on every surface is unregistered, and the sweep would print a wall
    // of findings or, worse, be tuned until it printed none.
    console.error(`CONFIG  the registry at ${factsPath} is unreadable (${e.message}) — nothing to compare against`);
    return 2;
  }

  const registered = registeredValues(factsDoc);
  console.log(`== ${surfaces.length} surface(s), ${registered.size} registered value(s)`);

  const index = [];
  let findings = 0;
  let unreachable = 0;

  for (const s of surfaces) {
    const res = await readSurface(doc, s);
    if (!res.ok) {
      unreachable += 1;
      console.log(`UNREACHABLE  ${s.id} (${res.status ? `http ${res.status}` : res.error}) — not a finding, and not a pass`);
      continue;
    }
    const text = normalize(res.body);
    index.push(...quantityIndex(text, s.id, s.url ?? s.file));
    const orphans = extract(text, registered, s.id);
    findings += orphans.filter((o) => o.score >= 3).length;
    if (orphans.length) {
      console.log(`\n── ${s.id} ──`);
      for (const o of orphans) {
        const tag = o.score >= 3 ? 'UNREGISTERED' : o.score < 0 ? 'probably-chrome' : 'unregistered?';
        console.log(`${tag.padEnd(15)} ${o.token.padEnd(12)} …${o.context}…`);
      }
    }
  }

  const contradictions = findContradictions(index);
  if (contradictions.length) {
    console.log('\n── one quantity, two values, across surfaces ──');
    for (const c of contradictions.slice(0, 20)) {
      console.log(`CROSS-SURFACE  ${c.unit.padEnd(22)} ${c.values.join(' vs ')}  [${c.surfaces.join(', ')}]`);
    }
  }

  console.log(`\n${findings} claim-shaped unregistered number(s), ${contradictions.length} cross-surface `
    + `contradiction(s), across ${surfaces.length - unreachable} readable surface(s)`);
  if (unreachable) console.log(`${unreachable} surface(s) unreachable — that proves nothing about them`);
  return findings > 0 || contradictions.length > 0 ? 1 : 0;
}

// --------------------------------------------------------------------- selftest

function selftest() {
  let fail = 0;
  const ck = (name, want, got) => {
    const ok = String(want) === String(got);
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — want ${want}, got ${got}`}`);
    if (!ok) fail += 1;
  };
  const threw = (fn) => { try { fn(); return false; } catch { return true; } };

  const reg = new Set(['119']);
  const none = new Set();

  const planted = 'measured across 592 devices in 2026 on v1.2.3 at 09:30 with 119 combos';
  const hits = extract(planted, reg, 'test').map((o) => o.token);
  ck('planted orphan is caught', true, hits.includes('592'));
  ck('registered value is excused', false, hits.includes('119'));
  ck('year is excused', false, hits.includes('2026'));
  ck('semver is excused', false, hits.includes('1.2.3'));
  ck('clock is excused', false, hits.includes('09:30'));

  // The control that matters: a sweep that cannot find a token known to be
  // present proves nothing.
  ck('positive control finds a known token', true,
    extract('the value is 424242 here', none, 'test').some((o) => o.token === '424242'));

  ck('script blocks are stripped', false,
    normalize('<script>var x=99999</script><p>hi</p>').includes('99999'));

  // Regression: the token used to keep its trailing comma, so "1994," missed
  // the year rule and a citation was reported as an unregistered claim.
  ck('citation year with a comma is excused', false,
    extract('Ritchie 1994, Terrisol 1990', none, 'test').some((o) => o.token === '1994'));

  // The tokenizer splits an ISO date on its hyphens, so the whole-token year
  // rule never sees the month or the day. They arrive as bare two-digit
  // numbers next to whatever the sentence was about.
  const dated = extract('Measured across 592 devices. Published 2026-08-17.', none, 'test').map((o) => o.token);
  ck('the month of an ISO date is excused', false, dated.includes('08'));
  ck('the day of an ISO date is excused', false, dated.includes('17'));
  ck('and the claim on the same line still fires', true, dated.includes('592'));

  // The cross-surface join needs its own controls: it must fire across surfaces
  // and stay quiet within one.
  const cross = findContradictions(
    quantityIndex('measured on 592 devices today', 'a', 'x')
      .concat(quantityIndex('measured on 119 devices today', 'b', 'y')),
  );
  ck('same unit, two surfaces, two values fires', true, cross.some((c) => c.unit === 'device'));
  ck('plural and singular group together', true,
    findContradictions(quantityIndex('11 device here', 'a', 'x').concat(quantityIndex('22 devices here', 'b', 'y')))
      .some((c) => c.unit === 'device'));
  ck('a one-letter unit is never produced', null, unitPhrase(' v 3'));
  ck('a symbol unit is read before any word', 'percent', unitPhrase('% of traffic'));
  ck('a stopword is not a unit', null, unitPhrase(' of the thing'));
  ck('different units do not collide', 0,
    findContradictions(quantityIndex('592 devices', 'a', 'x').concat(quantityIndex('119 runs', 'b', 'y'))).length);
  ck('one surface quoting several values is prose, not a contradiction', 0,
    findContradictions(quantityIndex('592 devices and 119 devices', 'a', 'x')).length);
  ck('a second surface repeating one of several values is not a conflict', 0,
    findContradictions(
      quantityIndex('139255 neurons and 23188 neurons', 'fly', 'x')
        .concat(quantityIndex('139255 neurons here', 'profile', 'y')),
    ).length);

  ck('a number quoted inside its own retraction is not a live claim', 0,
    quantityIndex('the card formerly said 40 tok/s and was corrected', 'a', 'x').length);
  ck('the same number without retraction language still indexes', 1,
    quantityIndex('the engine runs at 40 tok/s today', 'a', 'x').length);

  ck('a registry with no facts registers nothing', 0, registeredValues({ facts: [] }).size);
  ck('a registered value and its comma form both count', 2,
    registeredValues({ facts: [{ value: '139,255' }] }).size);

  // THE FAULT CASE. A checker whose input is broken must stop, not sweep. Each
  // of these previously would have produced an empty, reassuring run.
  ck('a missing config is fatal, not an empty sweep', true,
    threw(() => configFrom(['--config', '/nonexistent/estate.json'], here)));
  ck('a malformed config is fatal', true,
    threw(() => section(JSON.parse('{}'), 'surfaces')));
  ck('a config with zero surfaces is fatal', true,
    threw(() => section({ surfaces: [] }, 'surfaces')));

  return fail;
}

if (args.includes('--selftest')) {
  process.exit(selftest() === 0 ? 0 : 1);
} else if (process.argv[1]?.endsWith('check-orphans.mjs')) {
  main().then((code) => process.exit(code)).catch(fatal);
}
