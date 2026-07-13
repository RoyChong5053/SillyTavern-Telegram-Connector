// index.js

// 只解构 getContext() 返回的对象中确实存在的属性
const {
    extensionSettings,
    deleteLastMessage, // 导入删除最后一条消息的函数
    saveSettingsDebounced, // 导入保存设置的函数
} = SillyTavern.getContext();

// getContext 函数是全局 SillyTavern 对象的一部分，我们不需要从别处导入它
// 在需要时直接调用 SillyTavern.getContext() 即可

// 从 script.js 导入所有需要的公共API函数
import {
    eventSource,
    event_types,
    getPastCharacterChats,
    sendMessageAsUser,
    doNewChat,
    selectCharacterById,
    openCharacterChat,
    Generate,
    setExternalAbortController,
} from "../../../../script.js";

const MODULE_NAME = 'SillyTavern-Telegram-Connector';
const DEFAULT_SETTINGS = {
    bridgeUrl: 'ws://127.0.0.1:2333',
    autoConnect: true,
};

let ws = null; // WebSocket实例
let lastProcessedChatId = null; // 用于存储最后处理过的Telegram chatId
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY_MS = 3000;

// 添加一个全局变量来跟踪当前是否处于流式模式
let isStreamingMode = false;

// --- 工具函数 ---
function getSettings() {
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = { ...DEFAULT_SETTINGS };
    }
    return extensionSettings[MODULE_NAME];
}

function updateStatus(message, color) {
    const statusEl = document.getElementById('telegram_connection_status');
    if (statusEl) {
        statusEl.textContent = `状态： ${message}`;
        statusEl.style.color = color;
    }
}

function reloadPage() {
    window.location.reload();
}
// ---

