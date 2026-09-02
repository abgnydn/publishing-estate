// lens-names.mjs — the canonical reviewers, and the spellings that mean one of
// them.
//
// The gate counts DISTINCT lens names, so two spellings of one lens satisfied a
// two-reviewer rule with one review. Normalising fixes that, and puts the alias
// map on the critical path of a decision — which makes a second copy of it a
// registry problem, not a style problem.
//
// There are exactly two copies, deliberately:
//   - this file, imported by gate/dry-run.mjs and checkers/check-lenses.mjs;
//   - the same map inside the python block of gate/verify-before-publish.sh,
//     because that hook is copied out and installed on its own and must not
//     depend on a checkout being present.
// gate/dry-run.mjs --selftest reads the hook and fails if the two disagree.

// A name outside this set is a typo, not a new lens. A genuinely new lens is
// added here deliberately, which is the point. Two canonical names
// (completeness, rendering) have no definition in lenses/ — they are estate
// roles this repository does not ship; adopters replace this set with their
// own before trusting check-lenses about their ledger.
export const CANONICAL = new Set([
  'refuter', 'reproducer', 'recipient', 'claim-auditor', 'completeness', 'rendering',
]);

export const ALIASES = {
  'rendering-and-mechanics': 'rendering',
  claims: 'claim-auditor',
  'claim-audit': 'claim-auditor',
  reproduction: 'reproducer',
};

export function normalise(lens) {
  const n = String(lens ?? '').trim().toLowerCase().replace(/[_\s]+/g, '-');
  return ALIASES[n] ?? n;
}
