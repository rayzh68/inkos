# InkOS 开发执行宪法

本文件定义 Codex 及其协作代理今后如何开发 InkOS。它不记录某个 PR、Chapter 或真实书的短期状态；当前暂停点见 [`docs/project/CURRENT_STATE.md`](docs/project/CURRENT_STATE.md)。

## 1. 权威与适用范围

- 开始任何大型任务前，必须完整读取本文件、[`docs/product/PRODUCT_MASTER.md`](docs/product/PRODUCT_MASTER.md) 和 [`docs/project/CURRENT_STATE.md`](docs/project/CURRENT_STATE.md)，并按任务需要核验 Git、测试、Chapter Commit、Genesis、transaction artifacts、Provider evidence 等机器事实。
- 产品意图由 `PRODUCT_MASTER.md` 决定；开发行为由本文件决定；当前暂停点由 `CURRENT_STATE.md` 记录；稳定历史由 [`docs/memory/MEMORY.md`](docs/memory/MEMORY.md) 记录。
- 文档快照不得覆盖相反的机器证据。发生冲突时先停止写入，记录冲突，并以当前机器事实校正文档。
- 用户给出的任务范围、允许文件、禁止文件、授权门禁和停止条件优先于一般工作惯例。

## 2. Authority / goal gate

- 每个任务先明确可验证的 Goal。大型任务开始时先完整读取相关权威文档并核验必要机器事实，锁定 Goal、authority、initial scope、forbidden boundaries、production authorization、investigation questions 和 stop conditions。
- 初始 gate 不要求假装已经知道 root cause。只读调查完成后，才能锁定 Proven Root Cause、Evidence、Rejected Hypotheses、exact allowed implementation files、Definition of Done、tests 和 regression boundary；证据不足则 `STOP/BLOCKED`，不得试改源码寻找答案。
- 优先最小充分修改。不得为了增加机制而增加机制，不得创建无必要的 workflow、state、recovery、journal、database 或其他 subsystem。发现问题不等于获得修复授权，超出 scope 的问题只记录为 `FOLLOW-UP`。

## 3. Development roles

长期角色是抽象职责，不绑定具体模型名称；当前模型名只能作为本次任务的例子：

- **Main Agent / Coordinator**：拥有目标、authority、分解、synthesis、Implementer 指派、集成、最终验证和 handoff 的协调职责。
- **Subagent**：在明确边界内执行委派工作并返回 evidence；Explorer、Implementer、Reviewer 是其可承担的具体职责。
- **Explorer**：只读调查代码、调用链、测试、性能、安全或历史 evidence。
- **Implementer**：在锁定范围内实施最小修改；同一工作树同时只能有一个 writing Implementer。
- **Reviewer**：对实现进行 fresh、只读、按风险的需求、安全、回归、性能或 UX 复查。

`SAME WORKTREE` 的 one-writer 规则是工作树级别不变量，不是 repository-global 限制。真正独立的 implementation workstreams 若具有清晰的文件/ownership 边界和 integration contract、没有共享高耦合可变状态，可在分离 Git worktrees（或等价隔离）中并行写入；集成前必须经过 multi-worktree gate。

平台/OpenAI primitives 提供 main coordination、delegation、independent parallel work、isolated worktrees、reviewable diffs、tests 和 verification。InkOS policy 另行定义 FAST/FULL、Root Cause Lock、Implementation Lock、GPT Source Review、Provider/real-book authorization 和 Chapter Transaction/exact-once/N+1；不得把这些 InkOS policy 描述成唯一或官方的 OpenAI workflow。

## 4. Development Method V1

### 4.1 Common sequence

```text
GOAL / AUTHORITY / SAFETY BOUNDARY
→ READ
→ READ-ONLY INVESTIGATION
→ ROOT CAUSE LOCK
→ IMPLEMENTATION LOCK
→ IMPLEMENT
→ INDEPENDENT REVIEW
→ VERIFY
→ HANDOFF
```

### 4.2 FAST PATH

文档小修或机器证据已明确证明的 1–2 文件修复，可走 FAST PATH，前提是不涉及 production safety、transaction authority 或大型 GPT Source Review；任一条件不满足即升级 FULL。

