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
    isGenerating,
} from "../../../../script.js";

const MODULE_NAME = 'SillyTavern-Telegram-Connector';
const DEFAULT_SETTINGS = {
    bridgeUrl: 'ws://127.0.0.1:2333',
    autoConnect: true,
};

let ws = null; // WebSocket实例
let reconnectAttempts = 0;
let reconnectStartTime = 0;
let reconnectTimer = null;
let manuallyDisconnected = false;
let heartbeatTimer = null;
let lastActivityTime = Date.now();
let reloadCounterResetTimer = null;

// 重连策略：无限次数 + 指数退避，超过时限后自动刷新页面兜底
const MAX_RECONNECT_DURATION_MS = 90 * 1000; // 重连窗口 90 秒
const BASE_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;

// 前端心跳：检测“假死”连接
const HEARTBEAT_INTERVAL_MS = 15000;
const HEARTBEAT_STALE_MS = 45000;

// 自动刷新兜底：防止服务器真挂时无限刷新循环
const MAX_AUTO_RELOADS = 3;
const RELOAD_COUNTER_KEY = 'telegram_auto_reload_count';

// ST 卡死看门狗
const JOB_ACTIVITY_TIMEOUT_MS = 15 * 60 * 1000; // 非流式慢模型宽限 15 分钟
const STREAM_SILENCE_TIMEOUT_MS = 60 * 1000;    // 流式生成 60 秒无新 chunk 判定卡死
const FINAL_REPLY_TIMEOUT_MS = 30 * 1000;       // 生成完成后 30 秒无最终回复判定卡死

// FIFO 串行消息队列：一次只处理一条消息，杜绝并发 Generate() 导致的 ST 状态卡死
const messageQueue = [];
let processingMessage = false;
let currentJob = null;

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
        // 提供方请求超时 / 生成被中断：多为限流或 fallback 链较慢导致的瞬态问题
        'timed out', 'provider timed out', 'timeout',
        'aborted', 'abort',
        'context canceled', 'canceled',
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

// --- 自动刷新兜底 ---
function getAutoReloadCount() {
    try {
        return parseInt(sessionStorage.getItem(RELOAD_COUNTER_KEY) || '0', 10) || 0;
    } catch (e) {
        return 0;
    }
}

function performAutoReload(logMsg) {
    if (manuallyDisconnected) return;
    const count = getAutoReloadCount();
    if (count >= MAX_AUTO_RELOADS) {
        console.error(`[Telegram Bridge] 已达到自动刷新次数上限(${MAX_AUTO_RELOADS})，请手动检查服务器后刷新页面`);
        updateStatus('自动恢复失败，请检查服务器', 'red');
        return;
    }
    try {
        sessionStorage.setItem(RELOAD_COUNTER_KEY, String(count + 1));
    } catch (e) { }
    console.log(`${logMsg} (自动刷新 ${count + 1}/${MAX_AUTO_RELOADS})`);
    setTimeout(reloadPage, 500);
}

function startReloadCounterResetTimer() {
    if (reloadCounterResetTimer) clearTimeout(reloadCounterResetTimer);
    reloadCounterResetTimer = setTimeout(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            try {
                sessionStorage.removeItem(RELOAD_COUNTER_KEY);
            } catch (e) { }
            console.log('[Telegram Bridge] 连接已稳定，重置自动刷新计数');
        }
    }, 5 * 60 * 1000);
}

// --- 前端心跳 ---
function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        // 超过 45 秒没有任何消息（含 heartbeat_ack），判定连接假死，强制断开触发重连
        if (Date.now() - lastActivityTime > HEARTBEAT_STALE_MS) {
            console.log('[Telegram Bridge] 心跳超时(45秒无消息)，强制断开触发重连');
            ws.close();
            return;
        }
        ws.send(JSON.stringify({ type: 'heartbeat' }));
    }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
}

