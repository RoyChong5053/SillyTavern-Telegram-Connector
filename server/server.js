// server.js
const TelegramBot = require('node-telegram-bot-api');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const https = require('https');

// 添加日志记录函数，带有时间戳
function logWithTimestamp(level, ...args) {
    const now = new Date();

    // 使用本地时区格式化时间
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');

    const timestamp = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    const prefix = `[${timestamp}]`;

    switch (level) {
        case 'error':
            console.error(prefix, ...args);
            break;
        case 'warn':
            console.warn(prefix, ...args);
            break;
        default:
            console.log(prefix, ...args);
    }
}

// 重启保护 - 防止循环重启
const RESTART_PROTECTION_FILE = path.join(__dirname, '.restart_protection');
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 60000; // 1分钟

// 检查是否可能处于循环重启状态
function checkRestartProtection() {
    try {
        if (fs.existsSync(RESTART_PROTECTION_FILE)) {
            const data = JSON.parse(fs.readFileSync(RESTART_PROTECTION_FILE, 'utf8'));
            const now = Date.now();

            // 清理过期的重启记录
            data.restarts = data.restarts.filter(time => now - time < RESTART_WINDOW_MS);

            // 添加当前重启时间
            data.restarts.push(now);

            // 如果在时间窗口内重启次数过多，则退出
            if (data.restarts.length > MAX_RESTARTS) {
                logWithTimestamp('error', `检测到可能的循环重启！在${RESTART_WINDOW_MS / 1000}秒内重启了${data.restarts.length}次。`);
                logWithTimestamp('error', '为防止资源耗尽，服务器将退出。请手动检查并修复问题后再启动。');

                // 如果有通知chatId，尝试发送错误消息
                if (process.env.RESTART_NOTIFY_CHATID) {
                    const chatId = parseInt(process.env.RESTART_NOTIFY_CHATID);
                    if (!isNaN(chatId)) {
                        // 创建临时bot发送错误消息
                        try {
                            const tempBot = new TelegramBot(require('./config').telegramToken, { polling: false });
                            tempBot.sendMessage(chatId, '检测到循环重启！服务器已停止以防止资源耗尽。请手动检查问题。')
                                .finally(() => process.exit(1));
                        } catch (e) {
                            process.exit(1);
                        }
                        return; // 等待消息发送后退出
                    }
                }

                process.exit(1);
            }

            // 保存更新后的重启记录
            fs.writeFileSync(RESTART_PROTECTION_FILE, JSON.stringify(data));
        } else {
            // 创建新的重启保护文件
            fs.writeFileSync(RESTART_PROTECTION_FILE, JSON.stringify({ restarts: [Date.now()] }));
        }
    } catch (error) {
        logWithTimestamp('error', '重启保护检查失败:', error);
        // 出错时继续执行，不要阻止服务器启动
    }
}

// 启动时检查重启保护
checkRestartProtection();

// 检查配置文件是否存在
const configPath = path.join(__dirname, './config.js');
if (!fs.existsSync(configPath)) {
    logWithTimestamp('error', '错误: 找不到配置文件 config.js！');
    logWithTimestamp('error', '请在server目录下复制 config.example.js 为 config.js，并设置您的Telegram Bot Token');
    process.exit(1); // 终止程序
}

const config = require('./config');

// --- 配置 ---
// 从配置文件中获取Telegram Bot Token和WebSocket端口
const token = config.telegramToken;
// WebSocket服务器端口
const wssPort = config.wssPort;

// 检查是否修改了默认token
if (token === 'TOKEN' || token === 'YOUR_TELEGRAM_BOT_TOKEN_HERE') {
    logWithTimestamp('error', '错误: 请先在config.js文件中设置你的Telegram Bot Token！');
    logWithTimestamp('error', '找到 telegramToken: \'YOUR_TELEGRAM_BOT_TOKEN_HERE\' 这一行并替换为你从BotFather获取的token');
    process.exit(1); // 终止程序
}

// 初始化Telegram Bot，但不立即启动轮询
const bot = new TelegramBot(token, { polling: false });
logWithTimestamp('log', '正在初始化Telegram Bot...');

// 手动清除所有未处理的消息，然后启动轮询
(async function clearAndStartPolling() {
    try {
        logWithTimestamp('log', '正在清除Telegram消息队列...');

        // 检查是否是重启，如果是则使用更彻底的清除方式
        const isRestart = process.env.TELEGRAM_CLEAR_UPDATES === '1';
        if (isRestart) {
            logWithTimestamp('log', '检测到重启标记，将执行更彻底的消息队列清理...');
            // 获取更新并丢弃所有消息
            let updates;
            let lastUpdateId = 0;

            // 循环获取所有更新直到没有更多更新
            do {
                updates = await bot.getUpdates({
                    offset: lastUpdateId,
                    limit: 100,
                    timeout: 0
                });

                if (updates && updates.length > 0) {
                    lastUpdateId = updates[updates.length - 1].update_id + 1;
                    logWithTimestamp('log', `清理了 ${updates.length} 条消息，当前offset: ${lastUpdateId}`);
                }
            } while (updates && updates.length > 0);

            // 清除环境变量
            delete process.env.TELEGRAM_CLEAR_UPDATES;
            logWithTimestamp('log', '消息队列清理完成');
        } else {
            // 普通启动时的清理
            const updates = await bot.getUpdates({ limit: 100, timeout: 0 });
            if (updates && updates.length > 0) {
                // 如果有更新，获取最后一个更新的ID并设置offset为它+1
                const lastUpdateId = updates[updates.length - 1].update_id;
                await bot.getUpdates({ offset: lastUpdateId + 1, limit: 1, timeout: 0 });
                logWithTimestamp('log', `已清除 ${updates.length} 条待处理消息`);
            } else {
                logWithTimestamp('log', '没有待处理消息需要清除');
            }
        }

        // 启动轮询
        bot.startPolling({
            restart: true,
            clean: true
        });
        logWithTimestamp('log', 'Telegram Bot轮询已启动');
    } catch (error) {
        logWithTimestamp('error', '清除消息队列或启动轮询时出错:', error);
        // 如果清除失败，仍然尝试启动轮询
        bot.startPolling({ restart: true, clean: true });
        logWithTimestamp('log', 'Telegram Bot轮询已启动（清除队列失败后）');
    }
})();

// 初始化WebSocket服务器
const wss = new WebSocket.Server({ port: wssPort });
logWithTimestamp('log', `WebSocket服务器正在监听端口 ${wssPort}...`);

