您的代码整体结构清晰，但存在若干并发、异常处理和资源管理相关的逻辑问题，长期运行可能导致内存泄漏或消息丢失。以下按严重程度列出主要逻辑错误和优化建议。

---

## 1. 逻辑错误（可能导致崩溃、泄漏或功能异常）

### 1.1 处理文档类型图片时崩溃
`bot.on('message')` 中处理以文件形式发送的图片时，直接调用了 `handlePhotoMessage(msg, chatId)`。而该函数内部读取 `msg.photo` 获取 `file_id`：
```js
const photos = msg.photo;
const fileId = photos[photos.length - 1].file_id; // 当 msg.photo 为 undefined 时崩溃
```
**后果**：用户发送图片文件（非压缩图片）会导致进程未捕获异常，服务崩溃。

**修复**：修改 `handlePhotoMessage`，使其能同时处理 `msg.photo` 和 `msg.document`，或为两种图片分别提取 `file_id`。

### 1.2 流式消息的 Promise 泄漏与挂起
创建流式会话时：
```js
const messagePromise = new Promise(resolve => {
    resolveMessagePromise = resolve;
});
session = { messagePromise, ... };
```
如果 `bot.sendMessage('正在思考...')` 失败（例如网络错误），会执行 `ongoingStreams.delete(data.chatId)`，但 `messagePromise` 不会被 resolve 或 reject。  
后续异步回调中若有 `await session.messagePromise`（如在 `stream_chunk` 的定时器里），就会**永远挂起**，造成内存泄漏，且异步任务无法回收。

**同时**，`const messageId = await session.messagePromise;` 没有 `try/catch`，一旦 Promise 被 reject（若未来加入 reject），会导致未处理的 rejection 崩溃。

**修复建议**：
- 在创建会话时记录一个 `reject` 函数，并在清理时主动 reject：
  ```js
  let rejectPromise;
  const messagePromise = new Promise((resolve, reject) => {
      resolveMessagePromise = resolve;
      rejectPromise = reject;
  });
  session = { messagePromise, rejectPromise, ... };
  // 出错删除会话时：
  rejectPromise(new Error('Stream cancelled'));
  ongoingStreams.delete(data.chatId);
  ```
- 在所有 `await session.messagePromise` 外用 `try/catch` 包裹。
- 设置超时（例如 30 秒）自动 reject 并清理会话，避免无限挂起。

### 1.3 流式 chunk 的编辑节流逻辑不精确
当新 `stream_chunk` 到达时：
```js
if (messageId && !session.isEditing && !session.timer) {
    session.timer = setTimeout(...); // 设置 2 秒后编辑
}
```
**问题**：若定时器已存在（`session.timer` 非空），新 chunk **不会重置定时器**，导致编辑发生在旧文本上，可能丢失最后 2 秒内的更新。  
**优化**：每次收到 chunk 时应**重置定时器**：
```js
if (session.timer) clearTimeout(session.timer);
session.timer = setTimeout(async () => { ... }, 2000);
```
同时配合 `isEditing` 锁防止并发编辑。

### 1.4 WebSocket 关闭时可能重复执行系统命令
`ws.on('close')` 中：
```js
if (ws.commandToExecuteOnClose) {
    const { command, chatId } = ws.commandToExecuteOnClose;
    // 直接调用命令，未清除标记
    if (command === 'reload') reloadServer(chatId);
    if (command === 'restart') restartServer(chatId);
    ...
}
```
在 `restartServer` 内部会调用 `wss.close()`，**可能再次触发 `close` 事件**（虽然连接已关闭通常只触发一次，但存在不确定性）。更安全的是**在执行前立刻清空标记**：
```js
const pending = ws.commandToExecuteOnClose;
ws.commandToExecuteOnClose = null;
if (pending) { ... }
```

### 1.5 缺少流会话超时清理
若由于网络或 ST 异常，`stream_end` 后未收到 `final_message_update`，会话会永远驻留在 `ongoingStreams` 中，用户只看到“正在思考...”，且无法清理。

**建议**：在创建会话时启动一个 30~60 秒超时，超时后自动编辑消息为“生成超时”并删除会话。

---

## 2. 其他优化与健壮性建议

### 2.1 命令执行结果无法反馈给用户
`handleTelegramCommand` 将 `/listchars`、`/switchchar` 等命令推送给 ST 后直接返回，而 ST 的回复 `command_executed` 仅被日志记录，未发送给用户。用户看不到角色列表或切换结果。  
**需确认**：ST 扩展侧是否通过 `ai_reply` 或其他消息类型向该 `chatId` 发送结果。若没有，应在 server 侧根据 `command_executed` 的内容构造一条 `bot.sendMessage` 给用户。

### 2.2 消息队列未实际使用
代码定义了 `messageQueue` 和 `queueMessage`，但未在任何地方调用。可移除冗余代码，或将其用于需要保证顺序的重要消息（如系统通知）。

### 2.3 `sendChatAction` 和 `sendMessage` 缺少重试与错误处理
多处直接调用 `bot.sendChatAction(...)`、`bot.sendMessage(...)` 未包装 `withRetry`，也未 `.catch()`，例如命令处理中的部分发送。建议统一包装，或至少捕获异常记录日志。

### 2.4 流式首条消息发送失败后，后续块仍创建新会话
在 `stream_chunk` 中，如果初始消息发送失败且会话被删除，下一个 chunk 会再次进入 `!session` 分支，重新发送“正在思考...”，造成重复发信。  
**改进**：引入一个“已失败”标记，使得同一 `chatId` 在初次失败后忽略后续流事件，并发送一条错误提示。

### 2.5 配置文件热重载的浅拷贝风险
```js
const newConfig = require('./config.js');
Object.assign(config, newConfig);
```
如果 `config.js` 导出嵌套对象（未来可能），`Object.assign` 不会深拷贝，可能导致旧引用残留。建议直接替换 `module.exports` 或使用深拷贝。

### 2.6 日志与监控
- 对关键路径（流式创建、结束、异常）增加更详细的日志，便于排查。
- 可添加 `ongoingStreams.size` 定期打印，监控是否泄漏。

### 2.7 图片 MIME 检测缺少 JPEG 魔数
虽默认 fallback 为 `image/jpeg`，但最好显式检查 JPEG 标志 `0xFF 0xD8`，使逻辑更清晰。

### 2.8 环境变量清理时机
`TELEGRAM_CLEAR_UPDATES` 仅在子进程启动后删除，父进程若存在该变量退出前未清理（无影响，但风格统一）。可无需修改。

---

## 总结
您代码的核心流程设计合理，但**并发场景下的异常处理和资源清理**存在漏洞，尤其是流式消息的 Promise 管理和图片文档处理。请优先修复上述会导致崩溃或泄漏的逻辑错误，再逐步采纳优化建议。修复后，该插件的稳定性将大幅提升。
