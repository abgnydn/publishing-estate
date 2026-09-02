#!/usr/bin/env node
// check-lenses.mjs — is the publish gate's quorum what it claims to be?
//
//   check-lenses.mjs --ledger <dir>    read that ledger
//   check-lenses.mjs --config <file>   take the ledger path from the config
//   check-lenses.mjs --selftest        prove each rule catches a planted defect
//
// With neither flag it reads PUBLISH_LEDGER_DIR, then the gate's own default of
// $HOME/.claude/verify-ledger — the same two the hook uses, in the same order,
// so this cannot end up reading a different ledger than the one that decides.
//
// WHY THIS EXISTS
// ---------------
// Every other checker reads a published surface. This one reads the VERIFIER,
// because the gate is the last thing between a wrong claim and the public and
// nothing was checking it. Three defects it would have reported months earlier:
//
//   1. SPLIT-QUORUM. The gate counts DISTINCT lens names. A ledger held
//      `rendering` and `rendering and mechanics`, plus `claims` and
//      `claim-auditor`. Two spellings of one lens satisfied a rule that is
//      supposed to mean two independent ones, so one review cleared a
//      two-review bar. The gate normalises names now; this reports the ledger
//      entries that made it necessary.
//
//   2. SERIAL. Lenses are independent by construction — each is given the
//      artifact only, never the other findings — so they can always run at
//      once. Nothing enforced it, and the same job took minutes on one artifact
//      and an hour on another.
//
//   3. THIN. A SAFE with a short note and no anchor is the weakest possible
//      evidence: absence-of-evidence from a judge whose defect recall is poor.
//      Those are what the anchored rule exists to outvote, so they are worth
//      counting.
//
// Read-only, writes nothing. Exit 0 clean, 1 findings, 2 broken.

// mkdir/write/rm are used by the selftest only, against a throwaway directory.
// Nothing on the reporting path writes anything.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, configPath, fatal, flag, readConfig } from './config.mjs';
// The gate owns the canonical names, because the gate is what counts them. This
// checker reports on the entries that made normalising necessary, so it must
// read the same list rather than keep its own.
import { CANONICAL, normalise } from '../gate/lens-names.mjs';

const args = process.argv.slice(2);

// Lenses finishing within this of each other were running together. Chosen from
// observed data: parallel runs cluster within a couple of minutes between
// finishes, serial ones spread far wider.
const PARALLEL_MIN = 4;
const THIN_NOTE = 200;

// A ledger file that cannot be parsed is reported, never skipped. The live
// version of this checker dropped unparseable entries silently, so a ledger
// that had become half-unreadable looked exactly like a healthy one.
export function readLedger(dir) {
  if (!existsSync(dir)) return null;
  const entries = [];
  const malformed = [];
  for (const n of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    let e;
    try {
      e = JSON.parse(readFileSync(join(dir, n), 'utf8'));
    } catch (err) {
      malformed.push({ file: n, why: `not valid JSON — ${String(err.message).split('\n')[0]}` });
      continue;
    }
    if (!e?.artifact_sha256) { malformed.push({ file: n, why: 'no artifact_sha256' }); continue; }
    if (!e.lens) { malformed.push({ file: n, why: 'no lens' }); continue; }
    entries.push({ ...e, file: n, t: Date.parse(e.date ?? '') });
  }
  return { entries, malformed };
}

export function groupByArtifact(entries) {
  const g = new Map();
  for (const e of entries) {
    if (!g.has(e.artifact_sha256)) g.set(e.artifact_sha256, []);
    g.get(e.artifact_sha256).push(e);
  }
  for (const a of g.values()) a.sort((x, y) => (x.t || 0) - (y.t || 0));
  return g;
}

// A run is serial if any consecutive pair finished further apart than the
// parallel threshold. Reported with the worst gap so the size is visible.
export function serialGap(group) {
  const ts = group.map((e) => e.t).filter(Number.isFinite).sort((a, b) => a - b);
  if (ts.length < 2) return null;
  let worst = 0;
  for (let i = 1; i < ts.length; i += 1) worst = Math.max(worst, ts[i] - ts[i - 1]);
  const gapMin = Math.round(worst / 60000);
  return gapMin > PARALLEL_MIN ? { gapMin, spanMin: Math.round((ts.at(-1) - ts[0]) / 60000) } : null;
}

