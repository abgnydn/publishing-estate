# Capacity tiers, and the one exception

Agents in this pipeline do jobs of very different difficulty, and running all
of them at the top of the range costs enough that the pipeline stops being run.
Running all of them at the bottom is worse: it degrades the one place where
degradation is invisible.

So there are three tiers for pipeline agents and a standing exception for the
lenses.

## The rule for pipeline agents

**Start at the lowest tier that can do the job. Escalate only on demonstrated
failure — a specific task this tier got wrong, not a feeling that a harder
model would be nicer.**

| tier | the job | how you know it fits |
|---|---|---|
| **mechanical** | the result is checkable by something that is not a model: a sweep, a formatter, a schema, a test. Moving files, regenerating a derived artifact, running a checker and reporting its exit code. | if it were wrong, something downstream would say so |
| **compositional** | multi-file work that has to hold a shape in mind. Writing a checker, porting a mechanism, refactoring across a directory, drafting prose that will then be reviewed. | a person or a lens reads the output before it matters |
| **adversarial** | finding what is wrong when nothing says where to look. Auditing a guard, reconciling surfaces that disagree, deciding what a defect actually was. | nothing downstream will catch a miss |

Escalation is a record, not a habit. When a tier fails a task, note the task and
move that task up — not the whole class of work, and not permanently by default.
The reverse move is equally allowed: a job that has been mechanical for months
belongs at the mechanical tier regardless of where it started.

## The exception: lenses are pinned

**Every lens in [`lenses/`](../lenses/) declares its model and its reasoning
effort in its own frontmatter, and neither is inherited from whatever spawned
it.**

Before this, review lenses ran at whatever model and effort the spawning session
happened to be using. Two runs of nominally the same quorum were therefore not
the same quorum, nothing on the ledger entry recorded which one had happened,
and the difference between them is exactly the difference between catching a
defect and writing SAFE. A quorum whose quality depends on an ambient setting is
not a quorum.

Three things follow from pinning:

1. **A cheaper lens is the wrong economy.** A lens is the last thing between a
   wrong claim and the public. The saving is small and the failure is a
   notification that has already been emailed to everyone subscribed to the
   thread.
2. **Verdicts become comparable across time.** Two SAFE verdicts recorded a
   month apart were produced under the same conditions — a property of the
   pinning, not of the ledger entry, which records neither field — so a
   regression in lens quality is a change somebody made rather than weather.
3. **`inherit` is not used.** The field is written out in each definition
   rather than left to the harness, because an ambient default changes
   quietly, by whichever session is cheapest to run.

The specific values in the frontmatter (`model:`, `effort:`) name one harness's
settings and will not transfer verbatim. The rule that transfers is: pin them,
pin them at the top of the range you have, and write them where the lens is
defined rather than where it is called.

## What this does not cover

Nothing here says which model. This estate's lenses share a model family, which
[the Limitations section of the design reference](design.md#5-limitations) records as an
open weakness — four same-family lenses carry far fewer than four independent
votes, and pinning them does not fix that. Pinning stops the quorum from
degrading silently. A cross-family reproducer is what would make it stronger,
and it is not built.