// WebSocket心跳检测：每30秒ping客户端
const HEARTBEAT_INTERVAL_MS = 30000;
const heartbeatTimer = setInterval(() => {
    wss.clients.forEach(ws => {
        if (ws.isAlive === false) {
            logWithTimestamp('warn', 'WebSocket客户端心跳超时，断开连接');
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
    });
}, HEARTBEAT_INTERVAL_MS);

wss.on('close', () => {
    clearInterval(heartbeatTimer);
});

let sillyTavernClient = null; // 用于存储连接的SillyTavern扩展客户端

// 用于存储正在进行的流式会话，调整会话结构，使用Promise来处理messageId
// 结构: { messagePromise: Promise<number> | null, lastText: String, timer: NodeJS.Timeout | null, isEditing: boolean }
const ongoingStreams = new Map();

// 用于存储每个聊天最后一条消息的内容（文本/图片），以便兼容旧格式按钮重发
const lastMessages = new Map();

// 用于存储每个聊天最近一条成功送达的AI回复全文，供 /repush 命令重新推送
const lastAiReplies = new Map();

// 用于精确重发：每次失败生成唯一 token 作为 key，保存失败消息的原文与图片。
// Telegram callback_data 限制 64 字节，因此不能把消息内容塞进按钮，只能存服务端。
const pendingResends = new Map();
const MAX_PENDING_RESENDS = 100;

function createResendToken() {
    return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function recordPendingResend(chatId, text, inlineImage) {
    const token = createResendToken();
    pendingResends.set(token, { chatId, text, inlineImage: inlineImage || null, ts: Date.now() });

    // 防止无限增长：超过上限时淘汰最旧的记录
    if (pendingResends.size > MAX_PENDING_RESENDS) {
        let oldestKey = null;
        let oldestTs = Infinity;
        pendingResends.forEach((v, k) => {
            if (v.ts < oldestTs) {
                oldestTs = v.ts;
                oldestKey = k;
            }
        });
        if (oldestKey) pendingResends.delete(oldestKey);
    }
    return token;
}

// Telegram 消息长度限制
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
        let splitAt = remaining.lastIndexOf('\n', maxLength);
        if (splitAt === -1 || splitAt < maxLength * 0.5) {
            splitAt = Math.max(
                remaining.lastIndexOf('。', maxLength),
                remaining.lastIndexOf('.', maxLength),
                remaining.lastIndexOf('？', maxLength),
                remaining.lastIndexOf('?', maxLength),
                remaining.lastIndexOf('\n', maxLength),
            );
        }
        if (splitAt === -1 || splitAt < maxLength * 0.3) {
            splitAt = maxLength;
        }
        chunks.push(remaining.slice(0, splitAt + 1));
        remaining = remaining.slice(splitAt + 1).trim();
    }
    if (chunks.length > 1) {
        return chunks.map((chunk, i) => `(${i + 1}/${chunks.length})\n${chunk}`);
    }
    return chunks;
}

function sendSplitMessage(chatId, text, extra = {}) {
    const chunks = splitMessage(text);
    const promises = chunks.map((chunk, i) => {
        return bot.sendMessage(chatId, chunk, i === 0 ? extra : {}).catch(err => {
            logWithTimestamp('error', `发送分片消息 ${i + 1}/${chunks.length} 失败: ${err.message}`);
        });
    });
    return Promise.all(promises);
}

// 重载服务器函数
function reloadServer(chatId) {
    logWithTimestamp('log', '重载服务器端组件...');
    Object.keys(require.cache).forEach(function (key) {
        if (key.indexOf('node_modules') === -1) {
            delete require.cache[key];
        }
    });
    try {
        delete require.cache[require.resolve('./config.js')];
        const newConfig = require('./config.js');
        Object.assign(config, newConfig);
        logWithTimestamp('log', '配置文件已重新加载');
    } catch (error) {
        logWithTimestamp('error', '重新加载配置文件时出错:', error);
        if (chatId) bot.sendMessage(chatId, '重新加载配置文件时出错: ' + error.message);
        return;
    }
    logWithTimestamp('log', '服务器端组件已重载');
    if (chatId) bot.sendMessage(chatId, '服务器端组件已成功重载。');
}

// 重启服务器函数
function restartServer(chatId) {
    logWithTimestamp('log', '重启服务器端组件...');

    // 首先停止Telegram Bot轮询
    bot.stopPolling().then(() => {
        logWithTimestamp('log', 'Telegram Bot轮询已停止');

        // 然后关闭WebSocket服务器
        if (wss) {
            wss.close(() => {
                logWithTimestamp('log', 'WebSocket服务器已关闭，准备重启...');
                setTimeout(() => {
                    const { spawn } = require('child_process');
                    const serverPath = path.join(__dirname, 'server.js');
                    logWithTimestamp('log', `重启服务器: ${serverPath}`);
                    const cleanEnv = {
                        PATH: process.env.PATH,
                        NODE_PATH: process.env.NODE_PATH,
                        TELEGRAM_CLEAR_UPDATES: '1' // 添加标记，表示这是一次重启
                    };
                    if (chatId) cleanEnv.RESTART_NOTIFY_CHATID = chatId.toString();
                    const child = spawn(process.execPath, [serverPath], { detached: true, stdio: 'inherit', env: cleanEnv });
                    child.unref();
                    process.exit(0);
                }, 1000);
            });
        } else {
            // 如果没有WebSocket服务器，直接重启
            setTimeout(() => {
                const { spawn } = require('child_process');
                const serverPath = path.join(__dirname, 'server.js');
                logWithTimestamp('log', `重启服务器: ${serverPath}`);
                const cleanEnv = {
                    PATH: process.env.PATH,
                    NODE_PATH: process.env.NODE_PATH,
                    TELEGRAM_CLEAR_UPDATES: '1' // 添加标记，表示这是一次重启
                };
                if (chatId) cleanEnv.RESTART_NOTIFY_CHATID = chatId.toString();
                const child = spawn(process.execPath, [serverPath], { detached: true, stdio: 'inherit', env: cleanEnv });
                child.unref();
                process.exit(0);
            }, 1000);
        }
    }).catch(err => {
        logWithTimestamp('error', '停止Telegram Bot轮询时出错:', err);
        // 即使出错也继续重启过程
        if (wss) {
            wss.close(() => {
                // 重启代码...
                setTimeout(() => {
                    const { spawn } = require('child_process');
                    const serverPath = path.join(__dirname, 'server.js');
                    logWithTimestamp('log', `重启服务器: ${serverPath}`);
                    const cleanEnv = {
                        PATH: process.env.PATH,
                        NODE_PATH: process.env.NODE_PATH,
                        TELEGRAM_CLEAR_UPDATES: '1' // 添加标记，表示这是一次重启
                    };
                    if (chatId) cleanEnv.RESTART_NOTIFY_CHATID = chatId.toString();
                    const child = spawn(process.execPath, [serverPath], { detached: true, stdio: 'inherit', env: cleanEnv });
                    child.unref();
                    process.exit(0);
                }, 1000);
            });
        } else {
            // 如果没有WebSocket服务器，直接重启
            setTimeout(() => {
                const { spawn } = require('child_process');
                const serverPath = path.join(__dirname, 'server.js');
                logWithTimestamp('log', `重启服务器: ${serverPath}`);
                const cleanEnv = {
                    PATH: process.env.PATH,
                    NODE_PATH: process.env.NODE_PATH,
                    TELEGRAM_CLEAR_UPDATES: '1' // 添加标记，表示这是一次重启
                };
                if (chatId) cleanEnv.RESTART_NOTIFY_CHATID = chatId.toString();
                const child = spawn(process.execPath, [serverPath], { detached: true, stdio: 'inherit', env: cleanEnv });
                child.unref();
                process.exit(0);
            }, 1000);
        }
    });
}

