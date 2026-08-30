# InkOS Current State

**Snapshot date:** 2026-08-30  
**Task:** `CHAPTER006_SETTLEMENT_FIX_FINAL_LANDING` — externally reviewed settlement parser correction integration closeout
**Rule:** 本文件是当前暂停点快照；继续工作前必须重新核验机器事实。

## 1. Repository

| Field | Current machine fact |
| --- | --- |
| Repository | `rayzh68/inkos` |
| Local root | `D:\Inkos-Projects\inkos` |
| Branch | `master` |
| PR14 merge commit / integration base | `e886d96d935441e232f01b4358cb7dc157f7e93d` |
| Post-PR14 UI convergence merge commit | `f1a63ed8145c507d00f6bb872a5cc6a6149fcd8a` |
| Full-book and BookDetail refresh merge commit | `33979787b14f8e8b08d75f118b34852b3e01c374` |
| Chapter 006 settlement parser correction merge commit | `4012ed1f7e6c033114a1e5d087803a6da70b6d68` |
| Rebased authority commits | `c52dc01bb44679036126426479f03975678c2d40` → `fa35b91a0db7fe7304abbc789c3944bfa7a7735f` → `e950e1e1bb67c7b517e7f61c4595beee4187cd9a` |
| Closeout HEAD | the commit containing this snapshot; resolve with `git rev-parse HEAD` |
| Final synchronization | verify `master == origin/master` from Git and the final handoff; this file cannot embed its own commit SHA |
| Working state | expected CLEAN after the authorized closeout commit and push; machine verification controls |

The three authority/development-method commits were rebased without conflict onto the merged PR14 authority. Their content remains limited to `.gitignore`, `AGENTS.md`, and four authority Markdown files under `docs/`.

## 2. PR #14 — merged milestone

| Field | Current fact |
| --- | --- |
| PR | `rayzh68/inkos#14` |
| Title | `fix: converge autonomous production safety and studio roles` |
| Final audited head | `f0a9febcfafbf50294ccd6403c9a80e5c5a10260` |
| GPT gate | `GPT_FINAL_PR14_REVIEW = PASS` |
| Merge method | Merge commit; not squash or rebase merge |
| Merge commit | `e886d96d935441e232f01b4358cb7dc157f7e93d` |
| GitHub merged at | `2026-08-30T03:48:22Z` |
| Merged | Yes |

The audited head is an ancestor of the merge commit and of the integrated master history. The prior Draft/review/not-merged blockers are closed. This does not authorize real Provider calls, real-book mutation, or any Chapter action.

## 3. PR #15 — post-PR14 UI convergence

| Field | Current fact |
| --- | --- |
| PR | `rayzh68/inkos#15` |
| Title | `fix: converge production UI for users` |
| Final externally reviewed head | `3d75c98e69c431ab94f0e5f242b0ea14c5eee5df` |
| GPT gate | `GPT_UI_FINAL_SCOPED_REVIEW = PASS` |
| Merge method | Merge commit; not squash or rebase merge |
| Merge commit | `f1a63ed8145c507d00f6bb872a5cc6a6149fcd8a` |
| GitHub merged at | `2026-08-30T06:02:30Z` |
| Merged | Yes |

The user-facing Autonomous Production UI now presents short product statuses and only Production, Review, and Reader on the ordinary surface. Raw status, phase, internal role, Provider/model, and transport evidence remain available in default-collapsed Details. Resume and Rewrite/abandon behavior were not changed.

The stale ignored Studio bundle issue is closed. Source-checkout startup uses a deterministic freshness gate and reuses the complete formal Studio build; client refresh therefore restores the compiled `dist/api/index.js` server entry. Fresh source startup does not rebuild unnecessarily, and packaged runtime with an existing bundle remains unchanged.

## 4. PR #16 — full-book default and BookDetail live refresh

| Field | Current fact |
| --- | --- |
| PR | `rayzh68/inkos#16` |
| Title | `fix: continue autonomous production through book` |
| Final externally reviewed head | `04755e11ce96570a3dd720bff84f6af34ccf0538` |
| GPT gate | `GPT_FULL_BOOK_AND_REFRESH_SOURCE_REVIEW = PASS` |
| Merge method | Merge commit; not squash or rebase merge |
| Merge commit | `33979787b14f8e8b08d75f118b34852b3e01c374` |
| GitHub merged at | `2026-08-30T08:15:24Z` |
| Merged | Yes |

