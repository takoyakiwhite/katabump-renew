const path = require('path');

function numberEnv(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER, integer = false } = {}) {
    const raw = process.env[name];
    if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || value > max) return fallback;
    return integer ? Math.floor(value) : value;
}

const CONFIG = Object.freeze({
    targetUrl: 'https://dashboard.katabump.com/auth/login',
    viewport: Object.freeze({ width: 1280, height: 720 }),
    locale: 'en-US',
    navigationTimeoutMs: numberEnv('KATABUMP_NAV_TIMEOUT_MS', 60_000, { min: 5_000, max: 180_000, integer: true }),
    loginFormTimeoutMs: numberEnv('KATABUMP_LOGIN_FORM_TIMEOUT_MS', 15_000, { min: 1_000, max: 60_000, integer: true }),
    loginSettleMs: numberEnv('KATABUMP_LOGIN_SETTLE_MS', 2_500, { min: 250, max: 15_000, integer: true }),
    emailSettleMs: numberEnv('KATABUMP_EMAIL_SETTLE_MS', 1_000, { min: 0, max: 10_000, integer: true }),
    passwordSettleMs: numberEnv('KATABUMP_PASSWORD_SETTLE_MS', 3_000, { min: 0, max: 15_000, integer: true }),
    dashboardTimeoutMs: numberEnv('KATABUMP_DASHBOARD_TIMEOUT_MS', 15_000, { min: 1_000, max: 60_000, integer: true }),
    modalTimeoutMs: numberEnv('KATABUMP_MODAL_TIMEOUT_MS', 10_000, { min: 1_000, max: 60_000, integer: true }),
    renewSettleMs: numberEnv('KATABUMP_RENEW_SETTLE_MS', 10_000, { min: 3_000, max: 30_000, integer: true }),
    renewPostSettleMs: numberEnv('KATABUMP_RENEW_POST_SETTLE_MS', 1_000, { min: 250, max: 15_000, integer: true }),
    turnstileDetectPollMs: numberEnv('KATABUMP_TURNSTILE_POLL_MS', 400, { min: 100, max: 2_000, integer: true }),
    turnstileTimeoutMs: numberEnv('KATABUMP_TURNSTILE_TIMEOUT_MS', 20_000, { min: 3_000, max: 60_000, integer: true }),
    turnstileRetryLimit: numberEnv('KATABUMP_TURNSTILE_RETRIES', 2, { min: 1, max: 5, integer: true }),
    proxyTimeoutMs: numberEnv('KATABUMP_PROXY_TIMEOUT_MS', 10_000, { min: 1_000, max: 60_000, integer: true }),
    screenshotDir: path.join(process.cwd(), 'screenshots'),
});

const EXIT_CODE = Object.freeze({
    SUCCESS: 0,
    FATAL: 1,
    PROXY_RETRY: 42,
    RENEW_CAPTCHA_FAILED: 43,
    NOT_READY: 3,
    ALREADY_RENEWED: 4,
    LOGIN_FAILED: 5,
    NO_PROXY_AVAILABLE: 6,
});

module.exports = { CONFIG, EXIT_CODE, numberEnv };