// 退出服务器函数
function exitServer() {
    logWithTimestamp('log', '正在关闭服务器...');
    const forceExitTimeout = setTimeout(() => {
        logWithTimestamp('error', '退出操作超时，强制退出进程');
        process.exit(1);
    }, 10000);
    try {
        clearInterval(heartbeatTimer);
        if (fs.existsSync(RESTART_PROTECTION_FILE)) {
            fs.unlinkSync(RESTART_PROTECTION_FILE);
            logWithTimestamp('log', '已清理重启保护文件');
        }
    } catch (error) {
        logWithTimestamp('error', '清理重启保护文件失败:', error);
    }
    const finalExit = () => {
        clearTimeout(forceExitTimeout);
        logWithTimestamp('log', '服务器端组件已成功关闭');
        process.exit(0);
    };
    if (wss) {
        wss.close(() => {
            logWithTimestamp('log', 'WebSocket服务器已关闭');
            bot.stopPolling().finally(finalExit);
        });
    } else {
        bot.stopPolling().finally(finalExit);
    }
}

function handleSystemCommand(command, chatId) {
    logWithTimestamp('log', `执行系统命令: ${command}`);

    // 处理 ping 命令 - 返回连接状态信息
    if (command === 'ping') {
        const bridgeStatus = 'Bridge状态：已连接 ✅';
        const stStatus = sillyTavernClient && sillyTavernClient.readyState === WebSocket.OPEN ?
            'SillyTavern状态：已连接 ✅' :
            'SillyTavern状态：未连接 ❌';
        bot.sendMessage(chatId, `${bridgeStatus}\n${stStatus}`);
        return;
    }

    let responseMessage = '';
    switch (command) {
        case 'reload':
            responseMessage = '正在重载服务器端组件...';
            // 如果SillyTavern已连接，则执行刷新UI
            if (sillyTavernClient && sillyTavernClient.readyState === WebSocket.OPEN) {
                sillyTavernClient.commandToExecuteOnClose = { command, chatId };
                sillyTavernClient.send(JSON.stringify({ type: 'system_command', command: 'reload_ui_only', chatId }));
            } else {
                // 如果未连接，直接重载服务器
                bot.sendMessage(chatId, responseMessage);
                reloadServer(chatId);
            }
            break;
        case 'restart':
            responseMessage = '正在重启服务器端组件...';
            // 如果SillyTavern已连接，则执行刷新UI
            if (sillyTavernClient && sillyTavernClient.readyState === WebSocket.OPEN) {
                sillyTavernClient.commandToExecuteOnClose = { command, chatId };
                sillyTavernClient.send(JSON.stringify({ type: 'system_command', command: 'reload_ui_only', chatId }));
            } else {
                // 如果未连接，直接重启服务器
                bot.sendMessage(chatId, responseMessage);
                restartServer(chatId);
            }
            break;
        case 'exit':
            responseMessage = '正在关闭服务器端组件...';
            // 如果SillyTavern已连接，则执行刷新UI
            if (sillyTavernClient && sillyTavernClient.readyState === WebSocket.OPEN) {
                sillyTavernClient.commandToExecuteOnClose = { command, chatId };
                sillyTavernClient.send(JSON.stringify({ type: 'system_command', command: 'reload_ui_only', chatId }));
            } else {
                // 如果未连接，直接退出服务器
                bot.sendMessage(chatId, responseMessage);
                exitServer();
            }
            break;
        default:
            logWithTimestamp('warn', `未知的系统命令: ${command}`);
            bot.sendMessage(chatId, `未知的系统命令: /${command}`);
            return;
    }

    // 只有在SillyTavern已连接的情况下，消息才会在上面的switch语句中发送
    // 所以这里只在SillyTavern已连接时发送响应消息
    if (sillyTavernClient && sillyTavernClient.readyState === WebSocket.OPEN) {
        bot.sendMessage(chatId, responseMessage);
    }
}

