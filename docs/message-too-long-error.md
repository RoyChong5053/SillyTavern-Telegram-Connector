# `ETELEGRAM: 400 Bad Request: message is too long` 错误排查文档

## 现象

```
[2026-06-20 18:29:18] 发送非流式AI回复失败: ETELEGRAM: 400 Bad Request: message is too long
```

偶尔也会在流式模式下出现：

```
编辑 Telegram 消息失败: ETELEGRAM: 400 Bad Request: message is too long
```

## 根因分析

### 1. Telegram Bot API 的硬性限制

| 限制项 | 数值 | 说明 |
|--------|------|------|
| `sendMessage` 单条消息最大字符数 | **4096** | Telegram 服务端强制拒绝 |
| `editMessageText` 单条消息最大字符数 | **4096** | 同上 |

这是 **Telegram Bot API 的服务端硬限制**，不是库的限制，也不是插件的限制。任何 Bot 都受此约束。

### 2. Token ≠ 字符

常见误区：

| 概念 | 说明 |
|------|------|
| **Token** | LLM 的计量单位，1 token ≈ 0.75 个英文单词 或 1~2 个中文字 |
| **字符** | Telegram 的实际计数单位，一个中文字 = 1 个字符 |

所以"4000 tokens 都能发，这次怎么不行？"的原因：

- 4000 tokens 的中文文本 ≈ **4000~8000 个字符**
- 如果这次 AI 回复包含 CoT、思考链、多轮修正输出，字符数很容易突破 4096
- **即使肉眼看起来"短"，实际累积的字符数可能已经超限**

过去几个月没触发是因为回复刚好在 4096 以内，这次遇到长回复就暴露了。

### 3. 插件为什么没有兜住

`server/server.js` 中所有 `bot.sendMessage()` 调用 **都没有做长度检查**，也没有消息分片逻辑：

```javascript
// line 753 — 非流式 AI 回复
await bot.sendMessage(data.chatId, data.text).catch(err => {
    logWithTimestamp('error', `发送非流式AI回复失败: ${err.message}`);
});

// line 695 — 流式最终更新
await bot.editMessageText(data.text, {
    chat_id: data.chatId,
    message_id: messageId,
}).catch(err => {
    if (!err.message.includes('message is not modified'))
        logWithTimestamp('error', '编辑最终格式化 Telegram 消息失败:', err.message);
});
```

代码中搜索 `4096`、`MAX_MESSAGE_LENGTH`、`split`、`chunk` 等关键词：**无任何匹配**。

## 受影响的两条代码路径

### 路径 A：非流式模式（ai_reply）

```
SillyTavern GENERATION_ENDED
  → index.js handleFinalMessage()
    → 从 DOM 获取 renderedText (index.js:569-577)
    → ws.send({ type: 'ai_reply', text: renderedText })
      → server.js 收到
        → bot.sendMessage(chatId, text)  ← 此处溢出
```

### 路径 B：流式模式（final_message_update）

```
SillyTavern GENERATION_ENDED
  → index.js handleFinalMessage()
    → 从 DOM 获取 renderedText
    → ws.send({ type: 'final_message_update', text: renderedText })
      → server.js 收到
        → bot.editMessageText(text, ...)  ← 此处溢出
```

## 可能加剧问题的因素

### CoT（思考链）被塞入回复

部分模型（尤其是开启了 CoT 的模型）会在最终回复中插入大段思考过程：

```
...
综合以上分析，用户可能遇到的是...
```

这些内容会被 SillyTavern 渲染到 `mes_text` 中，然后被插件完整抓取发送给 Telegram，**大幅增加字符数**。

### HTML 渲染解析的潜在 bug

`index.js:569-577` 获取文本的方式：

```javascript
let renderedText = messageTextElement.html()           // 获取带 HTML 标签的内容
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p>/gi, '\n\n')
const tempDiv = document.createElement('div');
tempDiv.innerHTML = renderedText;
renderedText = tempDiv.textContent;                    // 剥离 HTML 标签
```

`textContent` 会递归获取**所有子元素的文本**。如果 `mes_text` 内部包含隐藏 UI 元素（如 swipe 按钮、token 计数器、时间戳等），它们的文本也会被抓取，导致最终文本意外膨胀。

## 解决方案建议

### 方案 A：消息分片（推荐，兜底方案）

在 `server/server.js` 中添加分片函数，对所有 `sendMessage` 和 `editMessageText` 做保护：

```javascript
const MAX_TELEGRAM_LENGTH = 4096;

function splitMessage(text, maxLength = MAX_TELEGRAM_LENGTH) {
    if (text.length <= maxLength) return [text];

    const chunks = [];
    let remaining = text;

    while (remaining.length > 0) {
        if (remaining.length <= maxLength) {
            chunks.push(remaining);
            break;
        }

        // 优先在换行处拆分
        let splitAt = remaining.lastIndexOf('\n', maxLength);
        if (splitAt === -1 || splitAt < maxLength * 0.5) {
            // 没有合适换行，在句号/问号处拆分
            splitAt = Math.max(
                remaining.lastIndexOf('。', maxLength),
                remaining.lastIndexOf('.', maxLength),
                remaining.lastIndexOf('？', maxLength),
                remaining.lastIndexOf('?', maxLength),
                remaining.lastIndexOf('\n', maxLength),
            );
        }
        if (splitAt === -1 || splitAt < maxLength * 0.3) {
            // 实在找不到分割点，硬切
            splitAt = maxLength;
        }

        chunks.push(remaining.slice(0, splitAt + 1));
        remaining = remaining.slice(splitAt + 1).trim();
    }

    return chunks.map((chunk, i) => `(${i + 1}/${chunks.length})\n${chunk}`);
}
```

**对 `sendMessage`：** 循环发送多个消息。
**对 `editMessageText`：** 无法拆分多条，只能截断到 4096（streaming 本身就是同一个消息的持续编辑）。

### 方案 B：CoT 过滤（可选）

在 `index.js` 获取 `renderedText` 后，用正则剥离常见的 CoT 包裹标记：

```javascript
// 移除常见的 CoT 包裹
renderedText = renderedText
    .replace(/```[\s\S]*?```/g, '')     // 移除代码块
    .replace(/\u0001.*?\u0001/g, '')    // 移除 ... 包裹
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<antThinking>[\s\S]*?<\/antThinking>/gi, '');
```

但需谨慎：CoT 过滤无法覆盖所有模型，且可能误删有用内容。

## 调试建议

下次遇到此错误时，可以通过以下方式确认实际字符数：

1. **在 `server.js` line 753 之前加日志：**
   ```javascript
   logWithTimestamp('log', `AI回复长度: ${data.text.length} 字符`);
   ```

2. **或手动统计：** 将收到的 Telegram 消息（如果有部分发送成功的）复制出来，用 `wc -c` 或 `wc -m` 统计

3. **区分 token 和字符：** 在 ST 中查看生成统计（tokens），同时对比 Telegram 的 4096 字符限制

## 参考链接

- [Telegram Bot API sendMessage 文档](https://core.telegram.org/bots/api#sendmessage)
- [Telegram Bot API 限制说明](https://core.telegram.org/bots/faq#what-message-length-limits-are-there)
- `node-telegram-bot-api` 版本: 0.64.0（见 `server/package.json`）
