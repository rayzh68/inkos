# InkOS Project Memory

本文件只保存已经稳定、以后不应反复重新讨论的项目决定、重大里程碑和长期教训。当前分支、PR gate、Chapter 状态和 NEXT 见 [`../project/CURRENT_STATE.md`](../project/CURRENT_STATE.md)。

## 1. 系统权威迁移

### NovelFactory

- 已确认决定：旧 `D:\NovelFactory` 已停止使用并冻结，不再是当前小说正文生产系统，也不得被自动清理、reset、修改或复用其运行状态。
- 长期边界：InkOS 与 NovelFactory 不得形成双重生产 authority；InkOS 开发任务不得跨界修改 NovelFactory。
- 未证明历史：现有正式交接证明了“停用/冻结”的决定，但没有提供完整的原始决策记录来证明停用的全部业务与技术原因。若未来需要精确复盘，应补充当时的正式评审材料，不得从现状反推细节。

### InkOS

- 已确认决定：InkOS 是当前小说正文生产主系统。
- 已确认方向：系统以一键、自动、连续生产小说为目标；人工不参与逐章正文生成和逐章审核。
- 长期原则：安全、exact-once 和可恢复性必须服务于可靠生产，不能演变成无限机制建设。

### AI-Dev-Orchestrator

- 已确认决定：`D:\AI-Dev-Orchestrator` 不再作为当前 InkOS 开发入口，不启动 V0.4，也不得用于绕过 InkOS 自身的开发宪法和授权门禁。
- 已确认教训：历史 bounded worker 曾在准备与清理通过后耗尽，没有产出实现或测试证据。worker exhaustion 不是继续扩大 Orchestrator 或重复启动 worker loop 的授权。
- 未证明历史：为何从所有候选开发入口中最终选择当前 Codex/Subagent 流程，现有材料只证明最终决定和部分失败教训，不足以重建完整决策过程。

## 2. 产品模型角色决定

- 产品层只有三个模型角色：Production、Review、Reader。
- Production 默认面向 GPT；Review 默认面向 DeepSeek；Reader 默认面向 Gemini，并允许产品明确配置为 GPT。
- Writer 与 Reviser 是 Production 内部能力，不是两个额外产品角色。
- 内部 agent 数量不等于产品模型角色数量。Planner、Analyzer、Validator、Polisher、Settler 等内部职责不得直接膨胀用户的模型配置心智。
- 五个或更多产品模型角色的路径已被明确否决，不应在后续 UI 或架构讨论中反复恢复。

若此处与 [`../product/PRODUCT_MASTER.md`](../product/PRODUCT_MASTER.md) 冲突，以 Product Master 为准。

## 3. 已合并里程碑

以下 PR 状态和主方向已通过 GitHub repository history 核实；描述限于标题、文件范围和正式交接能够支持的结论。

### PR #11 — Chapter transaction authority convergence

- PR `rayzh68/inkos#11` 已 merge，merge commit 为 `ca757c2c74b0c14f45ee4143ada7f083fc3acb4f`。
- 主要方向：引入 Chapter Transaction，将章节生产、状态更新和 Commit 收敛到正式 transaction authority；补齐 pipeline、controller、Studio API 和大量 transaction tests。
- 长期约束：未 Commit 的章节不能推进下一章，状态与正文不能各自独立成为 authority。

### PR #12 — Long-production P0 safety closure

- PR `rayzh68/inkos#12` 已 merge，merge commit 为 `a596681aaeb417fe97c77dcd114509f32d94f458`。
- 主要方向：关闭长篇生产中的 P0 safety gaps，覆盖 provider、retry、edit/delete、pipeline、transaction、controller、Studio API 和 CLI revision 路径。
- 历史验证的完整数字和 Windows `EPERM` 限定属于当时快照，不作为永久测试基线；未来必须重新运行相关验证。

### PR #13 — Bounded chapter attempt abandonment

- PR `rayzh68/inkos#13` 已 merge，merge commit 为 `a5671b1cde68a1ed98f83e602dd4f66904bc8a71`。
- 主要方向：加入 bounded chapter attempt abandonment，并在 Core transaction、autonomous production、Studio API/UI 中表达 abandoned attempt 与 fresh attempt 的隔离。
- 长期约束：abandoned attempt 的 staging、telemetry 和 evidence 不得污染新的 attempt。

## 4. PR #14 — production safety and UI convergence

