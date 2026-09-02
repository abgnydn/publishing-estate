#!/usr/bin/env node
// Generates generated/sites.json from a source document + facts/facts.json.
//
//   build-sites.mjs                    write generated/sites.json
//   build-sites.mjs --check            validate only, write nothing (for lefthook / CI)
//   build-sites.mjs --source <path>    validate a different source document
//
// --source exists so the failure can be demonstrated without editing the good
// source. The original had a fixed path; nothing else about the gate changed.
//
// Why this exists
// ---------------
// Every site rendered its sibling cards from a copy of the generated
// sites.json, baked in at deploy time. Three generations of the same file were
// live simultaneously: one site said the flagship was "~40 tok/s, 22% BEHIND
// WebLLM", the flagship's own copy said "69.6 tok/s, +16%", and the benchmark
// artifact said 69.55 / +16.0%. The sign was inverted on a live site because
// nothing regenerated the copies.
//
// The rule this enforces: a number reaches a public surface only through a
// {{fact:id}} placeholder. If the fact is withdrawn, the build fails. If the
// fact is unbacked, it may not sit in a stat tile. There is no path for a
// hand-typed number to reach a site.
//
// Severity is graded by SURFACE, not by rule. A stat tile is short, always
// redesignable, and read as a claim, so a literal number there is an error. A
// tagline mixes metrics with product names, so it is a warning. A stat label
// or short description carries model specs, physics scales and citation
// years, so those warn too. A
// comparable public gate, found in the author's unpublished survey of the
// space, was disabled by its own author for noise. A guard that always fires
// gets bypassed; grading by surface is what makes this one survivable.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const argv = process.argv.slice(2);
const CHECK_ONLY = argv.includes('--check');
const sourceArg = argv[argv.indexOf('--source') + 1];
const sourcePath = argv.includes('--source') && sourceArg
  ? resolvePath(process.cwd(), sourceArg)
  : join(here, 'sites.source.json');

const facts = JSON.parse(readFileSync(join(root, 'facts', 'facts.json'), 'utf8'));
const source = JSON.parse(readFileSync(sourcePath, 'utf8'));
const byId = new Map(facts.facts.map((f) => [f.id, f]));

const errors = [];
const warnings = [];

// Where a value is allowed to be soft. A stat tile is a headline; prose is not.
const STAT_CONTEXT = /^SITES\.[^.]+\.stats\[\d+\]\.value$/;
// A tagline is a headline too — facts.json rule 2 names "headline, tagline or
// stat tile" and this build originally guarded only the tiles. The gap let
// three unbacked medians sit in a tagline for a day.
const TAGLINE_CONTEXT = /^SITES\.[^.]+\.tagline$/;
const headline = (path) => STAT_CONTEXT.test(path) || TAGLINE_CONTEXT.test(path);
// A digit that starts a standalone number. The lookbehind spares names that
// carry digits (Phi-3, Geant4-DNA, b1.58, 2B4T is handled below): a digit
// glued to a letter, hyphen or dot is part of a name, not a metric.
const METRIC_DIGIT = /(?<![A-Za-z0-9.\-])\d[\d.,]*(?![A-Z]\d)/;

function resolve(str, path) {
  // {{fact:id}}         -> the value alone
  // {{fact:id+caveat}}  -> the value followed by its caveat, in parentheses
  return str.replace(/\{\{fact:([^}+]+)(\+caveat)?\}\}/g, (_m, id, wantsCaveat) => {
    const f = byId.get(id);
    if (!f) {
      errors.push(`${path}: references unknown fact "${id}"`);
      return `{{MISSING:${id}}}`;
    }
    if (f.status === 'withdrawn') {
      errors.push(`${path}: references WITHDRAWN fact "${id}" (${f.note ?? 'retired'})`);
      return `{{WITHDRAWN:${id}}}`;
    }
    if (f.value === null || f.value === undefined) {
      errors.push(`${path}: fact "${id}" has no value yet (status ${f.status})`);
      return `{{NOVALUE:${id}}}`;
    }
    if (headline(path) && f.status !== 'protocol') {
      errors.push(`${path}: fact "${id}" is "${f.status}", not "protocol" — it may not sit in a stat tile or tagline`);
    }
    // Rule 7: a tally counts something that grows and is stale the next
    // commit, so protocol status does not save it in a headline. Found the
    // hard way: a shader-file count passed the protocol check into a tagline,
    // then moved 50 -> 51 within a day.
    if (headline(path) && f.kind === 'tally') {
      errors.push(`${path}: fact "${id}" is a tally — it may only appear on the surface that generates it, never in a stat tile or tagline`);
    }

    // A caveat is part of the value, not documentation about it.
    //
    // This exists because a published model card carried a block-cosine
    // fidelity metric as evidence that 3-bit experts were usable, while the
    // repo's own spec file argued at length that the number could not support
    // that claim. The caveat was written down. Nothing carried it to the
    // surface quoting the number. That value is withdrawn; docs/incidents.md
    // is where it is quoted, framed as retracted.
    //
    // Only a caveat on a NON-protocol fact is binding. A protocol number is
    // reproducible by command, so its caveat is context and may be rendered on
    // request. A single-run or provisional number can be actively misread
    // without its qualification, so it may not travel alone.
    //
    // The distinction matters because a rule that caveats everything trains
    // readers to skip caveats, which is worse than having none.
    const binding = f.caveat && f.status !== 'protocol';
    if (binding) {
      if (headline(path)) {
        errors.push(`${path}: fact "${id}" is "${f.status}" and carries a caveat ("${f.caveat}"); a stat tile or tagline has nowhere to put it`);
        return String(f.value);
      }
      if (!wantsCaveat) {
        errors.push(`${path}: fact "${id}" is "${f.status}" and its caveat must travel with it — write {{fact:${id}+caveat}}`);
        return String(f.value);
      }
    }
    if (f.caveat && wantsCaveat) return `${f.value} (${f.caveat})`;
    if (wantsCaveat && !f.caveat) {
      errors.push(`${path}: fact "${id}" has no caveat, so +caveat is meaningless`);
    }
    return String(f.value);
  });
}

