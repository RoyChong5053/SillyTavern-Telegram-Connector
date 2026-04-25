# 代码检查报告 - SillyTavern-Telegram-Connector Fork 项目

**生成时间**: 2026-04-25  
**最后更新**: 2026-04-25 (已修复严重问题)  
**项目路径**: `/home/roychong/sdcard/app/st-extension/SillyTavern-Telegram-Connector`  
**Fork 来源**: qiqi20020612/SillyTavern-Telegram-Connector  
**当前仓库**: RoyChong5053/SillyTavern-Telegram-Connector

---

## 一、已完成的修复

### 1.1 配置文件修复

#### manifest.json
- ✅ 已更新 `homePage` 链接从 `qiqi20020612` 改为 `RoyChong5053`

#### README.md
- ✅ 已更新 GitHub badges 链接
- ✅ 已更新安装 URL 链接

#### CONTRIBUTING.md
- ✅ 已更新 git clone 链接

### 1.2 文档更新

#### README.md TODO 列表
- ✅ 根据 build-log.md 更新了 TODO 列表
- ✅ 添加了已实现的功能标记（AI 重试、Telegram 重试、WebSocket 重连等）
- ✅ 添加了待修复的技术问题（Promise 泄漏、图片处理等）

### 1.3 代码问题修复（本次完成）

#### 1.3.1 Promise 泄漏问题 - ✅ **已修复**
- **位置**: `server/server.js` 第 529-617 行
- **修复内容**:
  - 添加 `rejectPromise` 函数用于错误情况下的 Promise 清理
  - 在 `bot.sendMessage` 失败时主动 reject Promise
  - 添加 60 秒会话超时清理机制
  - 在 `stream_chunk`、`stream_end`、`final_message_update` 处理中正确清理超时定时器
  - 添加 try-catch 包裹 `await session.messagePromise` 防止未处理的 rejection

#### 1.3.2 图片处理崩溃问题 - ✅ **已修复**
- **位置**: `server/server.js` 第 829-856 行
- **修复内容**:
  - 添加对 `msg.photo` 和 `msg.document` 两种图片格式的判断
  - 处理文件形式的图片（`msg.document.mime_type.startsWith('image/')`）
  - 添加无效消息格式的错误处理和日志

#### 1.3.3 编辑节流逻辑优化 - ✅ **已修复**
- **位置**: `server/server.js` 第 588-616 行
- **修复内容**:
  - 每次收到 chunk 时重置定时器（`clearTimeout` + `setTimeout`）
  - 移除 `!session.timer` 检查，改为先清除再设置
  - 添加对 Promise reject 情况的处理

#### 1.3.4 WebSocket 关闭时重复执行问题 - ✅ **已修复**
- **位置**: `server/server.js` 第 776-793 行
- **修复内容**:
  - 在执行命令前先获取并清空 `commandToExecuteOnClose` 标记
  - 使用局部变量 `pending` 保存命令信息

---

## 二、代码问题分析

根据 `deepseek-tell.md` 中的代码审查，发现以下严重问题：

### 2.1 严重问题（会导致崩溃或内存泄漏）

#### 2.1.1 处理文档类型图片时崩溃 ⚠️ **严重**

**位置**: `server/server.js` 第 751-800 行 (`handlePhotoMessage` 函数)

**问题描述**:
```javascript
async function handlePhotoMessage(msg, chatId) {
  const photos = msg.photo;  // 当 msg.photo 为 undefined 时崩溃
  const fileId = photos[photos.length - 1].file_id;
```

当用户以"文件"形式发送图片（而非压缩图片）时，`msg.photo` 为 `undefined`，导致崩溃。

**修复建议**:
```javascript
async function handlePhotoMessage(msg, chatId) {
  let fileId;
  
  // 处理压缩图片
  if (msg.photo && msg.photo.length > 0) {
    fileId = msg.photo[msg.photo.length - 1].file_id;
  } 
  // 处理文件形式的图片
  else if (msg.document && msg.document.mime_type && 
           msg.document.mime_type.startsWith('image/')) {
    fileId = msg.document.file_id;
  }
  else {
    throw new Error('不是有效的图片消息');
  }
  
  // ... 后续处理
}
```

---

#### 2.1.2 流式消息的 Promise 泄漏与挂起 ⚠️ **严重**

**位置**: `server/server.js` 第 534-557 行