- PR `rayzh68/inkos#14` 已通过 `GPT_FINAL_PR14_REVIEW` 并以 merge commit 合入 master。
- Final audited head：`f0a9febcfafbf50294ccd6403c9a80e5c5a10260`；merge commit：`e886d96d935441e232f01b4358cb7dc157f7e93d`。Audited head 保持为 merged authority history 的 ancestor。
- 产品层正式收敛为 Production、Review、Reader 三个模型角色；Writer/Reviser 属于 Production 内部能力。
- 单章状态结算只接受 final prose；semantic retry 有界；Logical Calls 与 Provider Transports 分离计量。
- repeated O(N-book) Provider scanning 已关闭；正常调用路径不得通过反复全书扫描重建 evidence。
- Provider transport exception 与 post-transport local/pipeline failure 的分类边界已关闭：本地 persistence/observer failure 不得冒充 Provider failure。
- returned-transport checkpoint failure 使用既有 error/progress authority 保留 truthful returned evidence，并在恢复时阻止 duplicate transport；没有为此新增 database、journal、recovery subsystem 或平行 authority。
- UI convergence 方向保持：普通用户只面对三个产品模型角色、短状态、短按钮和单一语言；高级 evidence 留在审计层。

### Development Method V1 实战事实

- PR14 是第一次正式通过复杂 FULL Subagent Path 完成 Source Review、bounded repair、scoped re-review 和 release landing 的大型任务；本次最终收尾同时把 cleanup 确立为 push/reachability 后的正式 gate。
- 并行只读 review 找出了旧审核遗漏的 Provider safety blockers；所有 blocker 都在锁定范围内由 same-worktree sole Implementer 依 TDD 完成。
- Scoped re-review 只重审受影响的 root cause/safety boundary，避免每轮重新启动完整调查团队。
- FAST/FULL/MULTI-WORKTREE 必须在正式任务提示词中显式指定；parallelism follows independence；same-worktree one writer。
- 隔离 worktree 并行写入只适用于真正独立、有 ownership 与 integration contract 的任务；worktree lifecycle 必须包含任务完成后的 cleanup。
- Active worktree 在任务期间不是 TEMP/orphan；完成使命且 commits 已进入 authority 后应使用 `git worktree remove` 与 `git worktree prune`，并以 ownership + disposable status 证明清理安全。

### Post-PR14 user-facing UI convergence

- Post-PR14 user-facing UI convergence 已通过外部 GPT UI source review，并以 PR `rayzh68/inkos#15` merge；最终 reviewed head 为 `3d75c98e69c431ab94f0e5f242b0ea14c5eee5df`，merge commit 为 `f1a63ed8145c507d00f6bb872a5cc6a6149fcd8a`。
- 普通 Autonomous Production 页面只展示 Production、Review、Reader 三个产品角色，并使用短状态和短操作；raw status、phase、内部角色、Provider/model 和 transport evidence 保留在默认折叠的 Details 中。
- 忽略的旧 `dist` 不得覆盖更新的 source。Source checkout 的 freshness refresh 必须复用完整正式 Studio build，而不能只运行 client build 后永久清空共享 `dist` 中的 compiled server artifacts。
- UI presentation 收敛不改变 Resume endpoint/handler/disabled semantics，也不改变 Rewrite/abandon confirmation 或 production semantics。

### Full-book default and BookDetail live refresh

- Ordinary Autonomous Production Resume/Start 默认使用 `full-book`；Volume 不再是要求普通用户重新点击的 execution boundary，正式书籍最后一章完成后进入 `BOOK_COMPLETE`。
- Identity-bound recovery 必须保留 persisted `runtime.mode`。既有 `current-volume` Provider、pipeline、ambiguous-outcome 或 formal preserved recovery identity 不得被普通 UI 默认值改写为 `full-book`。
- BookDetail 章节列表以 matching-book `autonomous:chapter-complete` 作为 autonomous live-refresh contract；普通 autonomous start、phase、progress、complete、paused 和 error 不触发 chapter-list refetch。
- BookDetail 复用既有 SSE cursor，逐条消费批次新增消息；因此 batch 中间事件和初始空 stream 后的第一条 chapter completion 不会丢失。没有新增 polling、watcher、queue 或第二套 SSE subsystem。
- 该产品修正由 PR `rayzh68/inkos#16` 以 merge commit 合入；final reviewed head `04755e11ce96570a3dd720bff84f6af34ccf0538` 通过 `GPT_FULL_BOOK_AND_REFRESH_SOURCE_REVIEW`，Core source 保持 0 修改。
- NON-BLOCKING FOLLOW-UP：historical recovery terminal-promotion 尚未统一发送 `autonomous:chapter-complete`；后续如需规范化，必须单独定界，不得把本次正常 autonomous Chapter Commit 路径的修复扩大解释为历史路径已解决。

