# The checker fleet

Six checker sources ship here, curated. The pattern essay below is what
survived from the version of this file that shipped no source at all, and it is
still the more useful half: the code is one estate's answer, the shape is
everyone's.

The registry (`facts/facts.json`) and the render gate (`render/build-sites.mjs`)
stop a wrong number from reaching a *new* surface. The checker fleet is the
other half: surfaces that were published before the fact changed, and surfaces
nothing in the pipeline owns. A build gate protects the future. A checker asks
what is true right now.

## What "curated" means

The live fleet is bound to one person's accounts, domains and checkouts. Ported
verbatim it would be files of someone else's configuration. Two kinds of thing
came out on the way here — configuration and surfaces — and a short list of
machine-side machinery went with them. What is here is not a strict subset of
what runs: each shipped checker also gained a fault case.

**Config-out.** No checker names a surface, an account, a checkout path, a port
or a schedule. The only hostnames in the sources are the public API endpoints
they query. Every one of them reads
[`estate.example.json`](estate.example.json) through
[`config.mjs`](config.mjs), or takes the one or two paths it needs as
arguments. Copy the example to `estate.json`, point it at your own surfaces,
and the checkers work unchanged — except `check-lenses.mjs`, which reads it
only when passed `--config` and otherwise resolves its ledger from the
environment.

**Surfaces-out.** The example config points at
[`fixtures/`](fixtures/) rather than at anything live, so the shipped example
sweeps offline on any clone and demonstrates each rule firing. Where a section
would have had to carry someone's account name it is empty instead — and an
empty section is a hard failure, not a clean run.

What did **not** cross over: the fleet runner and its cron glue, the per-surface
snapshot diffing and its dismissal file, and the `--quiet` flag. The first two
are machine state; the third existed for a runner that does not ship here, and
its incident is recorded in [`../docs/incidents.md`](../docs/incidents.md)
rather than reproduced in code.

## The shape

Five properties recur across the fleet. None was designed in; each was added
after a sweep failed in a way that looked like success.

### 1. Selftests inside the checker

`--selftest` plants known findings and asserts the real classifier reports them.
The failure being defended against is a broken sweep printing a clean sheet on a
scheduled run nobody is watching — which is why the selftest ships inside the
checker itself rather than as a suite to remember to run. In this directory it
is a separate command that runs and exits; only `facts/check-facts.mjs` runs its
self-check in the same process as the sweep, ahead of `--verify-cheap`. Wiring
`--selftest` into every shipped sweep is open work.

Every checker here carries one, and every one of them ends with the **fault
case**: a missing config, a malformed config or a config naming nothing to
check must HARD-FAIL rather than sweep, and an unreadable ledger entry or an
unreadable workflow file must surface as a finding rather than be silently
dropped. That rule exists because three checkers once ran with a flag that
routed their findings through the suppressed output channel, and one had never
successfully reported in any scheduled sweep at all. Nothing noticed, because a
broken sweep and a clean one produce the same output.

The corollary is a rule about output channels: **a finding never travels through
an optional one.** A checker that exits non-zero with empty stdout is reported
as broken by any runner reading exit codes — correctly — and the real finding
never arrives.

### 2. Positive controls on every sweep

A sweep that reports zero findings is indistinguishable from a sweep that is
broken. This estate shipped one: an unquoted shell variable fed the search tool
one bogus path, it errored into `/dev/null`, and the run reported "0 hits" for
every pattern — including strings that were definitely present. It passed while
completely broken.

The rule that came out of it: **treat any reported verification without a
positive control as unverified.** A sweep must be able to demonstrate that it
can find a string known to be present. Each selftest here contains at least one
case whose only job is that demonstration; in the shipped checkers it runs
under `--selftest` rather than during the sweep.

### 3. UNREACHABLE is not a pass

The single most important line in the fleet. Offline, an expired token, a moved
checkout, a 404, a rate limit — none of these is evidence that the number is
still right. They are a separate outcome and they are reported as such:

```
UNREACHABLE  <id>  cheap produced_by did not run, so this fact is UNVERIFIED (not agreed)
```

A checker that folds network failure into "clean" trains you to trust a green
run that means nothing. A checker that folds it into "drift" trains you to
ignore findings. It is a third category, and it stays a third category.

`check-reach.mjs` is the sharpest case, because it is the one checker whose
subject is a count. A source that did not answer must never become a zero: a
missing number and a real zero mean opposite things there, and conflating them
makes a quiet week look like a dead project.

