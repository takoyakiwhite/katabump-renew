const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const { buildBrowserLaunchOptions, classifyProxyResponse, classifyProxyError, validateUsersConfig, safeAccountLabel } = require('./runtime_helpers');
const { CONFIG, EXIT_CODE } = require('./config');
const { launchBrowser, preparePage } = require('./browser');
const { pageHasTurnstile, solveTurnstile, turnstileDiagnostics } = require('./captcha');
const {
    bodyText,
    expiryFromText,
    notReadyFromText,
    successFromText,
    openServer,
    clickOuterRenew,
    waitForDashboard,
    waitForRenewModal,
    getRenewConfirmButton,
    readRenewState,
} = require('./katabump_page');
const {
    makeResult,
    statusToCode,
    writeResult,
    mergeCode,
    summarizeStatus,
    sendNotification,
} = require('./result');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function proxyFromEnv(raw) {
    if (!raw) return null;
    try {
        const u = new URL(raw);
        if (u.protocol !== 'http:' || !u.hostname || !u.port) return null;
        const username = u.username ? decodeURIComponent(u.username) : '';
        const password = u.password ? decodeURIComponent(u.password) : '';
        return {
            server: `http://${u.hostname}:${u.port}`,
            host: u.hostname,
            port: Number(u.port),
            username: username || undefined,
            password: password || undefined,
        };
    } catch {
        return null;
    }
}

async function preflightProxy(proxy) {
    if (!proxy) return { ok: true, category: 'no_proxy' };
    try {
        const request = {
            proxy: { protocol: 'http', host: proxy.host, port: proxy.port },
            timeout: CONFIG.proxyTimeoutMs,
        };
        if (proxy.username && proxy.password) request.proxy.auth = { username: proxy.username, password: proxy.password };
        const response = await axios.get(CONFIG.targetUrl, request);
        return classifyProxyResponse(response.status);
    } catch (error) {
        return error.response?.status
            ? classifyProxyResponse(error.response.status)
            : classifyProxyError(error);
    }
}

async function dump(page, name) {
    fs.mkdirSync(CONFIG.screenshotDir, { recursive: true });
    const screenshotPath = path.join(CONFIG.screenshotDir, `${name}.png`);
    const htmlPath = path.join(CONFIG.screenshotDir, `${name}.html`);
    try { await page.screenshot({ path: screenshotPath, fullPage: true }); } catch (error) { console.error(`[诊断] 截图失败: ${error.message}`); }
    try { fs.writeFileSync(htmlPath, await page.content(), 'utf8'); } catch (error) { console.error(`[诊断] HTML 保存失败: ${error.message}`); }
    return { screenshotPath, htmlPath };
}

async function waitForRenewCompletion(page, modal, oldExpiry, label) {
    const deadline = Date.now() + CONFIG.renewSettleMs;
    let lastCf = false;

    while (Date.now() < deadline) {
        const state = await readRenewState(page, modal);
        if (state.success) return { status: 'success', message: 'Renew successful', oldExpiry, newExpiry: state.expiry, cfHandled: lastCf };
        if (state.notReady) return { status: 'not_ready', message: state.notReady, oldExpiry, newExpiry: state.expiry, cfHandled: lastCf };
        if (oldExpiry && state.expiry && oldExpiry !== state.expiry) {
            return { status: 'success', message: 'Expiry changed', oldExpiry, newExpiry: state.expiry, cfHandled: lastCf };
        }

        const modalVisible = await modal.isVisible().catch(() => false);
        if (!modalVisible) {
            await sleep(Math.min(CONFIG.renewPostSettleMs, Math.max(0, deadline - Date.now())));
            const finalText = await bodyText(page);
            const finalExpiry = expiryFromText(finalText);
            return oldExpiry && finalExpiry === oldExpiry
                ? { status: 'already_renewed', message: 'Renew modal closed but Expiry did not change', oldExpiry, newExpiry: finalExpiry, cfHandled: lastCf }
                : { status: 'success', message: 'Renew modal closed after confirmation', oldExpiry, newExpiry: finalExpiry, cfHandled: lastCf };
        }

        if (!lastCf && await pageHasTurnstile(page, modal)) {
            lastCf = true;
            const solved = await solveTurnstile(page, 'Renew阶段', CONFIG, sleep);
            if (!solved.solved) {
                const info = await turnstileDiagnostics(page);
                return { status: 'captcha_required', message: `Renew Turnstile could not be completed${info.verificationFailed ? ': verification failed' : ''}`, oldExpiry, cfHandled: true };
            }

            await sleep(1_500);
            const retry = await getRenewConfirmButton(modal);
            if (retry && await retry.isVisible().catch(() => false) && await retry.isEnabled().catch(() => false)) {
                console.log('[Renew阶段] Turnstile 验证完成，重新点击 Confirm。');
                await retry.click();
            }
            continue;
        }

        await sleep(500);
    }

    const finalState = await readRenewState(page, modal);
    if (finalState.success || (oldExpiry && finalState.expiry && oldExpiry !== finalState.expiry)) {
        return { status: 'success', message: 'Renew successful', oldExpiry, newExpiry: finalState.expiry, cfHandled: lastCf };
    }
    if (finalState.notReady) return { status: 'not_ready', message: finalState.notReady, oldExpiry, newExpiry: finalState.expiry, cfHandled: lastCf };
    if (await pageHasTurnstile(page, modal)) return { status: 'captcha_required', message: 'Renew Turnstile remains after settlement timeout', oldExpiry, newExpiry: finalState.expiry, cfHandled: true };
    return { status: 'error', message: 'Renew confirmation completed without a clear result', oldExpiry, newExpiry: finalState.expiry, cfHandled: lastCf };
}

