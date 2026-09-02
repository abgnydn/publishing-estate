#!/usr/bin/env node
// check-memory.mjs — the numbers in the notes, against the registry.
//
//   check-memory.mjs --config <file>   read the configured notes directory
//   check-memory.mjs --selftest        prove each rule catches a planted defect
//
// WHY THIS EXISTS
// ---------------
// The notes a working session loads are the most-read surface in an estate and
// usually the only one nothing audits. They are written once, in the tense of
// the day they were written, and then quoted back as current. One of them here
// asserted a repo was "sitting 7 commits unpushed" — true when written, a claim
// about right now when read.
//
// This is the published-numbers sweep pointed inward, and it is the same
// argument that put every neglected profile page into the pipeline: a surface
// nobody checks is where retired numbers go to survive.
//
// THREE RULES, EACH NARROW ENOUGH TO BE RIGHT
//   1. RETIRED    a withdrawn fact's value appears in a note. The value was
//                 retracted; a note repeating it republishes it into every
//                 future session.
//   2. FACT-DRIFT a note states "<n> <unit>" where the registry records a
//                 DIFFERENT value for that same unit, within that note's own
//                 project. The first-word-unit rule is the only join available
//                 when nothing declares which fact was meant.
//   3. VOLATILE   a note states something git can answer right now — commits
//                 ahead, commits past a tag — and git disagrees. These age
//                 fastest and read most current.
//
// Rule 2 is the weakest and reads "look at this", not "this is wrong": two
// quantities can share a project and a unit and still be different things.
// Rules 1 and 3 are assertions.
//
// A quoted retraction is not a claim. A note saying a number WAS withdrawn is
// doing its job, so retraction language in the sentence suppresses rule 1.
//
// Exit 0 clean, 1 findings, 2 broken or misconfigured. Reads only; writes
// nothing.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { configFrom, configPath, fatal, section } from './config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

// A number inside its own retraction is a record, not a republication.
const RETRACTION = /retract|withdraw|superseded|corrected|erratum|no longer|used to|(?:was|is|are|were) wrong|must stop|stop (?:making|claiming)|appears? nowhere|disagree|retired|stale|outdated|previously/i;

// Words that mean nothing as a unit. The unit is the first word after a number,
// at least three characters, not a stopword.
const STOPWORDS = new Set([
  'and', 'the', 'for', 'was', 'are', 'has', 'had', 'but', 'not', 'its', 'his',
  'her', 'out', 'now', 'one', 'two', 'six', 'ten', 'per', 'via', 'off', 'own',
  'all', 'any', 'new', 'old', 'yet', 'too', 'from', 'that', 'this', 'with',
  'into', 'over', 'each', 'more', 'less', 'than', 'then', 'when', 'were',
]);

export function unitPhrase(after) {
  const w = String(after).trim().split(/[\s,.;:!?)\]]+/)[0] ?? '';
  const clean = w.replace(/[^a-z0-9%×x/_-]/gi, '').toLowerCase();
  if (clean.length < 3) return null;
  if (STOPWORDS.has(clean)) return null;
  if (/^\d+$/.test(clean)) return null;
  return clean;
}

