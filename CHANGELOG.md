# Changelog - SillyTavern Telegram Connector

## 2026-07-13 - 稳定性优化 v3（假死修复 & 多回复丢失修复）

### 核心 Bug 修复

#### 1. 修复 `lastProcessedChatId` 竞态条件导致多回复丢失
- **根因**: `handleFinalMessage` 在 `setTimeout` 内部重置 `lastProcessedChatId = null`，前一条消息的 timeout 会在后一条消息生成期间触发，误清变量导致后续回复全部被静默丢弃
- **修复**: 在 `handleFinalMessage` 入口立即将 `lastProcessedChatId` 抓取到局部变量并全局置 null，timeout 内部使用局部变量，消除跨消息竞争

#### 2. 修复 Telegram 轮询假死
- **根因**: 未监听 `bot.on('polling_error')`，Telegram API 返回 502 时库进入 degraded 状态停止处理新消息
- **修复**: 
  - 添加 `polling_error` 监听器，连续 5 次错误后自动重启轮询
  - 添加每 60 秒 `getMe()` 健康检查，异常时自动恢复

#### 3. 修复消息超过 4096 字符被 Telegram 静默拒绝
- **根因**: `bot.sendMessage()` / `bot.editMessageText()` 均无长度检查
- **修复**: 新增 `splitMessage()` 按换行/句号智能分片，加 `(1/N)` 前缀；`sendSplitMessage()` 包装自动分片发送；`editMessageText` 截断至 4096

#### 4. WebSocket 心跳检测 & 断开保护
- 新增每 30s ping/pong 心跳检测，超时自动断开
- WS 断开后延迟 30s 清理流式会话，给客户端重连窗口

#### 5. 客户端 502 可重试
- `isRetryableError` 添加 `'502', 'bad gateway'` 到瞬态错误列表

### 修改文件

| 文件 | 改动 |
|------|------|
| `index.js:547-548` | `handleFinalMessage` 竞态修复 |
| `index.js:180` | 添加 502 到可重试列表 |
| `server/server.js` | polling_error 监听 + 健康检查 + 消息分片 + WS 心跳 + 延迟清理 |

---

## 2026-04-25 - 稳定性优化 v2

### 核心改进

#### 1. AI 生成重试机制增强
- 最长重试时间从 17 秒延长到 **5 分钟**
- 智能退避策略：3s → 6s → 12s → 24s...（最大 30 秒）+ 随机抖动避免惊群效应
- **自动清理残留消息**：所有重试失败后调用 `deleteLastMessage()` 删除 ST 中的用户消息
- 非 500 错误立即退出，不再浪费时间重试
- 通过 WebSocket 发送 `retry_status` 通知服务器重试进度

#### 2. Telegram 重发按钮功能
- 错误消息附带 **"🔄 重发消息"** 按钮，无需复制粘贴
- 点击按钮自动重新发送原始消息到 SillyTavern
- 使用 `lastMessages` Map 存储每个聊天最后一条消息文本
- 添加 `callback_query` 事件处理监听按钮点击

#### 3. WebSocket 自动重连
- 自动重连最多 10 次，每次间隔 3 秒
- 手动断开不会触发重连
- 连接成功后重置重试计数器

#### 4. 代码质量修复
- ✅ **修复 Promise 泄漏问题**：添加 `rejectPromise` 函数用于错误情况下的 Promise 清理，添加 60 秒会话超时清理机制
- ✅ **修复图片处理崩溃**：处理 `msg.photo` 和 `msg.document` 两种图片格式，添加无效消息格式的错误处理
- ✅ **优化编辑节流逻辑**：每次收到 chunk 时重置定时器，移除 `!session.timer` 检查
- ✅ **修复 WebSocket 关闭时重复执行**：执行命令前先获取并清空 `commandToExecuteOnClose` 标记

### 技术细节

