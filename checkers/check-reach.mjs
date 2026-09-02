#!/usr/bin/env node
// check-reach.mjs — who is actually looking at any of this.
//
//   check-reach.mjs --config <file>   read the configured accounts and report
//   check-reach.mjs --selftest        prove a missing source is never a zero
//
// WHY THIS EXISTS
// ---------------
// Every other checker answers "is it wrong". None answers "is it landing", and
// that is the question the publishing effort exists to move. The estate's own
// record already showed the shape of the problem once: the preprints travelled
// while the runnable software records sat in single digits. Nothing on the
// panel made that asymmetry visible, so it survived for months until someone
// went looking.
//
// A source that cannot be reached is UNREACHABLE and is never counted as a
// zero. A missing number and a real zero mean opposite things here, and
// conflating them makes a quiet week look like a dead project — the same
// mistake, pointed at a different question, as folding a 404 into "clean".
//
// Reach is information, not a defect, so findings do not fail the run. The one
// failing case is a run in which NOTHING was readable: a report of no reach and
// a report that could not be collected look identical, and only one of them
// means anything.

import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { configFrom, fatal, section } from './config.mjs';

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const TIMEOUT = 20000;

async function getJSON(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; } finally { clearTimeout(t); }
}

// ------------------------------------------------- pure transforms of a payload
//
// Kept separate from the fetching so the selftest can plant a null, an empty
// object and a real-shaped record without touching the network. The whole point
// of this checker is what it does with a payload it did not get.

export function zenodoRow(name, doi, hits) {
  const rec = hits?.hits?.hits?.[0] ?? null;
  if (!rec) return { name, doi, reachable: false };
  const st = rec.stats ?? {};
  return {
    name,
    doi,
    reachable: true,
    title: rec.metadata?.title ?? null,
    version: rec.metadata?.version ?? null,
    // ?? and not ||: a genuine 0 is a real observation and must survive.
    views: st.version_views ?? st.views ?? null,
    downloads: st.version_downloads ?? st.downloads ?? null,
  };
}

export function githubRows(list) {
  if (!Array.isArray(list)) return null;
  return list
    .filter((r) => !r.isPrivate)
    .map((r) => ({ name: r.name, stars: r.stargazerCount ?? 0, forks: r.forkCount ?? 0, pushedAt: r.pushedAt ?? null }))
    .sort((a, b) => b.stars - a.stars);
}

export function hfRows(kind, list) {
  if (!Array.isArray(list)) return null;
  return list.map((item) => ({
    kind,
    id: item.id,
    downloads: item.downloads ?? 0,
    likes: item.likes ?? 0,
    updated: item.lastModified ?? null,
  }));
}

// ------------------------------------------------------------------- sources

async function zenodo(records) {
  const out = [];
  for (const r of records) {
    if (!r.concept_doi) continue;
    // A CONCEPT doi does not address a record directly — /api/records/<id>
    // 404s for it. Query by conceptdoi and take the resolved latest version.
    const q = encodeURIComponent(`conceptdoi:"${r.concept_doi}"`);
    out.push(zenodoRow(r.name ?? r.concept_doi, r.concept_doi, await getJSON(`https://zenodo.org/api/records?q=${q}&size=1`)));
  }
  return out;
}

async function github(user) {
  try {
    const { stdout } = await exec('gh', [
      'repo', 'list', user, '--limit', '80', '--json', 'name,stargazerCount,forkCount,isPrivate,pushedAt',
    ], { timeout: TIMEOUT, maxBuffer: 8 << 20 });
    return githubRows(JSON.parse(stdout));
  } catch { return null; }
}

async function huggingface(author) {
  const out = [];
  let any = false;
  for (const kind of ['models', 'datasets']) {
    const rows = hfRows(kind, await getJSON(`https://huggingface.co/api/${kind}?author=${author}`));
    if (rows === null) { console.log(`UNREACHABLE  huggingface ${kind} — not a zero`); continue; }
    any = true;
    out.push(...rows);
  }
  return any ? out.sort((a, b) => b.downloads - a.downloads) : null;
}

// ---------------------------------------------------------------------- main