// 处理Telegram命令
async function handleTelegramCommand(command, args, chatId) {
    logWithTimestamp('log', `处理Telegram命令: /${command} ${args.join(' ')}`);

    // 显示"输入中"状态
    bot.sendChatAction(chatId, 'typing').catch(error =>
        logWithTimestamp('error', '发送"输入中"状态失败:', error));

    // 默认回复
    let replyText = `未知命令: /${command}。 使用 /help 查看所有命令。`;

    // 特殊处理help命令，无论SillyTavern是否连接都可以显示
    if (command === 'help') {
        replyText = `SillyTavern Telegram Bridge 命令：\n\n`;
        replyText += `聊天管理\n`;
        replyText += `/new - 开始与当前角色的新聊天。\n`;
        replyText += `/listchats - 列出当前角色的所有已保存的聊天记录。\n`;
        replyText += `/switchchat <chat_name> - 加载特定的聊天记录。\n`;
        replyText += `/switchchat_<序号> - 通过序号加载聊天记录。\n\n`;
        replyText += `角色管理\n`;
        replyText += `/listchars - 列出所有可用角色。\n`;
        replyText += `/switchchar <char_name> - 切换到指定角色。\n`;
        replyText += `/switchchar_<序号> - 通过序号切换角色。\n\n`;
        replyText += `系统管理\n`;
        replyText += `/reload - 重载插件的服务器端组件并刷新ST网页。\n`;
        replyText += `/restart - 刷新ST网页并重启插件的服务器端组件。\n`;
        replyText += `/exit - 退出插件的服务器端组件。\n`;
        replyText += `/ping - 检查连接状态。\n\n`;
        replyText += `实用功能\n`;
        replyText += `/repush - 重新推送上一条AI回复到Telegram（消息丢失时使用）。\n`;
        replyText += `/reranker [on|off] - 查看或开关Vector Storage插件的Reranker。\n\n`;
        replyText += `帮助\n`;
        replyText += `/help - 显示此帮助信息。`;

        // 发送帮助信息并返回
        bot.sendMessage(chatId, replyText).catch(err => {
            logWithTimestamp('error', `发送命令回复失败: ${err.message}`);
        });
        return;
    }

    // /repush 只需重推服务器内存中保存的上一条AI回复，不依赖SillyTavern连接
    if (command === 'repush') {
        const lastReply = lastAiReplies.get(chatId);
        if (!lastReply || !lastReply.text) {
            bot.sendMessage(chatId, '当前会话没有可重推的AI回复记录。').catch(err => {
                logWithTimestamp('error', `发送命令回复失败: ${err.message}`);
            });
            return;
        }
        // 回复超过5分钟则过期，防止推送过期内容
        if (Date.now() - lastReply.ts > 5 * 60 * 1000) {
            bot.sendMessage(chatId, '上一条回复已过期（超过5分钟），请重新发送消息。').catch(err => {
                logWithTimestamp('error', `发送命令回复失败: ${err.message}`);
            });
            lastAiReplies.delete(chatId);
            return;
        }
        logWithTimestamp('log', `向 chatId ${chatId} 重推上一条AI回复 (${lastReply.text.length} 字符)`);
        await sendSplitMessage(chatId, lastReply.text);
        return;
    }

    // 检查SillyTavern是否连接
    if (!sillyTavernClient || sillyTavernClient.readyState !== WebSocket.OPEN) {
        bot.sendMessage(chatId, 'SillyTavern未连接，无法执行角色和聊天相关命令。请先确保SillyTavern已打开并启用了Telegram扩展。');
        return;
    }

    // 根据命令类型处理
    switch (command) {
        case 'new':
            // 发送命令到前端执行
            sillyTavernClient.send(JSON.stringify({
                type: 'execute_command',
                command: 'new',
                chatId: chatId
            }));
            return; // 前端会发送响应，所以这里直接返回
        case 'listchars':
            // 发送命令到前端执行
            sillyTavernClient.send(JSON.stringify({
                type: 'execute_command',
                command: 'listchars',
                chatId: chatId
            }));
            return;
        case 'switchchar':
            if (args.length === 0) {
                replyText = '请提供角色名称或序号。用法: /switchchar <角色名称> 或 /switchchar_数字';
            } else {
                // 发送命令到前端执行
                sillyTavernClient.send(JSON.stringify({
                    type: 'execute_command',
                    command: 'switchchar',
                    args: args,
                    chatId: chatId
                }));
                return;
            }
            break;
        case 'listchats':
            // 发送命令到前端执行
            sillyTavernClient.send(JSON.stringify({
                type: 'execute_command',
                command: 'listchats',
                chatId: chatId
            }));
            return;
        case 'switchchat':
            if (args.length === 0) {
                replyText = '请提供聊天记录名称。用法： /switchchat <聊天记录名称>';
            } else {
                // 发送命令到前端执行
                sillyTavernClient.send(JSON.stringify({
                    type: 'execute_command',
                    command: 'switchchat',
                    args: args,
                    chatId: chatId
                }));
                return;
            }
            break;
        case 'reranker':
            // 发送命令到前端执行，由前端操作Vector Storage插件的Reranker开关
            sillyTavernClient.send(JSON.stringify({
                type: 'execute_command',
                command: 'reranker',
                args: args,
                chatId: chatId
            }));
            return;
        default:
            // 处理特殊格式的命令，如 switchchar_1, switchchat_2 等
            const charMatch = command.match(/^switchchar_(\d+)$/);
            if (charMatch) {
                // 发送命令到前端执行
                sillyTavernClient.send(JSON.stringify({
                    type: 'execute_command',
                    command: command, // 保持原始命令格式
                    chatId: chatId
                }));
                return;
            }

            const chatMatch = command.match(/^switchchat_(\d+)$/);
            if (chatMatch) {
                // 发送命令到前端执行
                sillyTavernClient.send(JSON.stringify({
                    type: 'execute_command',
                    command: command, // 保持原始命令格式
                    chatId: chatId
                }));
                return;
            }
    }

    // 发送回复
    bot.sendMessage(chatId, replyText).catch(err => {
        logWithTimestamp('error', `发送命令回复失败: ${err.message}`);
    });
}

