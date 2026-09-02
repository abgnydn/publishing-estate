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
//   - the alias map inside the python block of gate/verify-before-publish.sh,
//     because that hook is copied out and installed on its own and must not
//     depend on a checkout being present. The canonical set lives only here.
// gate/dry-run.mjs --selftest checks the hook's text still carries each alias
// pair; test/dry-run-agrees.sh asserts hook and dry run reach the same verdict
// on the spelling-variant ledger states it covers. Neither compares the two
// normalisation functions symbolically — the agreement suite is the check.

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

// One explicit separator class, written in escapes so no invisible character
// hides in this source, and character-for-character the same set as the
// python copy in the hook. JS \s and python \s disagree at the edges
// (U+0085, U+001C, U+FEFF), which was enough to let a BOM inside a lens name
// mint a second reviewer in one implementation and not the other.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters ARE the point - the class is deliberately explicit so both copies match the same set
const SEPARATORS =
  /[_\t\n\v\f\r \u001c-\u001f\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/g;

export function normalise(lens) {
  const n = String(lens ?? '')
    .toLowerCase()
    .replace(SEPARATORS, '-')
    .replace(/^-+|-+$/g, '');
  return ALIASES[n] ?? n;
}
