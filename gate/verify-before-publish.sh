#!/usr/bin/env bash
# PreToolUse guard: block actions that publish under the operator's name unless
# multi-agent adversarial verification is on record for the exact bytes.
#
# Install as a PreToolUse hook on Bash (and on the MCP tool namespace, if the
# harness passes those through). It reads the tool-call payload on stdin and
# writes a permission decision on stdout.
#
# Configuration, all optional:
#   PUBLISH_LEDGER_DIR       where lens verdicts are written. Default:
#                            $HOME/.claude/verify-ledger
#   PUBLISH_REQUIRED_LENSES  distinct SAFE lenses required. Default: 2
#
# Override (only form):
#   CLAUDE_PUBLISH_VERIFIED=1 CLAUDE_PUBLISH_ARTIFACT=/path/to/artifact <command>
# The prefix must be at the START of the command. The hook hashes the artifact
# and requires ledger entries from at least PUBLISH_REQUIRED_LENSES distinct
# lenses, all SAFE, for that exact hash, at least one of them anchored to
# external evidence. Editing the file after verification changes the hash and
# revokes the approval. For an action with no natural file (archiving a repo,
# editing a description), write an action manifest describing exactly what will
# be done, have the lenses verify THAT, and pass its path.
#
# Hardened 2026-08-16 after an adversarial audit of this hook found:
#   - the flag was matched as a SUBSTRING of the whole command, so the string
#     "CLAUDE_PUBLISH_VERIFIED=1" quoted inside a comment body (i.e. inside
#     untrusted content a lens quotes) self-authorized the gate;
#   - the /markdown exemption was a substring match over the entire command,
#     so any publish whose BODY mentioned /markdown was exempt;
#   - a bare assertion with no artifact was allowed with a warning, which made
#     the ledger optional;
#   - `gh api -f body=...` auto-switches to POST and was unmatched;
#   - the stale-hash scan spawned ~3 processes per ledger file; past ~580
#     files it would exceed the hook timeout, and a timed-out hook does not
#     block — the gate would silently disable itself as the ledger grew.
# Known residual (documented, not solved here): shell obfuscation is a
# denylist problem and denylists are fragile; the durable answer is
# canonicalization and an egress boundary. See docs/incidents.md and the
# Limitations section of the README.
#
# Rationale: docs/incidents.md

set -uo pipefail
shopt -s nullglob

ledger_dir="${PUBLISH_LEDGER_DIR:-$HOME/.claude/verify-ledger}"
required_lenses="${PUBLISH_REQUIRED_LENSES:-2}"
mkdir -p "$ledger_dir" 2>/dev/null

payload=$(cat)
tool=$(printf '%s' "$payload" | jq -r '.tool_name // empty' 2>/dev/null)

deny() {
  jq -n --arg r "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $r
    }
  }'
  exit 0
}

# ------------------------------------------------------------------ MCP path
# GitHub MCP write tools publish without ever touching Bash, so a Bash-only
# matcher is a gate with an open side door. MCP writes are denied outright and
# routed to the gh CLI, where the ledger flow applies. Reads pass.
if [ "$tool" != "Bash" ]; then
  case "$tool" in
    mcp__github__*)
      case "$tool" in
        *add_*|*create_*|*update_*|*merge_*|*delete_*|*push_*|*_write|*fork_*|*request_*|*run_secret_scanning*)
          deny "BLOCKED: ${tool} publishes to GitHub without passing the publish gate.

Use the gh CLI for this action instead - the verification ledger flow applies
there. MCP write tools have no override path by design." ;;
      esac
      ;;
  esac
  exit 0
fi

cmd=$(printf '%s' "$payload" | jq -r '.tool_input.command // empty' 2>/dev/null)
[ -z "$cmd" ] && exit 0

# --------------------------------------------------------- verification flag
# ANCHORED: the env-assignment prefix must open the command. A quoted
# occurrence anywhere else - e.g. inside a --body that quotes hostile content -
# never authorizes. The hook's own env is also honored (deploy tooling).
verified=""
prefix=$(printf '%s' "$cmd" | grep -oE '^[[:space:]]*([A-Z_]+=("[^"]*"|'\''[^'\'']*'\''|[^[:space:]]*)[[:space:]]+)+' || true)
case "$prefix" in
  *CLAUDE_PUBLISH_VERIFIED=1*) verified="1" ;;
esac
[ "${CLAUDE_PUBLISH_VERIFIED:-}" = "1" ] && verified="1"

# Artifact path: parsed ONLY from the anchored prefix region, or the hook env.
artifact="${CLAUDE_PUBLISH_ARTIFACT:-}"
if [ -z "$artifact" ] && [ -n "$prefix" ]; then
  artifact=$(printf '%s' "$prefix" \
    | grep -oE "CLAUDE_PUBLISH_ARTIFACT=(\"[^\"]*\"|'[^']*'|[^[:space:]]+)" \
    | head -1 \
    | sed -E 's/^CLAUDE_PUBLISH_ARTIFACT=//; s/^["'"'"']//; s/["'"'"']$//')
fi
case "$artifact" in
  "~/"*) artifact="$HOME/${artifact#\~/}" ;;
