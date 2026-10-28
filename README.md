# Muse 飞书桥接（非官方）

用飞书自建应用当聊天入口，跟一个以文件队列为接口的 AI agent 对话。
本项目只做**传输 + 表现**：飞书长连接收发消息、交互卡片、卡片 patch 流式、
断线补发、收到确认表情；推理本身由你的 agent 完成，不在本仓库里。

> 非官方项目：与 Meta、Muse、飞书官方无关。飞书侧用的是官方
> `@larksuiteoapi/node-sdk` 的长连接（WSClient），无需公网服务器、无需回调 URL。

## 工作原理

```
飞书 App ──长连接──> src/feishu.mjs ──> queue/inbox/<id>.json
                                              │
                                     agent 工人（见 docs/hook-example.md）
                                              │
                                     queue/outbox/<id>.json
                                              │
src/feishu.mjs ──卡片/文本──> 飞书 App（同一会话）
```

- 入站：订阅 `im.message.receive_v1`，只接受 `config.json` 白名单里的发送者
  （飞书侧是 open_id，如 `ou_xxxxxxxxxxxxxxxx`，不是手机号）。
- 回复：工人把 `{text}` 或 `{text, card}` 写进 outbox，桥接先发一张占位卡片，
  完成后再 patch 同一张卡；长回答按小节追加到 `queue/stream/<id>.txt`，
  桥接约每 1.5 秒 patch 一次，卡片上带“正在生成…”提示。
- 断线补发：桥接把会话 ID 与已完成消息水位存在 `queue/bridge-state.json`，
  重连后用会话历史接口按时间顺序补发漏掉的文本消息，去重、失败不阻塞长连接。
- 收到确认：收到消息先加表情回应（优先 THUMBSUP，备用 THINKING），失败不阻塞回复。
- 主动推送：`node src/feishu.mjs proactive <open_id> <text...>`，目标必须在白名单内。
- 可选的文件投递：往 `queue/sync/` 里放 `{"text": "..."}` 文件，桥接会发到
  已持久化的 1:1 会话，成功后归档到 `queue/done/sync/`，失败留文件重试。

## 飞书应用设置（手机或网页端均可）

1. 在 [open.feishu.cn](https://open.feishu.cn) 创建**企业自建应用**（仅自己团队内用）。
2. 开启机器人能力；事件订阅选**长连接**，订阅 `im.message.receive_v1`。
3. 开通权限并发布版本：
   - `im:message`、`im:message.p2p_msg:readonly`、`im:message:send_as_bot`
   - 分段流式需要 `im:message:update`（自建应用的免审核权限保存后即生效，
     以一次真实 patch 调用为准）
   - 可选：图片/文件消息需要 `im:resource`；卡片按钮回调需要订阅
     `card.action.trigger`（见飞书回调配置页）——本仓库当前版本不处理按钮回调。
4. 记下 App ID 与 App Secret，**只通过环境变量交给桥接，绝不要写进代码或提交到仓库**。

## 本地运行

```bash
npm install
cp config.example.json config.json
# 把你的 open_id 填进 config.json 的 allowedSenders
FEISHU_APP_ID=cli_xxx FEISHU_APP_SECRET=xxx npm run feishu
```

首次运行时，日志会打印非白名单发送者的 open_id，把它加进白名单后重启即可。
生产常驻用 watchdog（退出即重启，退避 5 秒起、最高 60 秒）：

```bash
FEISHU_APP_ID=cli_xxx FEISHU_APP_SECRET=xxx npm run feishu-watchdog
```

如需凭据存盘 standby，可把上述两个变量写进本目录的 `.credentials.env`
（0600，仅所有者可读），watchdog 会在环境变量缺失时读取它；
**该文件已被 `.gitignore` 挡住，永远不要提交**。能用环境变量时优先用环境变量。

## 测试

```bash
npm run feishu-mock-test
```

只做离线测试：事件解析、非文本忽略、白名单拦截、队列往返、去重，
不连飞书、不需要真实凭据。

## 限制

- 默认一对一；群聊只在后续版本考虑 @ 响应。
- 卡片没有字号参数，卡片正文字号比纯文本小一号，这是为排版、媒体与流式
  付出的代价；纯文本消息无法 patch，因而无法流式。
- Agent 侧的唤醒（本仓库外的 hook/定时任务如何扫 inbox、写 outbox）
  取决于你用的 agent 运行时，见 `docs/hook-example.md`，需按自己的运行时改写。
- 非官方通道，无可用性保证；虚拟机/主机重启会短暂中断，靠 watchdog 与
  断线补发恢复。

## 许可证

MIT，见 `LICENSE`。
