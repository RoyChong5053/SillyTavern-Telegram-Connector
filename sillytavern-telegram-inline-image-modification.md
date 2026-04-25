# SillyTavern Telegram 插件图片功能改造实录

> 从零到一：给 SillyTavern-Telegram-Connector 加 inline image 支持
> 日期：2026-04-16

---

## 1. 问题背景

原始插件只支持纯文本消息。用户在 Telegram 发送图片时，插件完全无法处理——要么忽略，要么报错。

其他 AI（DeepSeek、Opus 4.6）尝试过修复，但都失败了：
- DeepSeek：搞坏了插件，连基础文本功能都崩了
- Opus 4.6：花了 $10，搞出来的方案是用 CLIP 做 image caption（古董方案），不是直接传图给 API

**目标**：实现 Telegram 图片 → 下载 → base64 → SillyTavern inline image → 直接发给后端 API 的完整链路。

---

## 2. 架构理解

### 2.1 插件是双端架构

```
Telegram Bot  ←→  server.js (Node.js 后端)  ←→  WebSocket  ←→  index.js (ST 前端)
```

- **server.js**：运行在 `server/` 目录下，负责 Telegram Bot 轮询、消息接收、WebSocket 转发
- **index.js**：SillyTavern 扩展前端，运行在浏览器中，负责调用 ST 内部 API（`sendMessageAsUser`、`Generate` 等）

### 2.2 SillyTavern 的消息传递机制

关键发现：SillyTavern 的 `sendMessageAsUser()` **只接受文本参数**，不接受图片。

所以图片必须在消息创建后，通过修改 `chat` 数组中最后一条消息的 `extra.media` 数组来附加：

```javascript
// 消息创建后，手动注入图片
const lastMsg = context.chat[context.chat.length - 1];
lastMsg.extra.media.push({
    url: data.inlineImage,     // base64 data URI
    type: 'image',
    title: 'Telegram Image',
    source: 'api',
});
lastMsg.extra.inline_image = true;
```

---

## 3. 修改内容

### 3.1 server.js 修改（后端）

#### 新增依赖
```javascript
const https = require('https');  // 用于下载 Telegram 图片
```

#### 新增 `downloadPhoto()` 函数
```javascript
function downloadPhoto(fileId) {
    return new Promise((resolve, reject) => {
        bot.getFileLink(fileId).then(fileUrl => {
            const url = new URL(fileUrl);
            const options = {
                hostname: url.hostname,
                path: url.pathname + url.search,
                method: 'GET',
            };
            const chunks = [];
            https.get(options, (res) => {
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', () => {
                    const buffer = Buffer.concat(chunks);
                    resolve(buffer);
                });
            }).on('error', reject);
        }).catch(reject);
    });
}
```

**知识点**：
- Telegram Bot API 的 `getFileLink()` 返回的是一个临时 URL
- 需要用原生 `https.get` 下载，不能用 `fetch`（Node.js 版本可能不支持）
- 用 `Buffer.concat` 合并 chunks，得到完整图片二进制

#### 新增 `handlePhotoMessage()` 函数
```javascript
async function handlePhotoMessage(msg, chatId) {
    // 1. 获取最高分辨率图片的 file_id
    const photos = msg.photo;
    const fileId = photos[photos.length - 1].file_id;

    // 2. 下载图片
    const buffer = await downloadPhoto(fileId);

    // 3. 转 base64
    const base64 = buffer.toString('base64');

    // 4. MIME 类型检测（通过文件头字节）
    let mimeType = 'image/jpeg';
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
        mimeType = 'image/png';
    } else if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
        mimeType = 'image/gif';
    } else if (buffer[0] === 0x57 && buffer[1] === 0x45 && buffer[2] === 0x42 && buffer[3] === 0x50) {
        mimeType = 'image/webp';
    }

    const inlineImageUri = `data:${mimeType};base64,${base64}`;

    // 5. 通过 WebSocket 发给前端
    const payload = JSON.stringify({
        type: 'user_message',
        chatId,
        text: msg.caption || '',
        inlineImage: inlineImageUri,
    });
    sillyTavernClient.send(payload);
}
```

**知识点**：
- Telegram 的 `msg.photo` 是一个数组，包含多种分辨率，**最后一个元素是最高分辨率**
- `msg.caption` 是图片附带的文字说明，作为消息文本一起发送
- SillyTavern inline image 格式是 `data:<mime>;base64,<data>` 的 data URI

