#!/usr/bin/env node
// Static analyzer for facts.json.
//
//   check-facts.mjs                 rule checks only, no network, no subprocesses
//   check-facts.mjs --verify-cheap  additionally re-runs every produced_by marked
//                                   cost:cheap (seconds each, no GPU) and reports
//                                   FACT-DRIFT where the live number disagrees
//   check-facts.mjs --verify        re-runs EVERY runnable produced_by, GPU benches
//                                   included. Minutes. Run this one by hand.
//   check-facts.mjs --json
//
// Exit 0 clean, 1 on findings.
//
// The rule checks catch drift: the same quantity published at different values.
// --verify catches decay: a value that was right when recorded and is not now.
// Neither catches a number that is internally consistent and simply wrong -
// that needs an agent that EXECUTES something, not one that reads. Four review
// agents missed a wrong version floor on a public comment; the fifth caught it
// by creating a session against the real build and watching it fail.
//
// The cheap/expensive split exists because nothing re-ran the cheap checks on a
// schedule. A shader-file count drifted 50->51 and was caught only because an
// agent happened to re-run its produced_by by hand. --verify-cheap is that
// accident made routine: most commands here are ls|wc, jq over a file, or one
// API call, and there is no reason to wait for luck on those.
//
// Neither verify pass EDITS this file. Rule 5 says a value changes by re-running
// produced_by; deciding that a new number is the right one is a judgement about
// what to publish, so the checker reports and a human or orchestrator decides.

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const factsPath = join(here, 'facts.json');
// produced_by commands are written relative to the repository root, so they run
// the same whether the analyzer was invoked from the root or from facts/.
const repoRoot = join(here, '..');
const args = process.argv.slice(2);
const VERIFY = args.includes('--verify');
const VERIFY_CHEAP = args.includes('--verify-cheap');
const JSON_OUT = args.includes('--json');

const findings = [];
const add = (level, id, msg) => findings.push({ level, id, msg });

let doc;
try {
  doc = JSON.parse(readFileSync(factsPath, 'utf8'));
} catch (e) {
  console.error(`cannot read facts.json: ${e.message}`);
  process.exit(2);
}

const facts = doc.facts ?? [];
const byId = new Map(facts.map((f) => [f.id, f]));
const VALID_STATUS = new Set(['protocol', 'single-run', 'provisional', 'unbacked', 'withdrawn']);
// A produced_by is runnable only when it LOOKS like a command, not merely
// because it avoids the word UNRESOLVED. The old predicate was a naming
// convention doing execution-guard work: a supervisor planted prose reading
// "measured by hand $(touch SENTINEL) on the M2 Max" and verify-cheap shelled
// it out — the $(touch) ran, and the failure surfaced as a benign UNREACHABLE
// with exit 0. Prose must never reach execSync. The allowlist is the commands
// this file actually uses; extend it deliberately when a new fact needs a new
// tool, never by loosening the pattern.
const COMMAND_SHAPE = /^(cd |ls |cat |jq |rg |grep |curl |node |npx |npm |uv |python3? |for |BENCH_[A-Z_]*=)/;
const RUNNABLE = (f) =>
  Boolean(f.produced_by) && !/^UNRESOLVED/.test(f.produced_by) && COMMAND_SHAPE.test(f.produced_by);

// R0 - shape
for (const f of facts) {
  if (!f.id) add('ERROR', '(no id)', 'fact has no id');
  if (!f.scope) add('ERROR', f.id, 'no scope recorded');
  if (!VALID_STATUS.has(f.status)) add('ERROR', f.id, `invalid status "${f.status}"`);
}
const seen = new Set();
for (const f of facts) {
  if (seen.has(f.id)) add('ERROR', f.id, 'duplicate id');
  seen.add(f.id);
}

// R2 - "protocol" means reproducible by command. Nothing less qualifies.
for (const f of facts) {
  if (f.status === 'protocol' && !RUNNABLE(f)) {
    add('ERROR', f.id, 'status "protocol" but produced_by is not runnable - downgrade or record the command');
  }
}

// R2b - "single-run" is a real observation that is not a protocol round. It does
// not need a scripted command, but it must record the conditions, or it is just
// a number someone remembers.
for (const f of facts) {
  if (f.status === 'single-run' && (!f.measured_at || !f.measured_on)) {
    add('ERROR', f.id, 'status "single-run" requires measured_at and measured_on');
  }
}

