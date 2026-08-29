# InkOS Current State

**Snapshot date:** 2026-08-30  
**Task:** `INKOS_AUTHORITY_DOCS_TRACKING_CLOSEOUT`  
**Rule:** 本文件是当前暂停点快照；继续工作前必须重新核验机器事实。

## 1. Repository

| Field | Current machine fact |
| --- | --- |
| Repository | `rayzh68/inkos` |
| Local root | `D:\Inkos-Projects\inkos` |
| Branch | `master` |
| Baseline HEAD before authority-doc commits | `a5671b1cde68a1ed98f83e602dd4f66904bc8a71` |
| `origin/master` | `a5671b1cde68a1ed98f83e602dd4f66904bc8a71` |
| Baseline status | Clean before this documentation-only task |

Authority-doc bootstrap 与 tracking closeout 只修改允许的文档和 `.gitignore` 白名单，不修改业务源码。本轮可以形成本地 commit；最终当前 HEAD 必须从 Git 机器事实读取，不能由文档自引用推导。

## 2. PR #14

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

## 3. 当前真实 Book

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

## 4. 当前授权矩阵

| Action | Authorized now? |
| --- | --- |
| 读取 Git、PR、测试报告和真实书 evidence | Yes, read-only |
| 修改本任务五个权威 Markdown | Yes, only for this bootstrap |
| 修改 Core / Studio / tests / workflows | No |
| 调用真实 Provider/model | No |
| 修改真实书或 runtime | No |
| Resume / Rewrite / Abandon Chapter 005 | No |
| 开始 Chapter 006 | No |
| 修改 NovelFactory 或 AI-Dev-Orchestrator | No |
| merge PR14 | No |

## 5. Blockers

- PR14 尚未通过 `GPT_FINAL_PR14_REVIEW`。
- PR14 未 merge，当前 master 不包含 PR14 head。
- Chapter 005 保持未 Commit 的 STAGING/failed 历史现场；恢复真实生产需要 PR14 门禁完成、同步后的 clean master、现场重新核验以及新的明确生产授权。

## 6. 上一轮 verification 摘要

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

## 7. NEXT

Authority-doc bootstrap 与 tracking closeout 完成后，当前顺序为：

1. `INKOS_DEVELOPMENT_METHOD_V1` / development method stabilization；
2. `READ_CURRENT_CODEX_PR14_RESULT`；
3. `PR14_NEW_METHOD_SOURCE_REVIEW` / `GPT_FINAL_PR14_REVIEW`；
4. 只有 GPT PASS 后，才决定是否 merge PR14；
5. PR14 merge、master 同步且现场重新核验后，另行取得明确授权，才可考虑恢复 Chapter 005。

`INKOS_DEVELOPMENT_METHOD_V1` 需要正式梳理 AGENTS 中 root cause 的锁定时间点；本任务只记录该待办，不提前改写开发流程，也不开始上述第 1 步。

## 8. 更新触发器

每次 merge、PR 关键门禁、real-book test、正式停工或重大开发任务结束时更新本文件。更新时删除已经失效的短期细节，不把完整项目历史复制进来。
