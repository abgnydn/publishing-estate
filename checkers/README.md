# The checker fleet

Pattern only. No checker source ships here.

The ten checkers this pattern describes are bound to one person's surfaces: a
named GitHub account, thirteen live domains, a specific HuggingFace user, a
specific set of watched threads. Ported to your estate they would be ten files
of someone else's configuration, and the useful part is not the code. The
useful part is the shape every one of them converged on, and the incident each
one exists to answer. Both are below.

The registry (`facts/facts.json`) and the render gate (`render/build-sites.mjs`)
stop a wrong number from reaching a *new* surface. The checker fleet is the
other half: surfaces that were published before the fact changed, and surfaces
nothing in the pipeline owns. A build gate protects the future. A checker asks
what is true right now.

## The shape

Every checker in the fleet ended up with the same five properties. They were not
designed in; each was added after a sweep failed in a way that looked like
success.

### 1. Selftests first, in the same process

`--selftest` plants known findings and asserts the real classifier reports them,
then the real run proceeds. It runs *before* the sweep, not as a separate test
command, because the failure being defended against is a broken sweep printing a
clean sheet on a scheduled run nobody is watching.

`facts/check-facts.mjs` ships this and it is runnable:

```
$ node facts/check-facts.mjs --verify-cheap
```

Its `selfCheck()` plants three cases — a mismatch, a match, and a command that
exits non-zero — and pushes each through `runAndCompare()`, the same function
the real facts go through. If any of the three is misread it prints
`SELF-CHECK FAILED` and exits 2 without touching a real fact. A drift detector
that cannot detect a planted drift has no business reporting on real numbers.

### 2. Positive controls on every sweep

A sweep that reports zero findings is indistinguishable from a sweep that is
broken. This estate shipped one: an unquoted shell variable fed the search tool
one bogus path, it errored into `/dev/null`, and the run reported "0 hits" for
every pattern — including strings that were definitely present. It passed while
completely broken.

The rule that came out of it: **treat any reported verification without a
positive control as unverified.** A sweep must demonstrate, in the same run,
that it can find a string known to be present.

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

### 4. Graded severity, and a per-finding tolerance that is declared

A guard that always fires gets bypassed. The other public implementation of an
unbacked-number gate was switched off by its own author for noise. Grading is
what keeps a gate on: ERROR where a number is read as a claim, WARN where prose
legitimately carries model specs and citation years.

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

## The classes

One page per class, with the incident each answers.

| class | watches for | born from |
|---|---|---|
| **facts** | rule violations in the registry; re-runs every cheap `produced_by` behind a sabotage-proof self-check | a shader-file count that drifted 50→51 in a day and was caught only because someone happened to re-run it by hand |
| **copies** | any baked consumer copy behind the authority | four manual resyncs of one file in one day; consuming repos read their own stale copy and nothing read it back |
| **numbers** | published claims re-fetched from the surface and compared against a manifest, including client-rendered DOM via a headless browser | a site publishing four different rates that `curl` could not see, because they were rendered in JS |
| **withdrawn** | retracted values still live on any page, social card or model card — bare, comma-grouped and unit-formed | a withdrawn average living on a page comma-grouped, which a bare grep for the bare digits never matched (`docs/incidents.md`) |
| **dois** | DOIs that fail to resolve, version pins where a concept DOI belongs, and papers that moved to a new version | a site quoting figures its own papers' errata had retired |
| **archives** | archival records materially behind the code they claim to archive | a flagship whose citable record was 251 commits stale |
| **sites** | liveness, plus the SPA-fallback-served-as-`immutable` failure class | a missing asset frozen at the edge as HTML for a year, status 200 the whole time |
| **threads** | deltas on watched threads and reactions on your own comments | replies landing unseen for days |
| **identity** | JSON-LD `Person` consistency, ORCID gaps, email uniformity across citation files | twelve published identities and no path from any of them to the papers |
| **hf** | model-hub downloads, likes, and discovery metadata that silently hides a model | an untagged model invisible to task-filtered browse, which is how most people find models |

Two of these — **numbers** and **withdrawn** — are worth building first if you
build any. They are the two that check what is *live* rather than what is *in
git*, and every incident in `docs/incidents.md` that survived the longest was
live-only.

## Running them

The fleet is driven by one runner that executes each checker, distinguishes
UNREACHABLE from a finding, and exits non-zero if anything was found. It runs
weekly from cron. Three properties of the runner matter:

- A missing checker is skipped, not an error. The fleet grows and shrinks.
- Each checker owns its own state file, next to itself.
- The runner never edits anything. Rule 5 of the registry says a value changes
  by re-running `produced_by`; deciding that a new number is the right one to
  publish is a judgement, so the checker reports and a person decides.

The cheap pass is affordable weekly — measured at 2.5s warm, 4.9s cold, network
included. The expensive pass re-runs real GPU benchmarks and a test suite that
takes 9m30s on its own, so it is run by hand. The split is declared per fact in
the registry (`cost: "cheap" | "expensive"`) and is measured, not guessed: one
test-count fact touches no GPU at all and still takes 9m30s.