// A number inside backticks is an identifier, not a claim.
function stripCode(line) {
  return line.replace(/`[^`]*`/g, (m) => ' '.repeat(m.length));
}

export function numbersIn(text) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = stripCode(lines[i]);
    for (const m of line.matchAll(/(?<![\w.])(\d[\d,]*(?:\.\d+)?)([a-z%×]{0,4}\b|%)?\s*(\S*)/gi)) {
      const raw = m[1];
      const value = Number(raw.replace(/,/g, ''));
      if (!Number.isFinite(value)) continue;
      // A unit written against the number — 458x, 6.1% — is asserted by the
      // writer. A unit in the next word is inferred. Only the first is trusted
      // at one character, which is what makes "458x" usable and a bare "x"
      // noise.
      const attached = (m[2] ?? '').toLowerCase();
      out.push({
        raw,
        value,
        unit: attached || unitPhrase(m[3]),
        attached: !!attached,
        line: i + 1,
        context: lines[i].trim().slice(0, 200),
      });
    }
  }
  return out;
}

// ------------------------------------------------------------------- rules

function sameUnit(a, b) {
  if (!a || !b) return false;
  const norm = (u) => String(u).toLowerCase().replace(/[^a-z0-9%×/]/g, '').replace(/^×$/, 'x');
  return norm(a) === norm(b);
}

export function ruleRetired(nums, withdrawn) {
  const hits = [];
  for (const n of nums) {
    if (RETRACTION.test(n.context)) continue;
    if (!n.unit) continue;
    for (const f of withdrawn) {
      if (String(f.value) !== String(n.value)) continue;
      if (!sameUnit(n.unit, f.unit)) continue;
      hits.push({ kind: 'RETIRED', fact: f.id, value: f.value, at: n });
    }
  }
  return hits;
}

// A note is named after its project, so the filename is the join. A note that
// matches no project compares against nothing rather than against everything.
export function factsForFile(fileName, facts) {
  const prefix = fileName.replace(/\.md$/, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (prefix.length < 3) return [];
  return facts.filter((f) => String(f.id).toLowerCase().split('.')[0] === prefix);
}

export function ruleFactDrift(nums, live) {
  const byUnit = new Map();
  for (const f of live) {
    const u = f.unit ? unitPhrase(f.unit) : null;
    if (!u) continue;
    const a = byUnit.get(u) ?? [];
    a.push(f);
    byUnit.set(u, a);
  }
  const hits = [];
  for (const n of nums) {
    if (!n.unit || RETRACTION.test(n.context)) continue;
    const facts = byUnit.get(n.unit);
    // A unit owned by two facts identifies neither, so it is skipped rather
    // than guessed at.
    if (facts?.length !== 1) continue;
    if (String(facts[0].value) === String(n.value)) continue;
    hits.push({ kind: 'FACT-DRIFT', fact: `${facts[0].id}=${facts[0].value}`, value: n.value, at: n });
  }
  return hits;
}

const VOLATILE = [
  { re: /(\d[\d,]*)\s+commits?\s+(?:past|since|beyond)\s+(\S+)/gi, kind: 'past-tag' },
  { re: /(\d[\d,]*)\s+commits?\s+(?:unpushed|ahead)/gi, kind: 'ahead' },
  { re: /(?:unpushed|ahead)[^.\n]{0,20}?(\d[\d,]*)\s+commits?/gi, kind: 'ahead' },
];

function git(dir, a) {
  try { return execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}

// Which repo a volatile sentence is about. The note is named after the project,
// so the filename is the best available answer and a wrong guess is visible
// rather than silent.
export function repoFor(fileName, line, repos) {
  const hay = `${fileName} ${line}`.toLowerCase();
  return repos.find((r) => r.name && hay.includes(String(r.name).toLowerCase())) ?? null;
}

export function ruleVolatile(text, fileName, repos) {
  const hits = [];
  const seen = new Set();
  for (const line of text.split('\n')) {
    if (RETRACTION.test(line)) continue;
    for (const v of VOLATILE) {
      v.re.lastIndex = 0;
      for (const m of line.matchAll(v.re)) {
        const stated = Number(m[1].replace(/,/g, ''));
        const repo = repoFor(fileName, line, repos);
        if (!repo?.dir || !existsSync(join(repo.dir, '.git'))) continue;
        let raw;
        if (v.kind === 'past-tag') {
          const tag = m[2].replace(/[^\w.-]/g, '');
          raw = git(repo.dir, ['rev-list', '--count', `${tag}..HEAD`]);
        } else {
          raw = git(repo.dir, ['rev-list', '--count', '@{u}..HEAD']);
        }
        if (raw === null) {
          // git did not answer — missing binary, broken checkout, no upstream.
          // A claim that cannot be checked is unverified, never confirmed, and
          // dropping it silently makes a broken sweep look clean.
          const key = `${repo.name}|unreachable`;
          if (seen.has(key)) continue;
          seen.add(key);
          hits.push({
            kind: 'GIT-UNREACHABLE',
            fact: repo.name,
            value: stated,
            actual: null,
            at: { context: line.trim().slice(0, 200), line: 0 },
          });
          continue;
        }
        const actual = Number(raw);
        if (!Number.isFinite(actual) || actual === stated) continue;
        const key = `${repo.name}|${v.kind}|${stated}|${line.trim()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push({
          kind: 'VOLATILE',
          fact: `${repo.name} ${v.kind}`,
          value: stated,
          actual,
          at: { context: line.trim().slice(0, 200), line: 0 },
        });
      }
    }
  }
  return hits;
}

// -------------------------------------------------------------------- main

