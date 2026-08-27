const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const {
    buildBrowserLaunchOptions,
    classifyProxyResponse,
    classifyProxyError,
    mergeExitCode,
    validateUsersConfig,
    safeAccountLabel,
} = require('./runtime_helpers');
const { sendTelegramNotification } = require('./telegram');

chromium.use(stealth);

const EXIT_CODE = Object.freeze({
    SUCCESS: 0,
    FATAL: 1,
    PROXY_RETRY: 42,
    RENEW_CAPTCHA_FAILED: 43,
    NOT_READY: 3,
    ALREADY_RENEWED: 4,
    LOGIN_FAILED: 5,
});

const CONFIG = Object.freeze({
    targetUrl: 'https://dashboard.katabump.com/auth/login',
    loginTimeoutMs: 15_000,
    modalTimeoutMs: 10_000,
    settleMs: 10_000,
    extraSettleMs: 5_000,
    turnstileTimeoutMs: 15_000,
    proxyTimeoutMs: 10_000,
    screenshotDir: path.join(process.cwd(), 'screenshots'),
});

function result({ exitCode, status, message = '', accounts = [], screenshotPath = null, htmlPath = null }) {
    return { exitCode, status, message, accounts, screenshotPath, htmlPath, timestamp: new Date().toISOString() };
}

function writeResult(payload) {
    const file = process.env.KATABUMP_RESULT_FILE;
    if (!file) return;
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
    } catch (error) {
        console.error(`[结果] 写入失败: ${error.message}`);
    }
}

function proxyFromEnv(raw) {
    if (!raw) return null;
    try {
        const u = new URL(raw);
        if (u.protocol !== 'http:' || !u.hostname || !u.port) return null;
        return {
            server: `http://${u.hostname}:${u.port}`,
            host: u.hostname,
            port: Number(u.port),
            username: u.username ? decodeURIComponent(u.username) : undefined,
            password: u.password ? decodeURIComponent(u.password) : undefined,
        };
    } catch {
        return null;
    }
}

async function preflightProxy(proxy) {
    if (!proxy) return { ok: true, category: 'no_proxy' };
    try {
        const config = {
            proxy: { protocol: 'http', host: proxy.host, port: proxy.port },
            timeout: CONFIG.proxyTimeoutMs,
        };
        if (proxy.username && proxy.password) {
            config.proxy.auth = { username: proxy.username, password: proxy.password };
        }
        const response = await axios.get(CONFIG.targetUrl, config);
        return classifyProxyResponse(response.status);
    } catch (error) {
        return error.response?.status ? classifyProxyResponse(error.response.status) : classifyProxyError(error);
    }
}

async function text(page) {
    try {
        return (await page.locator('body').innerText()).replace(/\s+/g, ' ').trim();
    } catch {
        return '';
    }
}

function expiryFromText(value) {
    const textValue = String(value || '');
    const patterns = [
        /(?:Expiry|Expires?)[^\d]*(\d{4}-\d{2}-\d{2})/i,
        /(?:Expiry|Expires?)[^A-Za-z]*(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}/i,
    ];
    for (const p of patterns) {
        const m = textValue.match(p);
        if (m) return m[1] && /^\d{4}-/.test(m[1]) ? m[1] : m[0].replace(/^.*?(?:Expiry|Expires?)\s*/i, '').trim();
    }
    return null;
}