#### 修改消息监听器
在 `bot.on('message', ...)` 回调中，在文本处理之前插入图片检测：

```javascript
// 处理图片消息（msg.photo 是 Telegram 原生图片）
if (msg.photo) {
    await handlePhotoMessage(msg, chatId);
    return;
}

// 处理图片文档（用户以文件形式发送的图片）
if (msg.document && (msg.document.mime_type || '').startsWith('image/')) {
    await handlePhotoMessage(msg, chatId);
    return;
}
```

**知识点**：
- Telegram 有两种发图方式：原生图片（`msg.photo`）和文件（`msg.document`）
- 必须两种都处理，否则用户用"发送文件"方式发图时会失效
- 图片处理完后要 `return`，避免落入后面的文本处理逻辑

### 3.2 index.js 修改（前端）

在 `user_message` 处理流程中，`sendMessageAsUser()` 之后插入图片注入逻辑：

```javascript
// 1. 先将文本消息发给 ST
await sendMessageAsUser(data.text);

// 2. 如果有 inline image，附加到最后一条消息
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

        // 保存聊天
        if (context.saveChatConditional) {
            await context.saveChatConditional();
        }
    }
}
```

**知识点**：
- 顺序很重要：必须先 `sendMessageAsUser()` 创建消息，再修改 `extra.media`
- `lastMsg.is_user` 校验确保我们修改的是刚创建的用户消息
- `saveChatConditional()` 确保修改持久化到磁盘
- `extra.inline_image = true` 是 SillyTavern 内部标记，告诉后端这是 inline 图片

---

## 4. 关键踩坑记录

| 坑 | 原因 | 解决方案 |
|---|---|---|
| `sendMessageAsUser` 不接受图片 | ST 内部 API 设计如此，只接受文本 | 消息创建后修改 `chat` 数组 |
| 文件方式发图不生效 | 只处理了 `msg.photo`，没处理 `msg.document` | 增加 MIME type 检测分支 |
| 图片分辨率太低 | 取了 `photos[0]`（最低分辨率） | 改为 `photos[photos.length - 1]` |
| MIME type 错误 | 硬编码 `image/jpeg` | 通过文件头字节检测真实类型 |
| 其他 AI 搞出 CLIP caption | 没理解 ST 的 inline image 机制 | 直接传 base64 data URI 给 API |

---

## 5. 数据流全景

```
用户在 Telegram 发图
    │
    ▼
Telegram Bot 收到 msg.photo / msg.document
    │
    ▼
server.js: handlePhotoMessage()
    ├── bot.getFileLink(fileId)  → 获取临时下载 URL
    ├── https.get()  → 下载二进制
    ├── Buffer → base64 转换
    ├── 文件头字节检测 MIME type
    └── WebSocket 发送 { type: 'user_message', inlineImage: 'data:...' }
    │
    ▼
index.js: ws.onmessage 收到 user_message
    ├── sendMessageAsUser(text)  → 创建文本消息
    ├── context.chat[last].extra.media.push({ url: inlineImage })
    ├── extra.inline_image = true
    └── saveChatConditional()
    │
    ▼
SillyTavern Generate() 触发
    └── 图片作为 inline image 一起发给后端 API（OpenAI/Claude 等）
```

---

## 6. 文件清单

| 文件 | 修改类型 | 说明 |
|---|---|---|
| `server/server.js` | 新增函数 + 修改监听器 | 图片下载、base64 转换、MIME 检测、WS 转发 |
| `index.js` | 修改 user_message 处理流程 | inline image 注入到 chat 数组 |
| `server/config.js` | 无修改 | 配置文件，不涉及图片功能 |

---

## 7. 经验总结

1. **读源码比猜结构快**：先看 `sendMessageAsUser` 的签名和 `chat` 数组的结构，再动手改
2. **双端架构要两边都改**：后端负责下载和转发，前端负责注入到 ST 数据结构
3. **Telegram 有两种图片通道**：原生 `photo` 和文件 `document`，都要覆盖
4. **base64 data URI 是通用方案**：不需要 CLIP、不需要 caption，直接把图片二进制编码成 data URI 塞给 API
5. **顺序决定成败**：先创建消息 → 再修改 extra → 再保存，顺序反了就全崩