Ordinary Autonomous Production Resume/Start now defaults to `full-book`, so Volume is no longer a user execution boundary. Identity-bound Provider, pipeline, ambiguous-outcome, and formally preserved recovery continues to use its persisted `runtime.mode`; an existing `current-volume` recovery identity is not rewritten as `full-book`.

BookDetail now refreshes its chapter list for a matching-book `autonomous:chapter-complete`. It consumes each new SSE message through the existing cursor contract, so an intermediate completion in a React batch and the first completion after an initially empty stream are not skipped. Other autonomous start/phase/progress/complete/paused/error events do not trigger chapter-list refetch, and no polling, watcher, or new SSE subsystem was added.

## 5. PR #17 — Chapter 006 settlement parser correction

| Field | Current fact |
| --- | --- |
| PR | `rayzh68/inkos#17` |
| Title | `fix: preserve modern settlement delta failures` |
| Final externally reviewed head | `2e61e146a22709f70770c386a8f290bd14c5f3c5` |
| GPT gate | `GPT_CHAPTER006_SETTLEMENT_FIX_SOURCE_REVIEW = PASS` |
| Merge method | Merge commit; not squash or rebase merge |
| Merge commit | `4012ed1f7e6c033114a1e5d087803a6da70b6d68` |
| GitHub merged at | `2026-08-30T12:53:26Z` |
| Merged scope | Exactly two Core production files and three focused Core tests |
| Runtime schema modification | `0` |
| Studio modification | `0` |

The exact merged five-file scope is:

- `packages/core/src/agents/settler-delta-parser.ts`;
- `packages/core/src/agents/writer.ts`;
- `packages/core/src/__tests__/settler-delta-parser.test.ts`;
- `packages/core/src/__tests__/writer.test.ts`;
- `packages/core/src/__tests__/bounded-autonomous-controller.test.ts`.

The modern settlement envelope is now authoritative. An exact persisted `hookOps.upsert[*].status: "pressured"` compatibility value is normalized to canonical `"progressing"` before schema validation, while the formal runtime schema remains the canonical `open / progressing / deferred / resolved` four-state enum. A declared modern delta that is malformed or schema-invalid now fails closed and cannot fall back to legacy placeholders. Genuine legacy responses without the modern envelope remain compatible. The cached COMPLETE artifact regression proves matching replay adds zero Provider transports; Provider identity, transaction, Chapter Commit, and N+1 algorithms were not modified.

## 6. Latest verification

These are fresh local release checks on audited head `f0a9febc`; they are not independent CI:

- Provider + bounded-controller focused: 122/122 PASS;
- Core full: QUALIFIED PASS — 2039/2041; only the two known Windows symlink fixture `EPERM` baseline failures in `skill-agent-tool.test.ts`;
- Studio full: 667/667 PASS;
- Core typecheck: PASS;
- Studio typecheck: PASS;
- Studio build: PASS;
- fresh internal read-only safety review: PASS;
- external `GPT_FINAL_PR14_REVIEW`: PASS;
- real Provider/model calls: 0;
- real-book mutation: 0.

The post-PR14 UI convergence release checks on reviewed head `3d75c98e` are local Codex results, not independent CI:

- freshness focused: 6/6 PASS;
- freshness plus frozen UI: 35/35 PASS;
- first default-parallel Studio full run: 686/688, with one Windows reclaim-directory `ENOTEMPTY` cleanup failure and one asynchronous chat ordering failure;
- isolated affected tests: PASS;
- single-worker Studio full: 688/688 PASS;
- Studio typecheck: PASS;
- Studio build: PASS, with both `dist/index.html` and `dist/api/index.js` present;
- fresh internal scoped read-only review: PASS;
- external `GPT_UI_FINAL_SCOPED_REVIEW`: PASS;
- Core modification: 0;
- real Provider/model calls: 0;
- real-book mutation: 0.

The PR #16 release checks on reviewed head `04755e11` are fresh local Codex results, not independent CI:

- Studio focused: 69/69 PASS;
- Studio single-worker full: 709/709 PASS;
- Studio typecheck: PASS;
- Studio build: PASS;
- existing Core full-book/Stop/N+1/Commit focused regressions: 5/5 PASS;
- Core source modification: 0;
- fresh internal product, safety/scope, and BookDetail event reviews: PASS;
- external `GPT_FULL_BOOK_AND_REFRESH_SOURCE_REVIEW`: PASS;
- real Provider/model calls: 0;
- real-book mutation: 0;
- Chapter 006 action: none;
- Chapter 007 action: none.

The PR #17 settlement parser correction checks on reviewed head `2e61e146` are local Codex results, not independent CI:

- Settler delta parser focused: 9/9 PASS;
- Writer focused: 11/11 PASS;
- bounded autonomous controller focused: 62/62 PASS;
- Chapter transaction: 31/31 PASS;
- Pipeline runner: 114/114 PASS;
- Core full: QUALIFIED PASS — 2045/2047; only the two established Windows symlink fixture `EPERM` baseline failures in `skill-agent-tool.test.ts`;
- Core typecheck: PASS;
- Core build: PASS;
- `git diff --check`: PASS;
- external `GPT_CHAPTER006_SETTLEMENT_FIX_SOURCE_REVIEW`: PASS;
- real Provider/model calls: 0;
- real-book mutation: 0;
- Chapter 006 action: none;
- Chapter 007 action: none.

## 7. Current system-development state

- PR14 is merged and its audited history is preserved.
- Post-PR14 UI convergence PR #15 is merged; its two externally reviewed commits remain reachable from master.
- Full-book and BookDetail refresh PR #16 is merged; reviewed head `04755e11` is reachable from master through merge commit `33979787`.
- Chapter 006 settlement parser correction PR #17 is merged; externally reviewed head `2e61e146` remains directly reachable from master through merge commit `4012ed1f`.
- The real InkOS production remains user-paused at Chapter 006 `SETTLING_STATE` / `PAUSED_PIPELINE_ERROR`; this landing performed no production action.
- The system correction landing is complete. The critical next action is `USER_COLD_RESTARTS_LATEST_MASTER_AND_RETURNS_TO_UI`; this is not authorization for Codex to operate that UI or start production.
- Authority documents, Development Method V1, official alignment, and the worktree lifecycle rules are the current development authority.
- Development Method V1 has now been exercised through a complex FULL Subagent Path, scoped re-review, FAST documentation path, and release integration. The PR #17 feature worktree is removed only after the final docs commit push/reachability gate; its completion is proved by the final machine handoff rather than claimed early in this embedded snapshot.
- No further PR14 business development is authorized by this snapshot.

## 8. Current real production pause — read-only revalidated

The following machine facts were re-read from existing real-book artifacts without mutation during this closeout:

- latest committed authority: Chapter 005;
- current target: Chapter 006;
- runtime status / phase: `PAUSED_PIPELINE_ERROR` / `SETTLING_STATE`;
- real job: `autonomous-d69ce3bf6834220e42624eb34672b3ca`;
- real transaction: `chapter-txn-590cbd1b1d3d3602205cf462edd5afa692c5cbb8`;
- persisted recovery mode: `current-volume`;
- Chapter 006 committed: no;
- Chapter 007 started: no;
- real production remains user-paused.

The existing recovery identity must not be migrated to `full-book` during landing. No production authorization is granted to Codex.

## 9. Production authorization

| Action | Authorized now? |
| --- | --- |
| Read system-development Git/docs evidence | Yes, read-only |
| Real Provider/model call | No |
| Real-book/runtime mutation | No |
| Chapter 005 Resume / Rewrite / Abandon / Commit | No |
| Chapter 006 start | No |
| Codex operation of the real InkOS UI | No |
| NovelFactory or AI-Dev-Orchestrator modification | No |

## 10. NEXT

`USER_COLD_RESTARTS_LATEST_MASTER_AND_RETURNS_TO_UI`

The user must inspect the UI and decide any later production action outside this Codex closeout. Codex stops here and does not execute NEXT.

## 11. Update triggers

Update this snapshot after a later merge, real-book test, production-state revalidation, formal stop, or other major development milestone. Machine facts always override stale prose.