esac

matched=""
check() {
  [ -n "$matched" ] && return 0
  if printf '%s' "$cmd" | grep -Eq "$1"; then
    matched="$2"
  fi
}

# Read-only gh api exemption, ENDPOINT-POSITION only: the first non-flag
# argument after `gh api` must itself be the render/report endpoint. A body
# that merely mentions /markdown does not qualify.
if printf '%s' "$cmd" | grep -Eq "gh[[:space:]]+api[[:space:]]+(-[^[:space:]]+[[:space:]]+)*[\"']?/?(markdown|rate_limit)[\"']?([[:space:]?/]|$)"; then
  exit 0
fi

check 'gh[[:space:]]+issue[[:space:]]+(comment|create|edit|close|reopen)'        'gh issue write'
check 'gh[[:space:]]+pr[[:space:]]+(comment|create|review|merge|edit|close)'     'gh pr write'
check 'gh[[:space:]]+release[[:space:]]+(create|edit|upload|delete)'             'gh release write'
check 'gh[[:space:]]+repo[[:space:]]+(edit|archive|unarchive|create|delete|rename)' 'gh repo write'
check 'gh[[:space:]]+api[[:space:]].*(-X|--method)[[:space:]]+(POST|PATCH|PUT|DELETE)' 'gh api write'
# gh api auto-switches to POST when request parameters are supplied - no -X
# needed. Any field/input flag makes an api call a write.
check 'gh[[:space:]]+api[[:space:]].*[[:space:]](-f|-F|--field|--raw-field|--input)([[:space:]]|=)' 'gh api write (auto-POST)'
check 'gh[[:space:]]+alias[[:space:]]+set'                                       'gh alias set (matcher evasion shape)'
check 'curl[[:space:]].*api\.github\.com.*(-X[[:space:]]*(POST|PATCH|PUT|DELETE)|--data|[[:space:]]-d[[:space:]]|[[:space:]]-F[[:space:]])' 'curl github write'
check 'git[[:space:]]+push.*gh-pages'                                            'git push gh-pages'
check 'hf[[:space:]]+upload.*--create-pr'                                        'hf upload --create-pr'
check 'huggingface-cli[[:space:]]+upload'                                        'huggingface-cli upload'
check '(npm|pnpm|yarn)[[:space:]]+publish'                                       'package publish'
check 'wrangler[[:space:]]+(pages[[:space:]]+)?(deploy|publish|versions[[:space:]]+deploy)' 'wrangler deploy'
check 'vercel[[:space:]].*--prod'                                                'vercel --prod'
check '\$\{IFS\}'                                                                'IFS obfuscation (matcher evasion shape)'

[ -z "$matched" ] && exit 0

standing_rule="Standing rule: run multi-agent adversarial verification BEFORE publishing, not after.

Use distinct lenses, not repeated general reviews:
  1. adversarial technical  - told to default to \"this claim is wrong\"
  2. independent reproduction - actually run the commands and execute the snippet
  3. recipient perspective  - read as each person who gets the notification
  4. completeness critic    - what is missing, stale, superseded, already said
  5. rendering and mechanics - how it renders, do links resolve, does step 1 work

Give each agent the artifact only, never the prior findings. At least one must
execute rather than inspect: every defect that survived multiple passes was
caught by running something.

Also check what a reader finds by clicking through - stale drafts, retracted
claims, numbers that contradict what is being published."

# ---------------------------------------------------------------- unverified
if [ -z "$verified" ]; then
  deny "BLOCKED: this publishes under your name (matched: ${matched}).

${standing_rule}

When verification has run and the lenses have written their ledger entries,
re-run with the prefix AT THE START of the command:
  CLAUDE_PUBLISH_VERIFIED=1 CLAUDE_PUBLISH_ARTIFACT=/path/to/artifact <command>

For an action with no natural file, write an action manifest describing it,
verify that, and pass its path."
fi

# ------------------------------------------- verified, but no artifact named
# There is no assertion-only path. An unchecked assertion is not verification.
if [ -z "$artifact" ]; then
  deny "BLOCKED: this publishes under your name (matched: ${matched}).

CLAUDE_PUBLISH_VERIFIED=1 was given without CLAUDE_PUBLISH_ARTIFACT. The
assertion-only path was removed: it made the ledger optional, and an audit
showed the flag could even be triggered by quoted untrusted content.

Name the exact file being published (or an action manifest for file-less
actions), have >=${required_lenses} lenses write SAFE ledger entries for its
hash, then re-run:
  CLAUDE_PUBLISH_VERIFIED=1 CLAUDE_PUBLISH_ARTIFACT=/path/to/artifact <command>"
fi

# ------------------------------------------------- verified with an artifact
if [ ! -f "$artifact" ]; then
  deny "BLOCKED: this publishes under your name (matched: ${matched}).

CLAUDE_PUBLISH_ARTIFACT points at a file that does not exist:
  ${artifact}"
fi

sha=$(shasum -a 256 "$artifact" 2>/dev/null | awk '{print $1}')
if [ -z "$sha" ]; then
  deny "BLOCKED: this publishes under your name (matched: ${matched}).

