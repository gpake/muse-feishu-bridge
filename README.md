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

## Muse 侧还需要配的三件事（本仓库不含）

桥接只做传输和表现，下面三条都在 Muse 侧（第 3 条可选），不配齐前两条
通道就跑不起来或断了回不来：

1. **回答唤醒：每 5 秒扫 inbox 的 Hook。** 桥接不推理。Muse 侧需要
   一条 Hook（或等价定时任务），每 5 秒扫 `queue/inbox/`，有新消息就
   唤醒工人：先读 `queue/session.jsonl` 最近 30 回合做上下文、确认发送者
   在白名单内，再把 `{"text": ...}` 或 `{"text": ..., "card": ...}` 写进
   `queue/outbox/<同 id>.json`；长回答还要按小节追加到
   `queue/stream/<id>.txt`。没有这一条，消息只进 inbox、永远没人回。
   具体约定见 `docs/hook-example.md`，Hook 定义需按 Muse 运行时改写。

2. **存活拉起：每 60 秒跑一次的脚本 Hook（不要用 agent 定时任务）。**
   watchdog 只负责桥接进程退出后重启；虚拟机/主机替换会连 watchdog
   一起杀掉，watchdog 没法自己把自己拉回来。Muse 侧需要一条每 60 秒
   轮询的**脚本型** Hook：脚本 `pgrep` 查 `src/watchdog.mjs` 与
   `src/feishu.mjs`，都在就静默退出（不开 agent 回合、零算力消耗）；
   watchdog 不在就脱离会话后台重拉它、等约 25 秒自验进程已起，成功
   同样静默；只有重拉失败、或桥接子进程在 watchdog 存活时消失超过
   5 分钟，才唤醒 agent 兜底。脚本示例见 `docs/hook-example.md`。
   早期版本用每 5 分钟的 agent 存活检查也能恢复（中断窗口最长约
   6 分钟、漏消息靠断线补发），但每次检查都要开一个完整 agent 回合，
   实测曾与同步任务合计占约三分之二的 token 消耗，故改成纯脚本。
   脚本只是文件、不会自己跑：能跨重启生效，靠的是 agent 运行时在
   虚拟机替换后重新接管已保存的 Hook，调度器在运行时那一层。

3. **可选：把 agent 主聊天的回复同步到飞书。** 桥接已支持
   `queue/sync/` 文件投递（见工作原理）。省算力的分工是“随手同步 +
   低频兜底”：agent 在主聊天每次正式回复的同一回合，顺手把清洗后的
   全文写成 `queue/sync/piggy-<毫秒>.json`（近乎即时，几乎不额外花
   算力）；另设一条每 1 小时的 agent 兜底任务，按时间水位读主聊天
   补漏，补发前先按 piggy 文件的全文与 15 分钟时间窗去重、跳过已
   随手发过的。不要用高频 agent 定时任务做全量轮询同步：每次都要
   重读上下文，是 token 消耗的大头。

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
- 非官方通道，无可用性保证；虚拟机/主机重启会短暂中断，靠 Muse 侧
  每 60 秒脚本 Hook 重拉 watchdog 加断线补发恢复（脚本发现并拉起
  通常在约 1 分钟内）。单靠 watchdog 不够，因为它也会随虚拟机一起死。

## 许可证

MIT，见 `LICENSE`。
