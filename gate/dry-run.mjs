#!/usr/bin/env node
// dry-run.mjs — what verdict would verify-before-publish.sh reach right now?
//
//   dry-run.mjs                          every artifact path the ledger names
//   dry-run.mjs --artifact <path>        just that one
//   dry-run.mjs --archive                copy verified bytes beside their entry
//   dry-run.mjs --selftest               prove each rule, and the fault case
//
//   --ledger <dir>   which ledger. Defaults to PUBLISH_LEDGER_DIR, then to the
//                    hook's own default of $HOME/.claude/verify-ledger, in that
//                    order, so this cannot read a different ledger than the one
//                    that decides.
//
// WHY THIS EXISTS
// ---------------
// The only way to learn the gate's verdict was to attempt the publish. That is
// a bad way to ask a question whose wrong answer is a notification everyone
// subscribed to the thread has already been emailed. This answers it without
// running anything.
//
// It cannot approve, bypass or pre-authorize. It writes nothing outside the
// ledger's own directory, and only under --archive. If its answer ever differs
// from the hook's, the hook is right and this is the bug: it is a readout of
// the rule, never a second implementation of it.
//
// THE STATE IT EXISTS TO SURFACE
// ------------------------------
// Not pass, and not fail: lenses on record for the PATH but at a different
// sha, because the file was edited after it was verified. That reads as
// verified from every angle except the one that counts.
//
// THE BODY ARCHIVE
// ----------------
// A ledger entry is keyed by sha256 alone. Once the artifact file changes, or
// moves, or the scratch directory holding it is deleted, the entry proves THAT
// something was reviewed and never WHAT. --archive copies the verified bytes to
// <sha256>.body beside the entry, and refuses to write a body whose hash is not
// the name it would be stored under — so a drifted file can never quietly
// become the record of what was approved.
//
// Exit 0 when every artifact examined would pass, 1 when any would be blocked,
// 2 when the ledger could not be read.

// copyFileSync writes, and only under --archive, and only into the ledger's own
// directory. mkdir/write/rm are used by the selftest, against a throwaway dir.
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ALIASES, normalise } from './lens-names.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const HOME = homedir();

// Same default and same env var as the hook.
const REQUIRED_LENSES = Number(process.env.PUBLISH_REQUIRED_LENSES ?? 2);

function argOf(name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

function ledgerDir() {
  return argOf('--ledger') || process.env.PUBLISH_LEDGER_DIR || join(HOME, '.claude', 'verify-ledger');
}

export function sha256File(p) {
  try { return createHash('sha256').update(readFileSync(p)).digest('hex'); } catch { return null; }
}

// ------------------------------------------------------------------ the rule

// MIRRORS the hook, in its order of precedence:
//   1. any DO-NOT-POST for the exact sha  -> denied, whatever else is on record
//   2. fewer than N DISTINCT SAFE lenses  -> denied
//   3. no SAFE lens with "anchored": true -> denied
// Names are normalised first, for the same reason the hook normalises them: two
// spellings of one lens are not two reviewers.
export function judge(entries, required = REQUIRED_LENSES) {
  const pick = (fn) => [...new Set(entries.filter(fn).map((e) => normalise(e.lens)))];
  const safe = pick((e) => e.verdict === 'SAFE');
  const bad = pick((e) => e.verdict === 'DO-NOT-POST');
  const anchored = pick((e) => e.verdict === 'SAFE' && e.anchored === true);

  let missing = null;
  if (bad.length) missing = `${bad.join(', ')} recorded DO-NOT-POST for these exact bytes`;
  else if (safe.length === 0) missing = 'no lens has verified these bytes';
  else if (safe.length < required) {
    missing = `only ${safe.length} SAFE lens (${safe.join(', ')}) — ${required} distinct are required`;
  } else if (!anchored.length) {
    missing = `${safe.length} SAFE lenses, none anchored to external evidence`;
  }
  return { pass: !missing, safe, bad, anchored, missing };
}

// An action manifest describes something that was never a file — archiving a
// repo, editing a description. Its "path" is prose, and a missing prose path is
// not a deleted artifact.
export function isDescriptor(p) {
  return !p.startsWith('/') || / @ | of /.test(p);
}

export function stateOf(path, ledgerShas, live) {
  if (!existsSync(path)) return isDescriptor(path) ? 'descriptor' : 'gone';
  return ledgerShas.includes(live) ? 'current' : 'drifted';
}

// ------------------------------------------------------------------- reading

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
    if (!e?.artifact_sha256 || !e.lens) { malformed.push({ file: n, why: 'no artifact_sha256 or no lens' }); continue; }
    entries.push({ ...e, file: n });
  }
  return { entries, malformed };
}

function byPath(entries) {
  const m = new Map();
  for (const e of entries) {
    if (!e.artifact_path) continue;
    const a = m.get(e.artifact_path) ?? [];
    a.push(e);
    m.set(e.artifact_path, a);
  }
  return m;
}

