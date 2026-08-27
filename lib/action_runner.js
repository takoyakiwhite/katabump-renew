const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { normalizeTimeoutMinutes, runChildWithTimeout, DEFAULT_GRACEFUL_TERMINATION_MS } = require('./runtime_helpers');
const { EXIT_CODE } = require('./config');
const { buildChildEnv, safeProxyId, buildHttpProxy, maskProxyUrl, emitGithubMask } = require('./proxy_manager');

const ACTION_TIMEOUT_MINUTES = normalizeTimeoutMinutes(process.env.ACTION_TIMEOUT_MINUTES);
const ACTION_TIMEOUT_MS = ACTION_TIMEOUT_MINUTES * 60 * 1000;

function createAttemptResultFile(attempt) {
    const nonce = crypto.randomBytes(8).toString('hex');
    return path.join(os.tmpdir(), `katabump-action-result-${process.pid}-${attempt}-${nonce}.json`);
}

function readActionResult(resultFile) {
    if (!resultFile) return null;
    try {
        if (!fs.existsSync(resultFile)) return null;
        const parsed = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (error) {
        console.error(`[proxy-runner] 结果文件读取失败: ${error.message}`);
        return null;
    } finally {
        try { fs.unlinkSync(resultFile); } catch { }
    }
}

function actionStatusFromCode(code) {
    switch (code) {
        case EXIT_CODE.SUCCESS: return 'success';
        case EXIT_CODE.NOT_READY: return 'not_ready';
        case EXIT_CODE.ALREADY_RENEWED: return 'already_renewed';
        case EXIT_CODE.LOGIN_FAILED: return 'login_failed';
        case EXIT_CODE.RENEW_CAPTCHA_FAILED: return 'captcha_required';
        case EXIT_CODE.PROXY_RETRY: return 'proxy_retry';
        default: return 'error';
    }
}

function isRealProxyNetworkFailure(attempt) {
    return Boolean(attempt && attempt.proxy !== 'direct' && attempt.code === EXIT_CODE.PROXY_RETRY && attempt.status === 'proxy_retry');
}

function makeAttemptRecord(attempt, parsed, childResult) {
    const actionResult = childResult.actionResult || {};
    const code = Number.isInteger(actionResult.exitCode) ? actionResult.exitCode : childResult.code;
    return {
        attempt,
        proxy: parsed ? safeProxyId(parsed) : 'direct',
        code,
        status: actionResult.status || actionStatusFromCode(code),
        message: actionResult.message || childResult.error?.message || (childResult.timedOut ? 'action_renew.js timed out' : ''),
        screenshotPath: actionResult.screenshotPath || null,
        htmlPath: actionResult.htmlPath || null,
        accounts: Array.isArray(actionResult.accounts) ? actionResult.accounts : [],
        timedOut: childResult.timedOut === true,
    };
}

async function runActionRenew(parsed, attempt = 1) {
    const env = buildChildEnv(parsed, process.env);
    if (!env) return { code: EXIT_CODE.FATAL, timedOut: false, actionResult: null };

    if (parsed) {
        const proxyUrl = buildHttpProxy(parsed);
        console.log(`[proxy-runner] 使用代理 ${safeProxyId(parsed)} (${maskProxyUrl(proxyUrl)})`);
        emitGithubMask(proxyUrl);
    } else {
        console.log('[proxy-runner] 使用直连模式');
    }

    const scriptPath = path.join(process.cwd(), 'action_renew.js');
    const resultFile = createAttemptResultFile(attempt);
    env.KATABUMP_MANAGED_BY_PROXY_RUNNER = '1';
    env.KATABUMP_RESULT_FILE = resultFile;

    try {
        const proc = spawn(process.execPath, [scriptPath], {
            env,
            stdio: 'inherit',
            shell: false,
            detached: true,
        });
        const childResult = await runChildWithTimeout(proc, {
            timeoutMs: ACTION_TIMEOUT_MS,
            gracefulMs: DEFAULT_GRACEFUL_TERMINATION_MS,
            logger: console.error,
        });
        return {
            code: childResult.code,
            timedOut: childResult.timedOut,
            actionResult: readActionResult(resultFile),
            error: childResult.error,
        };
    } catch (error) {
        try { fs.unlinkSync(resultFile); } catch { }
        return { code: EXIT_CODE.FATAL, timedOut: false, actionResult: null, error };
    }
}

module.exports = {
    ACTION_TIMEOUT_MINUTES,
    ACTION_TIMEOUT_MS,
    createAttemptResultFile,
    readActionResult,
    actionStatusFromCode,
    isRealProxyNetworkFailure,
    makeAttemptRecord,
    runActionRenew,
};