// Does this artifact's quorum survive normalisation? If the raw distinct count
// clears the bar and the normalised one does not, the gate was satisfied by a
// spelling rather than by a second reviewer.
export function quorumSplit(group, required = 2) {
  const safe = group.filter((e) => e.verdict === 'SAFE');
  const raw = new Set(safe.map((e) => e.lens));
  const norm = new Set(safe.map((e) => normalise(e.lens)));
  if (raw.size === norm.size) return null;
  return { raw: [...raw], norm: [...norm], decisive: raw.size >= required && norm.size < required };
}

function ledgerDir(argv = args) {
  const explicit = flag(argv, '--ledger');
  if (explicit) return explicit;
  const cfg = flag(argv, '--config');
  if (cfg) {
    const doc = readConfig(cfg);
    const p = configPath(doc, doc.ledger);
    if (!p) throw new ConfigError(`${cfg} names no "ledger" — pass --ledger, or set PUBLISH_LEDGER_DIR`);
    return p;
  }
  return process.env.PUBLISH_LEDGER_DIR || join(homedir(), '.claude', 'verify-ledger');
}

function main() {
  const dir = ledgerDir();
  const read = readLedger(dir);
  if (read === null) {
    console.log(`UNREACHABLE  no ledger directory at ${dir} — not a finding, and not a pass`);
    return 0;
  }
  const { entries, malformed } = read;
  let findings = 0;

  // Malformed first. An unreadable entry is a hole in the record the gate reads,
  // and it must never be quietly dropped on the way to a clean summary.
  for (const m of malformed) {
    findings += 1;
    console.log(`LEDGER-BROKEN ${m.file.padEnd(26)} ${m.why}`);
  }

  if (!entries.length) {
    console.log(`UNREACHABLE  ${dir} holds no readable entries — that proves nothing about the quorum`);
    return findings > 0 ? 1 : 0;
  }

  const groups = groupByArtifact(entries);

  // 1. names that are not canonical
  const odd = new Map();
  for (const e of entries) {
    if (CANONICAL.has(normalise(e.lens))) continue;
    odd.set(e.lens, (odd.get(e.lens) ?? 0) + 1);
  }
  for (const [name, n] of odd) {
    findings += 1;
    console.log(`LENS-NAME     ${String(name).padEnd(26)} ${n} entr(ies) under a name that is not a canonical lens`);
  }
  for (const e of entries) {
    const n = normalise(e.lens);
    if (n !== e.lens && CANONICAL.has(n)) {
      findings += 1;
      console.log(`LENS-ALIAS    ${e.file.slice(0, 12)}… "${e.lens}" is "${n}" spelled differently`);
    }
  }

  // 2. quorum that only holds before normalisation
  for (const [sha, g] of groups) {
    const q = quorumSplit(g);
    if (!q) continue;
    findings += 1;
    console.log(`SPLIT-QUORUM  ${sha.slice(0, 12)} ${q.decisive ? 'DECISIVE — ' : ''}`
      + `${q.raw.length} names, ${q.norm.length} reviewers: ${q.raw.join(', ')}`);
  }

  // 3. lenses that were run one at a time
  let serial = 0;
  for (const [sha, g] of groups) {
    if (g.length < 2) continue;
    const s = serialGap(g);
    if (!s) continue;
    serial += 1;
    findings += 1;
    console.log(`SERIAL        ${sha.slice(0, 12)} ${g.length} lenses over ${s.spanMin} min, `
      + `worst gap ${s.gapMin} min — they are independent and can run at once`);
  }

  // 4. SAFE verdicts carrying no evidence
  for (const e of entries) {
    if (e.verdict !== 'SAFE') continue;
    const note = String(e.note ?? '');
    if (e.anchored === true || note.length >= THIN_NOTE) continue;
    findings += 1;
    console.log(`THIN-SAFE     ${e.artifact_sha256.slice(0, 12)} ${normalise(e.lens).padEnd(14)} `
      + `SAFE, not anchored, ${note.length}-char note`);
  }

  console.log(`\n${entries.length} readable ledger entr(ies) across ${groups.size} artifact(s); `
    + `${malformed.length} unreadable; ${serial} run serially; ${findings} finding(s)`);
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
  const at = (min) => Date.parse('2026-08-01T00:00:00Z') + min * 60000;

  ck('an alias normalises to its canonical lens', 'rendering', normalise('rendering and mechanics'));
  ck('case and underscores normalise', 'claim-auditor', normalise('Claim_Auditor'));
  ck('a canonical name is unchanged', 'refuter', normalise('refuter'));
  ck('an unknown name is left alone, not guessed', 'inventor', normalise('inventor'));

  // The positive control: the checker must SEE a planted split quorum.
  const split = [
    { lens: 'rendering', verdict: 'SAFE', t: at(0) },
    { lens: 'rendering and mechanics', verdict: 'SAFE', t: at(1) },
  ];
  ck('two spellings of one lens are caught', true, !!quorumSplit(split));
  ck('and it is flagged decisive when it alone met the bar', true, quorumSplit(split).decisive);
  ck('two real lenses are not a split quorum', null,
    quorumSplit([{ lens: 'refuter', verdict: 'SAFE', t: at(0) },
      { lens: 'reproducer', verdict: 'SAFE', t: at(1) }]));
  // A DO-NOT-POST is not part of the SAFE quorum, so it cannot split it.
  ck('a non-SAFE verdict is outside the quorum', null,
    quorumSplit([{ lens: 'rendering', verdict: 'SAFE', t: at(0) },
      { lens: 'rendering and mechanics', verdict: 'DO-NOT-POST', t: at(1) }]));

  ck('lenses finishing together are parallel', null, serialGap([{ t: at(0) }, { t: at(1) }, { t: at(2) }]));
  ck('a long gap is serial', true, !!serialGap([{ t: at(0) }, { t: at(20) }]));
  ck('the worst gap is reported, not the average', 20,
    serialGap([{ t: at(0) }, { t: at(1) }, { t: at(21) }]).gapMin);
  ck('one lens alone cannot be serial', null, serialGap([{ t: at(0) }]));
  ck('entries with no timestamps are not guessed at', null, serialGap([{}, {}]));

  ck('grouping keys by artifact', 2,
    groupByArtifact([{ artifact_sha256: 'a', lens: 'x' }, { artifact_sha256: 'b', lens: 'y' }]).size);

  // THE FAULT CASE. A ledger directory that is not there, and entries that
  // cannot be read, must not produce a clean sheet. The unreadable ones are
  // findings, not silent skips.
  ck('a ledger directory that does not exist reads as null, not as empty', null,
    readLedger('/nonexistent/verify-ledger'));

  const tmp = join(process.env.TMPDIR || '/tmp', `check-lenses-selftest-${process.pid}`);
  mkdirSync(tmp, { recursive: true });
  try {
    writeFileSync(join(tmp, 'aaa-refuter.json'), '{ this is not json');
    writeFileSync(join(tmp, 'bbb-reproducer.json'), JSON.stringify({ artifact_sha256: 'bbb', verdict: 'SAFE' }));
    writeFileSync(join(tmp, 'ccc-refuter.json'),
      JSON.stringify({ artifact_sha256: 'ccc', lens: 'refuter', verdict: 'SAFE', anchored: true, note: 'x' }));
    const r = readLedger(tmp);
    ck('an unparseable entry is reported, not dropped', 1, r.malformed.filter((m) => m.why.startsWith('not valid JSON')).length);
    ck('an entry with no lens is reported, not dropped', 1, r.malformed.filter((m) => m.why === 'no lens').length);
    ck('and the readable entry still comes through', 1, r.entries.length);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  // THE CONFIG FAULT CASE, like every other checker in this directory: broken
  // config input stops the run rather than sweeping against nothing. These go
  // through ledgerDir() itself, not a re-implementation of it.
  const threw = (fn) => { try { fn(); return false; } catch { return true; } };
  const cfgTmp = join(process.env.TMPDIR || '/tmp', `check-lenses-cfg-${process.pid}.json`);
  try {
    writeFileSync(cfgTmp, JSON.stringify({ ledger: null }));
    ck('an explicit --ledger wins over the config', '/tmp/x',
      ledgerDir(['--config', cfgTmp, '--ledger', '/tmp/x']));
    ck('a missing config is fatal, not an empty sweep', true,
      threw(() => ledgerDir(['--config', '/nonexistent/estate.json'])));
    ck('a config naming no ledger is fatal, not a fallback', true,
      threw(() => ledgerDir(['--config', cfgTmp])));
  } finally {
    rmSync(cfgTmp, { force: true });
  }

  return fail;
}

if (args.includes('--selftest')) {
  process.exit(selftest() === 0 ? 0 : 1);
} else if (process.argv[1]?.endsWith('check-lenses.mjs')) {
  try { process.exit(main()); } catch (e) { fatal(e); }
}