// ------------------------------------------------------------------- archive

// Read-only with respect to everything except the ledger's own directory.
export function archive(dir, entries) {
  const wanted = new Map();
  for (const e of entries) if (e.artifact_path) wanted.set(e.artifact_sha256, e.artifact_path);

  let written = 0;
  let already = 0;
  const unrecoverable = [];
  for (const [sha, p] of wanted) {
    const body = join(dir, `${sha}.body`);
    if (existsSync(body)) { already += 1; continue; }
    if (!existsSync(p)) {
      if (isDescriptor(p)) continue;
      unrecoverable.push({ sha, path: p, why: 'the file is gone' });
      continue;
    }
    // The refusal that makes the archive worth having: a file that changed
    // since it was verified must never become the record of what was approved.
    if (sha256File(p) !== sha) {
      unrecoverable.push({ sha, path: p, why: 'the file changed since it was verified' });
      continue;
    }
    try { copyFileSync(p, body); written += 1; } catch (err) {
      unrecoverable.push({ sha, path: p, why: err.message });
    }
  }
  return { written, already, unrecoverable, total: wanted.size };
}

// ---------------------------------------------------------------------- main

const short = (s) => String(s).slice(0, 12);
const tilde = (p) => String(p).replace(HOME, '~');

function main() {
  const dir = ledgerDir();
  const read = readLedger(dir);
  if (read === null) {
    console.error(`BROKEN  no ledger directory at ${tilde(dir)}. There is nothing to read, `
      + 'which is not the same as nothing being verified.');
    return 2;
  }
  const { entries, malformed } = read;
  for (const m of malformed) console.log(`LEDGER-BROKEN ${m.file}: ${m.why}`);
  if (!entries.length) {
    console.error(`BROKEN  ${tilde(dir)} holds no readable entries.`);
    return 2;
  }

  if (args.includes('--archive')) {
    const r = archive(dir, entries);
    console.log(`archived ${r.written} of ${r.total} verified bodies (${r.already} already present)`);
    for (const u of r.unrecoverable) console.log(`UNRECOVERABLE ${short(u.sha)} ${tilde(u.path)} — ${u.why}`);
    return r.unrecoverable.length ? 1 : 0;
  }

  const only = argOf('--artifact');
  const groups = byPath(entries);
  const paths = only ? [only] : [...groups.keys()].sort();
  let blocked = 0;

  for (const p of paths) {
    const es = groups.get(p) ?? [];
    const shas = [...new Set(es.map((e) => e.artifact_sha256))];
    const live = sha256File(p);
    const state = stateOf(p, shas, live);
    const archived = shas.length > 0 && shas.every((s) => existsSync(join(dir, `${s}.body`)));

    console.log(`\n── ${tilde(p)}`);
    if (!es.length) {
      blocked += 1;
      console.log('   BLOCKED  no ledger entry names this path at all');
      continue;
    }
    console.log(`   state    ${state}${archived ? '' : '  (bytes not archived — the entry proves that, never what)'}`);
    console.log(`   lenses   ${[...new Set(es.map((e) => normalise(e.lens)))].join(', ')}`);

    if (state === 'descriptor') {
      console.log('   note     an action manifest, described rather than stored — there was never a file here');
      continue;
    }
    if (state === 'gone') {
      blocked += 1;
      console.log('   BLOCKED  the artifact is not on disk, so the hook cannot hash it');
      continue;
    }
    if (state === 'drifted') {
      blocked += 1;
      console.log(`   live     ${short(live)}`);
      console.log(`   ledger   ${shas.map(short).join(', ')}`);
      console.log('   BLOCKED  the file was edited after it was verified. An approval covers the exact');
      console.log('            bytes reviewed, so it does not carry over. Re-run those lenses.');
      continue;
    }

    const v = judge(es.filter((e) => e.artifact_sha256 === live));
    if (v.pass) {
      console.log(`   WOULD PASS  ${v.safe.length} SAFE (${v.safe.join(', ')}), anchored: ${v.anchored.join(', ')}`);
    } else {
      blocked += 1;
      console.log(`   BLOCKED  ${v.missing}`);
    }
  }

  console.log(`\n${paths.length} artifact path(s); ${blocked} would be blocked right now`);
  return blocked > 0 ? 1 : 0;
}

// -------------------------------------------------------------------- selftest

