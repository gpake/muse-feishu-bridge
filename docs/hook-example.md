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

## 存活拉起：脚本型 Hook 示例

存活检查不要用 agent 定时任务做：每次检查开一个完整 agent 回合，
实测是 token 消耗的大头。用一条每 60 秒轮询的**脚本** Hook 代替——
脚本自己判断、自己拉起，健康或恢复成功都静默退出，不花 agent 算力；
只有恢复失败才唤醒 agent。下面是本项目实际在用的检测脚本
（Muse 运行时版本，`silent` / `wake` / `log` / `hook_state_get` /
`hook_state_set` 是该运行时的 hook 协议助手，其他运行时请等价改写）：

```bash
#!/usr/bin/env bash
set -euo pipefail
source "$HATCH_HOOK_RUNTIME"

# - Watchdog + bridge running: silent (no agent turn, no cost).
# - Watchdog missing: relaunch it detached (it reads its own credentials
#   file; this script never reads, prints, or modifies that file), then
#   silent if the process comes up.
# - Relaunch failed, or bridge missing for >5 min while watchdog lives:
#   wake an agent to verify and, only if still down, tell the user.

DIR="$HOME/<your-bridge-dir>"
WD_PAT='[n]ode src/watchdog\.mjs'
BR_PAT='src/[f]eishu\.mjs'

wd_pid() { pgrep -f "$WD_PAT" 2>/dev/null | head -n 1 || true; }
br_pid() { pgrep -f "$BR_PAT" 2>/dev/null | head -n 1 || true; }

now="$(date +%s)"
state="$(hook_state_get)"
last_launch="$(printf '%s' "$state" | jq -r '.last_launch_epoch // 0')"
missing_since="$(printf '%s' "$state" | jq -r '.bridge_missing_since // 0')"

set_state() {
  hook_state_set "{\"last_launch_epoch\": $1, \"bridge_missing_since\": $2}"
}

WD="$(wd_pid)"
BR="$(br_pid)"

if [ -n "$WD" ]; then
  if [ -n "$BR" ]; then
    if [ "$missing_since" != "0" ]; then
      set_state "$last_launch" 0
    fi
    silent "feishu watchdog and bridge are running" '{}'
  fi
  # Watchdog is alive; restarting the bridge is its own job. Only escalate
  # if the bridge stays missing for more than 5 minutes.
  if [ "$missing_since" = "0" ]; then
    set_state "$last_launch" "$now"
    silent "watchdog running, bridge child missing (watchdog should restart it)" '{}'
  fi
  if [ "$now" -gt $((missing_since + 300)) ]; then
    wake "feishu bridge child missing for over 5 minutes while watchdog is running" "{\"watchdog_pid\": \"$WD\"}"
  fi
  silent "watchdog running, bridge child still missing within grace period" '{}'
fi

# Watchdog is down.
if [ "$missing_since" != "0" ]; then
  set_state "$last_launch" 0
fi

if [ "$now" -lt $((last_launch + 90)) ]; then
  silent "feishu watchdog down but a relaunch was attempted in the last 90 seconds" '{}'
fi

if [ "${HATCH_HOOK_DRY_RUN:-0}" = "1" ]; then
  wake "feishu watchdog is down (dry run, no relaunch attempted)" '{"watchdog": "down"}'
fi

set_state "$now" 0
cd "$DIR"
setsid nohup node src/watchdog.mjs >> "$DIR/logs/watchdog-hook-launch.log" 2>&1 < /dev/null &
sleep 25

WD="$(wd_pid)"
if [ -n "$WD" ]; then
  log "watchdog relaunched by hook" "{\"watchdog_pid\": \"$WD\"}"
  silent "feishu watchdog was down, hook relaunched it" "{\"watchdog_pid\": \"$WD\"}"
fi

wake "feishu watchdog relaunch by hook failed" '{"watchdog": "down", "launch": "failed"}'
```

要点：

- 进程匹配模式用 `[n]ode`、`[f]eishu` 这种写法，避免脚本匹配到自己。
- 拉起要用脱离会话（`setsid nohup ... &`），否则新进程可能随检测
  脚本所在会话结束被一起回收。
- 脚本不读、不打印、不改凭据文件；凭据由 watchdog 自己按它的方式
  读取（环境变量或它自己的 owner-only 文件）。
- 被唤醒的 agent 先核实进程与日志：已恢复就什么都不做；仍未恢复才
  再拉一次并验证；确实恢复不了才通知用户。例行掉线/恢复不要逐次汇报。
- 这条 Hook 能跨虚拟机替换生效，前提是运行时在新虚拟机上重新接管
  已保存的 Hook；首次部署后建议等一次自然重启，在 hook 日志里确认
  新开机时间之后仍有调用记录，再认定恢复路径成立。

## 主聊天同步（可选）

把 agent 主聊天的回复同步到飞书时，用“随手同步 + 每小时兜底”：
主代理每次正式回复的同一回合，把清洗后的全文写成
`queue/sync/piggy-<毫秒>.json`；每小时的兜底 agent 任务按水位补漏，
补发前以 piggy 文件全文 + 15 分钟时间窗去重。水位文件建议放在
仓库外的持久位置，兜底任务同样不要碰凭据文件、不要重启桥接。