// --- WebSocket服务器逻辑 ---
wss.on('connection', ws => {
    logWithTimestamp('log', 'SillyTavern扩展已连接！');
    sillyTavernClient = ws;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', async (message) => { // 将整个回调设为async
        let data; // 在 try 块外部声明 data
        try {
            data = JSON.parse(message);

// --- 处理前端心跳（客户端主动保活探测） ---
if (data.type === 'heartbeat') {
  ws.send(JSON.stringify({ type: 'heartbeat_ack' }));
  return;
}

// --- 处理流式文本块 ---
if (data.type === 'stream_chunk' && data.chatId) {
  let session = ongoingStreams.get(data.chatId);

  // 1. 如果会话不存在，立即同步创建一个占位会话，创建会话和 messagePromise
  if (!session) {
    // 使用 let 声明，以便在 Promise 内部访问 resolve 和 reject
    let resolveMessagePromise, rejectMessagePromise;
    const messagePromise = new Promise((resolve, reject) => {
      resolveMessagePromise = resolve;
      rejectMessagePromise = reject;
    });

    // 设置会话超时清理（60 秒）
    const SESSION_TIMEOUT_MS = 60000;
    const timeoutId = setTimeout(() => {
      logWithTimestamp('warn', `流式会话超时，清理 ChatID ${data.chatId}`);
      if (rejectMessagePromise) {
        rejectMessagePromise(new Error('Session timeout'));
      }
      if (ongoingStreams.has(data.chatId)) {
        const s = ongoingStreams.get(data.chatId);
        if (s.timer) clearTimeout(s.timer);
        if (s.timeoutId) clearTimeout(s.timeoutId);
        ongoingStreams.delete(data.chatId);
      }
      bot.sendMessage(data.chatId, '生成超时，请稍后重试。').catch(() => {});
    }, SESSION_TIMEOUT_MS);

    session = {
      messagePromise: messagePromise,
      rejectPromise: rejectMessagePromise,  // 保存 reject 函数用于错误清理
      lastText: data.text,
      timer: null,
      isEditing: false,
      timeoutId: timeoutId,  // 保存超时 ID 用于清理
    };
    ongoingStreams.set(data.chatId, session);

    // 异步发送第一条消息并更新 session
    bot.sendMessage(data.chatId, '正在思考...')
      .then(sentMessage => {
        // 当消息发送成功时，解析 Promise 并传入 messageId
        resolveMessagePromise(sentMessage.message_id);
      })
      .catch(err => {
        logWithTimestamp('error', '发送初始 Telegram 消息失败:', err);
        // 主动 reject Promise，防止挂起
        if (rejectMessagePromise) {
          rejectMessagePromise(err);
        }
        // 清理超时定时器
        if (timeoutId) clearTimeout(timeoutId);
        ongoingStreams.delete(data.chatId);
      });
  } else {
    // 2. 如果会话存在，只更新最新文本
    session.lastText = data.text;
  }

  // 3. 尝试触发一次编辑（节流保护）
  // 确保 messageId 已经获取到，并且当前没有正在进行的编辑或定时器
  // 使用 await messagePromise 来确保 messageId 可用
  let messageId;
  try {
    messageId = await session.messagePromise;
  } catch (err) {
    logWithTimestamp('error', '获取 messageId 失败:', err);
    return;  // Promise 被 reject，直接返回
  }

  // 每次收到 chunk 时重置定时器
  if (session.timer) {
    clearTimeout(session.timer);
  }

  if (messageId && !session.isEditing) {
    session.timer = setTimeout(async () => { // 定时器回调也设为 async
      const currentSession = ongoingStreams.get(data.chatId);
      if (currentSession) {
        // 再次获取 messageId，确保仍然有效
        let currentMessageId;
        try {
          currentMessageId = await currentSession.messagePromise;
        } catch (err) {
          logWithTimestamp('error', '获取 messageId 失败:', err);
          if (currentSession.timer) {
            currentSession.timer = null;
          }
          return;
        }
        
        if (currentMessageId) {
          currentSession.isEditing = true;
          const previewText = (currentSession.lastText + ' ...').slice(0, MAX_TELEGRAM_LENGTH);
          bot.editMessageText(previewText, {
            chat_id: data.chatId,
            message_id: currentMessageId,
          }).catch(err => {
            if (!err.message.includes('message is not modified'))
              logWithTimestamp('error', '编辑 Telegram 消息失败:', err.message);
          }).finally(() => {
            if (ongoingStreams.has(data.chatId)) {
              ongoingStreams.get(data.chatId).isEditing = false;
            }
          });
        }
        currentSession.timer = null;
      }
    }, 2000);
  }
  return;
}

// --- 处理流式结束信号 ---
if (data.type === 'stream_end' && data.chatId) {
  const session = ongoingStreams.get(data.chatId);
  // 只有当存在会话时才处理，这表明确实是流式传输
  if (session) {
    // 清理超时定时器
    if (session.timeoutId) {
      clearTimeout(session.timeoutId);
      session.timeoutId = null;
    }
    if (session.timer) {
      clearTimeout(session.timer);
    }
    // 设置备用超时：若 final_message_update 永远不来，用 lastText 兜底
    session.fallbackTimer = setTimeout(async () => {
      logWithTimestamp('warn', `stream_end 后 10 秒未收到 final_message_update，用 lastText 兜底 ChatID ${data.chatId}`);
      const fallbackText = session.lastText || "消息生成完成";
      try {
        await sendSplitMessage(data.chatId, fallbackText);
        lastAiReplies.set(data.chatId, { text: fallbackText, ts: Date.now() });
      } catch (err) {
        logWithTimestamp('error', `兜底发送失败: ${err.message}`);
      }
      if (session.timer) clearTimeout(session.timer);
      ongoingStreams.delete(data.chatId);
    }, 10000);
    logWithTimestamp('log', `收到流式结束信号，等待最终渲染文本更新...`);
    // 注意：我们不在这里清理会话，而是等待 final_message_update
  }
  // 如果不存在会话但收到 stream_end，这是一个异常情况
  // 可能是由于某些原因会话被提前清理了
  else {
    logWithTimestamp('warn', `收到流式结束信号，但找不到对应的会话 ChatID ${data.chatId}`);
    // 为安全起见，我们仍然发送消息，但这种情况不应该发生
    await sendSplitMessage(data.chatId, data.text || "消息生成完成");
  }
  return;
}

// --- 处理最终渲染后的消息更新 ---
if (data.type === 'final_message_update' && data.chatId) {
  const session = ongoingStreams.get(data.chatId);

  // 如果会话存在，说明是流式传输的最终更新
  if (session) {
    // 清理超时定时器
    if (session.timeoutId) {
      clearTimeout(session.timeoutId);
    }
    // 清理 stream_end 设置的备用超时
    if (session.fallbackTimer) {
      clearTimeout(session.fallbackTimer);
      session.fallbackTimer = null;
    }
    // 使用 await messagePromise
    let messageId;
    try {
      messageId = await session.messagePromise;
    } catch (err) {
      logWithTimestamp('error', '获取 messageId 失败:', err);
      // 清理会话
      if (session.timer) clearTimeout(session.timer);
      if (session.timeoutId) clearTimeout(session.timeoutId);
      ongoingStreams.delete(data.chatId);
      return;
    }
    
    if (messageId) {
      logWithTimestamp('log', `收到流式最终渲染文本，更新消息 ${messageId}`);
      const finalText = data.text.slice(0, MAX_TELEGRAM_LENGTH);
      await bot.editMessageText(finalText, {
        chat_id: data.chatId,
        message_id: messageId,
      }).catch(err => {
        if (!err.message.includes('message is not modified'))
          logWithTimestamp('error', '编辑最终格式化 Telegram 消息失败:', err.message);
      });
      lastAiReplies.set(data.chatId, { text: finalText, ts: Date.now() });
      logWithTimestamp('log', `ChatID ${data.chatId} 的流式传输准最终更新已发送。`);
    } else {
      logWithTimestamp('warn', `收到 final_message_update，但流式会话的 messageId 未能获取。`);
    }
    // 清理流式会话
    if (session.timer) clearTimeout(session.timer);
    if (session.timeoutId) clearTimeout(session.timeoutId);
    ongoingStreams.delete(data.chatId);
    logWithTimestamp('log', `ChatID ${data.chatId} 的流式会话已完成并清理。`);
  }
  // 如果会话不存在，说明这是一个完整的非流式回复
  // 注意：这种情况不应该发生，因为我们已经在客户端修复了这个问题
  // 但为了健壮性，我们仍然保留这个处理
  else {
    logWithTimestamp('log', `收到非流式完整回复，直接发送新消息到 ChatID ${data.chatId}`);
    await sendSplitMessage(data.chatId, data.text);
    lastAiReplies.set(data.chatId, { text: data.text, ts: Date.now() });
  }
  return;
}

            // --- 其他消息处理逻辑 ---
            if (data.type === 'error_message' && data.chatId) {
                logWithTimestamp('error', `收到SillyTavern的错误报告，将发送至Telegram用户 ${data.chatId}: ${data.text}`);
                // 若前端带回失败消息原文，则登记为精确重发目标（按钮携带唯一token而非消息内容）
                let replyMarkup = {};
                if (data.resendText) {
                    const token = recordPendingResend(data.chatId, data.resendText, data.resendInlineImage);
                    replyMarkup = {
                        reply_markup: {
                            inline_keyboard: [[
                                { text: '🔄 重发消息', callback_data: `resend_${token}` }
                            ]]
                        }
                    };
                }
                sendSplitMessage(data.chatId, data.text, replyMarkup);
            } else if (data.type === 'retry_status' && data.chatId) {
                // 发送重试状态更新（可以编辑之前的状态消息，或发送新消息）
                logWithTimestamp('log', `重试状态: 第${data.retryCount}次重试，已用时${data.elapsedTime}秒`);
                // 可选：可以发送状态消息，但为避免刷屏，这里只记录日志
            } else if (data.type === 'ai_reply' && data.chatId) {
                logWithTimestamp('log', `收到非流式AI回复，发送至Telegram用户 ${data.chatId}`);
                // 确保在发送消息前清理可能存在的流式会话
                if (ongoingStreams.has(data.chatId)) {
                    logWithTimestamp('log', `清理 ChatID ${data.chatId} 的流式会话，因为收到了非流式回复`);
                    ongoingStreams.delete(data.chatId);
                }
                // 发送非流式回复（已内含分片处理）
                await sendSplitMessage(data.chatId, data.text);
                lastAiReplies.set(data.chatId, { text: data.text, ts: Date.now() });
            } else if (data.type === 'typing_action' && data.chatId) {
                logWithTimestamp('log', `显示"输入中"状态给Telegram用户 ${data.chatId}`);
                bot.sendChatAction(data.chatId, 'typing').catch(error =>
                    logWithTimestamp('error', '发送"输入中"状态失败:', error));
            } else if (data.type === 'command_executed') {
                // 处理前端命令执行结果
                logWithTimestamp('log', `命令 ${data.command} 执行完成，结果: ${data.success ? '成功' : '失败'}`);
                if (data.message) {
                    logWithTimestamp('log', `命令执行消息: ${data.message}`);
                }
            }
        } catch (error) {
            logWithTimestamp('error', '处理SillyTavern消息时出错:', error);
            // 确保即使在解析JSON失败时也能清理
            if (data && data.chatId) {
                ongoingStreams.delete(data.chatId);
            }
        }
    });

