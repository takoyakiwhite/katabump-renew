const { EXIT_CODE } = require('./config');

function normalizeFinalCode(code) {
    return code === EXIT_CODE.NOT_READY || code === EXIT_CODE.ALREADY_RENEWED ? EXIT_CODE.SUCCESS : code;
}

function buildFinalSummary(finalCode, finalResult, attempts, maxAttempts = attempts.length) {
    const lastAttempt = attempts.at(-1) || null;
    const actionResult = finalResult || lastAttempt || {};
    const directFallback = attempts.find(attempt => attempt.directFallback === true) || null;
    const accounts = Array.isArray(actionResult.accounts) ? actionResult.accounts : [];
    let status = actionResult.status || 'error';

    if (finalCode === EXIT_CODE.NO_PROXY_AVAILABLE) status = 'no_proxy_available';
    if (finalCode === EXIT_CODE.FATAL && attempts.length > 0 && attempts.every(item => item.code === EXIT_CODE.PROXY_RETRY)) status = 'proxy_exhausted';

    return {
        exitCode: finalCode,
        status,
        message: actionResult.message || '',
        screenshotPath: actionResult.screenshotPath || lastAttempt?.screenshotPath || null,
        htmlPath: actionResult.htmlPath || lastAttempt?.htmlPath || null,
        attempts,
        maxAttempts,
        proxyAttempts: attempts.filter(attempt => attempt.proxy !== 'direct').length,
        directFallbackAttempted: Boolean(directFallback),
        directFallbackSucceeded: Boolean(directFallback && ['success', 'not_ready', 'already_renewed'].includes(directFallback.status)),
        totalAttempts: attempts.length,
        accounts,
        counts: {
            success: accounts.filter(account => ['success', 'already_renewed'].includes(account.status)).length,
            notReady: accounts.filter(account => account.status === 'not_ready').length,
            failed: accounts.filter(account => !['success', 'already_renewed', 'not_ready'].includes(account.status)).length,
        },
    };
}

function formatFinalNotification(summary) {
    const titles = {
        success: '✅ KataBump 自动续期完成',
        not_ready: '⏳ KataBump 本轮暂不可续期',
        already_renewed: 'ℹ️ KataBump 已续期或无需重复续期',
        captcha_required: '⚠️ KataBump 续期验证码阻断',
        login_failed: '❌ KataBump 登录失败',
        no_proxy_available: '❌ KataBump 无可用代理',
        proxy_exhausted: '❌ KataBump 代理已耗尽',
        proxy_retry: '⚠️ KataBump 代理需要重试',
        error: '❌ KataBump 自动续期失败',
    };
    const lines = [titles[summary.status] || titles.error, '', `代理尝试：${summary.proxyAttempts}/${summary.maxAttempts}`];
    if (summary.directFallbackAttempted) lines.push(`直连 fallback：${summary.directFallbackSucceeded ? '已执行' : '失败'}`);
    else if (summary.proxyAttempts === 0 && summary.totalAttempts > 0) lines.push('运行模式：直连');
    if (summary.accounts.length) {
        lines.push(`账号总数：${summary.accounts.length}`);
        lines.push(`成功：${summary.counts.success}`);
        lines.push(`暂不可续期：${summary.counts.notReady}`);
        lines.push(`失败：${summary.counts.failed}`);
    }
    lines.push(`最终状态：${summary.status}`);
    if (summary.message) lines.push(`原因：${summary.message}`);
    return lines.join('\n');
}

module.exports = { normalizeFinalCode, buildFinalSummary, formatFinalNotification };
