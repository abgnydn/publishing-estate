#!/usr/bin/env node
// check-deployed.mjs — is what is committed actually what is live?
//
//   check-deployed.mjs --config <file>   compare every configured repo
//   check-deployed.mjs --selftest        prove the comparison catches a planted drift
//
// WHY THIS EXISTS
// ---------------
// The worst failure this estate has recorded is committed-but-undeployed: a fix
// sat in git for weeks while production served the bug. The only signal for it
// was "commits ahead of the remote", which is a proxy that misses the worse
// case — committed AND pushed AND still never deployed. Git was clean. The live
// surface was not.
//
// WHAT IT COMPARES
// ----------------
// For each repo that declares a build output directory and a deployed url, it
// takes SENTINELS from the local built output — short distinctive strings — and
// asks whether the live url still contains them. Present locally and absent
// live means the build has not shipped.
//
// It deliberately does NOT diff whole pages. Edge providers rewrite email
// addresses, inject analytics and reorder headers, so a body hash can never
// match and would cry wolf on every run forever.
//
// It never builds and never deploys. Missing build output is reported as a
// stated GAP rather than a finding: nobody has run the build, which says
// nothing at all about what is live.
//
// Exit 0 clean, 1 drift found, 2 broken or misconfigured.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { configFrom, configPath, fatal, section } from './config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const TIMEOUT = 25000;

const readText = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };

// ----------------------------------------------------------------- sentinels

// Hashed asset names are the strongest sentinel a static build offers: they
// change on every content change and appear verbatim in the served HTML.
export function assetSentinels(html) {
  const out = new Set();
  for (const m of html.matchAll(/\/?assets\/[A-Za-z0-9._-]+\.(?:js|css)/g)) out.add(m[0].replace(/^\//, ''));
  return [...out];
}

// Both sides must be normalized THE SAME WAY before any text comparison. The
// first version took sentinels from stripped text and then searched the raw
// live HTML for them, so every sentence containing an inline tag "went missing"
// and two healthy sites were reported as undeployed.
export function toText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// A build with no hashed assets still has prose. Take a few long, distinctive
// runs of text that are unlikely to be boilerplate.
export function textSentinels(html) {
  return toText(html)
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 40 && s.length <= 160 && /[a-z]{4}/i.test(s))
    .slice(0, 6);
}

export function compare(localHtml, liveHtml) {
  const assets = assetSentinels(localHtml);
  if (assets.length) {
    const liveAssets = new Set(assetSentinels(liveHtml));
    const missing = assets.filter((a) => !liveAssets.has(a) && !liveHtml.includes(a));
    return { kind: 'asset', checked: assets.length, missing, drift: missing.length > 0 };
  }
  const texts = textSentinels(localHtml);
  const liveText = toText(liveHtml);
  const missing = texts.filter((t) => !liveText.includes(t));
  return {
    kind: texts.length ? 'text' : 'none',
    checked: texts.length,
    missing,
    // Prose is edited more loosely than assets are named, so require a majority
    // to be missing before calling it drift.
    drift: texts.length > 0 && missing.length > texts.length / 2,
  };
}

function localIndex(dir) {
  const idx = join(dir, 'index.html');
  if (existsSync(idx)) return { path: idx, html: readText(idx) };
  // Some builds emit into a nested directory; take the newest index.html one
  // level down.
  let best = null;
  try {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name, 'index.html');
      if (!existsSync(p)) continue;
      const t = statSync(p).mtimeMs;
      if (!best || t > best.t) best = { path: p, t };
    }
  } catch { /* no dir */ }
  return best ? { path: best.path, html: readText(best.path) } : null;
}

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

// ------------------------------------------------------------------------ main