ws.on('close', () => {
  logWithTimestamp('log', 'SillyTavern 扩展已断开连接。');
  
  const pending = ws.commandToExecuteOnClose;
  ws.commandToExecuteOnClose = null;
  
  if (pending) {
    const { command, chatId } = pending;
    logWithTimestamp('log', `客户端断开连接，现在执行预定命令：${command}`);
    if (command === 'reload') reloadServer(chatId);
    if (command === 'restart') restartServer(chatId);
    if (command === 'exit') exitServer(chatId);
  }
  
  // 仅当全局引用仍指向本连接时才清空，避免旧 socket 误杀已重连的新连接
  if (sillyTavernClient === ws) {
    sillyTavernClient = null;
  }
  
  // 延迟30秒清理流式会话，给客户端重连窗口
  setTimeout(() => {
    if (!sillyTavernClient && ongoingStreams.size > 0) {
      logWithTimestamp('log', `客户端未重连，清理 ${ongoingStreams.size} 个残留流式会话`);
      ongoingStreams.clear();
    }
  }, 30000);
});

    ws.on('error', (error) => {
        logWithTimestamp('error', 'WebSocket发生错误:', error);
        // 仅当全局引用仍指向本连接时才清空，避免旧 socket 误杀已重连的新连接
        if (sillyTavernClient === ws) {
            sillyTavernClient.commandToExecuteOnClose = null;
            sillyTavernClient = null;
        }
        setTimeout(() => {
            if (!sillyTavernClient && ongoingStreams.size > 0) {
                logWithTimestamp('log', `清理 ${ongoingStreams.size} 个残留的流式会话`);
                ongoingStreams.clear();
            }
        }, 30000);
    });
});

// 下载图片并转换为base64 inline data URI
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

// 处理图片消息
async function handlePhotoMessage(msg, chatId) {
  try {
    logWithTimestamp('log', `从 Telegram 用户 ${chatId} 收到图片消息`);

    let fileId;
    
    // 处理压缩图片（msg.photo 数组）
    if (msg.photo && msg.photo.length > 0) {
      // 获取最高分辨率的图片 file_id
      fileId = msg.photo[msg.photo.length - 1].file_id;
      logWithTimestamp('log', `处理压缩图片，fileId: ${fileId}`);
    } 
    // 处理文件形式的图片（msg.document）
    else if (msg.document && msg.document.mime_type && 
             msg.document.mime_type.startsWith('image/')) {
      fileId = msg.document.file_id;
      logWithTimestamp('log', `处理文件形式图片，fileId: ${fileId}`);
    }
    else {
      const errorMsg = '收到无效的图片消息格式';
      logWithTimestamp('error', errorMsg);
      throw new Error(errorMsg);
    }

        // 获取图片文件URL
        const fileLink = await bot.getFileLink(fileId);
        logWithTimestamp('log', `图片文件URL: ${fileLink}`);

        // 下载图片
        const buffer = await downloadPhoto(fileId);

        // 转换为base64 inline data URI (SillyTavern inline image format)
        const base64 = buffer.toString('base64');

        // 尝试检测MIME类型（默认jpeg）
        let mimeType = 'image/jpeg';
        if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
            mimeType = 'image/png';
        } else if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
            mimeType = 'image/gif';
        } else if (buffer[0] === 0x57 && buffer[1] === 0x45 && buffer[2] === 0x42 && buffer[3] === 0x50) {
            mimeType = 'image/webp';
        }

        const inlineImageUri = `data:${mimeType};base64,${base64}`;

        // 获取图片的caption（如果有的话）
        const caption = msg.caption || '';

        // 显示"输入中"状态
        bot.sendChatAction(chatId, 'typing').catch(() => {});

        // 将图片作为inline image发送给SillyTavern
        // 通过extra字段传递inlineImage数据URI，由前端添加到消息的extra.media中
        if (sillyTavernClient && sillyTavernClient.readyState === WebSocket.OPEN) {
            logWithTimestamp('log', `向SillyTavern发送inline image消息`);
            // 存储图片消息（含caption）以便重发
            lastMessages.set(chatId, { text: caption, inlineImage: inlineImageUri, ts: Date.now() });
            const payload = JSON.stringify({
                type: 'user_message',
                chatId,
                text: caption,
                inlineImage: inlineImageUri,
            });
            sillyTavernClient.send(payload);
        } else {
            logWithTimestamp('warn', '收到Telegram图片，但SillyTavern扩展未连接。');
            bot.sendMessage(chatId, '抱歉，我现在无法连接到SillyTavern。请确保SillyTavern已打开并启用了Telegram扩展。');
        }
    } catch (error) {
        logWithTimestamp('error', '处理图片消息时出错:', error);
        bot.sendMessage(chatId, '处理图片时出错，请稍后重试。').catch(err => {
            logWithTimestamp('error', '发送错误消息失败:', err.message);
        });
    }
}


