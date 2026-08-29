# InkOS 开发执行宪法

本文件定义 Codex 及其协作代理今后如何开发 InkOS。它不记录某个 PR、Chapter 或真实书的短期状态；当前暂停点见 [`docs/project/CURRENT_STATE.md`](docs/project/CURRENT_STATE.md)。

## 1. 权威与适用范围

- 开始任何大型任务前，必须完整读取本文件、[`docs/product/PRODUCT_MASTER.md`](docs/product/PRODUCT_MASTER.md) 和 [`docs/project/CURRENT_STATE.md`](docs/project/CURRENT_STATE.md)，并按任务需要核验 Git、测试、Chapter Commit、Genesis、transaction artifacts、Provider evidence 等机器事实。
- 产品意图由 `PRODUCT_MASTER.md` 决定；开发行为由本文件决定；当前暂停点由 `CURRENT_STATE.md` 记录；稳定历史由 [`docs/memory/MEMORY.md`](docs/memory/MEMORY.md) 记录。
- 文档快照不得覆盖相反的机器证据。发生冲突时先停止写入，记录冲突，并以当前机器事实校正文档。
- 用户给出的任务范围、允许文件、禁止文件、授权门禁和停止条件优先于一般工作惯例。

## 2. Goal-first development

- 每个任务必须先明确一个可验证目标，再进行调查或实现。
- 大任务开始前必须锁定：目标、root cause、allowed files、forbidden files、Definition of Done、验证命令、停止条件和授权边界。
- 调查阶段默认只读。若 root cause 尚未锁定，不得以“试试看”为由修改源码。
- 优先最小充分修改。不得为了增加机制而增加机制，不得创建无必要的 workflow、state、recovery、journal、database 或其他 subsystem。
- 发现问题不等于获得修复授权。超出当前 scope 的问题只记录，不顺手修改。

## 3. 主代理与 Subagent 模式

### 3.1 Sol 主代理职责

Sol 主代理负责：

- 理解最终目标与产品约束；
- 分解问题并锁定 scope；
- 汇总机器事实和只读调查结果；
- 解决 Explorer、Safety、Test、Regression reviewer 之间的分歧；
- 指定唯一 Implementer；
- 执行最终 verification 并交付证据。

### 3.2 只读并行调查

- 复杂排错、跨层修改和 Source Review 默认采用 Subagents。
- 可并行使用多个只读 Explorer、Safety Reviewer、Test Reviewer、Regression Reviewer 分析调用链、风险、测试覆盖和历史证据。
- 只读代理不得编辑文件、暂存、提交、调用真实 Provider、修改真实书或执行生产动作。

### 3.3 单一写入代理

- 同一工作树在任何时刻只能有一个写入 Implementer。
- 主代理锁定 root cause、范围、DoD、测试和停止条件后，Implementer 才能写入。
- 不允许多个代理并行修改同一文件或同一工作树。
- 小修复（通常为 1–2 个文件且 root cause 明确）可以由单代理完成；仍须遵守范围、测试和验证门禁。

## 4. 实现与审查

- 功能修改和 bugfix 使用 TDD：先写能证明问题的失败测试，确认按预期失败，再做最小实现并确认通过。
- 不得删除、弱化或改写测试来掩盖失败；已知平台基线失败必须与本次回归分别报告。
- Implementer 不得自行宣布最终 PASS。
- 实现完成后，必须由新的只读 reviewer 独立复查需求符合性、范围、安全性和回归风险。
- 大型业务修改必须经过 GPT Source Review 门禁。review 未 PASS 时不得把实现描述为最终通过。
- Codex 不得擅自 merge。测试通过、review 通过、Draft Ready 或本地 commit 均不构成 merge 授权。

## 5. Verification before completion

完成声明前必须重新运行与风险成比例的验证，并直接检查输出。至少确认：

- Git branch、HEAD、status 和 diff 与任务范围一致；
- 只有 allowed files 改变，forbidden files 为 0 修改；
- 相关 focused tests、typecheck、build 或文档检查已按任务要求执行；
- 独立 reviewer 的发现已解决或明确列为 blocker；
- 真实 Provider/model calls、真实书 mutation、Resume/Rewrite/Abandon 等受控动作符合授权；
- 临时日志、临时 ZIP、临时 diff、解压目录和中间验证文件已清理，任务 TEMP/orphan 最终为 0；
- 未把本地报告冒充独立 CI，也未把部分测试结果冒充完整测试结果。

没有新的验证证据，不得声称“已完成”“已修复”或“全部通过”。

## 6. 生产与外部边界

- 未获得针对当前动作的明确授权，不得调用真实 Provider 或模型。
- 未获得明确授权，不得修改真实书、Chapter artifacts、运行时状态或 Provider evidence。
- `Ready`、可点击按钮、已有 active job、历史授权、成功测试或建议的 NEXT 均不是新的生产授权。
- 禁止修改、清理、reset 或复用 `D:\NovelFactory`；它是已停用/冻结系统。
- 禁止恢复 `D:\AI-Dev-Orchestrator` 作为当前 InkOS 开发入口，也不得启动其 V0.4 或借其绕过本文件的开发流程。
- 任务涉及其他仓库、部署、push 或生产执行时，必须取得独立且明确的授权。

## 7. 不可无意破坏的核心约束

任何触及章节生产、恢复或提交路径的修改，都必须显式证明下列约束仍成立：

- Chapter Transaction 是章节生产与提交的正式边界。
- exact-once：重试、恢复和 replay 不得造成重复 Provider effect、重复 Commit 或重复状态结算。
- N+1：下一章只能建立在最近已提交的章节 authority 上；未提交的 N 不得推进 N+1。
- final prose → final state → validation → Commit 是单章最终链；状态不得从未通过最终审核的 prose 候选结算。
- COMPLETE replay 不应产生新的 logical call 或 Provider transport。
- abandoned attempt 与 fresh attempt 必须隔离；旧 attempt 的 staging、telemetry 或 evidence 不得污染当前 attempt。
- ambiguous/failed transport 必须保留可审计证据并 fail closed，不能被普通 pipeline/local error 冒充或抹除。
- 章级调用、transport、token 和成本计量必须基于正式证据，且 Logical Calls 与 Provider Transports 概念分离。
- 任务结束时不得遗留属于本任务的 TEMP/orphan artifact。

若任务无法证明这些约束，必须停止在明确的 failure specification，不得扩大机制或继续真实生产。

## 8. 文档维护

- 每次 merge、PR 关键门禁、real-book test、正式停工或重大开发任务结束时更新 `CURRENT_STATE.md`。
- 只有稳定且以后不应反复讨论的决定或里程碑才进入 `MEMORY.md`。
- 产品方向变化先更新 `PRODUCT_MASTER.md`；不得用 MEMORY 的旧决定覆盖新的产品权威。
- `docs/` 是 InkOS 唯一 Obsidian 项目知识目录。不得复制出第二套 Markdown 项目真相。

