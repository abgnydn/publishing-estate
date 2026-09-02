#!/usr/bin/env node
// check-ci.mjs — is there a pipeline, is it wired up, and did it actually run?
//
//   check-ci.mjs --config <file>          standards, then ask GitHub what ran
//   check-ci.mjs --config <file> --local  skip the network; standards only
//   check-ci.mjs --selftest               prove each rule catches a planted defect
//
// WHY THIS EXISTS
// ---------------
// Every other checker asks whether a published number is right. None asks
// whether the machinery meant to catch a bad number before it ships is present
// and honest. Three shapes of failure were found by hand:
//
//   - a deploy workflow that pushes to a model hub on every push to main and
//     does NOT depend on the test workflow. The two race on the same trigger,
//     so a deploy can land while the tests are still running, or after they
//     failed. A local publish gate cannot see this at all: it matches shell
//     commands, and this one runs on a machine that is not yours.
//   - a repository whose CI failed four of its last five runs, unnoticed.
//   - the verification system itself having no CI, and neither did the
//     repository holding the facts every other check reads.
//
// TWO HALVES, AND ONLY ONE NEEDS THE NETWORK
// ------------------------------------------
// STANDARDS is pure local analysis of the workflow files: does a pipeline
// exist, is the deploy gated on the tests, does a step report success when it
// silently did nothing. That half always works.
//
// HEALTH asks GitHub what actually ran. Unauthenticated that is a low hourly
// budget, so a rate limit is UNREACHABLE and never a zero — a repo whose runs
// could not be fetched is not a repo with no runs. Set GITHUB_TOKEN or GH_TOKEN
// to raise the limit.
//
// THE RULE THAT MATTERS MOST
// --------------------------
// Green means "no step failed", not "the thing happened". A deploy step that
// exits 0 with a notice when its token is unset makes a missing secret SUCCEED
// while doing nothing. Any pipeline used as a gate has to be checked for this,
// or "CI is green" is an inference that does not hold.
//
// Exit 0 clean, 1 findings, 2 broken or misconfigured.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { configFrom, configPath, fatal, section } from './config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const LOCAL_ONLY = args.includes('--local');
const TIMEOUT = 20000;

const readText = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
const readJSON = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

// --------------------------------------------------------- workflow parsing
//
// Deliberately not a YAML parser: this repository carries no dependencies, and
// the three questions asked of a workflow are answerable from its lines. Every
// heuristic below is exercised by --selftest, because a parser that quietly
// stops matching turns this checker green for the wrong reason.

// Anything here publishes under your name once it runs.
const PUBLISH_PATTERNS = [
  [/\bhf\s+upload\b|\bhuggingface-cli\s+upload\b/, 'hf upload'],
  [/git\s+push\b[^\n]*(huggingface\.co|hf\.co)/, 'git push to HuggingFace'],
  [/\bwrangler\s+(pages\s+)?(deploy|publish|versions\s+deploy)/, 'wrangler deploy'],
  [/\b(npm|pnpm|yarn)\s+publish\b/, 'package publish'],
  [/\bvercel\b[^\n]*--prod/, 'vercel --prod'],
  [/\bgh\s+release\s+(create|upload|edit)/, 'gh release'],
  [/peaceiris\/actions-gh-pages|JamesIves\/github-pages-deploy-action|actions\/deploy-pages/, 'pages deploy action'],
  [/cloudflare\/wrangler-action/, 'wrangler action'],
  [/HF_TOKEN|HUGGINGFACE_TOKEN/, 'uses a HuggingFace write token'],
];