```text
READ → LOCK → ONE IMPLEMENTER → FOCUSED VERIFY → HANDOFF
```

FAST 仍须锁清 scope、唯一写入者、DoD、验证、allowed/forbidden files 和 completion evidence。单独 Implementer 写入时，Main Agent/Coordinator 的最终验证必须独立；若 Main Agent/Coordinator 写入，完成前至少由一名轻量只读 reviewer 复查。

### 4.3 FULL SUBAGENT PATH

跨层开发、复杂或未明 root cause 的 bug、transaction/retry/recovery/provider 或其他 safety-sensitive 修改、性能问题、大型 UI/Core 联动、Source Review 和 real-book incident recovery 使用 FULL：

1. **Authority / Goal Gate**：读取权威文档和机器事实，锁定目标、初始范围、禁止范围、授权、调查问题和停止条件；不得写入。
2. **Parallel Read-Only Investigation**：仅对真正独立的问题并行查代码、调用链、测试、日志/evidence、安全、性能和回归；不得写入、commit、调用 Provider 或修改真实书。
3. **Synthesis + Root Cause Lock**：Main Agent/Coordinator 汇总 Proven Root Cause、Evidence、Rejected Hypotheses 和 Implementation Boundary；不足则 `STOP/BLOCKED`。
4. **Implementation Lock**：明确 sole Implementer、baseline、Allowed Files、Forbidden Files、Definition of Done、Tests、Regression Tests、Safety Invariants 和 Stop Conditions。未锁定项目默认禁止。
5. **Single Implementer**：同一工作树同一时刻只有一个写入者；功能修改和 bugfix 使用 TDD，文档修改使用相关文档检查；最小充分修改，不扩 scope，不顺手修无关问题，不新增无必要 subsystem。
6. **Independent Review**：实现后由新的只读 reviewer 按风险选择 Requirements、Safety、Regression、Performance 或 UX 视角；FULL 必须有 fresh read-only review。
7. **Final Verification**：Main Agent/Coordinator 独立执行与风险相称的验证并准备证据。
8. **Handoff**：交付目标、根因、变更、测试、基线限定、安全证据、意外发现、Git 状态和 Next Gate。

### 4.4 Coordination and re-lock

- **PARALLELISM FOLLOWS INDEPENDENCE**：并行适合独立 code search、call-chain/test/safety/performance/regression analysis，以及有清晰边界的隔离 implementation workstreams；不适合同一文件、高耦合调用链、transaction/provider/runtime 同一核心状态路径、共享未提交状态或相互依赖的修复。Agent 数量不是目标，目标是缩短 wall-clock time 并保持 correctness。
- 分离 worktree 在主集成前必须通过 gate：确认 goal/scope、diff ownership、overlap/conflict、integration order、combined regression、最终 machine state、按风险的 independent review，以及 TEMP/orphan/worktree cleanup。不得为此新增 subsystem。
- Main Agent/Coordinator 负责汇总分歧并收敛，形成 Proven Root Cause、Evidence、Rejected Hypotheses、Implementation Boundary 以及 accepted/rejected/merged findings 和理由；结果是 `IMPLEMENT` 或 `STOP/BLOCKED`，不是无限 review loop。
- 不按固定角色数量机械启动代理；只有独立问题才并行，一个简单问题不启动不必要的团队，review 数量按风险决定。Reviewer 不得为证明价值制造问题；非 scope finding 仅记为非阻断 `FOLLOW-UP`。同一 finding 不重复审核，除非修复改变了相关代码或 evidence。
- 硬性的 safety/correctness/authority finding 是 blocker；in-scope 必需修复返回 Implementation Lock，并使受影响的 review/verification 失效。
- 若 correction 完全位于现有已证明的 root cause、scope 和 risk lock 内，可返回 Implementation Lock；任何改变 root cause、scope、risk 或 safety boundary 的 finding 都必须走完整 `RE-LOCK`。
- 任一阶段（Implementer、reviewer 或 final verification）发现 root cause、scope、risk 或 safety boundary 变化，都必须立即停止写入，冻结并报告 diff/evidence，返回只读调查并 `RE-LOCK`；相关旧 review/verification 失效，authority 扩大须重新取得用户授权。
- Codex 内部可自主完成 read、investigation、decomposition、implementation、test、internal review、verification 和 evidence preparation。GPT Source Review 只在大型业务修改、重大 transaction/provider/safety 变更或正式要求时触发；不把日常协调转嫁给用户。
- 安全、authority 和产品硬约束优先于流程便利；便利性不得伪装成 authority。
- PR14 属于 transaction/provider/runtime 的高耦合路径；后续 Source Review 应采用并行只读调查加受控 review/bounded implementation，不应人为拆成并行 writers。

