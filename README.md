## 关于项目
非常抱歉，由于最近工作和生活上的事务越来越繁忙，我可能无法继续维护此项目。  
本项目代码完全开源，欢迎任何人随时Fork并进行自己的开发和改进。  
如果您对这个项目感兴趣，请随意将其作为您自己项目的起点，无需额外许可。  
感谢您的理解与支持。

# SillyTavern Telegram Connector

SillyTavern Telegram Connector 是一个为 SillyTavern 设计的扩展，允许用户通过 Telegram 与 SillyTavern 中的 AI 角色进行交互。该扩展建立了 SillyTavern 与 Telegram 机器人之间的桥接，使用户能够在移动设备上随时随地与他们喜爱的 AI 角色聊天。  
[![License](https://img.shields.io/github/license/RoyChong5053/SillyTavern-Telegram-Connector)](https://github.com/RoyChong5053/SillyTavern-Telegram-Connector/blob/main/LICENSE)
[![stars](https://img.shields.io/github/stars/RoyChong5053/SillyTavern-Telegram-Connector)](https://github.com/RoyChong5053/SillyTavern-Telegram-Connector)

## 功能特点

- **Telegram 集成**：通过 Telegram 应用与 SillyTavern 中的 AI 角色进行对话
- **实时同步**：Telegram 中的对话会实时同步到 SillyTavern 界面，反之亦然
- **命令支持**：提供多种 Telegram 命令，用于管理聊天和角色
  - `/help` - 显示所有可用命令
  - `/new` - 开始新的聊天
  - `/listchars` - 列出所有可用角色
  - `/switchchar <角色名称>` - 切换到指定角色
  - `/listchats` - 列出当前角色的所有聊天记录
  - `/switchchat <聊天名称>` - 切换到指定聊天记录
- **简单配置**：通过 WebSocket 连接，易于设置和使用

## 安装和使用

### 扩展安装

1. 在 SillyTavern 中，导航至 "Extensions" 标签页
2. 点击 "Install Extension"
3. 输入以下 URL: `https://github.com/RoyChong5053/SillyTavern-Telegram-Connector`
4. 点击 "Install" 按钮
5. 安装完成后，重启 SillyTavern

### 服务器设置

1. 克隆或下载此仓库到您的计算机
2. 进入 `server` 目录
3. 安装依赖：
   ```
   npm install node-telegram-bot-api ws
   ```
4. 复制 `config.example.js` 文件为 `config.js`：
   ```
   cp config.example.js config.js
   ```
   或在Windows系统中：
   ```
   copy config.example.js config.js
   ```
5. 编辑 `config.js` 文件，将 `YOUR_TELEGRAM_BOT_TOKEN_HERE` 替换为您的 Telegram Bot Token
   (可以通过 Telegram 的 [@BotFather](https://t.me/BotFather) 获取)
6. 启动服务器：
   ```
   node server.js
   ```

### 连接配置

1. 在 SillyTavern 中，进入 "Extensions" 标签页
2. 找到 "Telegram Connector" 部分
3. 在 "Bridge 服务器 WebSocket URL" 字段中输入 WebSocket 服务器地址
   (默认为 `ws://127.0.0.1:2333`)
4. 点击 "连接" 按钮
5. 状态显示 "已连接" 后，即可开始使用

### Telegram 使用方法

1. 在 Telegram 中，搜索并开始与您创建的机器人对话
2. 发送任何消息开始聊天
3. 您的消息将被发送到 SillyTavern，AI 的回复会自动发送回 Telegram
4. 使用 `/help` 命令查看所有可用命令

## 系统要求

- Node.js 14.0 或更高版本
- 运行中的 SillyTavern 实例
- 互联网连接（用于 Telegram API）
- 如果服务器在公网访问，建议使用 HTTPS/WSS

## 故障排除

- **连接问题**：确保 WebSocket 服务器正在运行，并且 URL 配置正确
- **Bot 无响应**：检查 Telegram Bot Token 是否正确，以及服务器日志中是否有错误
- **消息不同步**：确保 SillyTavern 扩展已连接到 WebSocket 服务器

## 支持和贡献

如果您遇到问题或有改进建议，请通过以下方式联系：

- 创建 GitHub Issue
- 联系作者：ZMou
- 访问作者主页：https://zmoutech.cn

欢迎提交 Pull Request 来改进此扩展！

## 许可证

本项目采用 GNU General Public License v3.0 (GPL-3.0) 许可证 - 详情请参阅 LICENSE 文件

## TODO

- **群聊功能增强**：
 - [ ] 响应群聊中@bot 的消息

- **媒体支持**：
 - [ ] 支持发送图片

- **消息格式**：
 - [ ] 实现 markdown 转义
 - [ ] Bot 信息解析方式改为 HTML 

- **架构优化**：
 - [x] 命令改为 server 处理，前端不再参与命令解析
 - [ ] 将 server 转换为标准服务端插件，遵循 [SillyTavern 服务端插件规范](https://docs.sillytavern.app/for-contributors/server-plugins/)

- **用户体验改进**：
 - [ ] 实现 WebSocket 心跳检测浏览器存活
 - [ ] 调整编辑消息的频率
 - [x] 流式传输优化：生成足够字数后再显示初始信息
 - [ ] "输入中"状态持续整个流式响应过程
 - [x] 新增 `/ping` 命令，让用户随时查询 Bridge 连接状态和 SillyTavern 状态
 - [x] 优化 setTimeout 等待 DOM 更新的处理方式

- **设置菜单**：
 - [ ] 扩展设置页新增白名单设置
 - [ ] 控制当角色切换等网页活动时是否向 Telegram 发送通知

- **错误处理与稳定性**：
 - [ ] `/exit` 命令总是"退出操作超时，强制退出进程"
 - [x] 处理 ST 中"停止生成"按钮点击事件（GENERATION_STOPPED 而非 GENERATION_ENDED）
 - [ ] 处理正在生成时发送新消息的情况（拦截并提示用户正在生成中，不提交到 ST）
 - [ ] 在 `/switchchar` 或 `/switchchat` 命令后通知 server 清空旧缓存状态
 - [x] 实现 AI 生成重试机制（最长 5 分钟，指数退避）
 - [x] 实现 Telegram API 重试机制（429/500 错误）
 - [x] 实现 WebSocket 自动重连
 - [x] 错误消息附带"重发"按钮，无需复制粘贴
 - [x] 自动清理重试失败后的残留消息

- **技术优化**：
 - [ ] 修复流式消息的 Promise 泄漏问题
 - [ ] 修复处理文档类型图片时的崩溃问题
 - [ ] 优化流式 chunk 的编辑节流逻辑
 - [ ] 添加流会话超时清理机制