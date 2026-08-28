# Chapter Transaction Convergence Design

## Goal and boundary

For transaction-enabled books, one verified immutable Chapter Commit bundle is the only authority that a chapter is formal. The only formal states are `NOT_STARTED`, `STAGING`, and `COMMITTED`. Legacy chapter files, indexes, snapshots, structured state, memory indexes, autonomous runtime, and Studio data are projections.

This design does not migrate every historical book. A single explicit genesis record establishes the last trusted legacy chapter and snapshot. Legacy recovery remains available only for books without transaction authority.

## CURRENT_AUTHORITY_GRAPH

Current master has no single promotion point:

1. `PipelineRunner._executeNextChapterLocked()` calls Writer, bounded Logic/Commercial review, at most two Reviser passes, state settlement, and state validation.
2. `persistChapterArtifacts()` then writes the chapter body/truth files through `WriterAgent.saveChapter()`, updates `chapters/index.json`, writes audit drift guidance, creates `story/snapshots/N`, and updates memory-derived facts.
3. `WriterAgent.saveChapter()` atomically updates a set of legacy files, but that set does not include index, snapshot, run evidence, or autonomous runtime.
4. `StateManager.getNextChapterNumber()` calls `resolveDurableStoryProgress()` and therefore treats a contiguous legacy artifact combination as progress. It also bootstraps structured state as a side effect.
5. `runBoundedAutonomousScope()` calls `getNextChapter()` after each pipeline result and starts the next Writer when the cursor advanced.
6. Provider replay reads immutable response artifacts plus corrected historical bindings. Production progress is written separately to `production-state.json`.
7. Studio reads legacy index, `getNextChapterNumber()`, autonomous runtime, and legacy recovery evidence, then independently projects Start/Resume readiness.

Consequently body, index, state, snapshot, runtime, and Studio can disagree after a crash. No existing write is the single formal authority transition.

## Canonical layout

```
story/commits/genesis.json
story/commits/chapter-0005/
  commit.json
  chapter.md
  review.json
  usage.json
  provider-refs.json
  state/**
  snapshot/**
story/runtime/chapter-transactions/chapter-0005/
  transaction.json
  staging/book/**
  staging/evidence/candidates/**
  staging/evidence/reviews/**
  staging/evidence/review-result.json
  staging/bundle/**
```

The entire verified final bundle is promoted by same-volume directory rename. A final bundle is immutable: an existing conflicting path fails closed. Projection writes occur only after promotion and can be repeated locally.

## Contracts

### ChapterGenesis

Binds schema version, book ID, trusted last chapter, the exact contiguous legacy chapter body tree, the legacy index projection, the trusted snapshot tree, creation timestamp, and a self-verifying genesis SHA. Genesis establishes `next = lastTrustedChapter + 1` and the predecessor identity for the first transaction. Any later change to a genesis-bound legacy body or Snapshot fails chain verification.

### ChapterTransaction

Binds deterministic transaction ID, book, chapter, predecessor identity, production authority identity, state, and current observational stage. Its ID is a hash of the stable authority inputs and therefore survives restart. Expensive outputs remain append-preserving under staging.

### ChapterCommit

Binds book/chapter/title, predecessor SHA, body SHA and deterministic length, the exact `LengthSpec`, terminal bounded-review status and evidence SHA, final candidate SHA, state and snapshot tree manifests, usage and Provider-reference SHAs, timestamps, and a self-verifying commit SHA.

Commit eligibility fails closed unless the body is non-empty and within hard range, literary status is `APPROVED` or `ACCEPTED_WITH_FINDINGS`, the review is candidate-bound with no blocking finding, state/snapshot manifests are complete and candidate-bound, predecessor is exactly N-1, and Provider evidence contains no unresolved ambiguous outcome.

### Verification and chain

Verification recalculates every file/tree hash and manifest identity. Authority is the latest contiguous valid chain beginning at genesis. Missing/tampered predecessor invalidates it and every descendant. Stray legacy artifacts never participate.

### Projection reconciliation

Reconciliation verifies the chain, then deterministically rebuilds the public chapter files, index, truth files, structured state, snapshot, and cursor projection from commits. It never invokes Writer, reviewer, Reviser, state model, or Provider. `memory.db` is explicitly an acceleration projection and may be deleted/rebuilt independently.

### Provider replay

Logical operation identity includes transaction ID, role, stage, round, input/candidate fingerprint, Provider, and requested model. A verified COMPLETE response is replayed locally. Definitely-not-started work may execute. Started with no provable COMPLETE response is ambiguous and pauses without a duplicate call.

## Production integration

The book lock remains the concurrency boundary. For a transaction-enabled book, PipelineRunner creates/reuses the deterministic staging transaction before creative work. All persistence targets the staging book. It verifies and promotes the canonical bundle, then reconciles legacy projections. `StateManager.getNextChapterNumber()`, autonomous N+1 gating, and Studio use commit authority whenever genesis exists. Books without genesis keep the current legacy path.

## Crash semantics

- `NOT_STARTED`: no transaction; create the deterministic transaction for authoritative next N.
- `STAGING`: reuse verified staged/model artifacts for the same transaction; never advance.
- `COMMITTED`: verify commit, reconcile projections, and proceed to N+1 without rerunning N.

No crash location or literary failure becomes another formal authority state.

## Current-book cutover (read-only plan)

After integration and separate authorization: archive the current Chapter 005/006 incident append-only, preserve Provider artifacts, create genesis at trusted Chapter 004/Snapshot 4, remove 005/006 only from active projections, reconcile from genesis, then start a new normal Chapter 005 transaction. This task does not execute that plan.

The later authorized procedure must use these stop gates:

1. Verify approved merged source, clean repository, stopped Studio worker, no active job/lock, and a before-migration full-book fingerprint.
2. Verify Chapter 004 body/index and Snapshot 4 structured-state manifests. Create an immutable archive inventory for every active/historical 005/006 body, index row, run/review/state/usage file, runtime file, and Provider artifact; record every SHA-256 before changing projections.
3. Create genesis exactly once for the book ID at Chapter 004/Snapshot 4. Verify its self-hash and trusted snapshot tree. Do not create literary reviews for Chapters 001-004.
4. Reconcile active projections from genesis so authoritative next is 005. Historical 005/006 remain archive-only and cannot be selected by the v2 transaction-scoped Provider identity.
5. Restart Studio and verify read-only projection: latest authority 004, next 005, current transaction `NOT_STARTED`, no legacy recovery plan/ownership, and Start enabled only by normal product admission.
6. Under separate real-run authorization, start once and allow normal autonomous production to commit 005, 006, 007, and 008 consecutively. Between chapters, record commit verification, predecessor SHA, hard-range result, bounded-review terminal result, revision count (at most two), state/snapshot binding, projection SHA, and next cursor. Do not intervene.
7. Stop and fail closed on any ambiguous Provider outcome, invalid commit/chain, projection that cannot reconcile locally, manual-edit requirement, state repair requirement, or N+1 Writer start before verified Commit N.
8. Acceptance passes only when Commit 005-008 form one valid chain with zero manual prose/state/runtime/commit edits and zero engineering intervention between chapters. Compare the final archive inventory and explicitly account for only the authorized cutover/production mutations.