// R2c - every runnable produced_by must be classified cheap or expensive, or the
// sweep never re-runs it. Absent and misspelled are the same failure: silently
// skipped by --verify-cheap, which is how a fact goes a year without being asked
// whether it is still true. Facts with no value have nothing to compare, so they
// are exempt.
const VALID_COST = new Set(['cheap', 'expensive']);
for (const f of facts) {
  if (!RUNNABLE(f) || f.value === null) continue;
  if (f.cost === undefined) {
    add('ERROR', f.id, 'runnable produced_by but no cost - classify "cheap" or "expensive" or it is never re-run');
  } else if (!VALID_COST.has(f.cost)) {
    add('ERROR', f.id, `invalid cost "${f.cost}" - must be "cheap" or "expensive"`);
  }
}

// R7 - a value that cannot stand alone must say so in a field that travels.
// `note` is for whoever maintains this file; `caveat` is for whoever reads the
// number on a public surface. build-sites.mjs refuses to render a caveated fact
// without its caveat.
for (const f of facts) {
  if ((f.status === 'single-run' || f.status === 'provisional') && !f.caveat) {
    add('ERROR', f.id, `status "${f.status}" requires a caveat — the qualification has to travel with the number, not sit in a note`);
  }
  if (f.caveat && f.caveat.length > 120) {
    add('WARN', f.id, 'caveat is long enough that a surface may truncate it; tighten to one clause');
  }
}

// R4 - withdrawn values must carry a note saying where they still survive
for (const f of facts) {
  if (f.status === 'withdrawn' && !f.note) {
    add('WARN', f.id, 'withdrawn with no note - record where it still appears so it can be removed');
  }
}

// R5 - a ratio must name its baseline
const BASELINE_HINT = /(vs|against|over|baseline|compared|relative to|reference)/i;
for (const f of facts) {
  if (f.status === 'withdrawn') continue; // being retired, not republished
  if ((f.unit === 'x' || f.unit === '%') && f.value !== null && !BASELINE_HINT.test(f.scope ?? '')) {
    add('ERROR', f.id, 'ratio with no named baseline in scope (rule 4)');
  }
}

// R6 - derived facts must reference existing ids
for (const f of facts) {
  for (const dep of f.derived_from ?? []) {
    if (!byId.has(dep)) add('ERROR', f.id, `derived_from references unknown id "${dep}"`);
  }
}

// R3 - unbacked or single-run values are not headline material
for (const f of facts) {
  if (f.status === 'unbacked' && f.value !== null) {
    add('WARN', f.id, `unbacked but carries a value (${f.value}) - may not appear in a headline, tagline or stat tile until produced_by is runnable`);
  }
  if (f.status === 'single-run' && f.value !== null) {
    add('WARN', f.id, `single-run (${f.value}) - not a protocol round; may not appear in a headline or stat tile`);
  }
}

