# Build Log - SillyTavern-Telegram-Connector

## Date: 2026-04-25

## 问题描述

用户在使用 SillyTavern-Telegram-Connector 时遇到 API 不稳定问题：
- **500 错误**: Google AI Studio API 服务器内部错误
- **429 错误**: Telegram API 速率限制
- 用户需要手动复制粘贴消息重发，非常麻烦

## 优化内容

### 1. AI 生成重试机制 (index.js)

针对 Google AI Studio API 500 错误添加客户端重试：

```javascript
const MAX_RETRIES = 3;
const RETRY_DELAYS = [2000, 5000, 10000];

while (retryCount < MAX_RETRIES && !generationSuccess) {
    try {
        await Generate('normal', { signal: abortController.signal });
    } catch (error) {
        if (errorMsg.includes('500') || errorMsg.includes('Internal Server Error')) {
            retryCount++;
            continue; // 重试
        }
        // 非500错误立即失败
    }
}
```

**关键特性**:
- 最多重试 3 次 AI 生成
- 等待时间：2s → 5s → 10s (指数退避)
- 只对 500 错误进行重试，其他错误立即失败
- 日志输出便于调试

### 2. Telegram API 重试机制 (server/server.js)

在文件开头添加了重试机制核心代码：

```javascript
const MAX_RETRIES = 5;
const INITIAL_DELAY_MS = 1000;
const MAX_DELAY_MS = 30000;

async function withRetry(apiCall, context) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            return await apiCall();
        } catch (error) {
            // 429: 使用 Retry-After 或指数退避
            if (errorCode === 429) { ... }
            // 500: 指数退避重试
            if (errorCode === 500) { ... }
        }
    }
}
```

**关键特性**:
- 最多重试 5 次 Telegram API 调用
- 429 错误优先使用 `Retry-After` 响应头
- 500 错误使用指数退避：1s → 2s → 4s → 8s → 16s
- 包装所有 `bot.sendMessage()`, `bot.editMessageText()`, `bot.sendChatAction()` 调用

### 3. WebSocket 自动重连 (index.js)

```javascript
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY_MS = 3000;

ws.onclose = () => {
    if (settings.autoConnect && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        setTimeout(connect, RECONNECT_DELAY_MS);
    }
};
```

**关键特性**:
- 自动重连最多 10 次
- 每次间隔 3 秒
- 手动断开（disconnect）不会触发重连
- 连接成功后重置重试计数器

### 4. 消息队列 (server/server.js)

```javascript
const messageQueue = [];

function queueMessage(sendFn, onError) {
    messageQueue.push({ sendFn, retries: 0, onError });
    processQueue();
}
```

**关键特性**:
- 失败的消息进入队列
- 最多重试 3 次后移除
- 队列消息按顺序发送

### 5. Inline Image 处理 (index.js)

从远程稳定版本 (m64) 恢复的图片处理代码：

```javascript
if (data.inlineImage) {
    const context = SillyTavern.getContext();
    const lastMsg = context.chat[context.chat.length - 1];
    if (lastMsg && lastMsg.is_user) {
        if (!lastMsg.extra) lastMsg.extra = {};
        if (!Array.isArray(lastMsg.extra.media)) lastMsg.extra.media = [];
        lastMsg.extra.media.push({
            url: data.inlineImage,
            type: 'image',
            title: 'Telegram Image',
            source: 'api',
        });
        lastMsg.extra.inline_image = true;
        if (context.saveChatConditional) {
            await context.saveChatConditional();
        }
    }
}
```

**关键特性**:
- 将 Telegram 图片附加到用户消息的 `extra.media` 中
- 设置 `inline_image = true` 标记
- 自动保存聊天

## 修改的文件

| 文件 | 修改内容 |
|------|---------|
| `index.js` | + AI重试、WebSocket重连、Inline Image处理 |
| `server/server.js` | + API重试机制、消息队列 |
| `build-log.md` | 新建本文档 |

## 测试建议

1. **测试 500 错误重试**:
   - 发送消息触发 API 500 错误
   - 观察日志：`[Telegram Bridge] 检测到500错误，准备重试...`

2. **测试图片功能**:
   - 发送图片到 Telegram
   - 验证 AI 能看到图片并正确描述

3. **测试 WebSocket 重连**:
   - 停止 server 后观察是否自动重连

## 实际测试结果

### 2026-04-25 首次验证成功

**测试场景**：发送文字消息触发 Google AI Studio API 500 错误

**时间线**：
- 04:34:01 - 收到消息，开始生成
- 04:36:27 - 最终收到500错误 → 历时约 **2分26秒**

**分析**：
- 之前（无重试）：10秒内立即失败
- 现在（有重试）：坚持了150秒直到最终失败
- 说明重试机制在静默执行，不断重试

