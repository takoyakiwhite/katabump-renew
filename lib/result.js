const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const { EXIT_CODE } = require('./config');
const { sendTelegramNotification } = require('./telegram');

function makeResult({ exitCode, status, message = '', accounts = [], screenshotPath = null, htmlPath = null }) {
    return {
        exitCode,
        status,
        message,
        accounts,
        screenshotPath,
        htmlPath,
        timestamp: new Date().toISOString(),
    };
}

function statusToCode(status) {
    switch (status) {
        case 'success': return EXIT_CODE.SUCCESS;
        case 'not_ready': return EXIT_CODE.NOT_READY;
        case 'already_renewed': return EXIT_CODE.ALREADY_RENEWED;
        case 'login_captcha_required': return EXIT_CODE.PROXY_RETRY;
        case 'captcha_required': return EXIT_CODE.RENEW_CAPTCHA_FAILED;
        case 'login_failed': return EXIT_CODE.LOGIN_FAILED;
        default: return EXIT_CODE.FATAL;
    }
}

function writeResult(result) {
    const file = process.env.KATABUMP_RESULT_FILE;
    if (!file) return;
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(result, null, 2), 'utf8');
    } catch (error) {
        console.error(`[结果] 写入失败: ${error.message}`);
    }
}

function mergeAccountCodes(accounts) {
    let code = EXIT_CODE.SUCCESS;
    for (const account of accounts) {
        code = mergeCode(code, statusToCode(account.status));
    }
    return code;
}

function mergeCode(current, next) {
    const priority = [EXIT_CODE.FATAL, EXIT_CODE.PROXY_RETRY, EXIT_CODE.LOGIN_FAILED, EXIT_CODE.RENEW_CAPTCHA_FAILED, EXIT_CODE.NOT_READY, EXIT_CODE.ALREADY_RENEWED, EXIT_CODE.SUCCESS];
    const a = priority.indexOf(current);
    const b = priority.indexOf(next);
    if (a < 0) return next;
    if (b < 0) return current;
    return b < a ? next : current;
}

function summarizeStatus(accounts, fallback = 'error') {
    if (accounts.some(account => account.status === 'success')) return 'success';
    if (accounts.some(account => account.status === 'not_ready')) return 'not_ready';
    if (accounts.some(account => account.status === 'already_renewed')) return 'already_renewed';
    return accounts[accounts.length - 1]?.status || fallback;
}

function formatNotification(result) {
    const title = {
        success: '✅ KataBump 自动续期完成',
        not_ready: '⏳ KataBump 本轮暂不可续期',
        already_renewed: 'ℹ️ KataBump 已续期或无需重复续期',
        captcha_required: '⚠️ KataBump 续期验证码阻断',
        login_captcha_required: '⚠️ KataBump 登录验证码阻断',
        login_failed: '❌ KataBump 登录失败',
        proxy_retry: '⚠️ KataBump 代理需要重试',
        error: '❌ KataBump 自动续期失败',
    }[result.status] || '❌ KataBump 自动续期失败';

    const lines = [title, ''];
    if (result.accounts?.length) {
        lines.push(`账号总数：${result.accounts.length}`);
        lines.push(`成功：${result.accounts.filter(a => ['success', 'already_renewed'].includes(a.status)).length}`);
        lines.push(`暂不可续期：${result.accounts.filter(a => a.status === 'not_ready').length}`);
        lines.push(`失败：${result.accounts.filter(a => !['success', 'already_renewed', 'not_ready'].includes(a.status)).length}`);
    }
    lines.push(`最终状态：${result.status}`);
    if (result.message) lines.push(`原因：${result.message}`);
    return lines.join('\n');
}

async function sendNotification(result) {
    if (process.env.KATABUMP_MANAGED_BY_PROXY_RUNNER === '1') return { skipped: true };
    try {
        return await sendTelegramNotification({
            axios,
            FormData,
            fs,
            token: process.env.TG_BOT_TOKEN,
            chatId: process.env.TG_CHAT_ID,
            message: formatNotification(result),
            imagePath: result.screenshotPath,
            logger: console,
        });
    } catch (error) {
        console.error(`[Telegram] 发送失败: ${error.message}`);
        return { skipped: false, textSent: false, imageSent: false };
    }
}

module.exports = {
    makeResult,
    statusToCode,
    writeResult,
    mergeCode,
    mergeAccountCodes,
    summarizeStatus,
    formatNotification,
    sendNotification,
};
