# 贡献指南

感谢您考虑为 SillyTavern Telegram Connector 项目做出贡献！以下是一些指导方针，帮助您参与项目开发。

## 如何贡献

### 报告问题

如果您发现了 bug 或有功能建议，请通过 GitHub Issues 提交：

1. 在提交前，请先搜索现有的 Issues，避免重复
2. 使用清晰的标题描述问题
3. 详细描述问题或建议，尽可能提供：
   - 复现步骤
   - 预期行为
   - 实际行为
   - 错误信息和日志
   - 系统环境信息

### 提交代码

1. Fork 本仓库
2. 创建您的特性分支：`git checkout -b feature/amazing-feature`
3. 提交您的更改：`git commit -m '添加某某功能'`
4. 推送到分支：`git push origin feature/amazing-feature`
5. 提交 Pull Request

### Pull Request 指南

- 确保代码符合项目的编码风格
- 更新文档以反映您的更改
- 保持 PR 专注于单一功能或修复
- 在 PR 描述中清晰说明您的更改内容和目的

## 开发设置

### 前提条件

- Node.js 14.0 或更高版本
- 已安装的 SillyTavern 实例

### 本地开发

1. 克隆仓库：
   ```bash
   git clone https://github.com/RoyChong5053/SillyTavern-Telegram-Connector.git
   cd SillyTavern-Telegram-Connector
   ```

2. 设置服务器：
   ```bash
   cd server
   npm install
   ```

3. 创建 Telegram Bot：
   - 使用 [@BotFather](https://t.me/BotFather) 创建一个新的 Telegram Bot
   - 获取 Bot Token
   - 在 `server.js` 中替换 TOKEN 变量

4. 启动服务器：
   ```bash
   npm run dev
   ```

5. 将扩展安装到 SillyTavern：
   - 在 SillyTavern 中，使用本地文件路径安装扩展
   - 或者使用 URL 安装：`http://localhost:你的端口/SillyTavern-Telegram-Connector`

## 代码风格

- 使用有意义的变量和函数名称
- 添加适当的注释
- 遵循 JavaScript 标准实践

## 许可证

通过提交 Pull Request，您同意您的贡献将在 [GPL-3.0 许可证](LICENSE) 下发布。 