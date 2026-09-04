# Research standards pointer

The canonical research-standards document lives in the webgpu-q repository:

- canonical: `https://github.com/abgnydn/webgpu-q/blob/main/RESEARCH_STANDARDS.md`

## Mirrors

webgpu-q publishes this document; consuming repositories mirror the relevant
sections. As of 2026-09-04 the known mirrors are:

- **webgpu-dna** — path moved; drift risk.
- **zero-tvm** — copy exists on the author's machine.
- **neuropulse** — not checked out; drift risk.

## Drift policy

Drift against the canonical is caught by `checkers/check-copies.mjs` in this
repository. Layering: the standards themselves are production discipline;
this estate file is dissemination enforcement.
