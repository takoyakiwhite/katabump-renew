const { EXIT_CODE } = require('./config');
const {
    loadProxies,
    loadCooldowns,
    removeExpiredCooldowns,
    buildProxyCandidateQueue,
    proxyKey,
    addCooldown,
    getMaxProxyAttempts,
} = require('./proxy_manager');
const {
    runActionRenew,
    makeAttemptRecord,
    isRealProxyNetworkFailure,
} = require('./action_runner');
const {
    normalizeFinalCode,
    buildFinalSummary,
    formatFinalNotification,
} = require('./proxy_summary');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const { sendTelegramNotification } = require('./telegram');

const NON_RETRYABLE = new Set([
    EXIT_CODE.SUCCESS,
    EXIT_CODE.NOT_READY,
    EXIT_CODE.ALREADY_RENEWED,
    EXIT_CODE.LOGIN_FAILED,
    EXIT_CODE.RENEW_CAPTCHA_FAILED,
]);

async function sendFinalTelegram(summary) {
    const message = formatFinalNotification(summary);
    console.log('[proxy-runner] 发送最终 Telegram 通知');
    try {
        return await sendTelegramNotification({
            axios,
            FormData,
            fs,
            token: process.env.TG_BOT_TOKEN,
            chatId: process.env.TG_CHAT_ID,
            message,
            imagePath: summary.screenshotPath,
            logger: console,
        });
    } catch (error) {
        console.error(`[proxy-runner] 最终 Telegram 通知失败: ${error.message}`);
        return { skipped: false, textSent: false, imageSent: false };
    }
}

async function finalizeWorkflow(finalCode, finalResult, attempts, maxAttempts) {
    const summary = buildFinalSummary(finalCode, finalResult, attempts, maxAttempts);
    await sendFinalTelegram(summary);
    return finalCode;
}

async function runProxyWorkflow() {
    const attempts = [];
    console.log('[proxy-runner] 启动代理轮换控制器');

    const proxyResult = loadProxies();
    let cooldowns = removeExpiredCooldowns(loadCooldowns());
    const proxies = proxyResult.valid;
    const attemptedProxyKeys = new Set();
    const candidates = buildProxyCandidateQueue(proxies, cooldowns, attemptedProxyKeys);
    const maxAttempts = proxies.length > 0 ? getMaxProxyAttempts(candidates.length) : 0;

    console.log(`[proxy-runner] 有效代理=${proxies.length}，冷却后候选=${candidates.length}，最多尝试=${maxAttempts}`);

    if (!proxyResult.configured) {
        const directResult = await runActionRenew(null, 1);
        const directRecord = makeAttemptRecord(1, null, directResult);
        directRecord.directFallback = true;
        attempts.push(directRecord);
        return finalizeWorkflow(normalizeFinalCode(directResult.code), directResult.actionResult || directRecord, attempts, maxAttempts);
    }

    if (proxies.length === 0) {
        return finalizeWorkflow(EXIT_CODE.NO_PROXY_AVAILABLE, {
            status: 'no_proxy_available',
            message: 'No valid proxy is configured',
            accounts: [],
        }, attempts, maxAttempts);
    }

    if (candidates.length === 0) {
        return finalizeWorkflow(EXIT_CODE.NO_PROXY_AVAILABLE, {
            status: 'no_proxy_available',
            message: 'All valid proxies are currently cooling down',
            accounts: [],
        }, attempts, maxAttempts);
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const selection = candidates.shift();
        if (!selection) break;
        const key = proxyKey(selection);
        attemptedProxyKeys.add(key);
        console.log(`\n[proxy-runner] ===== 代理尝试 ${attempt}/${maxAttempts}: ${key} =====`);

        const actionResult = await runActionRenew(selection, attempt);
        const attemptRecord = makeAttemptRecord(attempt, selection, actionResult);
        attempts.push(attemptRecord);
        const code = actionResult.code;

        if (NON_RETRYABLE.has(code)) {
            return finalizeWorkflow(normalizeFinalCode(code), actionResult.actionResult || attemptRecord, attempts, maxAttempts);
        }

        if (code === EXIT_CODE.PROXY_RETRY) {
            addCooldown(cooldowns, selection, 'proxy_retry_from_action_renew');
            cooldowns = loadCooldowns();
            continue;
        }

        return finalizeWorkflow(code, actionResult.actionResult || attemptRecord, attempts, maxAttempts);
    }

    if (attempts.length > 0 && attempts.every(isRealProxyNetworkFailure)) {
        console.log('[proxy-runner] 所有代理均明确为网络故障，启用直连 fallback');
        const directResult = await runActionRenew(null, attempts.length + 1);
        const directRecord = makeAttemptRecord(attempts.length + 1, null, directResult);
        directRecord.directFallback = true;
        attempts.push(directRecord);
        return finalizeWorkflow(normalizeFinalCode(directResult.code), directResult.actionResult || directRecord, attempts, maxAttempts);
    }

    return finalizeWorkflow(EXIT_CODE.FATAL, attempts.at(-1) || {
        status: 'proxy_exhausted',
        message: 'All proxy attempts returned PROXY_RETRY',
        accounts: [],
    }, attempts, maxAttempts);
}

module.exports = {
    NON_RETRYABLE,
    sendFinalTelegram,
    finalizeWorkflow,
    runProxyWorkflow,
};
