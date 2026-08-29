# InkOS 项目权威入口

本目录是 InkOS 在 Obsidian、GPT、Codex、GitHub 和人工阅读之间共用的唯一项目知识源。推荐将 `D:\Inkos-Projects\inkos\docs` 直接作为 Obsidian Vault，并将本文件设为首页；不要复制 Markdown 建立第二套项目真相。

## 权威文档

- [Product Authority](product/PRODUCT_MASTER.md) — InkOS 最终要做成什么。
- [Development Rules](../AGENTS.md) — Codex 和协作代理以后如何开发 InkOS。
- [Current State](project/CURRENT_STATE.md) — 当前做到哪里、停在哪里、下一步是什么。
- [Project Memory](memory/MEMORY.md) — 已稳定的历史决定、里程碑和长期教训。

## 冲突处理

1. 产品意图冲突：`PRODUCT_MASTER.md` 胜。
2. 开发行为冲突：`AGENTS.md` 胜。
3. 当前暂停点与 NEXT：以 `CURRENT_STATE.md` 为当前文档入口，但必须重新核验机器事实。
4. 历史事实：由 `MEMORY.md` 记录；未被正式证据证明的内容必须标记为未证明。
5. 机器事实：Git HEAD、Chapter Commit、Genesis、transaction artifacts、Provider evidence 和测试输出胜过任何文档快照。

若文档之间或文档与机器证据发生冲突，不得通过覆盖或猜测消除冲突；应先停止相关写入，以机器事实校正对应职责的文档。

## 使用约定

- 大型开发任务开始前：读取 Development Rules、Product Authority、Current State，并核验必要机器事实。
- 大型任务结束、PR/merge、real-book test 或正式停工时：更新 Current State。
- 产品方向被正式改变时：更新 Product Authority。
- 形成稳定、可复用且不应反复讨论的长期决定时：更新 Project Memory。
- 本入口只做导航和优先级声明，不复制其他文档正文。