// --verify: re-run what can be run
if (VERIFY) {
  for (const f of facts) {
    if (!RUNNABLE(f) || f.value === null) continue;
    let out;
    try {
      out = execSync(f.produced_by, { cwd: repoRoot, encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (e) {
      add('UNREACHABLE', f.id, `produced_by failed to run (not a drift finding): ${String(e.message).split('\n')[0]}`);
      continue;
    }
    const got = parseFloat(String(out).match(/-?\d+(\.\d+)?/)?.[0] ?? 'NaN');
    if (Number.isNaN(got)) {
      add('UNREACHABLE', f.id, `produced_by produced no number: "${String(out).slice(0, 60)}"`);
      continue;
    }
    const want = Number(f.value);
    const tol = Math.abs(want) * 0.01;
    if (Math.abs(got - want) > tol) {
      add('DRIFT', f.id, `stored ${want} but produced_by now yields ${got}`);
    }
  }
}

// --verify-cheap: re-run the produced_by commands marked cost:cheap.
//
// Comparison is exact, not the 1% band --verify uses. Every cheap fact is a count
// or a floored integer, so there is no run-to-run noise to forgive - and a band
// that forgives a delta of 1 would have forgiven a file count moving 50->51 and
// a device count moving 119->120, which are precisely the drifts this pass
// exists to catch. The band belongs to --verify, which re-runs noisy benchmarks.
const CHEAP_TIMEOUT_MS = 30000;

function runAndCompare(command, expected) {
  let out;
  try {
    out = execSync(command, { cwd: repoRoot, encoding: 'utf8', timeout: CHEAP_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    return { verdict: 'unreachable', why: String(e.message).split('\n')[0] };
  }
  const got = parseFloat(String(out).match(/-?\d+(\.\d+)?/)?.[0] ?? 'NaN');
  if (Number.isNaN(got)) {
    return { verdict: 'unreachable', why: `produced no number: "${String(out).slice(0, 60)}"` };
  }
  return { verdict: got === Number(expected) ? 'ok' : 'drift', got };
}

// Positive control, run before any real fact is touched, through the same
// function the real facts go through. A sweep reporting nothing looks exactly
// like a sweep that is broken, and this estate has already shipped one that
// returned 0 hits for everything. Plant a mismatch, a match and a failure: if
// the machinery misreads any of the three it has no business reporting on real
// numbers, so abort loudly rather than print a reassuring clean sheet.
function selfCheck() {
  const planted = [
    ['echo 41', 42, 'drift'],
    ['echo 42', 42, 'ok'],
    ['exit 7', 42, 'unreachable'],
  ];
  for (const [command, expected, want] of planted) {
    const { verdict } = runAndCompare(command, expected);
    if (verdict !== want) {
      console.error(`SELF-CHECK FAILED: \`${command}\` against ${expected} should read "${want}", read "${verdict}".`);
      console.error('The drift detector cannot detect drift. Refusing to report on real facts.');
      process.exit(2);
    }
  }
}

if (VERIFY_CHEAP) {
  selfCheck();
  for (const f of facts) {
    // RUNNABLE is the execution guard (command-shape allowlist), not just a
    // filter — a prose produced_by with a hand-added cost:cheap must never
    // reach the shell.
    if (f.cost !== 'cheap' || f.value === null || !RUNNABLE(f)) continue;
    const r = runAndCompare(f.produced_by, f.value);
    if (r.verdict === 'unreachable') {
      // Never agreement. Offline, an expired API token and a moved checkout
      // all land here, and none of them is evidence the number is still right.
      add('UNREACHABLE', f.id, `cheap produced_by did not run, so this fact is UNVERIFIED (not agreed): ${r.why}`);
    } else if (r.verdict === 'drift') {
      // A fact backed by a live counter moves daily, and a finding that fires
      // every sweep trains the reader to skip findings. Such a fact declares
      // drift_tolerance_pct: within the band it is a dated snapshot doing its
      // job, beyond it the published snapshot is misleadingly stale. Exact
      // comparison stays the default — the tolerance exists per-fact, by
      // declaration, never globally.
      const tol = Number(f.drift_tolerance_pct);
      if (tol > 0 && Math.abs(r.got - f.value) / Math.abs(f.value) * 100 <= tol) {
        // within band: quiet
      } else {
        add('FACT-DRIFT', f.id, `recorded ${f.value}, live ${r.got}, measured_at ${f.measured_at ?? 'unrecorded'} - rule 5: re-run produced_by, do not hand-edit`);
      }
    }
  }
}

const order = { ERROR: 0, 'FACT-DRIFT': 1, DRIFT: 2, WARN: 3, UNREACHABLE: 4 };
findings.sort((a, b) => (order[a.level] - order[b.level]) || a.id.localeCompare(b.id));

if (JSON_OUT) {
  console.log(JSON.stringify({ facts: facts.length, findings }, null, 2));
} else {
  for (const f of findings) console.log(`${f.level.padEnd(12)} ${String(f.id).padEnd(34)} ${f.msg}`);
  const counts = findings.reduce((a, f) => ((a[f.level] = (a[f.level] ?? 0) + 1), a), {});
  const summary = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ') || 'none';
  console.log(`\n${facts.length} facts checked; ${summary}`);
  const backed = facts.filter(RUNNABLE).length;
  console.log(`${backed}/${facts.length} have a runnable produced_by`);
  if (VERIFY_CHEAP) {
    // Say what was actually exercised. "No findings" is only worth reading if it
    // is attached to a count of things that ran.
    const cheap = facts.filter((f) => f.cost === 'cheap' && f.value !== null).length;
    console.log(`self-check passed; ${cheap} cheap facts re-run against their produced_by`);
  }
}

process.exit(findings.some((f) => f.level === 'ERROR' || f.level === 'DRIFT' || f.level === 'FACT-DRIFT') ? 1 : 0);