async function login(page, user) {
    try {
        await page.goto(CONFIG.targetUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.navigationTimeoutMs });
        await sleep(CONFIG.loginSettleMs);

        // 600010 等 Turnstile pageerror 本身不是验证失败证据；只有真实 challenge 存在时才处理。
        if (await pageHasTurnstile(page)) {
            const solved = await solveTurnstile(page, '登录阶段', CONFIG, sleep);
            if (!solved.solved) return { ok: false, status: 'login_captcha_required', message: 'Login Turnstile could not be completed' };
        }

        const email = page.locator('input[type="email"]').first();
        const password = page.locator('input[type="password"]').first();
        await email.waitFor({ state: 'visible', timeout: CONFIG.loginFormTimeoutMs });
        await email.fill(user.username);
        await sleep(CONFIG.emailSettleMs);
        await password.fill(user.password);
        await sleep(CONFIG.passwordSettleMs);

        const loginButton = page.getByRole('button', { name: 'Login', exact: true }).first();
        await loginButton.click();

        await sleep(CONFIG.loginSettleMs);
        const afterLogin = await bodyText(page);
        if (/Incorrect password or no account/i.test(afterLogin)) {
            return { ok: false, status: 'login_failed', message: 'Incorrect password or no account' };
        }
        if (/error=captcha/i.test(page.url()) || /Please complete captcha|captcha required/i.test(afterLogin)) {
            return { ok: false, status: 'login_captcha_required', message: 'Login captcha was not accepted' };
        }
        if (await waitForDashboard(page)) return { ok: true };
        return { ok: false, status: 'login_failed', message: 'Dashboard entry not found after login' };
    } catch (error) {
        return { ok: false, status: 'login_failed', message: `Login interaction failed: ${error.message}` };
    }
}

async function renewAccount(page, label) {
    await openServer(page);
    if (!(await clickOuterRenew(page))) return { status: 'error', message: 'Renew button not found' };
    console.log('Renew 按钮已点击。等待模态框...');

    const modal = await waitForRenewModal(page);
    if (!modal) return { status: 'error', message: 'Renew modal did not appear' };
    console.log('Renew 模态框已识别。');

    const stateBefore = await readRenewState(page, modal);
    if (stateBefore.notReady) return { status: 'not_ready', message: stateBefore.notReady, oldExpiry: stateBefore.expiry };
    const oldExpiry = stateBefore.expiry;

    // ALTCHA 文本、altcha-widget、普通 checkbox 都不代表需要验证。
    // 只有真正的 Cloudflare Turnstile frame/widget 才进入验证逻辑。
    if (await pageHasTurnstile(page, modal)) {
        console.log('[Renew阶段] 检测到真实 Cloudflare Turnstile，尝试处理。');
        const solved = await solveTurnstile(page, 'Renew阶段', CONFIG, sleep);
        if (!solved.solved) return { status: 'captcha_required', message: 'Renew Turnstile could not be completed', oldExpiry };
    } else {
        console.log('[Renew阶段] 未检测到真实 Cloudflare Turnstile，正常继续。');
    }

    const confirm = await getRenewConfirmButton(modal);
    if (!confirm || !(await confirm.isVisible().catch(() => false))) return { status: 'error', message: 'Renew confirm button not found', oldExpiry };
    if (!(await confirm.isEnabled().catch(() => false))) return { status: 'error', message: 'Renew confirm button is disabled', oldExpiry };

    await confirm.click();
    console.log(`[Renew阶段] Confirm 已点击，等待约 ${Math.round(CONFIG.renewSettleMs / 1000)} 秒。`);
    return waitForRenewCompletion(page, modal, oldExpiry, label);
}

