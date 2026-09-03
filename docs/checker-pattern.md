# The checker pattern

The shape every checker in the fleet converged on, and the incident each
property answers. The six shipped sources are described in
[../checkers/README.md](../checkers/README.md).

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
what keeps a gate on: ERROR where a number is read as a claim, WARN in the
tagline, stat-label and short-description fields, which legitimately carry
model specs and citation years.

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
property is real and the incident behind it is in `incidents.md`; the code
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
in `incidents.md` that survived longest was live-only.