### 4. Graded severity, and a per-finding tolerance that is declared

A guard that always fires gets bypassed. A comparable public gate, found in
the author's unpublished survey of the space, was switched off by its own
author for noise. Grading is
what keeps a gate on: ERROR where a number is read as a claim, WARN where prose
legitimately carries model specs and citation years.

`check-orphans.mjs` grades by ranking rather than filtering. A number beside a
unit is claim-shaped and sorts to the top; a number beside "followers" is
somebody else's page furniture and sorts to the bottom. Both are printed, so
nothing is silently dropped, and every benign rule states what it excuses and
why — because a silent exclusion is how a sweep passes while blind.

The same logic applies to drift. A fact backed by a live counter moves daily,
and a finding that fires every sweep is noise. Such a fact declares
`drift_tolerance_pct` — within the band it is a dated snapshot doing its job,
beyond it the published snapshot has become misleadingly stale. Exact comparison
stays the default. The tolerance is per-fact, by declaration, never global.

### 5. Deltas, with a seeded baseline

The watchers (threads, downloads, DOI versions) report only what moved since the
last run. First sight of an object seeds the baseline silently and reports
nothing. Otherwise the first run reports everything and is therefore read once
and never again.

Two of these need a state file for a reason that is not obvious: a concept DOI
always resolves to a paper's *current* version, so a paper can be revised — an
erratum retiring a published figure — and every surface citing it expires with
no visible change anywhere. The only way to see it is to remember what the DOI
resolved to last time.

This is the one property the curated fleet does not demonstrate. A state file is
machine state, so the snapshot half of `check-orphans.mjs` was left behind. The
property is real and the incident behind it is in `docs/incidents.md`; the code
for it is not here.

## The classes

One line per class, with the incident each answers. Seven classes ship: the
six marked **Ships.** are in this directory, and `facts` ships from
`facts/check-facts.mjs`.

| class | watches for | born from |
|---|---|---|
| **facts** | rule violations in the registry; re-runs every cheap `produced_by` behind a sabotage-proof self-check. *Ships, as `facts/check-facts.mjs`.* | a shader-file count that drifted 50→51 in a day and was caught only because someone happened to re-run it by hand |
| **orphans** | claim-shaped numbers on a live surface with no id at all, and one quantity published at two different values across two surfaces. **Ships.** | every defect found in one afternoon's manual read of the profile surfaces was unregistered, so none could drift, so none was reported |
| **deployed** | built output that never shipped, by sentinel rather than by body hash. **Ships.** | a fix committed and pushed and still not live, while every local copy was "fixed" |
| **memory** | withdrawn values, registry disagreements and stale git claims in the prose notes a session reads back as current. **Ships.** | a note asserting a repository was "7 commits unpushed" — true when written, a claim about right now when read |
| **ci** | a pipeline that is absent, that races the tests instead of waiting for them, or that reports success having skipped. **Ships.** | a deploy triggered on the same push as the tests, whose missing secret made it exit 0 having done nothing |
| **reach** | whether any of it is landing: archival record views, repository stars, model-hub downloads. **Ships.** | the preprints travelled while the runnable software records sat in single digits, invisible until someone went looking |
| **lenses** | the verifier read as a surface: split quorums, serial runs, SAFE verdicts with no evidence behind them. **Ships.** | a lens-name typo counted as a second distinct reviewer, so one review satisfied a two-review quorum |
| **copies** | any baked consumer copy behind the authority | four manual resyncs of one file in one day; consuming repos read their own stale copy and nothing read it back |
| **numbers** | published claims re-fetched from the surface and compared against a manifest, including client-rendered DOM via a headless browser | a site publishing four different rates that `curl` could not see, because they were rendered in JS |
| **withdrawn** | retracted values still live on any page, social card or model card — bare, comma-grouped and unit-formed | a withdrawn average living on a page comma-grouped, which a bare grep for the bare digits never matched |
| **dois** | DOIs that fail to resolve, version pins where a concept DOI belongs, and papers that moved to a new version | a site quoting figures its own papers' errata had retired |
| **archives** | archival records materially behind the code they claim to archive | a flagship whose citable record was hundreds of commits stale |
| **sites** | liveness, plus the SPA-fallback-served-as-`immutable` failure class | a missing asset frozen at the edge as HTML for a year, status 200 the whole time |
| **threads** | deltas on watched threads and reactions on your own comments | replies landing unseen for days |
| **identity** | JSON-LD `Person` consistency, ORCID gaps, email uniformity across citation files | a dozen published identities and no path from any of them to the papers |
| **hf** | model-hub downloads, likes, and discovery metadata that silently hides a model | an untagged model invisible to task-filtered browse, which is how most people find models |