// --- 重连 ---
function scheduleReconnect() {
    if (manuallyDisconnected) return;
    if (reconnectTimer) return; // 已安排重连
    const settings = getSettings();
    if (!settings.autoConnect) return;

    // 重连窗口耗尽 → 自动刷新页面兜底
    if (reconnectStartTime === 0) {
        reconnectStartTime = Date.now();
    }
    if (Date.now() - reconnectStartTime >= MAX_RECONNECT_DURATION_MS) {
        reconnectStartTime = 0;
        updateStatus('连接失败，准备自动刷新...', 'orange');
        performAutoReload('[Telegram Bridge] 重连超时，自动刷新页面');
        return;
    }

    const delay = Math.min(
        BASE_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts) + Math.random() * 1000,
        MAX_RECONNECT_DELAY_MS
    );
    reconnectAttempts++;
    console.log(`[Telegram Bridge] 尝试重新连接 (${reconnectAttempts})，${Math.round(delay)}ms 后...`);
    updateStatus(`重连中 (${reconnectAttempts})...`, 'orange');
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, delay);
}

// --- FIFO 队列 / 任务状态 ---
function clearJobTimers(job) {
    if (!job) return;
    if (job.activityTimer) clearTimeout(job.activityTimer);
    if (job.finalReplyTimer) clearTimeout(job.finalReplyTimer);
    job.activityTimer = null;
    job.finalReplyTimer = null;
}

function finishJob(job) {
    if (!job) return;
    clearJobTimers(job);
    job.finished = true;
    if (currentJob === job) {
        currentJob = null;
        processingMessage = false;
        processQueue();
    }
}

function armActivityTimer(job) {
    clearTimeout(job.activityTimer);
    const timeout = job.isStreamingMode ? STREAM_SILENCE_TIMEOUT_MS : JOB_ACTIVITY_TIMEOUT_MS;
    job.activityTimer = setTimeout(() => {
        if (currentJob === job) {
            onJobWedged(job, job.isStreamingMode ? '流式生成60秒无新内容' : '生成15分钟无响应');
        }
    }, timeout);
}

function onJobWedged(job, reason) {
    console.error(`[Telegram Bridge] SillyTavern疑似卡死(${reason})，准备自愈`);
    if (currentJob === job && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'error_message',
            chatId: job.chatId,
            text: 'SillyTavern生成无响应（可能已卡死），正在自动刷新页面恢复。请稍候片刻再重发消息。',
        }));
    }
    finishJob(job);
    performAutoReload(`[Telegram Bridge] ${reason}，自动刷新页面`);
}

async function processQueue() {
    if (processingMessage) return;
    if (messageQueue.length === 0) return;
    processingMessage = true;
    const job = messageQueue.shift();
    currentJob = job;
    await processMessageJob(job);
}