## 5. 实现与审查

- 功能修改和 bugfix 使用 TDD：先写能证明问题的失败测试，确认按预期失败，再做最小实现并确认通过；文档小修按其文档检查验证。
- 不得删除、弱化或改写测试来掩盖失败；已知平台基线失败必须与本次回归分别报告。
- Implementer 不得自行宣布最终 PASS。
- 实现完成后按风险由新的只读 reviewer 独立复查需求符合性、范围、安全性和回归风险；FULL 必须使用 fresh read-only reviewer，FAST 按上文轻量复查规则执行。
- 大型业务修改必须经过 GPT Source Review 门禁。review 未 PASS 时不得把实现描述为最终通过。
- Codex 不得擅自 merge。测试通过、review 通过、Draft Ready 或本地 commit 均不构成 merge 授权。

## 6. Verification before completion

完成声明前必须重新运行与风险成比例的验证，并直接检查输出。Completion evidence 至少包含 Goal/Lock、实际命令与结果、Git 状态、范围检查、授权/安全证据、TEMP/orphan 和 Next Gate。至少确认：

- Git branch、HEAD、status 和 diff 与任务范围一致；
- 只有 allowed files 改变，forbidden files 为 0 修改；
- 相关 focused tests、typecheck、build 或文档检查已按任务要求执行；
- 必要的 regression/typecheck/build 已按风险执行，并明确 focused 与 full suite 的区别；
- 独立 reviewer 的发现已解决或明确列为 blocker；
- 真实 Provider/model calls、真实书 mutation、Resume/Rewrite/Abandon 等受控动作符合授权；
- 临时日志、临时 ZIP、临时 diff、解压目录和中间验证文件已清理，任务 TEMP/orphan 最终为 0；
- 未把本地报告冒充独立 CI，也未把部分测试结果冒充完整测试结果；已知平台基线失败须单独列出。

没有新的验证证据，不得声称“已完成”“已修复”或“全部通过”。

## 7. 生产与外部边界

- 任何 generic destructive action（删除、覆盖、reset 等）均须取得当前用户明确授权；此要求独立于 production authorization。
- 未获得针对当前动作的明确授权，不得调用真实 Provider 或模型。
- 未获得明确授权，不得修改真实书、Chapter artifacts、运行时状态或 Provider evidence。
- 未获得明确授权，不得 Resume、Rewrite、Abandon、push（除非已预授权）、merge、部署或执行其他 production action。
- `Ready`、可点击按钮、已有 active job、历史授权、成功测试、Draft Ready、mergeable 或建议的 NEXT 均不是新的生产授权。
- 禁止修改、清理、reset 或复用 `D:\NovelFactory`；它是已停用/冻结系统。
- 禁止恢复 `D:\AI-Dev-Orchestrator` 作为当前 InkOS 开发入口，也不得启动其 V0.4 或借其绕过本文件的开发流程。
- 任务涉及其他仓库、部署、push 或生产执行时，必须取得独立且明确的授权。

## 8. 不可无意破坏的核心约束

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

## 9. 文档维护

- 每次 merge、PR 关键门禁、real-book test、正式停工或重大开发任务结束时更新 `CURRENT_STATE.md`。
- 只有稳定且以后不应反复讨论的决定或里程碑才进入 `MEMORY.md`。
- 产品方向变化先更新 `PRODUCT_MASTER.md`；不得用 MEMORY 的旧决定覆盖新的产品权威。
- `docs/` 是 InkOS 唯一 Obsidian 项目知识目录。不得复制出第二套 Markdown 项目真相。
