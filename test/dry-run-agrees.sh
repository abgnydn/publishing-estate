#!/usr/bin/env bash
# Does gate/dry-run.mjs reach the same verdict as gate/verify-before-publish.sh?
#
# The dry run's whole claim is that it is a READOUT of the hook's rule and never
# a second implementation of it. That claim is checkable, so it is checked: the
# same ledger states are put to both, and any disagreement fails here rather
# than surfacing as a publish that was predicted to pass and did not.
#
# Trigger strings are assembled from fragments so this file never contains a
# live trigger for the hook that gates the shell running it. It runs against a
# throwaway ledger directory and never touches a real one.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GH="g""h"
V="CLAUDE_PUBLISH_""VERIFIED=1"
A="CLAUDE_PUBLISH_""ARTIFACT"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/dryrun-agree.XXXXXX") || exit 2
LED="$TMP/ledger"; mkdir -p "$LED"
ART="$TMP/artifact.md"; echo "hello" > "$ART"
SHA=$(shasum -a 256 "$ART" | awk '{print $1}')
trap 'rm -rf "$TMP"' EXIT

mk() { jq -n --arg s "$SHA" --arg p "$ART" --arg l "$1" --arg v "$2" --argjson a "${3:-false}" \
  '{artifact_sha256:$s,artifact_path:$p,lens:$l,verdict:$v,anchored:$a,date:"t",note:"t"}' > "$LED/$SHA-$1.json"; }

hook() {
  jq -n --arg c "$V $A=$ART $GH issue comment 1 --body hi" '{tool_name:"Bash",tool_input:{command:$c}}' \
    | PUBLISH_LEDGER_DIR="$LED" bash "$ROOT/gate/verify-before-publish.sh" \
    | jq -r 'if .systemMessage then "PASS" else "DENY" end'
}
dry() {
  if PUBLISH_LEDGER_DIR="$LED" node "$ROOT/gate/dry-run.mjs" --artifact "$ART" >/dev/null 2>&1
  then echo PASS; else echo DENY; fi
}

agree=0; disagree=0
cmp_() {
  local h d
  h=$(hook); d=$(dry)
  if [ "$h" = "$d" ]; then agree=$((agree+1)); printf 'AGREE     %-34s %s\n' "$1" "$h"
  else disagree=$((disagree+1)); printf 'DISAGREE  %-34s hook=%s dry=%s\n' "$1" "$h" "$d"; fi
}

cmp_ "empty ledger"
mk refuter SAFE;          cmp_ "1 SAFE"
mk reproducer SAFE;       cmp_ "2 SAFE, none anchored"
mk reproducer SAFE true;  cmp_ "2 SAFE, 1 anchored"
mk recipient DO-NOT-POST; cmp_ "DO-NOT-POST present"
rm -f "$LED/$SHA-"*.json
# The two names below are one reviewer. If the hook and the dry run ever stop
# normalising the same way, this is where it shows.
mk claims SAFE true; mk claim-auditor SAFE; cmp_ "two spellings of one lens"
mk reproduction SAFE;     cmp_ "alias plus a real second lens"
rm -f "$LED/$SHA-"*.json
# Whitespace runs collapse in both implementations; a double space or a tab
# must not mint a second reviewer in one readout and not the other.
mk "claim  auditor" SAFE true; mk claim-auditor SAFE; cmp_ "double-space spelling is one reviewer"
mk "claim$(printf '\t')auditor" SAFE; cmp_ "tab spelling is the same lens"
echo edited >> "$ART";    cmp_ "artifact edited after approval"

echo
echo "RESULT: $agree agree, $disagree disagree"
[ "$disagree" -eq 0 ]
