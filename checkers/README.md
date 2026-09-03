# The checker fleet

Six checker sources ship here, curated. The pattern they converged on — the
five properties and the incident behind each — is in
[`docs/checker-pattern.md`](../docs/checker-pattern.md): the code is one
estate's answer, the shape is everyone's.

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


## Running them

Every checker proves itself before it is trusted:

```
$ node checkers/check-orphans.mjs --selftest
ok   planted orphan is caught
ok   registered value is excused
...
ok   a config with zero surfaces is fatal
```

The block opens with a planted-defect case and closes with the fault case.
Every selftest here contains both: at least one case whose only job is to
prove the checker can still see a planted defect, and a closing block in which
broken config input hard-fails instead of sweeping. Two of the six
(`check-orphans`, `check-deployed`) label a planted-defect case
`positive control` outright; three more name it in the comment above the case.

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