function notReadyFromText(value) {
    const textValue = String(value || '');
    if (!/You can't renew your server yet|You will be able to as of/i.test(textValue)) return null;
    return textValue.slice(Math.max(0, textValue.search(/You can't renew your server yet/i)), 300).trim();
}

function successFromText(value) {
    return /renew(?:al)?\s+(?:successful|completed)|renewed successfully|successfully renewed/i.test(String(value || ''));
}

function isCfUrl(url) {
    return /challenges\.cloudflare\.com|turnstile/i.test(url || '');
}

async function hasRealTurnstile(page, scope = page) {
    try {
        if (page.frames().some(frame => isCfUrl(frame.url()))) return true;
        return await scope.locator('.cf-turnstile, iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]').count() > 0;
    } catch {
        return false;
    }
}

async function waitForTurnstile(page, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await hasRealTurnstile(page)) return true;
        await page.waitForTimeout(400);
    }
    return false;
}

async function clickTurnstile(page) {
    for (const frame of page.frames().filter(frame => isCfUrl(frame.url()))) {
        try {
            const element = await frame.frameElement();
            const box = element ? await element.boundingBox() : null;
            if (box && box.width >= 50 && box.height >= 20) {
                await page.mouse.click(box.x + 28, box.y + box.height / 2);
                return true;
            }
        } catch { }
    }
    try {
        const widget = page.locator('.cf-turnstile').first();
        const box = await widget.boundingBox();
        if (box && box.width >= 50 && box.height >= 20) {
            await page.mouse.click(box.x + 28, box.y + box.height / 2);
            return true;
        }
    } catch { }
    return false;
}

async function solveTurnstile(page, stage) {
    if (!(await hasRealTurnstile(page))) return { present: false, solved: false };
    console.log(`[${stage}] 检测到真实 Cloudflare Turnstile。`);
    if (!(await clickTurnstile(page))) return { present: true, solved: false };
    await page.waitForTimeout(2500);
    const start = Date.now();
    while (Date.now() - start < CONFIG.turnstileTimeoutMs) {
        const body = await text(page);
        if (!/Verification failed/i.test(body) && !(await hasRealTurnstile(page))) return { present: true, solved: true };
        await page.waitForTimeout(800);
    }
    return { present: true, solved: false };
}

async function waitForModal(page) {
    const start = Date.now();
    while (Date.now() - start < CONFIG.modalTimeoutMs) {
        const modal = page.locator('div.modal.show, div[role="dialog"], .modal').last();
        if (await modal.isVisible().catch(() => false)) return modal;
        await page.waitForTimeout(250);
    }
    return null;
}

async function confirmButton(modal) {
    const preferred = modal.locator('div.modal-footer button.btn.btn-primary').filter({ hasText: /^Renew$/i }).first();
    if (await preferred.isVisible().catch(() => false)) return preferred;
    return modal.getByRole('button', { name: 'Renew', exact: true }).first();
}

async function dump(page, name) {
    fs.mkdirSync(CONFIG.screenshotDir, { recursive: true });
    const screenshotPath = path.join(CONFIG.screenshotDir, `${name}.png`);
    const htmlPath = path.join(CONFIG.screenshotDir, `${name}.html`);
    try { await page.screenshot({ path: screenshotPath, fullPage: true }); } catch { }
    try { fs.writeFileSync(htmlPath, await page.content(), 'utf8'); } catch { }
    return { screenshotPath, htmlPath };
}

async function login(page, user) {
    await page.goto(CONFIG.targetUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(2500);

    const cf = await solveTurnstile(page, '登录阶段');
    if (cf.present && !cf.solved) return { ok: false, status: 'login_captcha_required', message: 'Login Turnstile could not be completed' };

    const email = page.locator('input[type="email"]').first();
    const password = page.locator('input[type="password"]').first();
    try {
        await email.waitFor({ state: 'visible', timeout: CONFIG.loginTimeoutMs });
        await email.fill(user.username);
        await page.waitForTimeout(1000);
        await password.fill(user.password);
        await page.waitForTimeout(3000);
        await page.getByRole('button', { name: 'Login', exact: true }).click();
    } catch (error) {
        return { ok: false, status: 'login_failed', message: `Login interaction failed: ${error.message}` };
    }

    await page.waitForTimeout(2500);
    const body = await text(page);
    if (/Incorrect password or no account/i.test(body)) return { ok: false, status: 'login_failed', message: 'Incorrect password or no account' };
    if (/error=captcha/i.test(page.url()) || /Please complete captcha|captcha required/i.test(body)) {
        return { ok: false, status: 'login_captcha_required', message: 'Login captcha was not accepted' };
    }

    const start = Date.now();
    while (Date.now() - start < CONFIG.loginTimeoutMs) {
        if (/dashboard/i.test(page.url()) || await page.getByRole('link', { name: 'See', exact: true }).first().isVisible().catch(() => false)) return { ok: true };
        await page.waitForTimeout(400);
    }
    return { ok: false, status: 'login_failed', message: 'Dashboard entry not found after login' };
}

async function renew(page, label) {
    const see = page.getByRole('link', { name: 'See', exact: true }).first();
    if (await see.isVisible().catch(() => false)) {
        await see.click();
        await page.waitForTimeout(800);
    }

    const outer = page.getByRole('button', { name: 'Renew', exact: true }).first();
    if (!(await outer.isVisible().catch(() => false))) return { status: 'error', message: 'Renew button not found' };
    await outer.click();
    console.log('Renew 按钮已点击。等待模态框...');

    const modal = await waitForModal(page);
    if (!modal) return { status: 'error', message: 'Renew modal did not appear' };
    console.log('Renew 模态框已识别。');

    const modalText = (await modal.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    const before = await text(page);
    const oldExpiry = expiryFromText(before) || expiryFromText(modalText);
    const notReady = notReadyFromText(before) || notReadyFromText(modalText);
    if (notReady) return { status: 'not_ready', message: notReady, oldExpiry };

    // ALTCHA/checkbox 文案不是验证依据。只有真实 Turnstile frame/widget 才进入验证码流程。
    if (await hasRealTurnstile(page, modal)) {
        const solved = await solveTurnstile(page, 'Renew阶段');
        if (!solved.solved) return { status: 'captcha_required', message: 'Renew Turnstile could not be completed', oldExpiry };
    } else {
        console.log('[Renew阶段] 未检测到真实 Cloudflare Turnstile，正常继续。');
    }

    const confirm = await confirmButton(modal);
    if (!(await confirm.isVisible().catch(() => false))) return { status: 'error', message: 'Renew confirm button not found', oldExpiry };
    await confirm.click();
    console.log('[Renew阶段] Confirm 已点击，等待约 10 秒。');

    let cfHandled = false;
    if (await waitForTurnstile(page, CONFIG.settleMs)) {
        cfHandled = true;
        const solved = await solveTurnstile(page, 'Renew阶段');
        if (!solved.solved) return { status: 'captcha_required', message: 'Renew Turnstile appeared after confirm but could not be completed', oldExpiry, cfHandled };
        await page.waitForTimeout(1500);
        if (await modal.isVisible().catch(() => false)) {
            const retry = await confirmButton(modal);
            if (await retry.isVisible().catch(() => false)) {
                await retry.click();
                await page.waitForTimeout(CONFIG.settleMs);
            }
        }
    }

    await page.waitForTimeout(CONFIG.extraSettleMs);
    const after = await text(page);
    const newExpiry = expiryFromText(after);
    if (successFromText(after) || (oldExpiry && newExpiry && oldExpiry !== newExpiry)) {
        const debug = await dump(page, `renew_success_${label}`);
        return { status: 'success', message: 'Renew successful', oldExpiry, newExpiry, cfHandled, ...debug };
    }

    const laterNotReady = notReadyFromText(after);
    if (laterNotReady) return { status: 'not_ready', message: laterNotReady, oldExpiry, newExpiry, cfHandled };

    if (!(await modal.isVisible().catch(() => false))) {
        if (oldExpiry && newExpiry === oldExpiry) return { status: 'already_renewed', message: 'Renew modal closed but Expiry did not change', oldExpiry, newExpiry, cfHandled };
        return { status: 'success', message: 'Renew modal closed after confirmation', oldExpiry, newExpiry, cfHandled };
    }

    if (await hasRealTurnstile(page, modal)) return { status: 'captcha_required', message: 'Renew modal remains blocked by Cloudflare Turnstile', oldExpiry, newExpiry, cfHandled: true };
    return { status: 'error', message: 'Renew confirmation completed without a clear result', oldExpiry, newExpiry, cfHandled };
}

function codeForStatus(status) {
    return status === 'success' ? EXIT_CODE.SUCCESS
        : status === 'not_ready' ? EXIT_CODE.NOT_READY
            : status === 'already_renewed' ? EXIT_CODE.ALREADY_RENEWED
                : status === 'login_captcha_required' ? EXIT_CODE.PROXY_RETRY
                    : status === 'captcha_required' ? EXIT_CODE.RENEW_CAPTCHA_FAILED
                        : status === 'login_failed' ? EXIT_CODE.LOGIN_FAILED
                            : EXIT_CODE.FATAL;
}

async function run() {
    const cfg = validateUsersConfig(process.env.USERS_JSON);
    if (!cfg.valid) {
        const r = result({ exitCode: EXIT_CODE.FATAL, status: 'error', message: `Invalid USERS_JSON: ${cfg.reason}` });
        writeResult(r);
        return r.exitCode;
    }

    const proxy = proxyFromEnv(process.env.HTTP_PROXY);
    if (process.env.HTTP_PROXY && !proxy) {
        const r = result({ exitCode: EXIT_CODE.FATAL, status: 'error', message: 'Invalid HTTP_PROXY format' });
        writeResult(r);
        return r.exitCode;
    }
    if (proxy) {
        const check = await preflightProxy(proxy);
        if (['proxy_auth_failed', 'upstream_gateway_error', 'transport_error'].includes(check.category)) {
            const r = result({ exitCode: EXIT_CODE.PROXY_RETRY, status: 'proxy_retry', message: check.error || check.category });
            writeResult(r);
            return r.exitCode;
        }
    }

    let browser;
    const accounts = [];
    let overall = EXIT_CODE.SUCCESS;
    let screenshotPath = null;
    let htmlPath = null;

    try {
        browser = await chromium.launch(buildBrowserLaunchOptions(proxy));
        for (let i = 0; i < cfg.users.length; i += 1) {
            const user = cfg.users[i];
            const label = safeAccountLabel(user, i);
            console.log(`\n=== 正在处理用户 ${i + 1}/${cfg.users.length} ===`);
            if (user.__invalidConfig) {
                const status = 'login_failed';
                const message = user.__invalidReason;
                accounts.push({ account: user.username || label, status, message });
                overall = mergeExitCode(overall, codeForStatus(status));
                continue;
            }

            const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 720 } });
            const page = await context.newPage();
            page.setDefaultTimeout(60_000);
            try {
                const loginResult = await login(page, user);
                if (!loginResult.ok) {
                    accounts.push({ account: user.username, status: loginResult.status, message: loginResult.message });
                    overall = mergeExitCode(overall, codeForStatus(loginResult.status));
                    if (loginResult.status === 'login_captcha_required') break;
                    continue;
                }

                const renewResult = await renew(page, label);
                accounts.push({ account: user.username, status: renewResult.status, message: renewResult.message || '' });
                overall = mergeExitCode(overall, codeForStatus(renewResult.status));
                screenshotPath = renewResult.screenshotPath || screenshotPath;
                htmlPath = renewResult.htmlPath || htmlPath;
            } catch (error) {
                const debug = await dump(page, `error_${label}`);
                accounts.push({ account: user.username, status: 'error', message: error.message });
                overall = mergeExitCode(overall, EXIT_CODE.FATAL);
                screenshotPath = debug.screenshotPath;
                htmlPath = debug.htmlPath;
            } finally {
                await context.close().catch(() => {});
            }
        }
    } catch (error) {
        accounts.push({ account: 'runtime', status: 'error', message: error.message });
        overall = mergeExitCode(overall, EXIT_CODE.FATAL);
    } finally {
        await browser?.close().catch(() => {});
    }

    const hasSuccess = accounts.some(a => a.status === 'success');
    const status = hasSuccess ? 'success' : accounts.find(a => a.status === 'not_ready')?.status || accounts[accounts.length - 1]?.status || 'error';
    const finalResult = result({ exitCode: overall, status, message: accounts[accounts.length - 1]?.message || '', accounts, screenshotPath, htmlPath });
    writeResult(finalResult);

    if (!process.env.KATABUMP_MANAGED_BY_PROXY_RUNNER) {
        try {
            await sendTelegramNotification({
                axios,
                FormData,
                fs,
                token: process.env.TG_BOT_TOKEN,
                chatId: process.env.TG_CHAT_ID,
                message: `KataBump Renew: ${status}`,
                imagePath: screenshotPath,
                logger: console,
            });
        } catch (error) {
            console.error(`[Telegram] 发送失败: ${error.message}`);
        }
    }
    return overall;
}

module.exports = { EXIT_CODE, CONFIG, proxyFromEnv, expiryFromText, notReadyFromText, successFromText, hasRealTurnstile, run };