async function main() {
  const doc = configFrom(args, here);
  const cfg = section(doc, 'reach');
  const records = cfg.zenodo ?? [];
  if (!records.length && !cfg.github_user && !cfg.hf_author) {
    console.error('CONFIG  the "reach" section names no zenodo record, github user or huggingface author — '
      + 'there is nothing to ask about, which is not a report of no reach');
    return 2;
  }

  const [z, g, h] = await Promise.all([
    zenodo(records),
    cfg.github_user ? github(cfg.github_user) : Promise.resolve(undefined),
    cfg.hf_author ? huggingface(cfg.hf_author) : Promise.resolve(undefined),
  ]);

  let readable = 0;
  const reachable = z.filter((x) => x.reachable);
  for (const r of z) if (!r.reachable) console.log(`UNREACHABLE  zenodo ${r.name} (${r.doi}) — not a zero`);
  if (reachable.length) {
    readable += 1;
    console.log('\n== zenodo, by views');
    for (const r of [...reachable].sort((a, b) => (b.views ?? 0) - (a.views ?? 0))) {
      console.log(`  ${String(r.views ?? '—').padStart(6)} views  ${String(r.downloads ?? '—').padStart(5)} dl  ${r.name}`);
    }
  }
  if (g === null) console.log('UNREACHABLE  github — not a zero');
  else if (g) {
    readable += 1;
    console.log('\n== github, by stars');
    for (const r of g.slice(0, 10)) console.log(`  ${String(r.stars).padStart(4)} ★  ${r.forks} forks  ${r.name}`);
  }
  if (h === null) console.log('UNREACHABLE  huggingface — not a zero');
  else if (h) {
    readable += 1;
    console.log('\n== huggingface, by downloads');
    for (const r of h.slice(0, 10)) console.log(`  ${String(r.downloads).padStart(6)} dl  ${r.likes} ♥  ${r.id}`);
  }

  if (readable === 0) {
    console.error('\nBROKEN  every configured source was unreachable. This is not a report of no reach, '
      + 'and a panel that renders it as one is lying by omission.');
    return 2;
  }
  return 0;
}

// ------------------------------------------------------------------- selftest

function selftest() {
  let fail = 0;
  const ck = (name, want, got) => {
    const ok = String(want) === String(got);
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — want ${want}, got ${got}`}`);
    if (!ok) fail += 1;
  };
  const threw = (fn) => { try { fn(); return false; } catch { return true; } };

  const record = { hits: { hits: [{ metadata: { title: 't', version: '1' }, stats: { version_views: 560, version_downloads: 17 } }] } };
  ck('a real record is read', 560, zenodoRow('r', 'd', record).views);
  ck('and its downloads come with it', 17, zenodoRow('r', 'd', record).downloads);
  ck('a real record is marked reachable', true, zenodoRow('r', 'd', record).reachable);

  // The whole reason this checker exists. Each of the three shapes below is a
  // source that did not answer, and none of them is a zero.
  ck('a null payload is UNREACHABLE, not zero views', false, zenodoRow('r', 'd', null).reachable);
  ck('and it reports no views at all rather than 0', undefined, zenodoRow('r', 'd', null).views);
  ck('an empty hit list is UNREACHABLE', false, zenodoRow('r', 'd', { hits: { hits: [] } }).reachable);
  ck('a payload that is not the expected shape is UNREACHABLE', false, zenodoRow('r', 'd', { error: 'x' }).reachable);
  ck('github: a non-array payload is null, not an empty list', null, githubRows(null));
  ck('huggingface: a non-array payload is null, not an empty list', null, hfRows('models', undefined));

  // A genuine zero is a real observation and must survive the guard above.
  ck('a genuine zero survives', 0,
    zenodoRow('r', 'd', { hits: { hits: [{ stats: { version_views: 0 } }] } }).views);
  ck('a repo with no stars is still listed', 0, githubRows([{ name: 'a', stargazerCount: 0 }])[0].stars);
  ck('a private repo is not listed', 0, githubRows([{ name: 'a', isPrivate: true }]).length);
  ck('models are read as models', 'models', hfRows('models', [{ id: 'a' }])[0].kind);
  ck('a model with no downloads field reads as 0, having answered', 0, hfRows('models', [{ id: 'a' }])[0].downloads);

  // THE FAULT CASE.
  ck('a missing config is fatal, not an empty report', true,
    threw(() => configFrom(['--config', '/nonexistent/estate.json'], here)));
  ck('a config with no reach section is fatal', true, threw(() => section({}, 'reach')));

  return fail;
}

if (args.includes('--selftest')) {
  process.exit(selftest() === 0 ? 0 : 1);
} else if (process.argv[1]?.endsWith('check-reach.mjs')) {
  main().then((c) => process.exit(c)).catch(fatal);
}
