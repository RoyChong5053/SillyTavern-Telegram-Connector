# 并发消息串台 + 偶发"停止工作" 排查文档

> 最后更新：2026-08-07
> 对应提交：修复双 Bug（FIFO 串行队列 + ST 卡死看门狗 + 无限重连/自动刷新）

---

## 1. 现象

| 现象 | 说明 |
|------|------|
| 快速连发两条消息（如文本 + 补发的图片） | 插件只推送**最新**一条的回复，前一条被静默丢弃，日志无任何失败 |
| 偶发"停止工作" | Telegram 消息发出去，SillyTavern 没反应；`node server.js` 进程还活着；**刷新 ST 页面即恢复** |
| 两者都与网络无关 | 插件与 ST 跑在同一台电脑（`ws://127.0.0.1:2333`），本地回环不存在断网 |

## 2. 根因：是同一个 Bug 的两面

关键证据来自 ST 源码 `public/script.js`：

- ST 的 `Generate()` **没有内部并发锁**。UI 路径有守卫
  `if (is_send_press) return;`（script.js:1710），但**只有 UI 发送按钮会走这条路径**。
  本插件直接调用 `Generate()`，绕过了守卫。
- ST 的生成状态是**模块级单例**，被所有并发调用共享：
  - `is_send_press`（script.js:602）
  - `streamingProcessor`（script.js:455）
  - `abortController`（script.js:628）

### 故障链条

```
用户快速连发两条（文本 + 图片）
  → 前端 ws.onmessage 是 async，两条 user_message 被并发处理
    → 两个 Generate() 同时执行
      → 共享的 is_send_press / streamingProcessor / abortController 互相覆盖
        → ① 回复串台 / 前一条回复被吞掉        = Bug 1
        → ② ST 内部状态卡死
           （streamingProcessor 残留 / is_send_press 卡 true）
           → 之后所有 Generate() 静默无响应       = Bug 2
           → 只有刷新页面能重置 ST 的 JS 状态
              → 解释了"VNC 进去刷新就好"
```

### 之前的修复为什么没用

上一次提交（`871e6d6`）把 `handleFinalMessage` 里的 `lastProcessedChatId` 提前抓成局部变量，
只是缓解了"丢回复"，**没有消除并发本身**，ST 卡死的根源仍在。

---

## 3. 修复方案（本次提交）

### 3.1 前端 FIFO 串行队列（根治 Bug 1 + Bug 2）

`index.js` 新增：

```js
const messageQueue = [];
let processingMessage = false;
let currentJob = null;
```

- `user_message` 到达后**只入队**，由 `processQueue()` 串行处理。
- 一条消息完整走完（`sendMessageAsUser` → 附加 inline image → `Generate` → 最终回复送达 Telegram）后，
  才 `finishJob()` 处理下一条。
- 删除全局 `lastProcessedChatId` / `isStreamingMode`，改为 `currentJob` 上的字段，
  杜绝跨消息覆盖。
- 新增 `isGenerating()` 等待：若 ST 正在手动生成，先等待其完成再开始（上限 2 分钟）。

> 因为 ST 本来也只能同时生成一条，串行队列是正确的做法：既保住每个独立意图都能被回复，
> 又从源头消除了 ST 单例状态被并发打烂的可能。

### 3.2 ST 卡死看门狗（自愈）

`index.js` 三个看门狗计时器：

| 计时器 | 触发条件 | 动作 |
|--------|----------|------|
| `finalReplyTimer` | `Generate()` 成功返回后 30 秒内没收到最终回复 | 判 ST 卡死 |
| `activityTimer`（流式） | 流式模式下 60 秒无新 chunk | 判 ST 卡死 |
| `activityTimer`（非流式） | 15 分钟无任何响应（慢模型宽限） | 判 ST 卡死 |

判定卡死后：向 Telegram 发送错误提示 → `finishJob()` 让队列继续 → **自动刷新页面**。

### 3.3 无限重连 + 自动刷新兜底

- 重连改为**无限次数 + 指数退避**（1s → 2s → 4s → … → 30s 封顶 + 抖动）。
- 重连窗口耗尽（90 秒）→ 自动 `window.location.reload()`。
  - sessionStorage 记录次数，每会话最多自动刷新 **3 次**，防止服务器真挂时无限刷新循环。
  - 连接稳定超过 5 分钟自动清零计数。
- 前端心跳：每 15s 发 `{type:'heartbeat'}`；45 秒无任何消息判定"假死"连接，强制断开触发重连。
- 修复竞态：`connect()` 增加 `CONNECTING` 判断；`onclose`/`onerror` 用 `ws === this` 判空，
  防止旧 socket 误杀新 socket。

### 3.4 服务端修复（`server/server.js`）

- `ws.on('close')` / `ws.on('error')`：仅当 `sillyTavernClient === ws` 时才置空，
  避免旧连接断开事件误杀已重连的新连接（导致消息流静默全断）。
- 新增心跳应答：收到 `{type:'heartbeat'}` → 回复 `{type:'heartbeat_ack'}`。

---

## 4. 涉及文件与关键位置

| 文件 | 位置 | 改动 |
|------|------|------|
| `index.js` | 顶部常量区 | 队列/看门狗/重连/心跳常量 |
| `index.js` | `processQueue()` / `processMessageJob()` | FIFO 串行处理，替代原 `onmessage` 内联逻辑 |
| `index.js` | `onJobWedged()` | ST 卡死自愈入口 |
| `index.js` | `scheduleReconnect()` / `performAutoReload()` | 无限重连 + 自动刷新兜底 |
| `index.js` | `connect()` / `onclose` / `onerror` | CONNECTING 判断 + `ws === this` 判空 |
| `index.js` | `handleFinalMessage()` | 只处理 `currentJob`，发完调 `finishJob()` |
| `server/server.js` | `wss.on('connection')` 内 `heartbeat` 分支 | 心跳应答 |
| `server/server.js` | `ws.on('close')` / `ws.on('error')` | `sillyTavernClient === ws` 判空 |

## 5. 验证方式

1. **并发测试**：同聊天快速连发"文本 + 图片"两条 → 应**依次**生成两次回复，各自送达，无静默丢弃。
2. **重连测试**：`kill` 掉 `node server.js` 进程 → 前端应持续重连，进程重启后自动恢复；
   若一直连不上，约 90 秒后自动刷新页面（每会话最多 3 次）。
3. **卡死自愈**：人为让 ST 处于卡死状态（如并发 Generate 打烂状态后）→ 看门狗应报错并自动刷新恢复。

## 6. 已知限制

- 若用户在 Telegram 消息生成期间，**手动**在 ST 界面触发另一次生成，该手动生成的最终回复可能被误推给 Telegram。
  串行队列已大幅降低该概率，但无法完全消除（ST 本身单例状态所致）。
- 非流式慢模型使用 15 分钟活动宽限，极端情况下判断卡死会有延迟。
