# InkOS Current State

**Snapshot date:** 2026-08-30  
**Task:** `DEVELOPMENT_METHOD_V1_OFFICIAL_ALIGNMENT` — `COMPLETE`
**Rule:** 本文件是当前暂停点快照；继续工作前必须重新核验机器事实。

## 1. Repository

| Field | Current machine fact |
| --- | --- |
| Repository | `rayzh68/inkos` |
| Local root | `D:\Inkos-Projects\inkos` |
| Branch | `master` |
| Development Method V1 base HEAD | `91ce3a1901b5bea638358cec248361b0a4a31b46` |
| Completion HEAD | the local commit containing this snapshot; resolve with `git rev-parse HEAD` |
| `origin/master` | `a5671b1cde68a1ed98f83e602dd4f66904bc8a71` |
| Task-start Git status | Clean; local `master` is ahead of `origin/master` by 2 commits |
| Completion Git status | CLEAN after the authorized local commit; local `master` is ahead of `origin/master` by 3 commits |
| Push | No |

本任务只修改 `AGENTS.md` 与本文件；task completion 由包含本快照的 authorized local commit 固化，不在此处写入其 SHA。该 commit 后 bounded write authorization expires；不 push。最终/current HEAD 必须从 Git 机器事实和最终 handoff 读取，因为文档不能嵌入包含自身的 commit SHA。

## 2. Development Method V1

- 共同顺序：`GOAL / AUTHORITY / SAFETY BOUNDARY → READ → READ-ONLY INVESTIGATION → ROOT CAUSE LOCK → IMPLEMENTATION LOCK → IMPLEMENT → INDEPENDENT REVIEW → VERIFY → HANDOFF`。
- FAST PATH 仅用于文档小修或证据明确的 1–2 文件、非 production/transaction/safety、大型 Source Review 任务；否则走 FULL。
- 长期角色抽象为 Main Agent/Coordinator、Subagent、Explorer、Implementer、Reviewer；具体模型名只是当前例子。SAME WORKTREE 同时只能一个 writing Implementer；只有具备清晰 ownership/integration contract 且无共享高耦合可变状态的独立 workstreams，才可在隔离 worktrees 中并行写入。
- **PARALLELISM FOLLOWS INDEPENDENCE**：并行调查和隔离实施以独立性、wall-clock reduction 与 correctness 为目标；同文件、高耦合核心状态路径、共享未提交状态或依赖修复不并行。
- FULL 只对真正独立问题并行只读调查；Main Agent/Coordinator 汇总并锁定根因和实施边界，每个同一 worktree 由唯一 Implementer 写入，按风险进行 fresh read-only review，scope/root cause/risk 变化即停止写入并 `RE-LOCK`。多 worktree 主集成前须核验 goal/scope、ownership、overlap/conflict、order、combined regression、machine state、independent review 和 TEMP/orphan/worktree cleanup。
- Codex 内部自主完成调查、实现、测试、复核和验证；Provider/model、真实书、Resume/Rewrite/Abandon、destructive action、push、merge、部署仍须明确授权。Chapter Transaction、exact-once、N+1、最终 prose→state→validation→Commit、replay、attempt 隔离和 ambiguous evidence fail-closed 继续是硬约束。

## 3. PR #14

| Field | Current fact |
| --- | --- |
| PR | `rayzh68/inkos#14` |
| Title | `fix: converge autonomous production safety and studio roles` |
| Base branch / SHA | `master` / `a5671b1cde68a1ed98f83e602dd4f66904bc8a71` |
| Head branch / SHA | `codex/production-safety-convergence-001` / `66b32a7cba25968f7337db2990966b9253275e8f` |
| GitHub state | OPEN |
| Draft | Yes |
| Merge state | CLEAN / mergeable at the recorded GitHub check |
| Merged | No |
| Current gate | `GPT_FINAL_PR14_REVIEW` |

`PR14_FINAL_BOUNDED_REWORK` 已由当前 head 的第二个 PR commit 收尾。该事实不等于 GPT PASS，也不授权 merge。PR14 业务源码在本任务中冻结；不得在此文档任务中做增量源码审核、继续修改或 merge。
PR14 专用 worktree 保持 clean，HEAD 仍为 `66b32a7cba25968f7337db2990966b9253275e8f`；本任务未触碰该 worktree。
PR14 属于 transaction/provider/runtime 的高耦合路径；后续 Source Review 应采用并行只读调查加受控 review/bounded implementation，不应人为拆成并行 writers。