**问题描述**:
```javascript
if (!session) {
  let resolveMessagePromise;
  const messagePromise = new Promise(resolve => {
    resolveMessagePromise = resolve;
  });
  
  session = { messagePromise, ... };
  ongoingStreams.set(data.chatId, session);
  
  bot.sendMessage(data.chatId, '正在思考...')
    .then(sentMessage => {
      resolveMessagePromise(sentMessage.message_id);
    })
    .catch(err => {
      logWithTimestamp('error', '发送初始 Telegram 消息失败:', err);
      ongoingStreams.delete(data.chatId);  // ❌ Promise 未被 resolve/reject，永远挂起
    });
}
```

当 `bot.sendMessage` 失败时，`messagePromise` 永远不会被 resolve 或 reject，导致：
1. 内存泄漏（会话永远驻留在 Map 中）
2. 后续 `await session.messagePromise` 永远等待

**修复建议**:
```javascript
if (!session) {
  let resolveMessagePromise, rejectMessagePromise;
  const messagePromise = new Promise((resolve, reject) => {
    resolveMessagePromise = resolve;
    rejectMessagePromise = reject;
  });
  
  session = { 
    messagePromise, 
    rejectPromise: rejectMessagePromise,  // 保存 reject 函数
    lastText: data.text,
    timer: null,
    isEditing: false,
  };
  ongoingStreams.set(data.chatId, session);
  
  bot.sendMessage(data.chatId, '正在思考...')
    .then(sentMessage => {
      resolveMessagePromise(sentMessage.message_id);
    })
    .catch(err => {
      logWithTimestamp('error', '发送初始 Telegram 消息失败:', err);
      // 主动 reject Promise
      if (session.rejectPromise) {
        session.rejectPromise(err);
      }
      ongoingStreams.delete(data.chatId);
    });
}
```

同时，在所有 `await session.messagePromise` 处添加 try-catch：
```javascript
try {
  const messageId = await session.messagePromise;
  // ... 使用 messageId
} catch (err) {
  logWithTimestamp('error', '获取 messageId 失败:', err);
  return;  // 或进行错误处理
}
```

---

#### 2.1.3 流式 chunk 的编辑节流逻辑不精确 ⚠️ **中等**

**位置**: `server/server.js` 第 568-587 行

**问题描述**:
```javascript
if (messageId && !session.isEditing && !session.timer) {
  session.timer = setTimeout(async () => {
    // ... 编辑逻辑
    currentSession.timer = null;
  }, 2000);
}
```

问题：如果定时器已存在，新的 chunk **不会重置定时器**，导致编辑发生在旧文本上，丢失最后 2 秒的更新。

**修复建议**:
```javascript
// 每次收到 chunk 时重置定时器
if (session.timer) {
  clearTimeout(session.timer);
}

if (messageId && !session.isEditing) {
  session.timer = setTimeout(async () => {
    // ... 编辑逻辑
    if (ongoingStreams.has(data.chatId)) {
      ongoingStreams.get(data.chatId).timer = null;
    }
  }, 2000);
}
```

---

#### 2.1.4 缺少流会话超时清理 ⚠️ **中等**

**问题描述**:
如果由于网络或 ST 异常，`stream_end` 后未收到 `final_message_update`，会话会永远驻留在 `ongoingStreams` 中。

**修复建议**:
在创建会话时添加超时清理：
```javascript
const SESSION_TIMEOUT_MS = 60000;  // 60 秒

session = {
  messagePromise,
  rejectPromise: rejectMessagePromise,
  lastText: data.text,
  timer: null,
  isEditing: false,
  timeoutId: setTimeout(() => {
    logWithTimestamp('warn', `流式会话超时，清理 ChatID ${data.chatId}`);
    if (session.rejectPromise) {
      session.rejectPromise(new Error('Session timeout'));
    }
    ongoingStreams.delete(data.chatId);
    bot.sendMessage(data.chatId, '生成超时，请稍后重试。').catch(() => {});
  }, SESSION_TIMEOUT_MS),
};
```

在 `stream_end` 和 `final_message_update` 处理时清除超时：
```javascript
if (session.timeoutId) {
  clearTimeout(session.timeoutId);
}
```

---

### 2.2 其他优化建议

#### 2.2.1 WebSocket 关闭时可能重复执行系统命令 ⚠️ **低**

**位置**: `server/server.js` 第 704-715 行

**问题**: 在执行命令前未清除标记，可能导致重复执行。

