# Chapter Transaction Convergence Implementation Plan

1. Add Core transaction schemas, deterministic hashing, genesis creation/verification, transaction identity/state inspection, commit preparation/promotion, chain verification, and authoritative-next resolution.
2. Add deterministic projection reconciliation from verified commits, including chapter/index/truth/state/snapshot outputs and a rebuildable-memory boundary.
3. Add RED tests for generic cases A-N before production implementation: commit gates, crash/restart reuse, stray projections, tampering, ambiguous Provider, and chain integrity.
4. Adapt PipelineRunner persistence for genesis-enabled books so final output is written to staging, verified/promoted once, and projected only after commit. Preserve the current Writer/review/Reviser/state validation and PR #9 length gates.
5. Change StateManager progress resolution to commit authority for genesis-enabled books, leaving non-transaction books on the legacy path.
6. Add an autonomous pre-Writer barrier that verifies the predecessor chain and exposes stable transaction identity to Provider-operation identity/replay.
7. Project transaction authority and observational stage in Studio; Start/Resume must not infer transaction completion from legacy recovery/runtime classes.
8. Run focused Core/Studio regression, typecheck, build, real-book before/after fingerprint comparison, review scope, commit once, push the feature branch, and open a Draft PR without merging.