// 连接到WebSocket服务器
function connect() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        console.log('[Telegram Bridge] 已连接');
        return;
    }

    const settings = getSettings();
    if (!settings.bridgeUrl) {
        updateStatus('URL 未设置！', 'red');
        return;
    }

    updateStatus('连接中...', 'orange');
    console.log(`[Telegram Bridge] 正在连接 ${settings.bridgeUrl}...`);

    ws = new WebSocket(settings.bridgeUrl);

    ws.onopen = () => {
        console.log('[Telegram Bridge] 连接成功！');
        updateStatus('已连接', 'green');
        reconnectAttempts = 0;
    };

    ws.onmessage = async (event) => {
        let data;
        try {
            data = JSON.parse(event.data);

            // --- 用户消息处理 ---
            if (data.type === 'user_message') {
                console.log('[Telegram Bridge] 收到用户消息。', data);

                // 存储当前处理的chatId
                lastProcessedChatId = data.chatId;

                // 默认情况下，假设不是流式模式
                isStreamingMode = false;

                // 1. 立即向Telegram发送“输入中”状态（无论是否流式）
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'typing_action', chatId: data.chatId }));
                }

                // 2. 将用户消息添加到SillyTavern
                await sendMessageAsUser(data.text);

                // 2.5 如果有inline image，将其添加到最新消息的extra.media中
                if (data.inlineImage) {
                    console.log('[Telegram Bridge] 收到inline image，正在附加到消息...');
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
                        console.log('[Telegram Bridge] Inline image已附加到消息。');
                    }
                }

                // 3. 设置流式传输的回调
                const streamCallback = (cumulativeText) => {
                    // 标记为流式模式
                    isStreamingMode = true;
                    // 将每个文本块通过WebSocket发送到服务端
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'stream_chunk',
                            chatId: data.chatId,
                            text: cumulativeText,
                        }));
                    }
                };
                eventSource.on(event_types.STREAM_TOKEN_RECEIVED, streamCallback);

                // 4. 定义一个清理函数
                const cleanup = () => {
                    eventSource.removeListener(event_types.STREAM_TOKEN_RECEIVED, streamCallback);
                    if (ws && ws.readyState === WebSocket.OPEN && isStreamingMode) {
                        // 仅在没有错误且确实处于流式模式时发送stream_end
                        if (!data.error) {
                            ws.send(JSON.stringify({ type: 'stream_end', chatId: data.chatId }));
                        }
                    }
                    // 注意：不在这里重置isStreamingMode，让handleFinalMessage函数来处理
                };

                // 5. 监听生成结束事件，确保无论成功与否都执行清理
                // 注意: 我们现在使用once来确保这个监听器只执行一次，避免干扰后续的全局监听器
                eventSource.once(event_types.GENERATION_ENDED, cleanup);
                // 添加对手动停止生成的处理
                eventSource.once(event_types.GENERATION_STOPPED, cleanup);

                // 6. 触发SillyTavern的生成流程，并用try...catch包裹
                // 修改为基于时间的重试机制，最长5分钟
                const MAX_RETRY_TIME_MS = 5 * 60 * 1000; // 5分钟
                const MAX_RETRY_ATTEMPTS = 10; // 最大重试次数
                const INITIAL_DELAY_MS = 3000; // 初始延迟3秒
                const MAX_DELAY_MS = 30000; // 最大延迟30秒
                let generationSuccess = false;
                let lastError = null;
                let retryCount = 0;
                const startTime = Date.now();

                // 智能错误分类：区分瞬态错误（可重试）和永久错误（立即失败）
                function isRetryableError(errorMsg) {
                    const lower = errorMsg.toLowerCase();
                    // 瞬态错误：网络/服务端问题，可重试
                    const transientPatterns = [
                        '500', 'internal server error',
                        '502', 'bad gateway',
                        '503', 'service unavailable',
                        '504', 'gateway timeout',
                        '429', 'too many requests', 'rate limit',
                        'econnreset', 'econnrefused', 'etimedout',
                        'fetch failed', 'network', 'networkerror',
                        'socket hang up', 'request timeout',
                    ];
                    // 永久错误：认证/配额问题，不应重试
                    const permanentPatterns = [
                        '401', '403', 'unauthorized', 'forbidden',
                        'invalid_api_key', 'api key',
                        'quota exceeded', 'insufficient_quota',
                        'content_filter', 'safety',
                    ];
                    // 先检查是否为永久错误（优先级更高）
                    if (permanentPatterns.some(p => lower.includes(p))) {
                        return false;
                    }
                    return transientPatterns.some(p => lower.includes(p));
                }

                while (!generationSuccess && (Date.now() - startTime) < MAX_RETRY_TIME_MS) {
                    try {
                        if (retryCount > 0) {
                            // 计算指数退避延迟（带随机抖动）
                            const delay = Math.min(
                                INITIAL_DELAY_MS * Math.pow(2, retryCount - 1) + Math.random() * 1000,
                                MAX_DELAY_MS
                            );
                            console.log(`[Telegram Bridge] AI生成重试 (${retryCount}), 等待 ${Math.round(delay)}ms... (已用时: ${Math.round((Date.now() - startTime) / 1000)}s)`);

                            // 向Telegram发送重试状态
                            if (ws && ws.readyState === WebSocket.OPEN) {
                                ws.send(JSON.stringify({
                                    type: 'retry_status',
                                    chatId: data.chatId,
                                    retryCount: retryCount,
                                    elapsedTime: Math.round((Date.now() - startTime) / 1000),
                                }));
                            }

                            await new Promise(r => setTimeout(r, delay));
                        }

                        const abortController = new AbortController();
                        setExternalAbortController(abortController);
                        await Generate('normal', { signal: abortController.signal });
                        generationSuccess = true;
                    } catch (error) {
                        lastError = error;
                        const errorMsg = error.message || '';

                        console.log(`[Telegram Bridge] Generate错误: ${errorMsg}`);

                        // 智能错误分类：瞬态错误重试，永久错误立即失败
                        if (isRetryableError(errorMsg)) {
                            console.log(`[Telegram Bridge] 检测到瞬态错误，准备重试...`);
                            retryCount++;

                            // 检查是否超过最大重试次数
                            if (retryCount >= MAX_RETRY_ATTEMPTS) {
                                console.log(`[Telegram Bridge] 已达到最大重试次数 ${MAX_RETRY_ATTEMPTS}，停止重试`);
                                break;
                            }

                            // 检查是否超过最大重试时间
                            if ((Date.now() - startTime) >= MAX_RETRY_TIME_MS) {
                                console.log(`[Telegram Bridge] 已达到最大重试时间 ${MAX_RETRY_TIME_MS / 1000}秒`);
                                break;
                            }
                            continue;
                        }

                        // 永久错误: 立即失败
                        console.error("[Telegram Bridge] Generate() 永久错误:", error);
                        await deleteLastMessage();
                        console.log('[Telegram Bridge] 已删除导致错误的用户消息。');

                        const errorMessage = `抱歉，AI生成回复时遇到错误。\n您的上一条消息已被撤回，请重试或发送不同内容。\n\n错误详情: ${error.message || '未知错误'}`;
                        // 注意：不向用户暴露技术细节，只记录日志
                        if (ws && ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({
                                type: 'error_message',
                                chatId: data.chatId,
                                text: errorMessage,
                            }));
                        }

                        data.error = true;
                        cleanup();
                        return; // 非500错误直接返回，不继续重试
                    }
                }

                // 所有重试都失败（超时或达到最大重试时间）
                if (!generationSuccess && lastError) {
                    console.error("[Telegram Bridge] 所有重试都失败:", lastError);

                    // 删除SillyTavern中残留的用户消息
                    await deleteLastMessage();
                    console.log('[Telegram Bridge] 已删除重试失败的用户消息。');

                    const elapsedTime = Math.round((Date.now() - startTime) / 1000);
                    const errorMessage = `抱歉，AI生成回复超时（${elapsedTime}秒）。\n您的上一条消息已被撤回，请稍后重试。\n\n错误详情: ${lastError.message || '请求超时'}`;
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'error_message',
                            chatId: data.chatId,
                            text: errorMessage,
                        }));
                    }
                    data.error = true;
                    cleanup();
                }

                return;
            }

            // --- 系统命令处理 ---
            if (data.type === 'system_command') {
                console.log('[Telegram Bridge] 收到系统命令', data);
                if (data.command === 'reload_ui_only') {
                    console.log('[Telegram Bridge] 正在刷新UI...');
                    setTimeout(reloadPage, 500);
                }
                return;
            }

            // --- 执行命令处理 ---
            if (data.type === 'execute_command') {
                console.log('[Telegram Bridge] 执行命令', data);

                // 显示“输入中”状态
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'typing_action', chatId: data.chatId }));
                }

                let replyText = '命令执行失败，请稍后重试。';

                // 直接调用全局的 SillyTavern.getContext()
                const context = SillyTavern.getContext();
                let commandSuccess = false;

                try {
                    switch (data.command) {
                        case 'new':
                            await doNewChat({ deleteCurrentChat: false });
                            replyText = '新的聊天已经开始。';
                            commandSuccess = true;
                            break;
                        case 'listchars': {
                            const characters = context.characters.slice(1);
                            if (characters.length > 0) {
                                replyText = '可用角色列表：\n\n';
                                characters.forEach((char, index) => {
                                    replyText += `${index + 1}. /switchchar_${index + 1} - ${char.name}\n`;
                                });
                                replyText += '\n使用 /switchchar_数字 或 /switchchar 角色名称 来切换角色';
                            } else {
                                replyText = '没有找到可用角色。';
                            }
                            commandSuccess = true;
                            break;
                        }
                        case 'switchchar': {
                            if (!data.args || data.args.length === 0) {
                                replyText = '请提供角色名称或序号。用法: /switchchar <角色名称> 或 /switchchar_数字';
                                break;
                            }
                            const targetName = data.args.join(' ');
                            const characters = context.characters;
                            const targetChar = characters.find(c => c.name === targetName);

                            if (targetChar) {
                                const charIndex = characters.indexOf(targetChar);
                                await selectCharacterById(charIndex);
                                replyText = `已成功切换到角色 "${targetName}"。`;
                                commandSuccess = true;
                            } else {
                                replyText = `角色 "${targetName}" 未找到。`;
                            }
                            break;
                        }
                        case 'listchats': {
                            if (context.characterId === undefined) {
                                replyText = '请先选择一个角色。';
                                break;
                            }
                            const chatFiles = await getPastCharacterChats(context.characterId);
                            if (chatFiles.length > 0) {
                                replyText = '当前角色的聊天记录：\n\n';
                                chatFiles.forEach((chat, index) => {
                                    const chatName = chat.file_name.replace('.jsonl', '');
                                    replyText += `${index + 1}. /switchchat_${index + 1} - ${chatName}\n`;
                                });
                                replyText += '\n使用 /switchchat_数字 或 /switchchat 聊天名称 来切换聊天';
                            } else {
                                replyText = '当前角色没有任何聊天记录。';
                            }
                            commandSuccess = true;
                            break;
                        }
                        case 'switchchat': {
                            if (!data.args || data.args.length === 0) {
                                replyText = '请提供聊天记录名称。用法： /switchchat <聊天记录名称>';
                                break;
                            }
                            const targetChatFile = `${data.args.join(' ')}`;
                            try {
                                await openCharacterChat(targetChatFile);
                                replyText = `已加载聊天记录： ${targetChatFile}`;
                                commandSuccess = true;
                            } catch (err) {
                                console.error(err);
                                replyText = `加载聊天记录 "${targetChatFile}" 失败。请确认名称完全正确。`;
                            }
                            break;
                        }
                        default: {
                            // 处理特殊格式的命令，如 switchchar_1, switchchat_2 等
                            const charMatch = data.command.match(/^switchchar_(\d+)$/);
                            if (charMatch) {
                                const index = parseInt(charMatch[1]) - 1;
                                const characters = context.characters.slice(1);
                                if (index >= 0 && index < characters.length) {
                                    const targetChar = characters[index];
                                    const charIndex = context.characters.indexOf(targetChar);
                                    await selectCharacterById(charIndex);
                                    replyText = `已切换到角色 "${targetChar.name}"。`;
                                    commandSuccess = true;
                                } else {
                                    replyText = `无效的角色序号: ${index + 1}。请使用 /listchars 查看可用角色。`;
                                }
                                break;
                            }

                            const chatMatch = data.command.match(/^switchchat_(\d+)$/);
                            if (chatMatch) {
                                if (context.characterId === undefined) {
                                    replyText = '请先选择一个角色。';
                                    break;
                                }
                                const index = parseInt(chatMatch[1]) - 1;
                                const chatFiles = await getPastCharacterChats(context.characterId);

                                if (index >= 0 && index < chatFiles.length) {
                                    const targetChat = chatFiles[index];
                                    const chatName = targetChat.file_name.replace('.jsonl', '');
                                    try {
                                        await openCharacterChat(chatName);
                                        replyText = `已加载聊天记录： ${chatName}`;
                                        commandSuccess = true;
                                    } catch (err) {
                                        console.error(err);
                                        replyText = `加载聊天记录失败。`;
                                    }
                                } else {
                                    replyText = `无效的聊天记录序号: ${index + 1}。请使用 /listchats 查看可用聊天记录。`;
                                }
                                break;
                            }

                            replyText = `未知命令: /${data.command}。使用 /help 查看所有命令。`;
                        }
                    }
                } catch (error) {
                    console.error('[Telegram Bridge] 执行命令时出错:', error);
                    replyText = `执行命令时出错: ${error.message || '未知错误'}`;
                }

                // 发送命令执行结果
                if (ws && ws.readyState === WebSocket.OPEN) {
                    // 发送命令执行结果到Telegram
                    ws.send(JSON.stringify({ type: 'ai_reply', chatId: data.chatId, text: replyText }));

                    // 发送命令执行状态反馈到服务器
                    ws.send(JSON.stringify({
                        type: 'command_executed',
                        command: data.command,
                        success: commandSuccess,
                        message: replyText
                    }));
                }

                return;
            }
        } catch (error) {
            console.error('[Telegram Bridge] 处理请求时发生错误：', error);
            if (data && data.chatId && ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'error_message', chatId: data.chatId, text: '处理您的请求时发生了一个内部错误。' }));
            }
        }
    };

    ws.onclose = () => {
        console.log('[Telegram Bridge] 连接已关闭。');
        ws = null;
        updateStatus('已断开', 'red');

        const settings = getSettings();
        if (settings.autoConnect && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            reconnectAttempts++;
            console.log(`[Telegram Bridge] 尝试重新连接 (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
            setTimeout(connect, RECONNECT_DELAY_MS);
        } else if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            updateStatus('重连失败，请检查服务器', 'red');
        }
    };

    ws.onerror = (error) => {
        console.error('[Telegram Bridge] WebSocket错误:', error);
    };
}

function disconnect() {
    if (ws) {
        reconnectAttempts = MAX_RECONNECT_ATTEMPTS;
        ws.close();
    }
}

// 扩展加载时执行的函数
jQuery(async () => {
    console.log('[Telegram Bridge] 正在尝试加载设置 UI...');
    try {
        const settingsHtml = await $.get(`/scripts/extensions/third-party/${MODULE_NAME}/settings.html`);
        $('#extensions_settings').append(settingsHtml);
        console.log('[Telegram Bridge] 设置 UI 应该已经被添加。');

        const settings = getSettings();
        $('#telegram_bridge_url').val(settings.bridgeUrl);
        $('#telegram_auto_connect').prop('checked', settings.autoConnect);

        $('#telegram_bridge_url').on('input', () => {
            const settings = getSettings();
            settings.bridgeUrl = $('#telegram_bridge_url').val();
            // 确保调用saveSettingsDebounced保存设置
            saveSettingsDebounced();
        });

        $('#telegram_auto_connect').on('change', function () {
            const settings = getSettings();
            settings.autoConnect = $(this).prop('checked');
            // 确保调用saveSettingsDebounced保存设置
            console.log(`[Telegram Bridge] 自动连接设置已更改为: ${settings.autoConnect}`);
            saveSettingsDebounced();
        });

        $('#telegram_connect_button').on('click', connect);
        $('#telegram_disconnect_button').on('click', disconnect);

        if (settings.autoConnect) {
            console.log('[Telegram Bridge] 自动连接已启用，正在连接...');
            connect();
        }

    } catch (error) {
        console.error('[Telegram Bridge] 加载设置 HTML 失败。', error);
    }
    console.log('[Telegram Bridge] 扩展已加载。');
});

// 全局事件监听器，用于最终消息更新
function handleFinalMessage(lastMessageIdInChatArray) {
    const chatId = lastProcessedChatId;
    lastProcessedChatId = null;

    if (!ws || ws.readyState !== WebSocket.OPEN || !chatId) {
        return;
    }

    const lastMessageIndex = lastMessageIdInChatArray - 1;
    if (lastMessageIndex < 0) return;

    setTimeout(() => {
        const context = SillyTavern.getContext();
        const lastMessage = context.chat[lastMessageIndex];

        if (lastMessage && !lastMessage.is_user && !lastMessage.is_system) {
            const messageElement = $(`#chat .mes[mesid="${lastMessageIndex}"]`);

            if (messageElement.length > 0) {
                const messageTextElement = messageElement.find('.mes_text');

                let renderedText = messageTextElement.html()
                    .replace(/<br\s*\/?>/gi, '\n')
                    .replace(/<\/p>\s*<p>/gi, '\n\n')

                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = renderedText;
                renderedText = tempDiv.textContent;

                console.log(`[Telegram Bridge] 捕获到最终渲染文本，准备发送更新到 chatId: ${chatId}`);

                if (isStreamingMode) {
                    ws.send(JSON.stringify({
                        type: 'final_message_update',
                        chatId: chatId,
                        text: renderedText,
                    }));
                    isStreamingMode = false;
                } else {
                    ws.send(JSON.stringify({
                        type: 'ai_reply',
                        chatId: chatId,
                        text: renderedText,
                    }));
                }
            }
        }
    }, 100);
}

// 全局事件监听器，用于最终消息更新
eventSource.on(event_types.GENERATION_ENDED, handleFinalMessage);

// 添加对手动停止生成的处理
eventSource.on(event_types.GENERATION_STOPPED, handleFinalMessage);