**AI 重试机制** (`index.js:166-245`):
```javascript
const MAX_RETRY_TIME_MS = 5 * 60 * 1000; // 5分钟
const INITIAL_DELAY_MS = 3000; // 初始延迟3秒
const MAX_DELAY_MS = 30000; // 最大延迟30秒

while (!generationSuccess && (Date.now() - startTime) < MAX_RETRY_TIME_MS) {
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

**Telegram 重发按钮** (`server/server.js`):
```javascript
bot.sendMessage(data.chatId, data.text, {
    reply_markup: {
        inline_keyboard: [[
            { text: '🔄 重发消息', callback_data: `resend_${data.chatId}` }
        ]]
    }
});
```

### 测试验证
- 测试 500 错误重试：重试持续最多 5 分钟
- 测试残留消息清理：重试失败后用户消息已被删除
- 测试 Telegram 重发按钮：点击按钮自动重新发送
- 测试 WebSocket 重连：停止 server 后自动重连

---

## 2026-04-25 - 图片功能实现

### 新增功能：Telegram 图片支持

实现了完整的图片处理链路：Telegram 图片 → 下载 → base64 → SillyTavern inline image → 直接发给后端 API

#### 架构说明
```
Telegram Bot  ←→  server.js (Node.js 后端)  ←→  WebSocket  ←→  index.js (ST 前端)
```

#### 修改内容

**server.js 后端**:
- 新增 `downloadPhoto()` 函数：通过 Telegram API 获取图片并下载
- 新增 `handlePhotoMessage()` 函数：处理图片消息，支持 `msg.photo` 和 `msg.document` 两种格式
- MIME 类型检测：通过文件头字节检测真实类型（JPEG/PNG/GIF/WebP）
- 转 base64 后通过 WebSocket 发送 `user_message` 事件，包含 `inlineImage` 字段

**index.js 前端**:
- 在 `sendMessageAsUser()` 之后注入图片到 `extra.media` 数组
- 设置 `extra.inline_image = true` 标记
- 自动保存聊天（`saveChatConditional()`）

#### 关键踩坑记录
| 坑 | 原因 | 解决方案 |
|---|---|---|
| `sendMessageAsUser` 不接受图片 | ST 内部 API 设计如此，只接受文本 | 消息创建后修改 `chat` 数组 |
| 文件方式发图不生效 | 只处理了 `msg.photo`，没处理 `msg.document` | 增加 MIME type 检测分支 |
| 图片分辨率太低 | 取了 `photos[0]`（最低分辨率） | 改为 `photos[photos.length - 1]` |
| MIME type 错误 | 硬编码 `image/jpeg` | 通过文件头字节检测真实类型 |

---

## 2026-04-25 - 初始稳定性优化

### 首次优化内容

#### 1. AI 生成重试机制 (index.js)
针对 Google AI Studio API 500 错误添加客户端重试：
- 最多重试 3 次 AI 生成
- 等待时间：2s → 5s → 10s (指数退避)
- 只对 500 错误进行重试，其他错误立即失败

#### 2. Telegram API 重试机制 (server/server.js)
- 最多重试 5 次 Telegram API 调用
- 429 错误优先使用 `Retry-After` 响应头
- 500 错误使用指数退避：1s → 2s → 4s → 8s → 16s
- 包装所有 `bot.sendMessage()`, `bot.editMessageText()`, `bot.sendChatAction()` 调用

#### 3. WebSocket 自动重连 (index.js)
- 自动重连最多 10 次
- 每次间隔 3 秒
- 手动断开不会触发重连

#### 4. 消息队列 (server/server.js)
- 失败的消息进入队列
- 最多重试 3 次后移除
- 队列消息按顺序发送

#### 5. Inline Image 处理 (index.js)
从远程稳定版本 (m64) 恢复的图片处理代码

### 测试建议
1. 测试 500 错误重试：观察日志重试过程
2. 测试图片功能：验证 AI 能看到图片并正确描述
3. 测试 WebSocket 重连：停止 server 后观察是否自动重连

---

## 代码审查发现的问题（已修复）

### 严重问题修复

#### 1. Promise 泄漏问题 - ✅ 已修复
- **位置**: `server/server.js` 第 529-617 行
- **问题**: `bot.sendMessage` 失败时 Promise 永远不会被 resolve 或 reject
- **修复**: 添加 `rejectPromise` 函数，添加 60 秒会话超时清理机制

#### 2. 图片处理崩溃问题 - ✅ 已修复
- **位置**: `server/server.js` 第 829-856 行
- **问题**: 处理文档类型图片时 `msg.photo` 为 undefined 导致崩溃
- **修复**: 添加对 `msg.photo` 和 `msg.document` 两种格式的判断

#### 3. 编辑节流逻辑优化 - ✅ 已修复
- **位置**: `server/server.js` 第 588-616 行
- **问题**: 新的 chunk 不会重置定时器，导致丢失最后 2 秒的更新
- **修复**: 每次收到 chunk 时重置定时器

#### 4. WebSocket 关闭时重复执行问题 - ✅ 已修复
- **位置**: `server/server.js` 第 776-793 行
- **问题**: 在执行命令前未清除标记，可能导致重复执行
- **修复**: 在执行命令前先获取并清空标记

### 待优化项（低优先级）
- 实现命令执行结果反馈给用户
- 清理未使用的消息队列代码
- 添加更多错误日志和监控
- 考虑将 server 转换为标准服务端插件