if (process.env.RESTART_NOTIFY_CHATID) {
    const chatId = parseInt(process.env.RESTART_NOTIFY_CHATID);
    if (!isNaN(chatId)) {
        setTimeout(() => {
            bot.sendMessage(chatId, '服务器端组件已成功重启并准备就绪')
                .catch(err => logWithTimestamp('error', '发送重启通知失败:', err))
                .finally(() => {
                    delete process.env.RESTART_NOTIFY_CHATID;
                });
        }, 2000);
    }
}

// --- 轮询错误监听 & 自动恢复（带退避 + retry_after 尊重 + 去重刷屏） ---
let pollingErrorCount = 0;
let pollingErrorTimestamps = []; // 滑动窗口
const MAX_POLLING_ERRORS = 5;
const POLLING_ERROR_WINDOW_MS = 60000; // 1分钟内计满才触发窗口重启
const BASE_POLLING_BACKOFF_MS = 1000;
const MAX_POLLING_BACKOFF_MS = 30000;
let pollingBackoffMs = BASE_POLLING_BACKOFF_MS;
let pollingRestartTimer = null;
let lastPollingErrorLog = { key: '', time: 0 };

// 解析 Telegram 429 的 retry_after（秒）
function parseRetryAfter(error) {
    try {
        // node-telegram-bot-api 的 TelegramError 会把原始 response 挂在 error.response
        const body = error.response && error.response.body;
        if (body) {
            const parsed = typeof body === 'string' ? JSON.parse(body) : body;
            if (parsed && parsed.parameters && typeof parsed.parameters.retry_after === 'number') {
                return parsed.parameters.retry_after;
            }
            if (parsed && typeof parsed.description === 'string') {
                const m = parsed.description.match(/retry after (\d+)/i);
                if (m) return parseInt(m[1], 10);
            }
        }
    } catch (_) { /* ignore */ }
    const m2 = (error.message || '').match(/retry after (\d+)/i);
    if (m2) return parseInt(m2[1], 10);
    return null;
}

function isTooManyRequests(error) {
    const msg = (error.message || '').toLowerCase();
    const code = error.code || '';
    return code === 'ETELEGRAM' && (msg.includes('429') || msg.includes('too many requests')) || msg.includes('retry after');
}

function isTransientPollingError(error) {
    const msg = (error.message || '').toLowerCase();
    return msg.includes('502') || msg.includes('bad gateway') || msg.includes('500') || msg.includes('503') || msg.includes('504')
        || msg.includes('econnreset') || msg.includes('etimedout') || msg.includes('fetch failed') || msg.includes('network');
}

function schedulePollingRestart(delayMs, reason) {
    if (pollingRestartTimer) return; // 已有待执行的重启，避免叠加
    logWithTimestamp('warn', `将在 ${Math.round(delayMs / 1000)}s 后重启轮询（原因: ${reason}）`);
    pollingRestartTimer = setTimeout(() => {
        pollingRestartTimer = null;
        bot.stopPolling().then(() => {
            // startPolling 内部会按 interval=300ms 恢复；restart:true 允许覆盖现有轮询
            return bot.startPolling({ restart: true });
        }).then(() => {
            logWithTimestamp('log', `Telegram Bot轮询已重启（${reason}）`);
        }).catch(err => {
            logWithTimestamp('error', '重启轮询失败:', err && err.message ? err.message : err);
            // 重启失败则退避重试
            const nextDelay = Math.min(pollingBackoffMs * 2, MAX_POLLING_BACKOFF_MS);
            pollingBackoffMs = nextDelay;
            schedulePollingRestart(nextDelay, '重启失败退避重试');
        });
    }, delayMs);
}

bot.on('polling_error', (error) => {
    const now = Date.now();
    const msg = error.message || String(error);
    const key = msg.slice(0, 80); // 去重 key：截断避免参数影响
    const is429 = isTooManyRequests(error);

    // 去重刷屏：相同错误 5 秒内只打印一次详情，其余静默计数
    if (key === lastPollingErrorLog.key && (now - lastPollingErrorLog.time) < 5000) {
        // 静默计数但不刷日志
        if (!is429) {
            pollingErrorTimestamps.push(now);
            pollingErrorTimestamps = pollingErrorTimestamps.filter(t => now - t < POLLING_ERROR_WINDOW_MS);
        }
    } else {
        lastPollingErrorLog = { key, time: now };
        if (is429) {
            const retryAfterSec = parseRetryAfter(error) || 5;
            const delayMs = retryAfterSec * 1000 + Math.random() * 1000;
            logWithTimestamp('warn', `[polling_error] 429 Too Many Requests: retry after ${retryAfterSec}s，已抑制刷屏，将在 ${retryAfterSec + 1}s 后重启轮询。若多台机器共用同一 Token 请只保留一台轮询。 详情: ${msg}`);
            pollingBackoffMs = Math.max(pollingBackoffMs, delayMs);
            schedulePollingRestart(delayMs, `429限流退避 ${retryAfterSec}s`);
            return;
        }

        // 非 429：计入滑动窗口
        pollingErrorCount++;
        pollingErrorTimestamps.push(now);
        pollingErrorTimestamps = pollingErrorTimestamps.filter(t => now - t < POLLING_ERROR_WINDOW_MS);
        const windowCount = pollingErrorTimestamps.length;
        const isTransient = isTransientPollingError(error);
        const backoff = isTransient
            ? Math.min(BASE_POLLING_BACKOFF_MS * Math.pow(2, windowCount - 1) + Math.random() * 1000, MAX_POLLING_BACKOFF_MS)
            : Math.min(pollingBackoffMs * 1.5 + Math.random() * 500, MAX_POLLING_BACKOFF_MS);
        pollingBackoffMs = backoff;

        logWithTimestamp('error', `[polling_error] (${pollingErrorCount}/${MAX_POLLING_ERRORS} 窗口内${windowCount}次) ${msg} | 退避 ${Math.round(backoff)}ms`);

        if (windowCount >= MAX_POLLING_ERRORS) {
            logWithTimestamp('warn', `轮询错误在 ${POLLING_ERROR_WINDOW_MS / 1000}s 窗口内已达 ${windowCount} 次，触发退避重启`);
            pollingErrorTimestamps = [];
            pollingErrorCount = 0;
            schedulePollingRestart(backoff, `窗口内${windowCount}次错误`);
        } else if (windowCount >= 3) {
            // 3次以上就提前退避重启，避免等到5次刷屏
            schedulePollingRestart(backoff, `连续${windowCount}次瞬态错误`);
        }
        // 1-2 次的瞬态错误（典型 WiFi 抖动 502）仅记录日志，不立即重启，靠库自身 300ms 重试自愈
    }

    // 若是 429 的被抑制分支，也需要按 retry_after 调度一次
    if (is429) {
        const retryAfterSec = parseRetryAfter(error) || 5;
        const delayMs = retryAfterSec * 1000 + Math.random() * 1000;
        schedulePollingRestart(delayMs, `429限流退避 ${retryAfterSec}s`);
    }
});