**结论**：重试机制有效，让AI有更多时间等到API恢复

## 2026-04-25 重试机制优化 v2

### 问题描述（用户反馈）

1. **残留消息问题**：API请求失败后没有撤销之前发出的对话，导致SillyTavern残留大量相同的说话记录
2. **重试时间不足**：当前重试最长约3分钟就返回error 500，但云端免费API繁忙时需要等超过5分钟
3. **Telegram端体验差**：失败后需要手动复制粘贴重发消息

### 优化内容

#### 1. 增强重试机制 (index.js:166-245)

**修改前**：
- 固定3次重试，延迟 [2000, 5000, 10000]ms
- 总重试时间约17秒
- 重试失败后未删除用户消息

**修改后**：
```javascript
const MAX_RETRY_TIME_MS = 5 * 60 * 1000; // 5分钟
const INITIAL_DELAY_MS = 3000; // 初始延迟3秒
const MAX_DELAY_MS = 30000; // 最大延迟30秒

while (!generationSuccess && (Date.now() - startTime) < MAX_RETRY_TIME_MS) {
    // 指数退避 + 随机抖动
    const delay = Math.min(
        INITIAL_DELAY_MS * Math.pow(2, retryCount - 1) + Math.random() * 1000,
        MAX_DELAY_MS
    );
    
    // 向Telegram发送重试状态
    ws.send(JSON.stringify({
        type: 'retry_status',
        chatId: data.chatId,
        retryCount: retryCount,
        elapsedTime: Math.round((Date.now() - startTime) / 1000),
    }));
}
```

**关键改进**：
- 最长重试时间从17秒延长到 **5分钟**
- 智能退避策略：3s → 6s → 12s → 24s...（最大30秒）+ 随机抖动避免惊群效应
- **自动清理残留消息**：所有重试失败后调用 `deleteLastMessage()` 删除ST中的用户消息
- 非500错误立即退出，不再浪费时间重试
- 通过 WebSocket 发送 `retry_status` 通知服务器重试进度

#### 2. Telegram 重发按钮功能 (server/server.js)

**错误消息带重发按钮**：
```javascript
bot.sendMessage(data.chatId, data.text, {
    reply_markup: {
        inline_keyboard: [[
            { text: '🔄 重发消息', callback_data: `resend_${data.chatId}` }
        ]]
    }
});
```

**消息存储与重发**：
```javascript
// 存储每条消息以便重发
const lastMessages = new Map();

// 处理重发按钮点击
bot.on('callback_query', async (query) => {
    if (data.startsWith('resend_')) {
        const lastText = lastMessages.get(chatId);
        // 重新发送消息到SillyTavern
        sillyTavernClient.send(JSON.stringify({ 
            type: 'user_message', 
            chatId, 
            text: lastText 
        }));
    }
});
```

**关键改进**：
- 错误消息附带 **"🔄 重发消息"** 按钮，无需复制粘贴
- 点击按钮自动重新发送原始消息到SillyTavern
- 使用 `lastMessages` Map 存储每个聊天最后一条消息文本
- 添加 `callback_query` 事件处理监听按钮点击

### 修改的文件

| 文件 | 修改内容 |
|------|---------|
| `index.js` | + AI重试、WebSocket重连、Inline Image处理 |
| `server/server.js` | + API重试机制、消息队列 |
| `build-log.md` | 新建本文档 |

**更新后**：

| 文件 | 修改内容 |
|------|---------|
| `index.js` | 重试机制v2：5分钟超时、指数退避、自动清理残留消息 |
| `server/server.js` | 错误消息带重发按钮、消息存储、callback_query处理 |
| `build-log.md` | 更新文档 |

### 测试建议

1. **测试 500 错误重试**:
   - 发送消息触发 API 500 错误
   - 观察日志：`[Telegram Bridge] 检测到500错误，准备重试...`
   - 验证重试持续最多5分钟

2. **测试残留消息清理**:
   - 触发API错误导致重试失败
   - 检查SillyTavern聊天记录，确认用户消息已被删除

3. **测试 Telegram 重发按钮**:
   - 等待重试失败后，Telegram应显示错误消息带"🔄 重发消息"按钮
   - 点击按钮，验证消息自动重新发送

4. **测试图片功能**:
   - 发送图片到 Telegram
   - 验证 AI 能看到图片并正确描述

5. **测试 WebSocket 重连**:
   - 停止 server 后观察是否自动重连

## 回滚说明

如需回滚到修改前的版本：
```bash
git checkout -- index.js server/server.js
```

如需回滚到首次优化版本（3次重试）：
```bash
git log --oneline  # 找到首次优化的commit
git checkout <commit_hash> -- index.js server/server.js
```