// A workflow that calls a script publishes whatever the SCRIPT does. A deploy
// step written as one line — `bash scripts/deploy.sh` — reads as "uses a token"
// and nothing more to a scan that stops at the YAML. One level deep,
// repo-relative paths only, so this cannot wander off disk.
export function inlinedScripts(text, dir) {
  let extra = '';
  const seen = new Set();
  const add = (rel) => {
    if (!rel || seen.has(rel) || rel.includes('..')) return;
    seen.add(rel);
    const body = readText(join(dir, rel));
    if (body) extra += `\n${body}`;
  };
  for (const m of text.matchAll(/(?:bash|sh|source|\.)\s+([\w./-]+\.sh)/g)) add(m[1].replace(/^\.\//, ''));
  for (const m of text.matchAll(/(?:^|\s)(\.\/[\w./-]+\.(?:sh|mjs|js))/gm)) add(m[1].replace(/^\.\//, ''));
  const pkg = readJSON(join(dir, 'package.json'));
  if (pkg?.scripts) {
    for (const m of text.matchAll(/npm\s+run\s+([\w:-]+)/g)) {
      const cmd = pkg.scripts[m[1]];
      if (cmd) extra += `\n${cmd}`;
    }
  }
  return extra;
}

// Comments name hosts they do not push to, so the join below reads code only.
export function decomment(text) {
  return text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
}

export function publishesIn(text) {
  const hits = [];
  for (const [re, label] of PUBLISH_PATTERNS) if (re.test(text)) hits.push(label);

  // Same-line matching is not enough. A deploy script that sets its host into a
  // variable near the top and runs `git push` sixty lines below has the host
  // and the push too far apart for any single regex to see both. Two signals in
  // the same file, comments excluded, is the honest join.
  const code = decomment(text);
  if (/huggingface\.co|hf\.co/.test(code) && /\bgit\s+push\b/.test(code)) hits.push('git push to HuggingFace');
  return [...new Set(hits)];
}

// Which events start this workflow. Only the `on:` block, so a `push:` inside a
// run body is not mistaken for a trigger.
export function triggersOf(text) {
  const out = new Set();
  let inOn = false;
  let indent = 0;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\t/g, '  ');
    if (/^on:\s*$/.test(line)) { inOn = true; indent = 0; continue; }
    const inline = line.match(/^on:\s*\[?([a-z_,\s]+)\]?\s*$/);
    if (inline) { for (const t of inline[1].split(/[,\s]+/).filter(Boolean)) out.add(t); continue; }
    if (!inOn) continue;
    if (/^\S/.test(line)) { inOn = false; continue; }
    const m = line.match(/^(\s+)([a-z_]+):/);
    if (!m) continue;
    if (indent === 0) indent = m[1].length;
    if (m[1].length === indent) out.add(m[2]);
  }
  return [...out];
}

// A job that declares `needs:` waits for another job. A `workflow_run` trigger
// waits for another workflow. Either means this deploy is downstream of
// something rather than racing it.
export function isGated(text) {
  return /^\s+needs:/m.test(text) || triggersOf(text).includes('workflow_run');
}

// Green because nothing ran: an emptiness test on a secret whose branch exits
// successfully. The deploy reports success having skipped.
export function silentSkips(text) {
  const out = [];
  const re = /if\s*\[\s*-z\s*"?\$\{?(\w+)\}?"?\s*\]\s*;?\s*then([\s\S]{0,400}?)(?:\bfi\b|$)/g;
  for (const m of text.matchAll(re)) if (/\bexit\s+0\b/.test(m[2])) out.push(m[1]);
  return [...new Set(out)];
}

export function looksLikeTests(name, text) {
  return /\b(ci|test|check|lint|build|verify)\b/i.test(name)
    || /\bnpm\s+(run\s+)?(test|typecheck|lint)|vitest|pytest|cargo\s+test|playwright\s+test/.test(text);
}

export function analyseRepo(dir) {
  const wfDir = join(dir, '.github', 'workflows');
  let names = [];
  try { names = readdirSync(wfDir).filter((n) => /\.ya?ml$/.test(n)); } catch { /* none */ }

  const unreadable = [];
  const workflows = [];
  for (const n of names) {
    const raw = readText(join(wfDir, n));
    // A workflow file that exists and cannot be read must never analyse as a
    // workflow with no triggers and no publishers. That is a clean sheet
    // produced by a broken read, which is the failure this fleet is against.
    if (raw === null) { unreadable.push(n); continue; }
    const text = raw + inlinedScripts(raw, dir);
    workflows.push({
      file: n,
      // Triggers and gating are properties of the WORKFLOW, so they read the
      // yaml only; what it publishes may live in a script it calls.
      triggers: triggersOf(raw),
      publishes: publishesIn(text),
      gated: isGated(raw),
      silentSkips: silentSkips(text),
      tests: looksLikeTests(n, raw),
    });
  }

  return {
    workflows,
    unreadable,
    hasTests: workflows.some((w) => w.tests && !w.publishes.length),
    lefthook: existsSync(join(dir, 'lefthook.yml')),
  };
}

// ------------------------------------------------------------------ network

async function getJSON(url, token) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'check-ci' };
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers });
    if (res.status === 403 || res.status === 429) return { __limited: true };
    if (!res.ok) return { __status: res.status };
    return await res.json();
  } catch (e) {
    return { __error: e.message };
  } finally { clearTimeout(t); }
}

