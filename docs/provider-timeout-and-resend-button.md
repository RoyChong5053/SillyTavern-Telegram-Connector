# Provider 超时（fallback 竞态）+ 重发按钮发错消息 排查文档

> 最后更新：2026-08-07
> 对应提交：稳定性优化 v5（Provider 超时重试 & 重发按钮精确化）

---

## 1. 现象

| 现象 | 说明 |
|------|------|
| Telegram 端偶发 `Provider timed out after 24013ms` | 消息被撤回，附带"🔄 重发消息"按钮，提示"AI生成回复时遇到错误" |
| 重发按钮点下去重发的内容不对 | 发的是**上一条文本**，图片消息失败时尤其明显（可能发到上上轮的文本） |
| 出错后插件不再自动重试 | 直接把消息当永久错误处理，撤回 + 报错 |

## 2. 根因一：Provider 超时是"上游还在重试、ST 已放弃"的竞态

### 现场证据（one-api 日志 trace `3cd6d22f38d63b56`）

```
07:27:21  第一次请求 → channel 37 (gemini-3.6-flash, priority 15) 收到 429
         → one-api 将 channel 37 ability 置为 suspended
         → 因连续 429，channel 37 被自动禁用（status=3）
07:27:22  → 转走备用 channel 39 重试（remaining_attempts=12）
...
07:27:47  链路最终失败（~26s）
```

ST 侧的请求超时约 24s（报错显示 `24013ms`），而 one-api 的 fallback 链（含限流等待、备用 channel 连不上等）耗时约 **26s**。

```
provider 429 ──► one-api fallback 链（~26s）
                    │
ST 请求 24s 超时 ──┘► ST abort ──► 插件收到 "Provider timed out after 24013ms"
```

即：**上游 one-api 确实在做正确的 provider 切换，只是比 ST 的请求超时慢了一拍**。对插件而言这类错误是"延迟到达的瞬态错误"，重试是安全的。

### 旧代码的问题

`isRetryableError()` 的瞬态模式（`500/502/503/504/429/socket hang up/...`）里**没有匹配 `Provider timed out` 的子串**，所以它被归为永久错误：

```
"Provider timed out after 24013ms"
  → permanentPatterns? 否
  → transientPatterns? 否（无匹配）
  → 视为不可重试
    → deleteLastMessage() 撤回用户消息 + 发错误 + 🔄按钮
```

### 修复

瞬态模式新增 `'timed out'` / `'provider timed out'` / `'timeout'` / `'aborted'` / `'abort'`。这类错误现在走正常的指数退避重试（最长 5 分钟）。永久错误（401/403/配额/安全过滤）优先级不变，仍立即失败。

## 3. 根因二：重发按钮按 chatId 存"最后一条文本"，丢消息内容

### 旧代码数据流

```
index.js 失败时: error_message { chatId, text }          ← 只有错误文案，没有原始消息
server.js:       lastMessages.set(chatId, text)          ← 只有用户"文本消息"会记录
                 resend_<chatId>                         ← 按钮只带 chatId
回调时:          lastMessages.get(chatId) → 重发最近一条文本
```

三个缺陷：

1. **图片消息从不记录**：`handlePhotoMessage()` 不走 `lastMessages.set()`，图片失败后 `lastMessages` 里是上一条（甚至上上轮）文本
2. **同 chat 多条消息互相覆盖**：键只有 `chatId`，后发覆盖先发，重发永远不是"当时那条"
3. **回调数据只带 chatId**：Telegram `callback_data` 上限 64 字节，本来就塞不下消息内容，只能退化成"重发最近一条"

### 修复

- **index.js**：三个失败路径的 `error_message` 载荷都附带原始失败消息 `resendText` / `resendInlineImage`
- **server.js**：
  - 新增 `pendingResends` Map，以**每次失败的唯一 token** 为 key，存 `{ chatId, text, inlineImage, ts }`
  - 按钮 `callback_data` 改为 `resend_<token>`（token 很短，远低于 64 字节限制）
  - 回调时按 token 精确找回原始文本 + 图片重发；图片消息（含 caption）也能正确重发
  - token 用完立即删除，防止重复重发；上限 100 条，超限淘汰最旧记录
  - `lastMessages` 保留（现在存对象 `{text, inlineImage, ts}`），用于兼容旧格式按钮 / token 失效后的回退

## 4. 根因三：看门狗会误杀正在退避等待的重试

- 看门狗在**重试循环之前**武装，流式场景 60s（`STREAM_SILENCE_TIMEOUT_MS`）无新 chunk 即判 ST 卡死
- 但流式 chunk 只在生成时有，**退避等待期间没有 chunk**；累计退避 3+6+12+24... 可能超过 60s
- 结果：ST 还在正常重试，页面却因为看门狗触发自动刷新

### 修复

每次重试尝试前调用 `armActivityTimer(job)` 重置计时，给每次重试一个完整的新预算。

## 5. 修改文件

| 文件 | 改动 |
|------|------|
| `index.js` | `isRetryableError` 新增 timeout/abort 瞬态模式；`error_message` 附带 `resendText`/`resendInlineImage`；每次重试重置看门狗 |
| `server/server.js` | 新增 `pendingResends` 按消息存储 + token 按钮；callback 精确重发文本+图片；图片消息记录 `lastMessages` |
| `CHANGELOG.md` | 新增 v5 条目 |

## 6. 备注（本次未改动）

- one-api 侧的 fallback 链在日志里是**正确工作**的（429 → suspended → 禁用 → 切备用 channel），真正的落差是"fallback 比 ST 请求超时慢"。要让用户体验更好，理想方案是给 ST 的请求超时留足余量（或让 one-api 预检 channel 可用性），但这属于 one-api / ST 侧调优，**不在本插件范围内**，本次只修插件侧行为。
- 若后续仍频繁触发：可考虑降低 ST 生成请求的超时值以匹配 one-api fallback 速度，或给 one-api 配置更高优先级 channel，减少 fallback 概率。