Could not hash the artifact: ${artifact}"
fi

# One pass over the whole ledger in a single process. The per-file-jq version
# was O(3n) subprocesses; past ~580 entries it would blow the hook timeout,
# and a timed-out hook does not block.
ledger_scan=$(python3 - "$ledger_dir" "$sha" "$artifact" <<'PY'
import json, pathlib, sys
d, sha, art = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
safe, bad, stale, skipped, anchored = [], [], [], [], []
for f in sorted(d.glob("*.json")):
    try:
        e = json.loads(f.read_text())
    except Exception:
        skipped.append(f"{f.name}: not valid JSON"); continue
    esha, lens, verdict = e.get("artifact_sha256"), e.get("lens"), e.get("verdict")
    if f.name.startswith(sha + "-"):
        if esha != sha:
            skipped.append(f"{f.name}: artifact_sha256 does not match its filename"); continue
        if not lens or not verdict:
            skipped.append(f"{f.name}: missing lens or verdict"); continue
        if verdict == "SAFE":
            if lens not in safe: safe.append(lens)
            if e.get("anchored") is True and lens not in anchored: anchored.append(lens)
        elif verdict == "DO-NOT-POST":
            bad.append(lens)
        else:
            skipped.append(f"{f.name}: unknown verdict '{verdict}'")
    elif e.get("artifact_path") == art and esha and esha != sha:
        stale.append(lens or "?")
print(json.dumps({"safe": safe, "bad": bad, "stale": sorted(set(stale)), "skipped": skipped, "anchored": anchored}))
PY
) || ledger_scan='{"safe":[],"bad":[],"stale":[],"skipped":["ledger scan failed"]}'

safe_lenses=$(printf '%s' "$ledger_scan" | jq -r '.safe | join(" ")')
bad_lenses=$(printf '%s' "$ledger_scan" | jq -r '.bad | join(" ")')
stale_lenses=$(printf '%s' "$ledger_scan" | jq -r '.stale | join(" ")')
n_safe=$(printf '%s' "$ledger_scan" | jq -r '.safe | length')
n_anchored=$(printf '%s' "$ledger_scan" | jq -r '.anchored // [] | length')
skipped=$(printf '%s' "$ledger_scan" | jq -r '.skipped[]? | "  - " + .')

skipped_block=""
[ -n "$skipped" ] && skipped_block="
Malformed ledger files were skipped:
${skipped}"

if [ -n "$bad_lenses" ]; then
  deny "BLOCKED: this publishes under your name (matched: ${matched}).

A verification lens recorded DO-NOT-POST for this exact artifact.
  artifact: ${artifact}
  sha256:   ${sha}
  DO-NOT-POST from: ${bad_lenses}
  SAFE from: ${safe_lenses:-(none)}

Fix the defect, then re-verify. The new file has a new hash, so the old
DO-NOT-POST stops applying once the text actually changes.
${skipped_block}
${standing_rule}"
fi

if [ "$n_safe" -lt "$required_lenses" ]; then
  detail=""
  if [ -n "$stale_lenses" ]; then
    detail="Ledger entries exist for this path but for a DIFFERENT hash, from: ${stale_lenses}
The file was edited after it was verified. An approval covers the exact bytes
that were reviewed, so it does not carry over. Re-run those lenses."
  elif [ "$n_safe" -eq 0 ]; then
    detail="No ledger entries at all for this hash. No lens has verified this file."
  else
    detail="Only ${n_safe} distinct lens with a SAFE verdict: ${safe_lenses}
${required_lenses} distinct lenses are required."
  fi
  deny "BLOCKED: this publishes under your name (matched: ${matched}).

  artifact: ${artifact}
  sha256:   ${sha}
  ledger:   ${ledger_dir}/${sha}-<lens>.json

${detail}
${skipped_block}
${standing_rule}"
fi

# Quorum lesson from the 2026-08 verification survey: four same-family lenses
# carry ~1.7 effective votes, and a SAFE is absence-of-evidence from a lens
# whose measured defect recall is poor. Counting SAFEs is therefore not enough:
# at least one must be ANCHORED -- a verdict whose note cites execution output,
# a primary source, or file:line evidence ("anchored": true in the entry).
# Reading-only agreement, however unanimous, does not clear the gate.
if [ "$n_anchored" -lt 1 ]; then
  deny "BLOCKED: this publishes under your name (matched: ${matched}).

  artifact: ${artifact}
  sha256:   ${sha}

${n_safe} SAFE lens(es) on record, but NONE is anchored to external evidence
(execution output, a fetched primary source, file:line). Reading-based
agreement between same-family lenses is close to one opinion counted twice.
At least one SAFE must come from a lens that ran or fetched something --
normally the reproducer or the refuter -- with \"anchored\": true in its entry.
${skipped_block}
${standing_rule}"
fi

pass_note=""
[ -n "$skipped" ] && pass_note=" [skipped malformed ledger file(s)]"
jq -n --arg m "verify-before-publish: passed - ${n_safe} SAFE lenses on record for ${artifact} (${sha:0:12}): ${safe_lenses}${pass_note}" '{systemMessage: $m}'
exit 0