### Modern settlement delta compatibility boundary

- Modern settlement envelope 是 authoritative boundary：只要响应声明 `RUNTIME_STATE_DELTA`，malformed JSON 或 schema-invalid modern data 必须 fail closed，不得静默回退到 legacy settlement parsing。
- 历史持久化模型输出中的精确兼容别名 `hookOps.upsert[*].status: "pressured"` 只在 modern delta compatibility boundary 规范化为 canonical `"progressing"`；正式 `HookStatusSchema` 仍保持 `open / progressing / deferred / resolved`，不得扩展为双重 schema authority。
- Legacy settlement parsing 只保留给真正未声明 modern envelope 的历史响应；invalid modern response 不得生成“状态卡未更新”或“伏笔池未更新”占位结果。
- COMPLETE Provider artifact 在 exact identity 匹配时继续复用且不产生 duplicate transport；兼容性解析修正不得改写 Provider、job、stage、model、fingerprint 或 transaction identity。
- Chapter authority 仍要求 final state validation 成功并形成 Chapter Commit 后才能启动 N+1；parser compatibility 不构成跳过 transaction/Commit gate 的授权。
- 该边界修正已通过 `GPT_CHAPTER006_SETTLEMENT_FIX_SOURCE_REVIEW`，以 reviewed head `2e61e146a22709f70770c386a8f290bd14c5f3c5` 经 PR `rayzh68/inkos#17` merge；merge commit 为 `4012ed1f7e6c033114a1e5d087803a6da70b6d68`。

### Autonomous chapter convergence system closure

- 单章只有在 final prose、fresh final review authority 与 final state 对同一最终候选完成收敛并通过验证后，才能形成 Chapter Commit。
- State/canon validation 可以发现普通审核遗漏的 content defect；可修复的 content defect 必须反馈到既有 bounded prose revision chain，不能在 state settlement 中静默改写正文语义。
- Host 不声称理解自然语言语义。Host 只证明 provenance、identity、authority priority、hash、transaction binding 与 budget；自动 prose repair 还必须由两个既有独立语义职责对同一 structured committed fact 达成一致。
- 只有经过验证的 committed structured `current_state.json` / `hooks.json` records 能授权自动 prose repair；无法证明的文学歧义、冲突 evidence、显式 transition 或不确定判断必须 fail closed。
- 正文改变后，旧 reviewer authority、state extraction 和 state validation 全部失效；新候选必须重新取得 fresh Logic/Canon review、fresh Reader review、fresh state build 与 fresh validation。
- State-only failure 继续留在 settlement repair；mixed failure 先修正文，再重建与复核 state。
- Convergence 不得重置预算：prose revision 仍只有 `REVISION_1 + REVISION_2`，settlement retry 仍为每个 active Chapter Transaction 一次，logical calls / Provider transports 仍为 `18 / 24`。
- Exact-once Provider replay、Chapter Transaction 与 N+1 authority 始终是强制约束；matching `COMPLETE` replay 不得增加 transport，N+1 不得越过未 Commit 的 N。
- Stop 必须作用于实际 model-call admission，而不能只依赖 high-level pipeline stage；已 admission 的调用可完成并持久化 truthful evidence，但不得启动下一调用。
- Focused semantic adjudication 只授权或拒绝 content-repair route，不能成为 final reviewer authority；最终 Logic/Canon 与 Reader evidence 分别要求 `LOGIC_REVIEW` 与 `READER_REVIEW` stage。
- 该系统性闭环已通过 `GPT_AUTONOMOUS_CONVERGENCE_RE_REVIEW`，reviewed head `d74a0a4869894828a679ee194ce62bdefe5fff80` 经 PR `rayzh68/inkos#18` 以 merge commit `d684c2a8ad0e050255510d9a6d664ee5c2068cc2` 合入 master；未新增产品角色、transaction type、runtime schema、Provider adapter、UI 或 subsystem。

### Autonomous production cost convergence

