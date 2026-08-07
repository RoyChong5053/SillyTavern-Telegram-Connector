# Changelog - SillyTavern Telegram Connector

## 2026-08-07 - 稳定性优化 v5（Provider 超时重试 & 重发按钮精确化）

### 背景
用户在 Telegram 端偶发收到 `Provider timed out after 24013ms` 错误。排查确认：底层 one-api 其实发生了 provider 自动 fallback（429 → 切换到备用 channel），但整条 fallback 链耗时约 26s，超过 ST 请求超时（约 24s），ST 将请求标记为超时中止。这是"上游还在重试、ST 已放弃"的竞态，对插件而言属于可重试的瞬态错误，却被当成了永久错误。

### 核心修复

#### 1. 提供方超时/中断归类为可重试（index.js）
- `isRetryableError()` 的瞬态模式新增 `'timed out'` / `'provider timed out'` / `'timeout'` / `'aborted'` / `'abort'`
- 这类错误现在会进入指数退避重试（最长 5 分钟），而不是直接撤回消息 + 报错
- 永久错误（401/403/配额/安全过滤）优先级不变，仍立即失败

#### 2. 重发按钮精确重发（index.js + server/server.js）
- **旧问题**: server 端 `lastMessages` 只按 `chatId` 存**文本**，图片消息从不记录；错误按钮 `resend_<chatId>` 只会重发"上一条文本"——图片失败后点重发会发错消息甚至发到上上轮的文本
- **修复**:
  - index.js 在所有 `error_message` 载荷中附带 `resendText` / `resendInlineImage`（即失败消息的原文与图片）
  - server.js 新增 `pendingResends` 按消息维度存储，每次失败生成唯一 token（`resend_<token>` 作为按钮 callback_data，规避 Telegram 64 字节限制）
  - 点击按钮按 token 精确找回原始文本 + 图片并重发，图片消息也照常重发
  - 图片消息（`handlePhotoMessage`）现在也会记录进 `lastMessages`，兼容旧格式按钮
  - token 使用后立即失效，防止重复重发；`pendingResends` 上限 100 条，超限淘汰最旧记录

#### 3. 看门狗不再误杀合法重试（index.js）
- 每次重试尝试前重置活动看门狗计时器（`armActivityTimer(job)`）
- 避免累计退避时长（3s→30s 递增）触发"流式 60s 无新 chunk"误判，把还在退避等待的重试当成 ST 卡死而自动刷新

### 修改文件

| 文件 | 改动 |
|------|------|
| `index.js` | isRetryableError 新增 timeout/abort 瞬态模式；error_message 附带 resendText/resendInlineImage；每次重试重置看门狗 |
| `server/server.js` | 新增 pendingResends 按消息存储；error_message 用 token 按钮；callback 精确重发文本+图片；图片消息记录 lastMessages |

### 验证
- `node --check` 通过（index.js / server/server.js）

---

## 2026-08-07 - 稳定性优化 v4（并发串台根治 & ST 卡死自愈）

### 核心 Bug 修复

#### 1. 修复并发消息串台 / 丢回复（快速连发文本+图片只回最新一条）
- **根因**: `ws.onmessage` 是 `async`，两条 `user_message` 被并发处理，两个 `Generate()` 同时执行。ST 的 `Generate()` 无内部并发锁（`is_send_press` 守卫只在 UI 路径），`is_send_press` / `streamingProcessor` / `abortController` 均为模块级单例，被并发调用互相覆盖，导致回复串台或静默丢失
- **修复**: 前端新增 FIFO 串行消息队列（`messageQueue` / `processingMessage` / `currentJob`），一条完整走完再处理下一条；删除全局 `lastProcessedChatId` / `isStreamingMode`，改为 `currentJob` 上的字段；新增 `isGenerating()` 等待 ST 空闲

#### 2. 修复偶发"停止工作"（刷新页面即恢复）
- **根因**: 并发 Generate 会把 ST 内部状态卡死（`streamingProcessor` 残留 / `is_send_press` 卡 true），之后所有 Generate() 静默无响应，只有刷新页面能重置 ST 的 JS 状态
- **修复**:
  - FIFO 串行队列从源头杜绝并发 Generate
  - 新增 ST 卡死看门狗（生成完成 30s 无最终回复 / 流式 60s 无新 chunk / 非流式 15 分钟无响应 → 判卡死 → 发错误提示 → 自动刷新自愈）
  - 重连改为无限次数 + 指数退避（1s→30s 封顶），重连窗口耗尽（90s）自动刷新页面（sessionStorage 限制每会话最多 3 次，连接稳定 5 分钟清零）
  - 前端心跳 15s + 45s 假死判定，强制断开触发重连
  - 修复 `connect()` CONNECTING 竞态；`onclose`/`onerror` 用 `ws === this` 判空

#### 3. 服务端修复（server/server.js）
- `ws.on('close')` / `ws.on('error')` 仅当 `sillyTavernClient === ws` 时才置空，避免旧连接断开事件误杀已重连的新连接（消息流静默全断的隐患）
- 新增 `{type:'heartbeat'}` → `{type:'heartbeat_ack'}` 应答

### 修改文件

| 文件 | 改动 |
|------|------|
| `index.js` | FIFO 串行队列 + ST 卡死看门狗 + 无限重连/心跳/自动刷新兜底 |
| `server/server.js` | sillyTavernClient 判空 + 心跳应答 |
| `docs/concurrent-messages-and-st-freeze.md` | 新增排查文档 |

---

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
