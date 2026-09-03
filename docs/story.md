# Story

Where this came from and how it has been checked. The [README](../README.md)
says what it is; [design.md](design.md) says how it works.

## Why it exists

Three generations of one generated data file were live at the same time. Every
site rendered its sibling-project cards from a copy of that file, baked in at
deploy time and never regenerated. One site said the flagship runtime ran at
~40 tok/s and was "22% behind WebLLM". The flagship's own copy said 69.6 tok/s
and "+16%". The benchmark artifact said 69.55 and +16.0%. The sign of the
project's founding comparison was inverted on a live page and had been for
weeks.

Nothing in that failure happened at authoring time. Each of the three copies
was correct when it was written. The system was built and tested
beginning 2026-08-14, in the course of publishing real work, against that class
of defect: a correct thing that stopped being correct, on a surface nobody
owned.


## 7. Provenance

This system was built agent-orchestrated with Claude, beginning 2026-08-14, in
the course of publishing real work. Nothing here was designed in
advance. Most mechanisms were added after a failure recorded in
[`incidents.md`](incidents.md); graded severity and the drift band
carry their incidents in the code and the registry instead.

The shape of that table is itself a finding. Read the "what happened" column:
a recurring shape is a correct thing that stopped being correct rather than a
mistake made at the time of writing, and most of the rest are guards that were
never adequate and were found later. Publishing systems are usually built to
catch errors at authoring time, and little here failed at authoring time.

Release of this repository is held to the condition the system describes,
by the owner rather than by the hook — a plain `git push` is ungated by
design, and `test/hook-test.sh` asserts that: before any version of this file
ships, it must carry at least two SAFE ledger entries for its exact sha256, at
least one of them anchored — a verdict whose note cites executed output, a
fetched primary source, or file:line evidence. Editing the file revokes those
entries, which is the behaviour the gate exists to have.


## How the checker port was verified

The branch that added the six curated checkers, the gate matchers, the dry run
and the tier policy went through repeated rounds of the same three lenses this
repository ships — refuter, reproducer, claim-auditor — each round spawned in
parallel, each verdict written to the ledger against the exact bytes reviewed,
each fix committed before the next round. The rounds found six code defects the
suites had not: two in the hook's lens-name normalisation (separator runs, then
a codepoint-class disagreement between the python and JavaScript copies), a
silent skip in check-memory when git could not answer, a completeness score in
check-ci that improved when git went missing, and two render-gate holes — a stat
value mixing a placeholder with a hand-typed literal was not graded, and the
lookbehind that spares hyphenated names also spared a leading minus. Every one
is fixed with the failing case demonstrated first; the normalisation cases ship
in `test/hook-test.sh` and `test/dry-run-agrees.sh`, the missing-binary cases in
the checkers' own selftests. The remaining findings were descriptions stronger
than the code, which is the defect class this repository exists to catch, and
they were cut down to what the code does. The lesson recorded from the process
itself: a gate that keys its ledger to a self-describing manifest never
converges, because every fix rewrites the description; the next design keys the
ledger to the tree hash and reviews the diff.