async function runAccount(browser, user, index) {
    const label = safeAccountLabel(user, index);
    if (user.__invalidConfig) return { account: user.username || label, status: 'login_failed', message: user.__invalidReason };

    const context = await browser.newContext({
        locale: CONFIG.locale,
        viewport: CONFIG.viewport,
    });
    try {
        const page = await preparePage(context);
        const loginResult = await login(page, user);
        if (!loginResult.ok) {
            const debug = await dump(page, `login_${loginResult.status}_${label}`);
            return { account: user.username, ...loginResult, ...debug };
        }

        const renewResult = await renewAccount(page, label);
        let debug = {};
        if (renewResult.status !== 'success' && renewResult.status !== 'already_renewed') {
            debug = await dump(page, `renew_${renewResult.status}_${label}`);
        } else if (renewResult.status === 'success') {
            debug = await dump(page, `renew_success_${label}`);
        }
        return { account: user.username, ...renewResult, ...debug };
    } finally {
        await context.close().catch(() => { });
    }
}

async function run() {
    const usersConfig = validateUsersConfig(process.env.USERS_JSON);
    if (!usersConfig.valid) {
        const r = makeResult({ exitCode: EXIT_CODE.FATAL, status: 'error', message: `Invalid USERS_JSON: ${usersConfig.reason}` });
        writeResult(r);
        await sendNotification(r);
        return r.exitCode;
    }

    const proxy = proxyFromEnv(process.env.HTTP_PROXY);
    if (process.env.HTTP_PROXY && !proxy) {
        const r = makeResult({ exitCode: EXIT_CODE.FATAL, status: 'error', message: 'Invalid HTTP_PROXY format' });
        writeResult(r);
        await sendNotification(r);
        return r.exitCode;
    }

    if (proxy) {
        const check = await preflightProxy(proxy);
        if (['proxy_auth_failed', 'upstream_gateway_error', 'transport_error'].includes(check.category)) {
            const r = makeResult({ exitCode: EXIT_CODE.PROXY_RETRY, status: 'proxy_retry', message: check.error || check.category });
            writeResult(r);
            await sendNotification(r);
            return r.exitCode;
        }
    }

    let runtime;
    try {
        runtime = await launchBrowser(proxy);
        const accounts = [];
        let overall = EXIT_CODE.SUCCESS;
        let screenshotPath = null;
        let htmlPath = null;

        for (let i = 0; i < usersConfig.users.length; i += 1) {
            const account = await runAccount(runtime.browser, usersConfig.users[i], i);
            accounts.push(account);
            overall = mergeCode(overall, statusToCode(account.status));
            screenshotPath = account.screenshotPath || screenshotPath;
            htmlPath = account.htmlPath || htmlPath;
            // 登录验证码失败通常与当前代理相关，交给 proxy_runner 换代理；不用浪费同一代理跑后续账号。
            if (account.status === 'login_captcha_required') break;
        }

        const status = summarizeStatus(accounts);
        const finalResult = makeResult({
            exitCode: overall,
            status,
            message: accounts[accounts.length - 1]?.message || '',
            accounts,
            screenshotPath,
            htmlPath,
        });
        writeResult(finalResult);
        await sendNotification(finalResult);
        return overall;
    } catch (error) {
        const finalResult = makeResult({ exitCode: EXIT_CODE.FATAL, status: 'error', message: error.message });
        writeResult(finalResult);
        await sendNotification(finalResult);
        return EXIT_CODE.FATAL;
    } finally {
        await runtime?.close().catch(() => { });
    }
}

module.exports = {
    EXIT_CODE,
    CONFIG,
    proxyFromEnv,
    expiryFromText,
    notReadyFromText,
    successFromText,
    pageHasTurnstile,
    run,
};