**numbers** and **withdrawn** are the two worth building first if you build any,
and they are the two that did not survive curation — both are almost entirely a
list of one person's surfaces and one person's retracted values. They are the
two that check what is *live* rather than what is *in git*, and every incident
in `docs/incidents.md` that survived longest was live-only.

## Running them

Every checker proves itself before it is trusted:

```
$ node checkers/check-orphans.mjs --selftest
ok   planted orphan is caught
ok   registered value is excused
...
ok   a config with zero surfaces is fatal
```

The first line here is the positive control and the last is the fault case.
Every selftest in this directory contains both: at least one case whose only job
is to prove the checker can still see a planted defect, and a closing block in
which broken input hard-fails instead of sweeping.

Then the shipped example, which sweeps the two fixture surfaces. Context
strings are elided at both ends by the checker itself:

```
$ node checkers/check-orphans.mjs --config checkers/estate.example.json
== 2 surface(s), 8 registered value(s)

── fixture:site ──
UNREGISTERED    592          …ne. It ships 51 files of hand-written WGSL. Measured across 592 devices during the June round. Published 2026-08-17 as v1.2…

── fixture:profile ──
unregistered?   1,204        …machine. Measured across 119 devices during the June round. 1,204 followers · 87 connections…
unregistered?   119          …ns at 69.55 tok/s on the reference machine. Measured across 119 devices during the June round. 1,204 followers · 87 connect…
unregistered?   87           …across 119 devices during the June round. 1,204 followers · 87 connections…

── one quantity, two values, across surfaces ──
CROSS-SURFACE  device                 119 vs 592  [fixture:site, fixture:profile]

1 claim-shaped unregistered number(s), 1 cross-surface contradiction(s), across 2 readable surface(s)
```

Exit 1. Everything worth reading is in the grading. The registered 51 and 69.55
are excused outright. The bundle hash inside a `<script>` block is never read.
The follower and connection counts are printed but ranked to the bottom as
somebody else's page furniture, and 592 — beside a unit, on a page that is
making a claim — is the one thing raised to `UNREGISTERED`. Nothing was dropped
to get there. And the two fixtures disagree about one quantity in the way two
real surfaces do.

`check-memory.mjs` on the same config fires on the planted note and stays quiet
on the same value inside its own retraction two lines below it, which is the
guard that makes the rule usable rather than noise:

```
$ node checkers/check-memory.mjs --config checkers/estate.example.json
RETIRED      zerotvm.md:10                      carries 2865, withdrawn as kernelfusion.apple_avg_2865x
             …- The kernel work reached 2865x end to end on the Apple parts.…
FACT-DRIFT   zerotvm.md:9                       says 52 files; registered: zerotvm.wgsl_files=51
             …- It ships 52 files of hand-written WGSL today.…

1 note file(s) read against 8 registered fact(s); 2 finding(s)
```

`check-deployed.mjs`, `check-reach.mjs` and `check-lenses.mjs` refuse to run
against the shipped example, because it configures no deployed url, no accounts
and no ledger:

```
$ node checkers/check-reach.mjs --config checkers/estate.example.json
CONFIG  the "reach" section names no zenodo record, github user or huggingface author — there is nothing to ask about, which is not a report of no reach
```

Exit 2. That is the point, and it is what the fault case is for: a checker that
prints a clean sheet because it had nothing to look at is the failure the whole
fleet exists to prevent.

Three properties of a runner matter, if you build one:

- A missing checker is skipped, not an error. The fleet grows and shrinks.
- Each checker owns its own state file, next to itself.
- The runner never edits anything. Registry rule 5 says a value changes by
  re-running `produced_by`; deciding that a new number is the right one to
  publish is a judgement, so the checker reports and a person decides.

The cheap pass is affordable weekly. The expensive pass re-runs real GPU
benchmarks and a test suite that takes minutes on its own, so it is run by hand.
The split is declared per fact in the registry (`cost: "cheap" | "expensive"`)
and is measured, not guessed: in the author's full registry, one test-count fact
touches no GPU at all and is expensive anyway.