- 三个 PREPARING semantic model selectors 已从正式 Chapter Transaction path 移除并以 deterministic structure 取代；这不是新的 retrieval、cache、Provider 或 runtime subsystem。
- Writer 输入继续保留 current chapter intent、current Volume authority、N-1 continuity、Chapter N blueprint/memo、正式需要的 N+1 planning context、Story Frame global anchors 以及 active memory/facts/hooks。成本降低的长期边界是减少噪声，不能削弱 authority。
- 结构上的 logical-call 数量从 clean chapter `9 → 6`、one revision `12 → 9`、PREPARING `4 → 1`；已观察到的 Chapter 006 volume-map selector `62012` prompt tokens 因该 model selector 不再运行而从路径中消除。
- Quality、authority、convergence、Chapter Transaction、exact-once、N+1、Stop、recovery、revision、settlement-retry、logical-call 与 Provider-transport gates 均保持不变。
- 该 bounded convergence 已通过 `GPT_AUTONOMOUS_PRODUCTION_COST_SOURCE_REVIEW`，reviewed head `4e732b98f5f7ab9af9ee9136b66717fc55afe401` 经 PR `rayzh68/inkos#19` 以 merge commit `a2fc4f6e02fcc3283924579bde22d08f4d840d4d` 合入 master；开发、审核和落地期间真实 Provider/model calls 与 real-book mutation 均为 0。
- Cost optimization 到此关闭。在真实连续生产工作之前，不再启动 Logic/Reviser prompt 优化、Planner removal、Provider caching、state/convergence simplification 或额外 selector work；下一优先级回到一键完成 Volume I 的 P0 production continuity closure。

## 5. 不应反复重新设计的架构决定

- Chapter Transaction 是章节生产和提交的正式边界。
- 单章最终链是 `final prose → final state → validation → Commit`。
- exact-once、N+1、replay、ambiguous transport、abandoned attempt 和 fresh-attempt isolation 是必须显式保护的既有约束。
- Logical Calls 与 Provider Transports 是不同指标；token 与成本必须对用户可见。
- 原始正文、Chapter Commit、Genesis、transaction/provider evidence 是机器 authority；可重建索引和文档快照不能覆盖它们。
- 复杂排错和跨层修改采用主代理统筹、多个只读 reviewer、单一写入 Implementer、独立复查的模式。
- 不建立无必要的新 workflow、state、recovery、journal、database 或平行 subsystem；优先最小充分修改。

## 6. 重大事故与稳定教训

### Chapter 004 历史恢复

- 历史恢复曾暴露 source artifact identity 与 corrected logical Chapter target 的语义绑定差异。
- 稳定教训：历史 source metadata 和 bytes 必须保持不变；corrected logical identity 应通过独立正式 binding 表达，不能重写历史来源来制造一致。
- 恢复证明、实现修复和真实执行授权必须分开；只读 projection 或 UI Ready 不构成 Resume 授权。

### Chapter 005 生产暂停

- Chapter 005 曾出现空 Provider response（`usage=0+0`），后续又形成 abandoned attempt 与 fresh attempt 的受控现场。
- 稳定教训：普通 local/pipeline failure 不能冒充 Provider failure；已经开始但 ambiguous 的 transport 必须保留证据并计入 transport；COMPLETE replay 不得重复产生 logical call、transport 或 Commit。
- Chapter 005 的当前精确状态属于 `CURRENT_STATE.md`，不在本文件长期复制。

### Windows 验证基线

- 历史 full Core runs 多次遇到 `skill-agent-tool.test.ts` 中 Windows symlink fixture 的 `EPERM` 失败。
- 稳定教训：必须把这类已知平台限定与本次 focused regression 分开报告；不得称有失败的 full suite 为“全部通过”，也不得为无关任务顺手修改源码追逐该基线。

## 7. 已明确否决的路径

- 恢复 NovelFactory 为当前生产系统或修改其历史现场。
- 恢复 AI-Dev-Orchestrator 为当前 InkOS 开发入口。
- 把内部 agent 数量重新包装成五个或更多产品模型角色。
- 让人工参与逐章正文生成和逐章审核流水线。
- 多个写入代理同时修改同一工作树。
- 以 Ready、成功测试、review ZIP、Draft mergeable 或历史授权替代新的真实 Provider/真实书执行授权。
- 为了“更安全”而无限增加机制、重复扫描、平行状态或恢复 subsystem。
- 未经 GPT Source Review 和用户授权擅自 merge 大型业务修改。

## 8. 仍需历史材料补充

- NovelFactory 停用的完整原始决策记录和逐项根因。
- InkOS 被选为唯一主系统的完整比较评审材料。
- AI-Dev-Orchestrator 退出当前开发入口的完整决策时间线。
- PR #11–#14 每个 review round 的完整问题清单与批准记录；本文件只记录目前可由 GitHub和正式交接证明的主方向。

在这些材料补齐前，不得编造更详细的因果叙事。