// 轮询成功即重置退避（通过 monkey-patch getUpdates 捕获成功）
// node-telegram-bot-api 的 polling 内部调用 bot.getUpdates，成功时重置计数
const _originalGetUpdates = bot.getUpdates.bind(bot);
bot.getUpdates = function (...args) {
    return _originalGetUpdates(...args).then(result => {
        // 空轮询也算成功，重置窗口
        pollingErrorCount = 0;
        pollingBackoffMs = BASE_POLLING_BACKOFF_MS;
        pollingErrorTimestamps = [];
        return result;
    }).catch(err => { throw err; });
};

// 健康检查：独立计数，与轮询错误解耦
const HEALTH_CHECK_INTERVAL = 60000;
let healthErrorCount = 0;
let lastHealthErrorLog = 0;
setInterval(() => {
    bot.getMe().then(() => {
        healthErrorCount = 0;
        // 健康检查成功也顺带重置轮询退避（说明网络已恢复）
        pollingBackoffMs = BASE_POLLING_BACKOFF_MS;
    }).catch(err => {
        const now = Date.now();
        // 健康检查失败去重：5秒内不重复刷
        if (now - lastHealthErrorLog < 5000) {
            healthErrorCount++;
        } else {
            lastHealthErrorLog = now;
            const is429 = isTooManyRequests(err);
            if (is429) {
                const retryAfterSec = parseRetryAfter(err) || 5;
                logWithTimestamp('warn', `健康检查 429 限流，${retryAfterSec}s 后重试（多机同Token会导致此现象）`);
                return; // 429 不计入健康错误，避免误重启
            }
            logWithTimestamp('error', `健康检查失败，bot可能已断开: ${err.message}`);
            healthErrorCount++;
        }
        if (healthErrorCount >= MAX_POLLING_ERRORS) {
            logWithTimestamp('warn', '健康检查多次失败，正在重启轮询...');
            healthErrorCount = 0;
            schedulePollingRestart(Math.min(pollingBackoffMs, 5000), '健康检查多次失败');
        }
    });
}, HEALTH_CHECK_INTERVAL);

// 监听Telegram消息
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    const userId = msg.from.id;
    const username = msg.from.username || 'N/A';

    // 检查白名单是否已配置且不为空
    if (config.allowedUserIds && config.allowedUserIds.length > 0) {
        // 如果当前用户的ID不在白名单中
        if (!config.allowedUserIds.includes(userId)) {
            logWithTimestamp('log', `拒绝了来自非白名单用户的访问：\n  - User ID: ${userId}\n  - Username: @${username}\n  - Chat ID: ${chatId}\n  - Message: "${text}"`);
            // 向该用户发送一条拒绝消息
            bot.sendMessage(chatId, '抱歉，您无权使用此机器人。').catch(err => {
                logWithTimestamp('error', `向 ${chatId} 发送拒绝消息失败:`, err.message);
            });
            // 终止后续处理
            return;
        }
    }

    // 处理图片消息
    if (msg.photo) {
        await handlePhotoMessage(msg, chatId);
        return;
    }

    // 处理图片文档（以文件形式发送的图片）
    if (msg.document && (msg.document.mime_type || '').startsWith('image/')) {
        await handlePhotoMessage(msg, chatId);
        return;
    }

    if (!text) return;

    if (text.startsWith('/')) {
        const parts = text.slice(1).trim().split(/\s+/);
        const command = parts[0].toLowerCase();
        const args = parts.slice(1);

        // 系统命令由服务器直接处理
        if (['reload', 'restart', 'exit', 'ping'].includes(command)) {
            handleSystemCommand(command, chatId);
            return;
        }

        // 其他命令也由服务器处理，但可能需要前端执行
        handleTelegramCommand(command, args, chatId);
        return;
    }

    // 处理普通消息
    if (sillyTavernClient && sillyTavernClient.readyState === WebSocket.OPEN) {
        logWithTimestamp('log', `从Telegram用户 ${chatId} 收到消息: "${text}"`);
        // 存储消息内容以便重发
        lastMessages.set(chatId, { text, inlineImage: null, ts: Date.now() });
        const payload = JSON.stringify({ type: 'user_message', chatId, text });
        sillyTavernClient.send(payload);
    } else {
        logWithTimestamp('warn', '收到Telegram消息，但SillyTavern扩展未连接。');
        bot.sendMessage(chatId, '抱歉，我现在无法连接到SillyTavern。请确保SillyTavern已打开并启用了Telegram扩展。');
    }
});

// 处理回调查询（如重发按钮点击）
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    // 确认回调查询，移除按钮的loading状态
    bot.answerCallbackQuery(query.id).catch(err => {
        logWithTimestamp('error', '回答回调查询失败:', err.message);
    });

    if (data.startsWith('resend_')) {
        const token = data.slice('resend_'.length);
        const entry = pendingResends.get(token) || null;

        // 精确重发时校验chatId归属
        if (entry && entry.chatId !== chatId) {
            logWithTimestamp('warn', `回调chatId ${chatId} 与记录chatId ${entry.chatId} 不匹配`);
            return;
        }

        // 优先使用token对应的原始消息；兼容旧格式按钮（resend_<chatId>）或无记录时回退到最近一条消息
        const latest = lastMessages.get(chatId);
        const resendText = entry ? entry.text : (latest ? latest.text : null);
        const resendInlineImage = entry ? entry.inlineImage : (latest ? latest.inlineImage : null);

        if (!resendText) {
            logWithTimestamp('warn', `没有找到chatId ${chatId} 的消息内容用于重发`);
            bot.sendMessage(chatId, '无法重发：未找到原始消息内容。请重新发送。').catch(err => {
                logWithTimestamp('error', '发送错误消息失败:', err.message);
            });
            return;
        }

        logWithTimestamp('log', `用户请求重发消息到 chatId ${chatId}: "${resendText}"${resendInlineImage ? '（含图片）' : ''}`);

        // 检查SillyTavern是否连接
        if (!sillyTavernClient || sillyTavernClient.readyState !== WebSocket.OPEN) {
            bot.sendMessage(chatId, 'SillyTavern未连接，无法重发消息。').catch(err => {
                logWithTimestamp('error', '发送错误消息失败:', err.message);
            });
            return;
        }

        // 重新发送消息到SillyTavern（含图片，若有）
        const payload = { type: 'user_message', chatId, text: resendText };
        if (resendInlineImage) payload.inlineImage = resendInlineImage;
        sillyTavernClient.send(JSON.stringify(payload));
        logWithTimestamp('log', `已重发消息到SillyTavern: "${resendText}"${resendInlineImage ? '（含图片）' : ''}`);

        // 使用过的token立即失效，避免重复重发
        if (entry) pendingResends.delete(token);
    }
});