function main() {
  const doc = configFrom(args, here);
  const notesDir = configPath(doc, section(doc, 'notes').dir);
  const factsPath = configPath(doc, section(doc, 'facts'));

  let facts;
  try {
    facts = JSON.parse(readFileSync(factsPath, 'utf8')).facts ?? [];
  } catch (e) {
    console.error(`CONFIG  the registry at ${factsPath} is unreadable (${e.message}) — `
      + 'there is nothing to compare against, which is not a clean result');
    return 2;
  }
  if (!facts.length) {
    console.error(`CONFIG  the registry at ${factsPath} holds no facts — nothing to compare against`);
    return 2;
  }

  let files;
  try {
    files = readdirSync(notesDir).filter((n) => n.endsWith('.md'));
  } catch (e) {
    console.error(`CONFIG  cannot read the notes directory ${notesDir} (${e.code ?? e.message})`);
    return 2;
  }
  if (!files.length) {
    console.error(`CONFIG  no .md files under ${notesDir} — nothing was read, which is not a clean result`);
    return 2;
  }

  const withdrawn = facts.filter((f) => f.status === 'withdrawn');
  const live = facts.filter((f) => f.status === 'protocol' || f.status === 'provisional');
  const repos = (doc.repos ?? []).map((r) => ({ name: r.name, dir: configPath(doc, r.local ?? r.name) }));

  let findings = 0;
  for (const name of files) {
    const text = readFileSync(join(notesDir, name), 'utf8');
    const nums = numbersIn(text);
    const hits = [
      ...ruleRetired(nums, withdrawn),
      ...ruleFactDrift(nums, factsForFile(name, live)),
      ...ruleVolatile(text, name, repos),
    ];
    for (const h of hits) {
      const where = `${name}${h.at.line ? `:${h.at.line}` : ''}`;
      if (h.kind === 'GIT-UNREACHABLE') {
        // Not a finding and not a pass: the claim stands unverified.
        console.log(`UNREACHABLE  ${where.padEnd(34)} git did not answer for ${h.fact} — the volatile claim is unverified, not confirmed`);
        console.log(`             …${h.at.context}…`);
        continue;
      }
      findings += 1;
      if (h.kind === 'RETIRED') {
        console.log(`RETIRED      ${where.padEnd(34)} carries ${h.value}, withdrawn as ${h.fact}`);
      } else if (h.kind === 'FACT-DRIFT') {
        console.log(`FACT-DRIFT   ${where.padEnd(34)} says ${h.value} ${h.at.unit}; registered: ${h.fact}`);
      } else {
        console.log(`VOLATILE     ${where.padEnd(34)} says ${h.value}, git says ${h.actual} (${h.fact})`);
      }
      console.log(`             …${h.at.context}…`);
    }
  }

  console.log(`\n${files.length} note file(s) read against ${facts.length} registered fact(s); ${findings} finding(s)`);
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

  const withdrawn = [{ id: 'kernelfusion.transformer_458x', value: 458, unit: 'x' }];
  const live = [{ id: 'zerotvm.wgsl_files', value: 52, unit: 'files' }];

  // Rule 1, and its positive control: the checker must be able to SEE a planted
  // retired number, or a clean run means nothing.
  ck('a retired value in a note is caught', 1,
    ruleRetired(numbersIn('The fusion work reached 458x end to end.'), withdrawn).length);
  ck('the same value inside its own retraction is not a finding', 0,
    ruleRetired(numbersIn('458x was retracted by the v3 erratum.'), withdrawn).length);
  ck('an unrelated number is not a finding', 0,
    ruleRetired(numbersIn('There are 12 open threads.'), withdrawn).length);

  // Rule 2.
  ck('a note disagreeing with a registered fact is caught', 1,
    ruleFactDrift(numbersIn('It ships 51 files of hand-written WGSL.'), live).length);
  ck('a note agreeing with the record is silent', 0,
    ruleFactDrift(numbersIn('It ships 52 files of hand-written WGSL.'), live).length);
  ck('a number with no unit cannot drift', 0,
    ruleFactDrift(numbersIn('Around 51 of them.'), live).length);

  // The unit rule, which is the whole join. A two-word unit produced units like
  // "v" and "d" that grouped unrelated numbers.
  ck('unit is the first word only', 'files', unitPhrase('files of hand-written WGSL'));
  ck('a one-letter unit is rejected', null, unitPhrase('x of the thing'));
  ck('a stopword is not a unit', null, unitPhrase('and then some'));

  // Tokenizing.
  ck('a trailing comma does not join the number', 1994, numbersIn('in 1994, the thing happened')[0].value);
  ck('thousands separators are one number', 139255, numbersIn('139,255 neurons')[0].value);
  ck('a decimal stays whole', 69.55, numbersIn('69.55 tok/s sustained')[0].value);
  // A version is not a measurement. The lookbehind rejects a digit preceded by
  // a word character or a dot, so v0.2.0 yields nothing rather than three
  // claims of 0, 2 and 0.
  ck('a version string yields no numbers', 0, numbersIn('v0.2.0 shipped').length);

  // The two calibrations that made this usable rather than noise.
  ck('a retired value with a different unit is not a republication', 0,
    ruleRetired(numbersIn('a renderer was burning 39% CPU'), [{ id: 'a.speedup_39x', value: 39, unit: 'x' }]).length);
  ck('a retired value with the same unit still fires', 1,
    ruleRetired(numbersIn('it reached 39x on that machine'), [{ id: 'a.speedup_39x', value: 39, unit: 'x' }]).length);
  ck('an attached one-character unit survives', 'x', numbersIn('458x faster')[0].unit);
  ck('an ambiguous unit identifies no fact and is skipped', 0,
    ruleFactDrift(numbersIn('a baseline managed 51 files there'),
      [{ id: 'a.files', value: 52, unit: 'files' }, { id: 'b.files', value: 71, unit: 'files' }]).length);
  ck('a unit owned by exactly one fact still drifts', 1,
    ruleFactDrift(numbersIn('it ships 51 files today'), [{ id: 'a.files', value: 52, unit: 'files' }]).length);

  ck('a number inside a code span is an identifier, not a claim', 0,
    ruleRetired(numbersIn('four claims (`li-kf-seq-720x`, `li-kf-458x`)'),
      [{ id: 'a.sequential_720x', value: 720, unit: 'x' }]).length);
  ck('the same number outside a code span still fires', 1,
    ruleRetired(numbersIn('the sequential path reached 720x'),
      [{ id: 'a.sequential_720x', value: 720, unit: 'x' }]).length);
  ck('a note only compares against its own project facts', 1,
    factsForFile('zero-tvm.md',
      [{ id: 'zerotvm.wgsl_files', value: 52 }, { id: 'gpubench.total_runs', value: 794 }]).length);
  ck('a note naming no known project compares against nothing', 0,
    factsForFile('strategy.md', [{ id: 'zerotvm.wgsl_files', value: 52 }]).length);

  // Rule 3 needs a real checkout, so it is exercised structurally: a sentence
  // naming no configured repo must produce nothing rather than guess.
  ck('a volatile sentence about no known repo is skipped', 0,
    ruleVolatile('It is 9 commits unpushed.', 'notes.md', [{ name: 'zero-tvm', dir: '/nonexistent' }]).length);
  ck('a configured repo with no checkout on disk is skipped, not guessed', 0,
    ruleVolatile('zero-tvm is 9 commits unpushed.', 'zero-tvm.md', [{ name: 'zero-tvm', dir: '/nonexistent' }]).length);
  ck('the repo join reads the filename as well as the line', 'zero-tvm',
    repoFor('zero-tvm.md', 'nine commits unpushed', [{ name: 'zero-tvm' }])?.name);

  // A checkout git cannot answer for (broken repo, missing binary, no
  // upstream) must surface as UNREACHABLE, never as silent agreement. A plain
  // file named .git passes the existence check and makes every git call fail.
  {
    const tmp = join(process.env.TMPDIR || '/tmp', `check-memory-selftest-${process.pid}`);
    mkdirSync(tmp, { recursive: true });
    try {
      writeFileSync(join(tmp, '.git'), 'not a repository');
      const h = ruleVolatile('proj is 9 commits unpushed.', 'proj.md', [{ name: 'proj', dir: tmp }]);
      ck('a git that cannot answer is UNREACHABLE, not silence', 'GIT-UNREACHABLE', h[0]?.kind);
      ck('and it is reported once per repo, not per sentence', 1,
        ruleVolatile('proj is 9 commits unpushed. proj is 4 commits unpushed.', 'proj.md',
          [{ name: 'proj', dir: tmp }]).length);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // THE FAULT CASE.
  ck('a missing config is fatal, not an empty sweep', true,
    threw(() => configFrom(['--config', '/nonexistent/estate.json'], here)));
  ck('a config with no notes section is fatal', true, threw(() => section({}, 'notes')));
  ck('a config with no facts is fatal', true, threw(() => section({ notes: { dir: 'x' } }, 'facts')));

  return fail;
}

if (args.includes('--selftest')) {
  process.exit(selftest() === 0 ? 0 : 1);
} else if (process.argv[1]?.endsWith('check-memory.mjs')) {
  try { process.exit(main()); } catch (e) { fatal(e); }
}
