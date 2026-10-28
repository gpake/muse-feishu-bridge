# Agent 侧 Hook 示例（需按你的运行时改写）

桥接本身不推理。下面是本项目最初搭配的唤醒模式，供参考，
**不是开箱即用的配置**：不同 agent 运行时的 hook、定时任务、审批机制都不同。

## 约定

- 桥接把新消息写进 `queue/inbox/<id>.json`，并等待 `queue/outbox/<id>.json`，
  最长 10 分钟。
- 工人先读 `queue/session.jsonl` 最近 30 回合做上下文（每行一个回合，
  只有 role/text/时间，没有发送者标识），不要把已明确的上下文当新话题重问。
- 确认发送者在 `config.json` 白名单内，只回复白名单用户。
- 不要在回复里提及队列、hook、桥接、会话文件这些内部词。

## 输出格式

简单闲聊只写纯文本：

```json
{"text": "你的回复"}
```

结构化回答（对比表、清单、步骤）优先用交互卡片，卡片 body Markdown
不超过 2000 字、标题不超过 20 字，并附与卡片一致的纯文本摘要：

```json
{"text": "纯文本摘要", "card": {"config": {"wide_screen_mode": true}, "header": {"title": {"tag": "plain_text", "content": "标题"}, "template": "blue"}, "elements": [{"tag": "div", "text": {"tag": "lark_md", "content": "..."}}]}}
```

长回答（约 200 字以上或多个小节）按小节起草，每写好一节就**追加**
（不要覆盖）到 `queue/stream/<id>.txt`，桥接会约每 1.5 秒 patch
同一张卡；最终完整回复仍要写进 outbox，桥接会再 patch 一次。
短闲聊跳过 stream 文件，直接写 outbox。

## 提醒

- 运行时审批卡（如创建外部服务页面时的确认）一般只出现在 agent
  自己的 App 里，飞书侧看不到；不要指望用飞书按钮替代运行时的审批。
- 本仓库不包含任何 agent 运行时的 hook 定义、定时任务或审批设置，
  请按你所用产品的文档自行配置。
