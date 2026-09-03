# publishing-estate

Tooling for one person who publishes technical claims on many surfaces and
wants none of them to go quietly wrong.

It keeps two rules:

1. **A number reaches a public surface only through a registry id.** Every
   figure lives in one file with a status, a caveat and the command that
   produced it; pages are rendered from placeholders, and a hand-typed number in
   a stat tile fails the build.
2. **Nothing irreversible ships on one context's judgement.** Before a publish
   command runs, independent review agents must have written SAFE verdicts
   against the exact bytes, and at least one verdict must be anchored to
   something executed rather than read.

Three mechanisms enforce them:

| mechanism | what it does | where |
|---|---|---|
| registry + render gate | one source for every number; refuses a withdrawn or unbacked value at build time | `facts/`, `render/` |
| checker fleet | asks what is true *right now* on surfaces already published: drift, orphaned numbers, undeployed fixes, stale notes, broken CI, and the verifier itself | `checkers/` |
| lenses + ledger + hook | adversarial reviewers write sha256-bound verdicts; a PreToolUse hook denies any publish command without the quorum | `lenses/`, `gate/` |

Every mechanism was added after something went wrong. The list is in
[`docs/incidents.md`](docs/incidents.md).

## Quickstart

Plain Node ESM, no install step. `jq`, `python3`, `shasum` and `bash` for the
gate; `git` and the `gh` CLI for three of the checkers (they report
UNREACHABLE when one is missing).

```
git clone https://github.com/abgnydn/publishing-estate && cd publishing-estate

node facts/check-facts.mjs                    # the registry's own rules
node render/build-sites.mjs --check           # the render gate, dry run
node checkers/check-orphans.mjs --selftest    # any checker proves itself first
node checkers/check-orphans.mjs --config checkers/estate.example.json
bash test/hook-test.sh                        # the publish gate's regression suite
node gate/dry-run.mjs --artifact README.md    # the verdict without the publish
```

Each checker's `--selftest` plants a defect it must see and ends with a fault
case in which broken input hard-fails instead of sweeping. The example config
points at fixtures, so everything above runs offline.

## What is in the repo

| path | contents |
|---|---|
| `facts/facts.json`, `facts/check-facts.mjs` | the registry and its checker |
| `render/build-sites.mjs`, `render/sites.source.json` | the render gate and a placeholder-only source document |
| `checkers/check-*.mjs`, `checkers/estate.example.json` | six checkers, config-out, with fixtures |
| `lenses/*.md`, `lenses/platforms.json` | four reviewer definitions and per-platform posting rules |
| `gate/verify-before-publish.sh`, `gate/dry-run.mjs`, `gate/lens-names.mjs` | the hook, its readout, and the shared lens-name normaliser |
| `test/` | the gate's regression suite and the hook/dry-run agreement suite |
| `docs/design.md` | the full reference: rules, statuses, example runs, evidence, limitations |
| `docs/checker-pattern.md` | the five properties every checker converged on |
| `docs/incidents.md` | incident → mechanism, one row each |
| `docs/tiers.md` | the model/effort policy for pipeline agents and lenses |
| `docs/story.md` | where this came from and how it has been checked |

## Adopting it

Adopt a mechanism because you recognise its incident, not because it is here.

1. **Registry first.** Copy `facts/` and add one entry for every number on any
   surface you own. Most will start `unbacked`; that is the finding.
2. **Render gate.** Copy `render/build-sites.mjs`, adapt the three context
   patterns to your source document, replace every literal number with a
   `{{fact:id}}` placeholder, and run `--check` in CI or a pre-commit hook.
3. **Fleet.** Copy `checkers/estate.example.json` to `estate.json` and point it
   at your surfaces. Build the two classes that check what is *live* rather
   than what is in git — they are described in `docs/checker-pattern.md` and
   not shipped, because they are mostly one person's surfaces.
4. **Lenses and gate.** Start with `refuter` and `reproducer`. Pin their model
   and effort in the definitions (`docs/tiers.md`). Install
   `gate/verify-before-publish.sh` as a PreToolUse hook, run
   `bash test/hook-test.sh`, then fuzz it yourself — the first audit of this
   one found bypasses within the hour.
5. **Platform rules.** Write `lenses/platforms.json` from your own posting
   record. Mark what you have not checked `unaudited`.

## Limits worth knowing before you rely on it

The command matcher is a denylist, and denylists are fragile. The lenses share
a model family. There is no egress boundary and no multi-user story. Audience
simulation is advisory only. The full list, with the evidence behind each, is
in [`docs/design.md`](docs/design.md#5-limitations).

## License

MIT. See [LICENSE](LICENSE).