async function processMessageJob(job) {
    let cleanup = null;
    try {
        // 1. 立即向Telegram发送“输入中”状态
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'typing_action', chatId: job.chatId }));
        }

        // 1.5 若 SillyTavern 正在手动生成，等待其完成，避免并发 Generate 卡死 ST
        //     上限 8 分钟，覆盖 reranker 慢速场景（弱CPU 3-5分钟），超过则判定卡死并自愈
        const WAIT_ST_IDLE_TIMEOUT_MS = 8 * 60 * 1000;
        const waitStart = Date.now();
        while (isGenerating()) {
            if (Date.now() - waitStart > WAIT_ST_IDLE_TIMEOUT_MS) {
                onJobWedged(job, '等待SillyTavern空闲超时(8分钟)');
                return;
            }
            await new Promise(r => setTimeout(r, 1000));
        }

        // 2. 将用户消息添加到SillyTavern
        await sendMessageAsUser(job.text);

        // 2.5 如果有inline image，将其添加到最新消息的extra.media中
        if (job.inlineImage) {
            console.log('[Telegram Bridge] 收到inline image，正在附加到消息...');
            const context = SillyTavern.getContext();
            const lastMsg = context.chat[context.chat.length - 1];
            if (lastMsg && lastMsg.is_user) {
                if (!lastMsg.extra) lastMsg.extra = {};
                if (!Array.isArray(lastMsg.extra.media)) lastMsg.extra.media = [];
                lastMsg.extra.media.push({
                    url: job.inlineImage,
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
        job.streamCallback = (cumulativeText) => {
            if (currentJob !== job) return;
            job.isStreamingMode = true;
            armActivityTimer(job); // 有流块 = 活跃，重置卡死计时
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'stream_chunk',
                    chatId: job.chatId,
                    text: cumulativeText,
                }));
            }
        };
        eventSource.on(event_types.STREAM_TOKEN_RECEIVED, job.streamCallback);

        // 4. 定义一个清理函数（发送 stream_end；最终回复由 handleFinalMessage 负责）
        cleanup = () => {
            if (job.cleanupDone) return;
            job.cleanupDone = true;
            eventSource.removeListener(event_types.STREAM_TOKEN_RECEIVED, job.streamCallback);
            if (ws && ws.readyState === WebSocket.OPEN && job.isStreamingMode) {
                if (!job.error) {
                    ws.send(JSON.stringify({ type: 'stream_end', chatId: job.chatId }));
                }
            }
        };

        // 5. 监听生成结束事件，确保无论成功与否都执行清理
        //    注意: 使用 once 确保监听器只执行一次
        eventSource.once(event_types.GENERATION_ENDED, cleanup);
        eventSource.once(event_types.GENERATION_STOPPED, cleanup);

        // 6. 启动活动看门狗
        armActivityTimer(job);

        // 7. 触发SillyTavern的生成流程，并用try...catch包裹
        const MAX_RETRY_TIME_MS = 8 * 60 * 1000; // 8分钟（覆盖 reranker 慢速场景）
        const MAX_RETRY_ATTEMPTS = 3; // 最大重试次数（one-api 已稳定，无需多次重试）
        const INITIAL_DELAY_MS = 5000; // 初始延迟5秒（给 one-api 更多 fallback 时间）
        const MAX_DELAY_MS = 30000; // 最大延迟30秒
        let generationSuccess = false;
        let lastError = null;
        let retryCount = 0;
        const startTime = Date.now();

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
                            chatId: job.chatId,
                            retryCount: retryCount,
                            elapsedTime: Math.round((Date.now() - startTime) / 1000),
                        }));
                    }

                    // 每次重试前重置活动看门狗，避免累计退避时长触发误杀
                    armActivityTimer(job);

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
                    // 如果已用时超过3分钟，说明瓶颈在本地管线（reranker慢速），重试只会再跑一次 reranker，无意义
                    if ((Date.now() - startTime) > 3 * 60 * 1000) {
                        console.log(`[Telegram Bridge] 已用时超过3分钟，判定为本地管线瓶颈（reranker），停止重试`);
                        break;
                    }
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
                        chatId: job.chatId,
                        text: errorMessage,
                        // 携带原始失败消息，便于 server 端“重发”按钮精确重发
                        resendText: job.text,
                        resendInlineImage: job.inlineImage || undefined,
                    }));
                }

                job.error = true;
                cleanup();
                finishJob(job);
                return;
            }
        }

        // 所有重试都失败（超时或达到最大重试次数）
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
                    chatId: job.chatId,
                    text: errorMessage,
                    // 携带原始失败消息，便于 server 端“重发”按钮精确重发
                    resendText: job.text,
                    resendInlineImage: job.inlineImage || undefined,
                }));
            }
            job.error = true;
            cleanup();
            finishJob(job);
            return;
        }

        // 生成成功：等待最终回复（GENERATION_ENDED → handleFinalMessage）
        // 若 30 秒内未收到最终回复，判定 ST 卡死并自愈
        clearTimeout(job.activityTimer);
        job.finalReplyTimer = setTimeout(() => {
            if (currentJob === job) {
                onJobWedged(job, '生成完成但30秒未收到最终回复');
            }
        }, FINAL_REPLY_TIMEOUT_MS);
    } catch (error) {
        console.error('[Telegram Bridge] 处理消息时发生错误:', error);
        // 清理残留的用户消息
        try {
            await deleteLastMessage();
        } catch (e) { }
        if (currentJob === job && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'error_message',
                chatId: job.chatId,
                text: '处理您的消息时发生了一个内部错误。',
                // 携带原始失败消息，便于 server 端“重发”按钮精确重发
                resendText: job.text,
                resendInlineImage: job.inlineImage || undefined,
            }));
        }
        job.error = true;
        if (cleanup) cleanup();
        finishJob(job);
    }
}