async function main() {
  const doc = configFrom(args, here);
  const repos = section(doc, 'repos').filter((r) => r.url && r.out);
  if (!repos.length) {
    // Not a clean run. Every configured repo declined to say where its build
    // lands or what url serves it, so nothing was compared.
    console.error('CONFIG  no configured repo declares both "url" and "out" — nothing was compared, '
      + 'which is not the same as nothing having drifted');
    return 2;
  }

  console.log(`== ${repos.length} repo(s) declare a deployed url and a build output directory`);
  let drifted = 0;

  for (const r of repos) {
    const dir = configPath(doc, r.local ?? r.name);
    const outDir = join(dir, r.out);
    const local = localIndex(outDir);
    if (!local?.html) {
      console.log(`GAP          ${String(r.name).padEnd(22)} no built index.html under ${r.out} — run the build first`);
      continue;
    }
    const builtAt = new Date(statSync(local.path).mtimeMs).toISOString();

    const live = await fetchText(r.url);
    if (!live.ok) {
      console.log(`UNREACHABLE  ${String(r.name).padEnd(22)} ${r.url} (http ${live.status}) — not a finding, and not a pass`);
      continue;
    }

    const cmp = compare(local.html, live.body);
    if (cmp.drift) {
      drifted += 1;
      console.log(`DEPLOY-DRIFT ${String(r.name).padEnd(22)} built ${builtAt.slice(0, 16)} is NOT live at ${r.url}`);
      for (const m of cmp.missing.slice(0, 5)) console.log(`             missing live: ${String(m).slice(0, 110)}`);
    } else if (cmp.kind === 'none') {
      // No sentinel is a GAP, never a pass. A build with nothing distinctive in
      // it cannot be shown to have shipped, and reporting it as live is exactly
      // the reassuring-clean-sheet failure.
      console.log(`GAP          ${String(r.name).padEnd(22)} no usable sentinel in the built output — nothing could be compared`);
    } else {
      console.log(`ok           ${String(r.name).padEnd(22)} ${cmp.checked} ${cmp.kind} sentinel(s) present live`);
    }
  }

  console.log(`\n${drifted} repo(s) built but not live`);
  return drifted > 0 ? 1 : 0;
}

// -------------------------------------------------------------------- selftest

function selftest() {
  let fail = 0;
  const ck = (name, want, got) => {
    const ok = String(want) === String(got);
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — want ${want}, got ${got}`}`);
    if (!ok) fail += 1;
  };
  const threw = (fn) => { try { fn(); return false; } catch { return true; } };

  const built = '<html><head><script src="/assets/index-NEW123.js"></script></head><body>x</body></html>';
  const stale = '<html><head><script src="/assets/index-OLD999.js"></script></head><body>x</body></html>';

  ck('a stale deploy is caught', true, compare(built, stale).drift);
  ck('a current deploy is clean', false, compare(built, built).drift);
  ck('asset sentinels are preferred', 'asset', compare(built, stale).kind);

  // The positive control: the comparison must be able to see a sentinel it is
  // told is present, or a clean result means nothing.
  ck('positive control finds the sentinel', 0, compare(built, built).missing.length);

  const prose = '<p>This sentence is long enough to serve as a distinctive textual sentinel here.</p>';
  ck('falls back to text when there are no assets', 'text', compare(prose, prose).kind);
  ck('text drift needs a majority missing', false, compare(prose, prose).drift);
  ck('text drift fires when the prose is gone', true, compare(prose, '<p>nothing alike</p>').drift);

  // Regression: sentinels are taken from stripped text, so the live side must be
  // stripped too. Comparing against raw HTML reported two live sites as
  // undeployed.
  ck('inline tags on the live side do not fake a drift', false,
    compare(prose, '<p>This sentence is <em>long</em> enough to serve as a '
      + '<b>distinctive</b> textual sentinel here.</p>').drift);
  ck('&nbsp; on one side only does not fake a drift', false,
    compare('<p>Consulting at&nbsp;a client on the platform today, at some length.</p>',
      '<p>Consulting at a client on the platform today, at some length.</p>').drift);

  // THE FAULT CASE. Empty or unusable build output must never read as "live".
  // A build with no sentinel cannot be shown to have shipped, and drift:false
  // there is the absence of evidence, not evidence of absence — which is why
  // main() prints GAP for kind "none" and never "ok".
  ck('empty local output yields no sentinel', 'none', compare('', '').kind);
  ck('and an empty comparison is not reported as drift either', false, compare('', '').drift);
  ck('an unreadable local file is a gap, not a comparison', null, localIndex('/nonexistent/dir'));
  ck('a missing config is fatal, not an empty run', true,
    threw(() => configFrom(['--config', '/nonexistent/estate.json'], here)));
  ck('a config with zero repos is fatal', true, threw(() => section({ repos: [] }, 'repos')));

  return fail;
}

if (args.includes('--selftest')) {
  process.exit(selftest() === 0 ? 0 : 1);
} else if (process.argv[1]?.endsWith('check-deployed.mjs')) {
  main().then((c) => process.exit(c)).catch(fatal);
}