**修复建议**:
```javascript
ws.on('close', () => {
  logWithTimestamp('log', 'SillyTavern 扩展已断开连接。');
  
  // 立即获取并清空标记
  const pending = ws.commandToExecuteOnClose;
  ws.commandToExecuteOnClose = null;
  
  if (pending) {
    const { command, chatId } = pending;
    logWithTimestamp('log', `客户端断开连接，现在执行预定命令：${command}`);
    if (command === 'reload') reloadServer(chatId);
    if (command === 'restart') restartServer(chatId);
    if (command === 'exit') exitServer(chatId);
  }
  
  sillyTavernClient = null;
  ongoingStreams.clear();
});
```

---

#### 2.2.2 命令执行结果无法反馈给用户 ⚠️ **低**

**问题**: `handleTelegramCommand` 将命令推送给 ST 后直接返回，用户看不到执行结果。

**建议**: 监听 `command_executed` 消息并反馈给用户。

---

#### 2.2.3 消息队列未实际使用 ⚠️ **低**

**问题**: 代码中定义了 `messageQueue` 和 `queueMessage` 但未使用。

**建议**: 移除冗余代码，或用于需要保证顺序的重要消息。

---

#### 2.2.4 缺少 WebSocket 心跳检测 ⚠️ **中等**

**问题**: 根据 README TODO，缺少心跳检测，导致浏览器在 Termux 环境中休眠时断开连接。

**建议**: 实现 ping-pong 机制：
```javascript
// 服务器端
const HEARTBEAT_INTERVAL = 30000;  // 30 秒

wss.on('connection', ws => {
  ws.isAlive = true;
  
  const heartbeatInterval = setInterval(() => {
    if (ws.isAlive) {
      ws.isAlive = false;
      ws.ping();
    } else {
      clearInterval(heartbeatInterval);
      ws.terminate();
    }
  }, HEARTBEAT_INTERVAL);
  
  ws.on('pong', () => {
    ws.isAlive = true;
  });
  
  ws.on('close', () => {
    clearInterval(heartbeatInterval);
    // ... 其他清理
  });
});
```

---

## 三、修复优先级

| 优先级 | 问题 | 影响 | 建议修复时间 |
|--------|------|------|-------------|
| 🔴 高 | Promise 泄漏导致内存泄漏 | 长期运行后崩溃 | 立即修复 |
| 🔴 高 | 文档类型图片处理崩溃 | 用户发送文件图片时崩溃 | 立即修复 |
| 🟡 中 | 编辑节流逻辑不精确 | 丢失部分文本更新 | 尽快修复 |
| 🟡 中 | 缺少会话超时清理 | 内存泄漏 | 尽快修复 |
| 🟡 中 | 缺少 WebSocket 心跳检测 | Termux 休眠断开 | 尽快修复 |
| 🟢 低 | 命令结果无反馈 | 用户体验差 | 可选修复 |
| 🟢 低 | 消息队列未使用 | 代码冗余 | 可选清理 |

---

## 四、建议的后续工作

### 4.1 立即修复（本次 fork 完善）

1. ✅ 修复配置文件链接（已完成）
2. ✅ 更新 README TODO 列表（已完成）
3. ⏳ 修复 Promise 泄漏问题
4. ⏳ 修复图片处理崩溃问题
5. ⏳ 添加 WebSocket 心跳检测

### 4.2 未来优化

1. 实现命令执行结果反馈
2. 清理未使用的消息队列代码
3. 添加更多错误日志和监控
4. 考虑将 server 转换为标准服务端插件

---

## 五、测试建议

### 5.1 图片功能测试
- 发送压缩图片到 Telegram
- 发送文件形式的图片到 Telegram
- 验证 SillyTavern 能正确接收并显示图片

### 5.2 流式消息测试
- 发送消息触发长时间生成
- 验证不会出现 Promise 挂起
- 验证超时清理机制生效

### 5.3 稳定性测试
- 长时间运行（数小时）
- 监控内存使用情况
- 验证无内存泄漏

### 5.4 网络异常测试
- 模拟 WebSocket 断开重连
- 验证心跳检测机制
- 验证自动重连功能

---

## 六、总结

当前 fork 项目已完成基础配置修复，但存在若干**严重**的代码问题，可能导致：
- 内存泄漏（Promise 未清理）
- 进程崩溃（图片处理异常）
- 用户体验问题（文本丢失、无心跳）

建议优先修复标为🔴高优先级的问题，确保项目能够稳定运行。

---

**报告生成完毕**