## 4. 当前真实 Book

| Field | Current machine fact |
| --- | --- |
| Title | `The House She Built` |
| Book ID | `novelfactory-b1-compatibility-test` |
| Project | `D:\Inkos-Projects\projects\novelfactory-b1-compatibility-test` |
| Book root | `D:\Inkos-Projects\projects\novelfactory-b1-compatibility-test\books\novelfactory-b1-compatibility-test` |
| Target | 156 chapters, about 2200 English words per chapter |
| Volumes | 001–038 / 039–078 / 079–118 / 119–156 |

### Chapter authority

- Genesis `lastTrustedChapter` 为 4。
- Structured state manifest `lastAppliedChapter` 为 4。
- 正式 chapters/index 仅包含 Chapter 001–004。
- 当前正式 Chapter authority 是 **Chapter 004**。

### Chapter 005

- Chapter 005 尚未 Commit，正式 chapters 目录中没有 Chapter 005 正文。
- Chapter 005 transaction 为 `STAGING`。
- attempt 1 已留下正式 abandonment evidence；当前历史现场是 fresh attempt 2。
- attempt 2 transaction 仍为 `STAGING`。
- 当前 run artifact 状态为 `failed`，错误为 `STATE_SETTLEMENT_FAILED_BEFORE_CHAPTER_COMMIT`。
- `active-job.json` 不存在。
- 这些是只读历史现场，不授权 Resume、Rewrite、Abandon、状态修复或任何 Provider/model call。

### Chapter 006

- Chapter 006 未开始：没有 Chapter 006 committed prose，也没有 Chapter 006 transaction。
- 已存在的预规划材料不构成 Chapter 006 已开始或已取得 authority。

## 5. 当前授权矩阵

| Action | Authorized now? |
| --- | --- |
| 读取 Git、PR、测试报告和真实书 evidence | Yes, read-only |
| 修改 `AGENTS.md` 与本 `CURRENT_STATE.md` | No — bounded authorization expires with the authorized local commit containing this snapshot |
| 修改 Core / Studio / tests / workflows | No |
| 调用真实 Provider/model | No |
| 修改真实书或 runtime | No |
| Resume / Rewrite / Abandon Chapter 005 | No |
| 开始 Chapter 006 | No |
| 修改 NovelFactory 或 AI-Dev-Orchestrator | No |
| merge PR14 | No |

## 6. Blockers

- PR14 尚未通过 `GPT_FINAL_PR14_REVIEW`。
- PR14 未 merge，当前 master 不包含 PR14 head。
- Chapter 005 保持未 Commit 的 STAGING/failed 历史现场；恢复真实生产需要 PR14 门禁完成、同步后的 clean master、现场重新核验以及新的明确生产授权。

## 7. 上一轮 verification 摘要

PR14 当前 head `66b32a7cba25968f7337db2990966b9253275e8f` 的 bounded rework 记录如下。这些是 Codex 本地验证，不是独立 CI，也不等于 `GPT_FINAL_PR14_REVIEW` PASS：

- Core focused：172/172 PASS；
- Core full：QUALIFIED PASS — 2031/2033；仅两项既有 Windows symlink `EPERM` baseline failures；
- Studio focused：224/224 PASS；
- Studio full：667/667 PASS；
- Core typecheck：PASS；
- Studio typecheck：PASS；
- Studio build：PASS；
- 真实 Provider/model calls：0；
- 真实书 mutation：0；
- TEMP/orphan：0。

GitHub 当前没有 PR14 CI workflow/status；上述结果不得冒充独立 CI，也不得作为 merge、真实 Provider 调用或真实书 mutation 的授权。本 documentation-only closeout 未重跑业务测试套件。

## 8. NEXT

`READ_CURRENT_CODEX_PR14_RESULT` -> `PR14_NEW_METHOD_SOURCE_REVIEW` / `GPT_FINAL_PR14_REVIEW`

## 9. 更新触发器

每次 merge、PR 关键门禁、real-book test、正式停工或重大开发任务结束时更新本文件。更新时删除已经失效的短期细节，不把完整项目历史复制进来。