async function runsFor(owner, repo, token) {
  const j = await getJSON(`https://api.github.com/repos/${owner}/${repo}/actions/runs?per_page=10`, token);
  if (j.__limited) return { reachable: false, why: 'rate limited' };
  if (j.__status === 404) {
    return { reachable: false, why: token ? 'http 404 — no such repo' : 'http 404 — private, or renamed (unauthenticated)' };
  }
  if (j.__status) return { reachable: false, why: `http ${j.__status}` };
  if (j.__error) return { reachable: false, why: j.__error };
  return {
    reachable: true,
    runs: (j.workflow_runs ?? []).map((r) => ({
      name: r.name, conclusion: r.conclusion ?? r.status, at: r.created_at, branch: r.head_branch,
    })),
  };
}

function git(dir, a) {
  try { return execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}

// A checkout whose last commit cannot be read (missing git binary, broken
// repo) must say so: scoring freshness as "does not apply" would make the
// score IMPROVE when a tool goes missing. Exported so the selftest can plant
// the case without removing git from PATH.
// The score itself must obey the same rule: an unverifiable criterion stays in
// the denominator and is never met. Module-level and exported so the selftest
// asserts the arithmetic, not just the printed line.
export function scoreOf(x) {
  const vals = CRITERIA.map(([, fn]) => fn(x));
  const applicable = vals.filter((v) => v !== null);
  return { met: applicable.filter((v) => v === true).length, of: applicable.length, vals };
}

export function gitSilence(name, lastCommit) {
  if (lastCommit !== null) return null;
  return `UNREACHABLE    ${String(name).padEnd(22)} git did not answer in the checkout — `
    + 'freshness is unverified, not not-applicable';
}

// --------------------------------------------------------------------- main

// Each rule returns true, false, null for "does not apply here", or
// 'unreachable' for "could not be verified". A repo with no deploy has nothing
// to gate; scoring that as gated gives credit for a property it cannot have
// and flatters the emptiest repos. But unverifiable is not inapplicable: an
// unreachable criterion stays in the denominator and is never met, so a
// missing tool can only lower the score, never lift it.
export const CRITERIA = [
  ['ci', (x) => x.workflows > 0],
  ['tests', (x) => (x.workflows > 0 ? x.hasTests : null)],
  ['ran', (x) => (x.reachable === false ? null : (x.runs ?? []).length > 0)],
  ['green', (x) => (x.reachable === false || !x.lastRun ? null : x.lastRun.conclusion === 'success')],
  ['fresh', (x) => {
    if (x.reachable === false || !x.lastRun) return null;
    if (!x.lastCommit) return 'unreachable';
    return x.lastRun.at >= x.lastCommit;
  }],
  ['gated', (x) => (x.publishers.length ? x.publishers.every((p) => p.gated || !p.triggers.includes('push')) : null)],
  ['honest', (x) => (x.publishers.length ? x.publishers.every((p) => !p.silentSkips.length) : null)],
  ['hooks', (x) => x.lefthook],
];

async function main() {
  const doc = configFrom(args, here);
  const repos = section(doc, 'repos');
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  const rows = [];
  const skipped = [];
  let findings = 0;

  for (const r of repos) {
    const dir = configPath(doc, r.local ?? r.name);
    if (!existsSync(join(dir, '.git'))) {
      // Skipping these silently made the completeness table look complete.
      // Nothing local can read the pipeline of a repo that is not here.
      console.log(`GAP            ${String(r.name).padEnd(22)} no local checkout — nothing here can read its pipeline`);
      skipped.push(r.name);
      continue;
    }

    const a = analyseRepo(dir);
    const lastCommit = git(dir, ['log', '-1', '--format=%cI']);
    const silence = gitSilence(r.name, lastCommit);
    if (silence) console.log(silence);
    const row = {
      name: r.name,
      workflows: a.workflows.length,
      hasTests: a.hasTests,
      lefthook: a.lefthook,
      lastCommit,
      publishers: a.workflows.filter((w) => w.publishes.length)
        .map((w) => ({ file: w.file, does: w.publishes, gated: w.gated, triggers: w.triggers, silentSkips: w.silentSkips })),
    };

    for (const f of a.unreadable) {
      findings += 1;
      console.log(`CI-UNREADABLE  ${String(r.name).padEnd(22)} ${f} exists and could not be read — `
        + 'it is not a workflow that publishes nothing, it is a workflow nothing has looked at');
    }

    const owner = r.owner ?? doc.owner ?? null;
    if (!LOCAL_ONLY && owner) {
      const h = await runsFor(owner, r.name, token);
      row.reachable = h.reachable;
      if (h.reachable) {
        row.runs = h.runs.slice(0, 10);
        row.lastRun = h.runs[0] ?? null;
        const recent = h.runs.slice(0, 5);
        row.recentFailures = recent.filter((x) => x.conclusion === 'failure').length;
        row.recentCount = recent.length;
      } else {
        row.why = h.why;
      }
    } else {
      // Not asked is not answered. Leaving `reachable` unset would score the
      // health columns as failures, so a --local run would read as a red
      // pipeline rather than an unexamined one.
      row.reachable = false;
      row.why = LOCAL_ONLY
        ? 'the network half was skipped (--local)'
        : 'no owner configured for this repo, so its runs were never asked for';
    }

    // ---- standards, all local ----
    if (row.workflows === 0) {
      findings += 1;
      console.log(`CI-MISSING     ${String(r.name).padEnd(22)} no workflows at all`);
    } else {
      if (!a.hasTests) {
        findings += 1;
        console.log(`CI-NO-TESTS    ${String(r.name).padEnd(22)} ${row.workflows} workflow(s), none of which runs tests`);
      }
      for (const p of row.publishers) {
        if (!p.gated && p.triggers.includes('push') && a.hasTests) {
          findings += 1;
          console.log(`DEPLOY-UNGATED ${String(r.name).padEnd(22)} ${p.file} does "${p.does.join(', ')}" on push `
            + 'with no needs: and no workflow_run — it races the tests instead of waiting for them');
        }
        for (const s of p.silentSkips) {
          findings += 1;
          console.log(`SILENT-SKIP    ${String(r.name).padEnd(22)} ${p.file} exits 0 when ${s} is unset — `
            + 'a missing secret makes the deploy SUCCEED having done nothing');
        }
      }
    }

    // ---- health, needs the network ----
    if (row.reachable === false) {
      console.log(`UNREACHABLE    ${String(r.name).padEnd(22)} could not read runs (${row.why}) — not a repo without runs`);
    } else if (row.reachable) {
      if (row.workflows > 0 && (row.runs ?? []).length === 0) {
        findings += 1;
        console.log(`CI-NEVER-RAN   ${String(r.name).padEnd(22)} ${row.workflows} workflow file(s) and not one run on record`);
      } else if (row.lastRun) {
        // Broken now and intermittently broken are different problems, and
        // labelling a currently-green pipeline CI-RED reads as a contradiction
        // of the line it prints.
        if (row.lastRun.conclusion === 'failure') {
          findings += 1;
          console.log(`CI-RED         ${String(r.name).padEnd(22)} ${row.recentFailures} of the last ${row.recentCount} runs failed; `
            + `latest failure ${row.lastRun.at.slice(0, 10)} (${row.lastRun.name})`);
        } else if (row.recentFailures >= 2) {
          findings += 1;
          console.log(`CI-FLAKY       ${String(r.name).padEnd(22)} green now, but ${row.recentFailures} of the last ${row.recentCount} runs failed `
            + `(${row.lastRun.name}) — a gate you cannot trust is not a gate`);
        }
        // Ran, but not on what is in the tree now.
        if (lastCommit && row.lastRun.at < lastCommit) {
          const days = Math.round((Date.parse(lastCommit) - Date.parse(row.lastRun.at)) / 86400000);
          if (days >= 1) {
            findings += 1;
            console.log(`CI-STALE       ${String(r.name).padEnd(22)} last run ${row.lastRun.at.slice(0, 10)}, `
              + `last commit ${lastCommit.slice(0, 10)} — ${days}d of code nothing has tested`);
          }
        }
      }
    }

    rows.push(row);
  }

  if (!rows.length) {
    console.error('\nBROKEN  no configured repo had a checkout to read. Nothing was analysed, '
      + 'which is not the same as nothing being wrong.');
    return 2;
  }

  // ---- the completeness table: which pipelines are actually finished ----
  console.log('');
  console.log(`== pipeline completeness  (${CRITERIA.map((c) => c[0]).join(' · ')})`);
  const scored = rows.map((x) => ({ x, s: scoreOf(x) }));
  scored.sort((a, b) => (a.s.met / (a.s.of || 1)) - (b.s.met / (b.s.of || 1)) || a.x.name.localeCompare(b.x.name));
  for (const { x, s } of scored) {
    const marks = s.vals.map((v) => (v === null ? '·' : v === 'unreachable' ? '?' : v ? '+' : '.')).join('');
    console.log(`  ${marks}  ${String(s.met).padStart(2)}/${String(s.of).padEnd(2)} ${String(x.name).padEnd(22)}`
      + (x.lastRun ? `${x.lastRun.conclusion} ${x.lastRun.at.slice(0, 10)}`
        : x.reachable === false ? `runs unreadable — ${x.why}` : 'never ran'));
  }
  console.log('  + present   . missing   ? unverifiable (in the denominator, never met)   · does not apply');
  if (skipped.length) console.log(`  not checked at all, no local checkout: ${skipped.join(', ')}`);

  console.log(`\n${rows.length} repo(s) with a checkout; ${findings} finding(s)`);
  return findings > 0 ? 1 : 0;
}

// ---------------------------------------------------------------- selftest

function selftest() {
  let fail = 0;
  const ck = (name, want, got) => {
    const ok = String(want) === String(got);
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — want ${want}, got ${got}`}`);
    if (!ok) fail += 1;
  };
  const threw = (fn) => { try { fn(); return false; } catch { return true; } };

  // The shape this exists to catch: a deploy racing the tests, whose missing
  // secret makes it succeed having done nothing.
  const ungated = `
on:
  push:
    branches: [main]
  workflow_dispatch:
jobs:
  deploy:
    steps:
      - name: Deploy
        env:
          HF_TOKEN: \${{ secrets.HF_TOKEN }}
        run: |
          if [ -z "$HF_TOKEN" ]; then
            echo "::notice::skipping"
            exit 0
          fi
          hf upload owner/model dist
`;
  ck('a push-triggered deploy is seen as publishing', true, publishesIn(ungated).length > 0);
  ck('its trigger is read as push', true, triggersOf(ungated).includes('push'));
  ck('an ungated deploy is caught', false, isGated(ungated));
  ck('the silent skip is caught, by name', 'HF_TOKEN', silentSkips(ungated)[0]);

  // Positive controls: the checker must see a correct pipeline as correct, or a
  // clean result means nothing.
  ck('needs: counts as gated', true, isGated(ungated.replace('  deploy:\n', '  deploy:\n    needs: [test]\n')));
  ck('workflow_run counts as gated', true, isGated(`
on:
  workflow_run:
    workflows: [CI]
    types: [completed]
jobs:
  deploy:
    steps:
      - run: wrangler deploy
`));
  ck('a deploy with a real secret check is not a silent skip', 0,
    silentSkips('run: |\n  if [ -z "$HF_TOKEN" ]; then\n    echo missing\n    exit 1\n  fi\n').length);

  // Trigger parsing must not be fooled by the word appearing in a run body.
  ck('a push inside a run body is not a trigger', false, triggersOf(`
on:
  workflow_dispatch:
jobs:
  x:
    steps:
      - run: git push origin main
`).includes('push'));
  ck('inline list form of on: is parsed', true, triggersOf('on: [push, pull_request]\n').includes('pull_request'));

  // The indirection that hid the real action: host in a variable, push far below.
  ck('a push whose host is in a variable is still caught', true,
    publishesIn('SPACE="huggingface.co/spaces/o/r"\ngit remote add space "https://$SPACE"\ngit push -q --force space main\n')
      .includes('git push to HuggingFace'));
  ck('a comment naming the host does not fake a publish', false,
    publishesIn('# deploys to huggingface.co eventually\ngit push origin main\n').includes('git push to HuggingFace'));
  ck('a push with no HuggingFace anywhere is not a publish', 0, publishesIn('git push origin main\n').length);

  const ci = `
on:
  push:
    branches: [main]
jobs:
  test:
    steps:
      - run: npm ci
      - run: npm run test:unit
`;
  ck('a test workflow is recognised as tests', true, looksLikeTests('ci.yml', ci));
  ck('a test workflow is not a publisher', 0, publishesIn(ci).length);
  ck('a deploy workflow is not counted as tests-present', false,
    looksLikeTests('deploy-space.yml', 'run: hf upload x y'));

  // Completeness scoring: a repo with nothing to gate scores neither way.
  const nothingToGate = { workflows: 1, hasTests: true, lefthook: true, publishers: [], reachable: false };
  ck('a repo with no deploy is not credited with gating it', null,
    CRITERIA.find((c) => c[0] === 'gated')[1](nothingToGate));
  ck('an unreadable run history does not score as red', null,
    CRITERIA.find((c) => c[0] === 'green')[1](nothingToGate));

  // THE FAULT CASE. A repo directory that is not there, and a workflow file
  // that cannot be read, must not analyse as a clean pipeline.
  const absent = analyseRepo('/nonexistent/repo');
  ck('a missing checkout yields no workflows', 0, absent.workflows.length);
  ck('and no unreadable files either — there was nothing to read', 0, absent.unreadable.length);
  ck('a missing checkout is never credited with tests', false, absent.hasTests);
  ck('and never credited with hooks', false, absent.lefthook);
  ck('a git that cannot answer is UNREACHABLE, not not-applicable', true,
    gitSilence('proj', null) !== null);
  ck('a git that answered produces no unreachable line', null,
    gitSilence('proj', '2026-01-01T00:00:00+00:00'));
  // And the arithmetic: unverifiable stays in the denominator, never met, so a
  // missing binary can only lower the score. This was found live: with git off
  // PATH, freshness read as "does not apply" and the ratio IMPROVED.
  {
    const base = {
      workflows: 1, hasTests: true, lefthook: true, reachable: true,
      runs: [{}], lastRun: { at: '2026-01-02', conclusion: 'success' }, publishers: [],
    };
    const withGit = scoreOf({ ...base, lastCommit: '2026-01-01' });
    const without = scoreOf({ ...base, lastCommit: null });
    ck('an unverifiable criterion stays in the denominator', withGit.of, without.of);
    ck('and is never met, so the score drops rather than lifts', withGit.met - 1, without.met);
    ck('and renders as its own mark, not as does-not-apply', 'unreachable',
      without.vals[CRITERIA.findIndex(([n]) => n === 'fresh')]);
  }
  ck('a missing config is fatal, not an empty report', true,
    threw(() => configFrom(['--config', '/nonexistent/estate.json'], here)));
  ck('a config with zero repos is fatal', true, threw(() => section({ repos: [] }, 'repos')));

  return fail;
}

if (args.includes('--selftest')) {
  process.exit(selftest() === 0 ? 0 : 1);
} else if (process.argv[1]?.endsWith('check-ci.mjs')) {
  main().then((c) => process.exit(c)).catch(fatal);
}