// 连接到WebSocket服务器
function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        console.log('[Telegram Bridge] 已连接或正在连接中');
        return;
    }

    const settings = getSettings();
    if (!settings.bridgeUrl) {
        updateStatus('URL 未设置！', 'red');
        return;
    }

    manuallyDisconnected = false;
    updateStatus('连接中...', 'orange');
    console.log(`[Telegram Bridge] 正在连接 ${settings.bridgeUrl}...`);

    const socket = new WebSocket(settings.bridgeUrl);
    ws = socket;

    socket.onopen = () => {
        if (ws !== socket) return; // 防止旧 socket 覆盖新 socket
        console.log('[Telegram Bridge] 连接成功！');
        updateStatus('已连接', 'green');
        reconnectAttempts = 0;
        reconnectStartTime = 0;
        lastActivityTime = Date.now();
        startHeartbeat();
        startReloadCounterResetTimer();
    };

    socket.onmessage = async (event) => {
        if (ws !== socket) return;
        lastActivityTime = Date.now();

        let data;
        try {
            data = JSON.parse(event.data);

            // --- 心跳应答 ---
            if (data.type === 'heartbeat_ack') {
                return;
            }

            // --- 用户消息处理：进入 FIFO 队列串行处理 ---
            if (data.type === 'user_message') {
                console.log('[Telegram Bridge] 收到用户消息，加入队列。', data);
                messageQueue.push({
                    chatId: data.chatId,
                    text: data.text,
                    inlineImage: data.inlineImage,
                    finished: false,
                });
                processQueue();
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
                        case 'reranker': {
                            const $rerankCheckbox = $('#vectors_rerank_enabled');
                            if (!$rerankCheckbox.length) {
                                replyText = '未找到Vector Storage插件的Reranker开关，请确认该扩展已启用并刷新页面。';
                                break;
                            }
                            const rerankArg = ((data.args && data.args[0]) || '').toLowerCase();
                            const rerankCurrent = $rerankCheckbox.prop('checked');
                            if (!rerankArg) {
                                replyText = `Reranker当前状态：${rerankCurrent ? '开启' : '关闭'}。\n用法: /reranker on 或 /reranker off`;
                                commandSuccess = true;
                                break;
                            }
                            let rerankTarget = null;
                            if (['on', 'true', '1', '开', '开启'].includes(rerankArg)) rerankTarget = true;
                            else if (['off', 'false', '0', '关', '关闭'].includes(rerankArg)) rerankTarget = false;
                            if (rerankTarget === null) {
                                replyText = '无效参数。用法: /reranker on | /reranker off | /reranker（查看状态）';
                                break;
                            }
                            $rerankCheckbox.prop('checked', rerankTarget).trigger('input');
                            replyText = `Reranker已${rerankTarget ? '开启' : '关闭'}。`;
                            commandSuccess = true;
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

    socket.onclose = () => {
        if (ws !== socket) return;
        ws = null;
        stopHeartbeat();
        console.log('[Telegram Bridge] 连接已关闭。');
        updateStatus('已断开', 'red');

        if (!manuallyDisconnected) {
            scheduleReconnect();
        }
    };

    socket.onerror = (error) => {
        console.error('[Telegram Bridge] WebSocket错误:', error);
    };
}

function disconnect() {
    manuallyDisconnected = true;
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    if (ws) {
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
    const job = currentJob;
    if (!job) {
        console.warn('[Telegram Bridge] handleFinalMessage: no currentJob, skipping');
        return;
    }

    // 如果该任务已经被其他路径完成，直接跳过
    if (job.finished) {
        console.warn('[Telegram Bridge] handleFinalMessage: job already finished, skipping');
        return;
    }

    // WebSocket 未连接：无法送达回复，但仍需结束该任务，避免队列卡死
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.warn('[Telegram Bridge] 生成完成但WebSocket未连接，跳过推送并结束任务');
        finishJob(job);
        return;
    }

    const chatId = job.chatId;
    const lastMessageIndex = lastMessageIdInChatArray - 1;
    if (lastMessageIndex < 0) {
        console.warn(`[Telegram Bridge] lastMessageIndex < 0 (${lastMessageIdInChatArray}), finishJob`);
        finishJob(job);
        return;
    }

    setTimeout(() => {
        try {
            // 仅当该任务仍处于进行中才处理（防止过期任务影响新任务）
            if (currentJob !== job) {
                console.warn(`[Telegram Bridge] handleFinalMessage setTimeout: currentJob !== job (${currentJob?.chatId} !== ${job.chatId}), skip`);
                return;
            }

            // 再次检查 job 是否已被其他路径完成
            if (job.finished) {
                console.warn('[Telegram Bridge] handleFinalMessage setTimeout: job already finished, skip');
                return;
            }

            const context = SillyTavern.getContext();
            const lastMessage = context.chat[lastMessageIndex];

            if (lastMessage && !lastMessage.is_user && !lastMessage.is_system) {
                const messageElement = $(`#chat .mes[mesid="${lastMessageIndex}"]`);

                if (messageElement.length > 0) {
                    const messageTextElement = messageElement.find('.mes_text');

                    let renderedText = messageTextElement.html()
                        .replace(/<br\s*\/?>/gi, '\n')
                        .replace(/<\/p>\s*<p>/gi, '\n\n');

                    const tempDiv = document.createElement('div');
                    tempDiv.innerHTML = renderedText;
                    renderedText = tempDiv.textContent;

                    console.log(`[Telegram Bridge] 捕获到最终渲染文本，准备发送更新到 chatId: ${chatId}`);

                    if (job.isStreamingMode) {
                        ws.send(JSON.stringify({
                            type: 'final_message_update',
                            chatId: chatId,
                            text: renderedText,
                        }));
                        job.isStreamingMode = false;
                    } else {
                        ws.send(JSON.stringify({
                            type: 'ai_reply',
                            chatId: chatId,
                            text: renderedText,
                        }));
                    }
                } else {
                    console.warn(`[Telegram Bridge] 未找到消息DOM元素 mesid=${lastMessageIndex}，跳过推送（DOM可能尚未渲染完成）`);
                }
            } else {
                console.warn(`[Telegram Bridge] 最终消息校验未通过 mesid=${lastMessageIndex}`,
                    lastMessage ? { is_user: !!lastMessage.is_user, is_system: !!lastMessage.is_system } : '消息对象不存在');
            }
        } catch (err) {
            console.error(`[Telegram Bridge] handleFinalMessage setTimeout 内部异常:`, err);
        } finally {
            finishJob(job);
        }
    }, 100);
}

// 全局事件监听器，用于最终消息更新（使用 on 持续监听；job.finished 防重复触发）
eventSource.on(event_types.GENERATION_ENDED, handleFinalMessage);

// 添加对手动停止生成的处理
eventSource.on(event_types.GENERATION_STOPPED, handleFinalMessage);
