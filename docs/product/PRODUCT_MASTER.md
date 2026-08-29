# InkOS Product Master

**Status:** Product Authority  
**Scope:** InkOS 小说正文生产主系统的长期产品方向

本文件只回答一个问题：**我们最终要把 InkOS 做成什么？**

## 1. 产品使命

InkOS 是当前小说正文生产主系统。旧 NovelFactory 已停用并冻结，不再承担当前小说生产或开发入口。

InkOS 的最终目标是小说的一键自动生产：从已确认的书籍设计和当前权威状态出发，系统自动完成正文生产、审核、必要修订、状态结算、验证、提交和后续推进。人工不参与逐章正文生成，也不承担逐章审核流水线；人工负责产品目标、关键授权、异常治理和必要的高层决策。

系统的成功标准不是“拥有最多机制”，而是能够以可审计、可恢复、成本可见的方式，持续生产高质量小说。

## 2. 唯一产品模型角色

产品层只有三个模型角色：

| 产品角色 | 默认职责 | 默认模型方向 |
| --- | --- | --- |
| Production | 生成和修订最终正文，并完成生产链中的创作能力 | GPT |
| Review | 审核逻辑、canon、状态继承和结构质量 | DeepSeek |
| Reader | 从真实读者与商业可读性角度独立评价 | Gemini；产品允许明确配置为 GPT |

- Writer 与 Reviser 都只是 Production 内部能力，不是两个额外产品模型角色。
- Planner、Analyzer、Validator、Polisher、Settler 等内部 agent 或能力的数量，不等于产品模型角色数量。
- 内部实现可以按职责拆分，但 UI、配置和用户心智不得重新膨胀为五个或更多产品角色。

## 3. 单章生产契约

单章最终目标链为：

```text
final prose
→ final state
→ validation
→ Commit
```

- 只有最终选定并完成审核的 prose 能驱动 final state。
- final prose 与 final state 必须共同通过验证后才能 Commit。
- 未 Commit 的 Chapter 不构成下一章的正式 authority。
- 失败、重试、恢复、replay 和 abandoned attempt 不得破坏 exact-once，也不得让 N+1 越过未完成的 N。

这些安全约束服务于可靠生产，而不是取代生产本身。

## 4. 自动推进目标

- Chapter 完成并 Commit 后，系统应能自动推进下一章。
- Volume 完成后，系统应能根据正式书籍设计和权威状态自动推进下一 Volume。
- Book 应能在授权范围内持续自动生产，而不是要求用户逐章点击、逐章写作或逐章审核。
- 异常必须停在可理解、可恢复、可审计的边界，并给出最少且明确的用户动作。

## 5. 调用、成本与可观测性

用户必须能够看见并理解生产成本和调用情况，至少包括：

- Logical Calls；
- Provider Transports；
- Tokens；
- Estimated Cost。

Logical Call 表示一次产品逻辑步骤；Provider Transport 表示真实向 Provider 发出的传输。两者必须概念分离：transport retry 可能是一项 logical call 对应多次 transport；semantic retry 会新增 logical call；COMPLETE replay 不新增两者；已经开始但结果 ambiguous 的 transport 仍应被计数。

调用上限、重试和恢复必须有界且可审计，但不得通过反复扫描全书历史、无限重建机制或明显拖慢正常生产来实现。

## 6. 普通用户体验

- UI 面向普通用户，不暴露不必要的 raw internal enums、内部 agent 拆分或恢复机制细节。
- 同一界面保持单一语言，不混用面向用户的中英文状态。
- 操作按钮尽量使用 1–2 个词。
- 状态、错误和下一动作应短、明确、可执行。
- 高级证据可以保留在详情或审计层，但默认界面应聚焦“现在发生什么、花费多少、用户能做什么”。

## 7. 产品取舍原则

- 质量、可靠性、exact-once、安全和证据完整性都是硬约束。
- 同时，不得为了“机制正确”牺牲真实生产速度、成本透明度和可用性。
- 不建立无必要的新 workflow、state、recovery、journal、database 或平行 subsystem。
- 优先复用现有 transaction、runtime history、artifact 和验证路径，采用最小充分设计。
- 最终衡量标准始终是：InkOS 能否可靠、持续地生产高质量小说。

## 8. 权威关系

- 本文件是产品意图的唯一权威。
- 若 [`../memory/MEMORY.md`](../memory/MEMORY.md) 与本文件发生产品意图冲突，以本文件为准。
- 当前实现进度和暂停点见 [`../project/CURRENT_STATE.md`](../project/CURRENT_STATE.md)。实现尚未达到本文件目标，不改变产品目标本身。
- 开发和授权规则见 [`../../AGENTS.md`](../../AGENTS.md)。