function selftest() {
  let fail = 0;
  const ck = (name, want, got) => {
    const ok = String(want) === String(got);
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — want ${want}, got ${got}`}`);
    if (!ok) fail += 1;
  };
  const S = (lens, anchored = false) => ({ lens, verdict: 'SAFE', anchored });
  const N = (lens) => ({ lens, verdict: 'DO-NOT-POST' });

  // Precedence, in the hook's order.
  ck('two SAFE, one anchored, passes', true, judge([S('refuter', true), S('reproducer')]).pass);
  ck('a DO-NOT-POST vetoes any number of SAFEs', false,
    judge([S('refuter', true), S('reproducer'), S('recipient'), N('claim-auditor')]).pass);
  ck('and the veto is reported first, not the count', true,
    judge([S('refuter', true), S('reproducer'), N('recipient')]).missing.includes('DO-NOT-POST'));
  ck('one SAFE is not a quorum', false, judge([S('refuter', true)]).pass);
  ck('two SAFE and none anchored is not a pass', false, judge([S('refuter'), S('reproducer')]).pass);
  ck('and that denial names the anchoring, not the count', true,
    judge([S('refuter'), S('reproducer')]).missing.includes('anchored'));
  ck('no entries at all is not a pass', false, judge([]).pass);
  ck('an unknown verdict counts as neither', false, judge([S('refuter', true), { lens: 'x', verdict: 'MAYBE' }]).pass);

  // Normalisation, which is the whole reason the counts are trustworthy.
  ck('two spellings of one lens are one reviewer', false,
    judge([{ lens: 'claims', verdict: 'SAFE', anchored: true }, S('claim-auditor')]).pass);
  ck('an alias still counts as its canonical lens', true,
    judge([{ lens: 'claims', verdict: 'SAFE', anchored: true }, S('reproduction')]).pass);
  ck('the required count follows the environment, as the hook does', true, judge([S('refuter', true)], 1).pass);

  // Descriptors: an action with no natural file is not a deleted artifact.
  ck('an absolute path is not a descriptor', false, isDescriptor('/tmp/x.md'));
  ck('prose describing an action is a descriptor', true, isDescriptor('archive of the old repo'));
  ck('a drifted file is neither gone nor current', 'drifted', stateOf(here, ['aaa'], 'bbb'));
  ck('a matching hash is current', 'current', stateOf(here, ['aaa'], 'aaa'));
  ck('a missing file with an absolute path is gone', 'gone', stateOf('/nonexistent/x.md', ['aaa'], null));

  // THE FAULT CASE. A ledger that cannot be read must never read as "nothing
  // is blocked". main() returns 2 for both of these rather than 0.
  ck('a ledger directory that does not exist reads as null, not as empty', null,
    readLedger('/nonexistent/verify-ledger'));
  ck('a file that cannot be hashed yields null, never a hash of nothing', null,
    sha256File('/nonexistent/artifact.md'));

  const tmp = join(process.env.TMPDIR || '/tmp', `gate-dry-run-selftest-${process.pid}`);
  mkdirSync(tmp, { recursive: true });
  try {
    writeFileSync(join(tmp, 'aaa-refuter.json'), '{ not json');
    const art = join(tmp, 'artifact.md');
    writeFileSync(art, 'the reviewed bytes\n');
    const sha = sha256File(art);
    writeFileSync(join(tmp, `${sha}-refuter.json`),
      JSON.stringify({ artifact_sha256: sha, artifact_path: art, lens: 'refuter', verdict: 'SAFE', anchored: true }));
    const r = readLedger(tmp);
    ck('an unparseable entry is reported, not dropped', 1, r.malformed.length);
    ck('and the readable entry still comes through', 1, r.entries.length);

    // The archive, and its refusal.
    ck('the verified bytes are archived under their own hash', 1, archive(tmp, r.entries).written);
    ck('and the archived body is the bytes that were reviewed', 'the reviewed bytes\n',
      readFileSync(join(tmp, `${sha}.body`), 'utf8'));
    ck('a second run rewrites nothing', 0, archive(tmp, r.entries).written);

    writeFileSync(art, 'edited after approval\n');
    const stale = readLedger(tmp).entries.map((e) => ({ ...e, artifact_sha256: 'deadbeef' }));
    const after = archive(tmp, stale);
    ck('a file that changed since verification is refused, not archived', 0, after.written);
    ck('and the refusal says why', 'the file changed since it was verified', after.unrecoverable[0].why);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  // One fact, one generator: the alias map lives here and in the hook's python
  // block, and nowhere else. If they drift, the dry run stops describing the
  // rule it claims to read out.
  const hook = readFileSync(join(here, 'verify-before-publish.sh'), 'utf8');
  for (const [from, to] of Object.entries(ALIASES)) {
    ck(`the hook carries the alias ${from} -> ${to}`, true,
      hook.includes(`"${from}": "${to}"`));
  }
  ck('and normalise agrees with itself on a canonical name', 'refuter', normalise('  Refuter '));

  return fail;
}

if (args.includes('--selftest')) {
  process.exit(selftest() === 0 ? 0 : 1);
} else if (process.argv[1]?.endsWith('dry-run.mjs')) {
  try {
    process.exit(main());
  } catch (e) {
    console.error(`BROKEN  ${e.stack ?? e.message}`);
    process.exit(2);
  }
}