function walk(node, path) {
  if (typeof node === 'string') {
    const out = resolve(node, path);
    // A bare number in a stat tile that did not come from a placeholder is
    // exactly the thing this build exists to prevent. This was a warning
    // until 2026-08-15, and warnings turned out to be a path: 71x, 0.988 and
    // 100% all shipped through it. A tile value is short and always
    // redesignable, so here it is an error.
    if (STAT_CONTEXT.test(path) && !node.includes('{{fact:') && METRIC_DIGIT.test(node)) {
      errors.push(`${path}: literal number "${node}" — not traceable to a fact id; use {{fact:id}} or de-number the tile`);
    }
    // Taglines mix metrics with names (Phi-3, b1.58 2B4T), so a literal
    // number there is a warning, not an error — but it must be seen.
    if (TAGLINE_CONTEXT.test(path)) {
      const stripped = node.replace(/\{\{fact:[^}]+\}\}/g, '');
      if (METRIC_DIGIT.test(stripped)) {
        warnings.push(`${path}: literal number in tagline "${node}" — a tagline is a headline; back it with {{fact:id}} or move it to prose`);
      }
    }
    // A stat LABEL sits inside the tile just like the value, and a shortDesc
    // is prose a card renders verbatim. A supervisor pass found "3.8B params"
    // riding into a tile through its label and an UNBACKED "~86 ms/step" in a
    // shortDesc, while the emitted header claimed every number was traced.
    // Warnings, not errors: prose legitimately carries model specs (3.8B),
    // physics scales (10 keV) and citation years (Karamitros 2011), and a
    // guard that always fires gets bypassed. The point is that nothing rides
    // through unseen.
    if (/^SITES\.[^.]+\.(stats\[\d+\]\.label|shortDesc)$/.test(path)) {
      const stripped = node.replace(/\{\{fact:[^}]+\}\}/g, '');
      if (METRIC_DIGIT.test(stripped)) {
        warnings.push(`${path}: literal number in "${node.slice(0, 70)}" — not traceable to a fact id; back it, move it, or confirm it is a spec/citation`);
      }
    }
    return out;
  }
  if (Array.isArray(node)) return node.map((v, i) => walk(v, `${path}[${i}]`));
  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v, path ? `${path}.${k}` : k)]));
  }
  return node;
}

const built = walk(source, '');

for (const w of warnings) console.log(`WARN   ${w}`);
for (const e of errors) console.log(`ERROR  ${e}`);

const literalStats = warnings.length;
const total = JSON.stringify(source).match(/\{\{fact:/g)?.length ?? 0;
console.log(`\n${total} placeholder(s) resolved; ${literalStats} literal number(s) still un-traced; ${errors.length} error(s)`);

if (errors.length) {
  console.log('\nRefusing to write generated/sites.json.');
  process.exit(1);
}

if (CHECK_ONLY) {
  console.log('--check: no output written.');
  process.exit(0);
}

built._generated = {
  by: 'render/build-sites.mjs',
  warning: 'DO NOT EDIT. Numbers come from facts/facts.json. Editing this file is how three contradictory copies ended up live.',
};

mkdirSync(join(here, 'generated'), { recursive: true });
writeFileSync(join(here, 'generated', 'sites.json'), JSON.stringify(built, null, 2) + '\n');
console.log('wrote render/generated/sites.json');
