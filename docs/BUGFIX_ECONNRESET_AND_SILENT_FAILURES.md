# Bug Fix: Telegram API ECONNRESET 导致的静默失败问题

## 问题描述

插件在运行过程中偶发出现以下两个严重bug：

### Bug 1: ST已拿到AI回复但Telegram静默无反应
- **现象**: SillyTavern已成功生成AI回复，但Telegram端没有任何响应或消息推送
- **根本原因**: Telegram Bot API连接断开（`read ECONNRESET`）时，`sendSplitMessage` 函数中的 `.catch(err => {...})` 会静默吞掉所有错误，导致：
  1. Promise继续resolve，调用方认为消息发送成功
  2. `lastAiReplies.set()` 被无条件执行（即使实际未发送成功）
  3. Telegram用户看到的就是"静默无反应"

### Bug 2: `/repush` 功能无法生效
- **现象**: 用户使用 `/repush` 命令重新推送上一条AI回复时，没有任何反馈或失败提示
- **根本原因**: 
  1. `sendSplitMessage` 失败时静默返回，不抛出错误
  2. "🔄 重发消息" 按钮的回调处理中，`bot.sendMessage(...).catch(...)` 会吞掉 ECONNRESET 错误

## 日志证据

```
[06:55:06] 收到非流式AI回复，发送至Telegram用户 8377983516
[06:56:55] 健康检查失败，bot可能已断开: EFATAL: Error: read ECONNRESET
...
[07:03:04] 收到非流式AI回复，发送至Telegram用户 8377983516
[07:03:05] 发送分片消息 1/1 失败: EFATAL: Error: read ECONNRESET
```

## 修复方案

### 1. 修复 `sendSplitMessage` 静默吞掉错误的问题 (`server/server.js:271-305`)

**之前**:
```javascript
function sendSplitMessage(chatId, text, extra = {}) {
    const chunks = splitMessage(text);
    const promises = chunks.map((chunk, i) => {
        return bot.sendMessage(chatId, chunk, i === 0 ? extra : {}).catch(err => {
            logWithTimestamp('error', `发送分片消息 ${i + 1}/${chunks.length} 失败: ${err.message}`);
        });
    });
    return Promise.all(promises);
}
```

**现在**:
- 检测连接类错误（`ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, `network`）并抛出明确异常
- "message is not modified" 等非致命错误被静默忽略
- 所有分片发送失败时，会抛出详细错误信息并重新抛出给调用方

### 2. 确保 AI回复只在发送成功后才保存到 `lastAiReplies`

修改了以下位置的保存逻辑：
- **最终渲染文本更新** (`final_message_update`): 用 try-catch 包裹 `editMessageText`，仅在成功时调用 `lastAiReplies.set()`
- **非流式完整回复**: 用 try-catch 包裹 `sendSplitMessage`，失败时记录错误且不保存
- **非流式AI回复处理** (`ai_reply`): 同样添加 try-catch，确保发送失败时不保存到 `lastAiReplies`

### 3. 修复错误报告消息的静默失败 (`error_message`)

- 用 try-catch 包裹 `sendSplitMessage`
- 发送失败时向用户发送提示："抱歉，当前Telegram服务暂不稳定，您的消息已收到但回复未能送达。请稍后重试或尝试 /repush 命令。"

### 4. 增强 `/repush` 命令的错误反馈

**之前**: `sendSplitMessage` 失败时静默返回，用户看不到任何提示

**现在**:
- 发送成功时回复："✅ 已成功重新推送上一条AI回复。"
- 发送失败时明确提示："❌ 重推失败：当前Telegram服务暂不稳定（连接已断开/具体错误）。请稍后重试或检查网络。"

### 5. 修复 "🔄 重发消息" 按钮的静默失败 (`callback_query`)

**之前**: `bot.sendMessage(chatId, 'SillyTavern未连接...').catch(...)` 会吞掉 ECONNRESET 错误，用户看不到提示

**现在**: 用 try-catch 包裹，确保即使 bot 连接断开也能向用户明确反馈。

## 修复效果

1. **Telegram API 连接断开（ECONNRESET）时不再静默失败** - 会抛出明确错误并记录日志
2. **`lastAiReplies` 只在消息实际发送成功后才保存** - `/repush` 命令现在能正确工作
3. **用户能看到明确的错误提示** - 不再是"静默无反应"，而是收到服务不稳定的通知

## 相关配置与建议

### Telegram Bot API 限流与连接稳定性

1. **避免多机共用同一 Token**: 多台机器同时使用同一个 Bot Token 会导致 `429 Too Many Requests` 和连接重置
2. **健康检查间隔**: 默认60秒一次，如果频繁出现 ECONNRESET，可考虑增加间隔或检查网络环境
3. **轮询错误退避机制**: 代码已包含自动退避重启逻辑（基于 `polling_error` 事件），遇到瞬态错误会自动恢复

### 重启服务器端组件

修复后需重启 tmux 中的 `st-leer-tele` 进程或执行 `/restart` 命令：
```bash
tmux attach -t st-leer-tele || tmux new-session -d -s st-leer-tele -c /home/roychong/app/st-extension/SillyTavern-Telegram-Connector/server 'node server.js'
```

或在 Telegram 中发送 `/restart` 命令。

## 相关文件修改

- `server/server.js`: 
  - `sendSplitMessage` 函数 (lines 271-305)
  - `/repush` 命令处理 (lines 553-579)
  - `final_message_update` 处理 (lines 875-890)
  - 非流式完整回复处理 (lines 913-921)
  - `error_message` 处理 (lines 935-948)
  - `ai_reply` 处理 (lines 957-968)
  - `callback_query` resend 处理 (lines 1420-1437)
