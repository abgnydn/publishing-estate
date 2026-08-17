#!/usr/bin/env bash
# Adversarial + regression suite for gate/verify-before-publish.sh.
# Trigger strings are assembled from fragments so this file itself never
# contains a live trigger for the hook that gates the shell running it.
#
# 32 cases. The first block is the audit corpus: every string in it was a
# working bypass of an earlier version of the gate, found by fuzzing the hook
# itself. Those are regression tests now. The rest prove the legitimate flows
# still work, that the MCP side door is shut, and that the ledger behaves.
#
# The suite runs against a throwaway ledger directory, so it never touches the
# real one and can be run on a machine that has no ledger at all.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
H="$ROOT/gate/verify-before-publish.sh"

# Explicit template: macOS `mktemp -d` with no template ignores TMPDIR and uses
# the per-user Darwin temp dir, which a sandboxed shell may not be able to write.
TMP="$(mktemp -d "${TMPDIR:-/tmp}/publish-gate-test.XXXXXX")" || exit 2
export PUBLISH_LEDGER_DIR="$TMP/ledger"
mkdir -p "$PUBLISH_LEDGER_DIR"
LED="$PUBLISH_LEDGER_DIR"

V="CLAUDE_PUBLISH_""VERIFIED=1"
A="CLAUDE_PUBLISH_""ARTIFACT"
GH="g""h"
WR="wran""gler"
NPM="np""m"

pass=0; fail=0
run() { # run <name> <expect: DENY|ALLOW|PASSLED> <tool> <command>
  local name="$1" expect="$2" tool="$3" command="$4" out decision
  out=$(jq -n --arg t "$tool" --arg c "$command" '{tool_name:$t, tool_input:{command:$c}}' | bash "$H")
  decision=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecision // (if .systemMessage then "ALLOW-MSG" else "ALLOW" end)' 2>/dev/null)
  [ -z "$out" ] && decision="ALLOW"
  local got="ALLOW"
  [ "$decision" = "deny" ] && got="DENY"
  [ "$decision" = "ALLOW-MSG" ] && got="PASSLED"
  if [ "$got" = "$expect" ]; then pass=$((pass+1)); printf 'PASS  %-52s %s\n' "$name" "$got"
  else fail=$((fail+1)); printf 'FAIL  %-52s got=%s want=%s\n' "$name" "$got" "$expect"; fi
}

# artifact + ledger fixtures
ART="$TMP/gate-test-artifact.md"
echo "test artifact $(date +%s)" > "$ART"
SHA=$(shasum -a 256 "$ART" | awk '{print $1}')
mk() { jq -n --arg s "$SHA" --arg p "$ART" --arg l "$1" --arg v "$2" --argjson a "${3:-false}" \
  '{artifact_sha256:$s,artifact_path:$p,lens:$l,verdict:$v,anchored:$a,date:"t",note:"t"}' > "$LED/$SHA-$1.json"; }
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

echo "── the audit corpus: every one of these must DENY ──"
run "quoted flag in body (self-auth hole)"  DENY Bash "$GH issue comment 1 --body \"someone wrote $V in the thread\""
run "flag+artifact quoted in body"          DENY Bash "$GH issue comment 1 --body \"use $V $A=$ART ok\""
run "/markdown inside a body (exemption)"   DENY Bash "$GH issue comment 1 --body \"see /markdown for details\""
run "gh api -f auto-POST"                   DENY Bash "$GH api repos/o/r/issues/1/comments -f body='hi'"
run "gh api --field auto-POST"              DENY Bash "$GH api repos/o/r/issues/1 --field state=closed"
run "gh alias set evasion"                  DENY Bash "$GH alias set ic 'issue comment'"
run "curl github api write"                 DENY Bash "curl -X POST -H auth https://api.github.com/repos/o/r/issues/1/comments -d body=hi"
run "curl github api --data"                DENY Bash "curl https://api.github.com/repos/o/r/comments --data x=y"
run "git push gh-pages"                     DENY Bash "git push origin HEAD:gh-pages"
run "wrangler pages publish variant"        DENY Bash "npx $WR pages publish ./dist"
run "wrangler versions deploy"              DENY Bash "npx $WR versions deploy"
run "IFS obfuscation"                       DENY Bash "$GH\${IFS}issue\${IFS}comment 1 --body hi"
run "verified but NO artifact (old warn)"   DENY Bash "$V $GH issue comment 1 --body hi"
run "gh repo archive now gated"             DENY Bash "$GH repo archive o/r -y"

echo "── MCP side door ──"
run "mcp add_issue_comment"                 DENY  mcp__github__add_issue_comment ""
run "mcp create_pull_request"               DENY  mcp__github__create_pull_request ""
run "mcp issue_write"                       DENY  mcp__github__issue_write ""
run "mcp merge_pull_request"                DENY  mcp__github__merge_pull_request ""
run "mcp get_me (read) allowed"             ALLOW mcp__github__get_me ""
run "mcp search_issues (read) allowed"      ALLOW mcp__github__search_issues ""

echo "── legitimate flows must still work ──"
run "read-only gh api"                      ALLOW Bash "$GH api repos/o/r --jq .description"
run "gh api markdown endpoint (real use)"   ALLOW Bash "$GH api /markdown -f text=hi"
run "gh api rate_limit"                     ALLOW Bash "$GH api /rate_limit --jq .rate"
run "git status"                            ALLOW Bash "git status"
run "plain git push (by design ungated)"    ALLOW Bash "git push -q"
run "unverified publish blocks"             DENY Bash "$GH issue comment 1 --body hi"

echo "── ledger flow ──"
run "anchored flag, 0 ledger entries"       DENY Bash "$V $A=$ART $GH issue comment 1 --body hi"
mk refuter SAFE
run "1 SAFE lens"                           DENY Bash "$V $A=$ART $GH issue comment 1 --body hi"
mk reproducer SAFE
run "2 SAFE but ZERO anchored -> deny"      DENY Bash "$V $A=$ART $GH issue comment 1 --body hi"
mk reproducer SAFE true
run "2 SAFE, 1 anchored -> pass"            PASSLED Bash "$V $A=$ART $GH issue comment 1 --body hi"
mk recipient DO-NOT-POST
run "DO-NOT-POST vetoes 2 SAFEs"            DENY Bash "$V $A=$ART $GH issue comment 1 --body hi"
rm -f "$LED/$SHA-recipient.json"
echo "edited after approval" >> "$ART"
run "edited file -> stale hash blocks"      DENY Bash "$V $A=$ART $GH issue comment 1 --body hi"

echo "── ledger scale: 600 entries under the timeout ──"
# A timed-out hook does not block. The scan was O(3n) subprocesses and would
# have exceeded the harness timeout past ~580 entries, silently disabling the
# gate as the ledger grew. This is the regression test for that.
for i in $(seq 1 600); do
  jq -n --arg s "deadbeef$i" --arg p "/tmp/x$i" \
    '{artifact_sha256:$s,artifact_path:$p,lens:"refuter",verdict:"SAFE"}' > "$LED/deadbeef$i-refuter.json" 2>/dev/null
done
S=$(date +%s)
jq -n --arg c "$V $A=$ART $GH issue comment 1 --body hi" '{tool_name:"Bash",tool_input:{command:$c}}' | bash "$H" >/dev/null
E=$(date +%s)
rm -f "$LED"/deadbeef*-refuter.json
echo "600-entry ledger scan wall time: $((E-S))s (must be well under 10)"

echo
echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
