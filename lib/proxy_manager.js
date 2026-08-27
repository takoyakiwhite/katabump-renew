const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

function parsePositiveNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const CONFIG = Object.freeze({
    proxyCooldownHours: parsePositiveNumber(process.env.PROXY_COOLDOWN_HOURS, 26),
    maxProxySwitches: parsePositiveNumber(process.env.MAX_PROXY_SWITCHES, null),
    cooldownFile: path.join(process.cwd(), 'proxy-cooldown.json'),
    proxiesFile: path.join(process.cwd(), 'proxies.txt'),
});

function isValidPort(value) {
    return /^[0-9]+$/.test(value) && value.length <= 5 && Number(value) >= 1 && Number(value) <= 65535;
}

function isValidHost(value) {
    return typeof value === 'string' && value.length > 0 && !/[\s/\\?#@\u0000-\u001f\u007f]/.test(value);
}

function parseProxyLine(line, lineNumber) {
    const trimmed = String(line || '').trim();
    if (!trimmed || trimmed.startsWith('#')) return { valid: false, reason: 'empty_or_comment', lineNumber };

    if (trimmed.startsWith('http://')) {
        let parsed;
        try { parsed = new URL(trimmed); } catch { return { valid: false, reason: 'invalid_url_format', lineNumber }; }

        const explicitPort = trimmed.match(/:(\d+)\/?$/)?.[1];
        const port = explicitPort || parsed.port;
        if (
            parsed.protocol !== 'http:' ||
            !parsed.hostname ||
            !port ||
            parsed.pathname !== '/' ||
            parsed.search ||
            parsed.hash ||
            !parsed.username ||
            !parsed.password ||
            !isValidHost(parsed.hostname) ||
            !isValidPort(port)
        ) return { valid: false, reason: 'invalid_url_format', lineNumber };

        try {
            const username = decodeURIComponent(parsed.username);
            const password = decodeURIComponent(parsed.password);
            if (!username || !password) return { valid: false, reason: 'invalid_credentials', lineNumber };
            return { valid: true, ip: parsed.hostname.toLowerCase(), port, username, password, lineNumber };
        } catch {
            return { valid: false, reason: 'invalid_url_encoding', lineNumber };
        }
    }

    const parts = trimmed.split(':');
    if (parts.length === 2) {
        const [ip, port] = parts;
        if (!ip) return { valid: false, reason: 'empty_ip', lineNumber };
        if (!isValidHost(ip)) return { valid: false, reason: 'invalid_host', lineNumber };
        if (!port) return { valid: false, reason: 'empty_port', lineNumber };
        if (!isValidPort(port)) return { valid: false, reason: `invalid_port:${port}`, lineNumber };
        return { valid: true, ip: ip.toLowerCase(), port, username: '', password: '', lineNumber };
    }

    if (parts.length >= 4) {
        const ip = parts[0];
        const port = parts[1];
        const username = parts[2] || '';
        const password = parts.slice(3).join(':') || '';
        if (!ip) return { valid: false, reason: 'empty_ip', lineNumber };
        if (!isValidHost(ip)) return { valid: false, reason: 'invalid_host', lineNumber };
        if (!port) return { valid: false, reason: 'empty_port', lineNumber };
        if (!isValidPort(port)) return { valid: false, reason: `invalid_port:${port}`, lineNumber };
        if (!username || !password) return { valid: false, reason: 'invalid_credentials', lineNumber };
        return { valid: true, ip: ip.toLowerCase(), port, username, password, lineNumber };
    }

    return { valid: false, reason: `invalid_field_count:${parts.length}`, lineNumber };
}

function buildHttpProxy(parsed) {
    if (!parsed?.valid || !parsed.ip || !parsed.port) return null;
    if ((parsed.username && !parsed.password) || (!parsed.username && parsed.password)) return null;
    if (!isValidHost(parsed.ip)) return null;

    const user = parsed.username ? encodeURIComponent(parsed.username) : '';
    const pass = parsed.password ? encodeURIComponent(parsed.password) : '';
    const auth = user ? `${user}:${pass}@` : '';
    const proxyUrl = `http://${auth}${parsed.ip}:${parsed.port}`;

    try {
        const url = new URL(proxyUrl);
        if (url.protocol !== 'http:' || url.hostname !== parsed.ip || url.port !== String(parsed.port)) return null;
        return proxyUrl;
    } catch {
        return null;
    }
}

function proxyKey(parsed) {
    return `${parsed.ip}:${parsed.port}`;
}

function safeProxyId(parsed) {
    return parsed?.valid ? proxyKey(parsed) : 'invalid';
}

function maskProxyUrl(proxyUrl) {
    try {
        const url = new URL(proxyUrl);
        const port = url.port || (url.protocol === 'http:' ? '80' : '');
        return url.username || url.password
            ? `${url.protocol}//***:***@${url.hostname}:${port}`
            : proxyUrl;
    } catch {
        return '***';
    }
}

function emitGithubMask(proxyUrl, env = process.env, logger = console.log) {
    if (env.GITHUB_ACTIONS === 'true') logger(`::add-mask::${proxyUrl}`);
}

function buildChildEnv(parsed, baseEnv = process.env) {
    const env = { ...baseEnv };
    if (parsed === null) {
        delete env.HTTP_PROXY;
        delete env.HTTPS_PROXY;
        delete env.http_proxy;
        delete env.https_proxy;
        return env;
    }
    const proxyUrl = buildHttpProxy(parsed);
    if (!proxyUrl) return null;
    env.HTTP_PROXY = proxyUrl;
    env.HTTPS_PROXY = proxyUrl;
    env.http_proxy = proxyUrl;
    env.https_proxy = proxyUrl;
    return env;
}

function calculateCooldownUntil(nowSeconds = Math.floor(Date.now() / 1000)) {
    return nowSeconds + Math.round(CONFIG.proxyCooldownHours * 3600);
}

function loadCooldowns() {
    try {
        if (!fs.existsSync(CONFIG.cooldownFile)) return {};
        const parsed = JSON.parse(fs.readFileSync(CONFIG.cooldownFile, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
        console.warn(`[proxy-manager] 冷却文件读取失败，按空集合处理: ${error.message}`);
        return {};
    }
}

function saveCooldowns(cooldowns) {
    fs.writeFileSync(CONFIG.cooldownFile, JSON.stringify(cooldowns, null, 2), 'utf8');
}

function addCooldown(cooldowns, parsed, reason) {
    const key = proxyKey(parsed);
    const until = calculateCooldownUntil();
    cooldowns[key] = { until, reason };
    try { saveCooldowns(cooldowns); } catch (error) { console.error(`[proxy-manager] 保存冷却失败: ${error.message}`); }
    console.log(`[proxy-manager] ${key} 冷却至 ${new Date(until * 1000).toISOString()}，原因=${reason}`);
}

function removeExpiredCooldowns(cooldowns) {
    const now = Math.floor(Date.now() / 1000);
    let changed = false;
    for (const [key, value] of Object.entries(cooldowns)) {
        if (!value || !Number.isFinite(Number(value.until)) || Number(value.until) <= now) {
            delete cooldowns[key];
            changed = true;
        }
    }
    if (changed) {
        try { saveCooldowns(cooldowns); } catch (error) { console.error(`[proxy-manager] 保存清理结果失败: ${error.message}`); }
    }
    return cooldowns;
}

function loadProxies() {
    if (!fs.existsSync(CONFIG.proxiesFile)) return { configured: false, valid: [], invalidCount: 0 };
    const lines = fs.readFileSync(CONFIG.proxiesFile, 'utf8').split(/\r?\n/);
    const valid = [];
    const invalid = [];
    lines.forEach((line, index) => {
        const parsed = parseProxyLine(line, index + 1);
        if (!parsed.valid || !buildHttpProxy(parsed)) {
            if (line.trim() && !line.trim().startsWith('#')) invalid.push(parsed);
            return;
        }
        valid.push(parsed);
    });
    return { configured: true, valid, invalidCount: invalid.length };
}

function buildProxyCandidateQueue(proxies, cooldowns, attemptedKeys = new Set()) {
    const now = Math.floor(Date.now() / 1000);
    const seen = new Set(attemptedKeys);
    const available = proxies.filter(proxy => {
        const key = proxyKey(proxy);
        return !seen.has(key) && (!cooldowns[key] || Number(cooldowns[key].until) <= now);
    });
    for (let i = available.length - 1; i > 0; i -= 1) {
        const j = crypto.randomInt(i + 1);
        [available[i], available[j]] = [available[j], available[i]];
    }
    return available;
}

function selectRandomProxy(proxies, cooldowns = {}) {
    const queue = buildProxyCandidateQueue(proxies, cooldowns);
    return queue[0] || null;
}

function getMaxProxyAttempts(validProxyCount, configuredLimit = CONFIG.maxProxySwitches) {
    if (validProxyCount <= 0) return 0;
    const limit = configuredLimit || validProxyCount;
    return Math.min(validProxyCount, Math.max(1, Math.floor(limit)));
}

module.exports = {
    CONFIG,
    parsePositiveNumber,
    parseProxyLine,
    buildHttpProxy,
    proxyKey,
    safeProxyId,
    maskProxyUrl,
    emitGithubMask,
    buildChildEnv,
    calculateCooldownUntil,
    loadCooldowns,
    saveCooldowns,
    addCooldown,
    removeExpiredCooldowns,
    loadProxies,
    buildProxyCandidateQueue,
    selectRandomProxy,
    getMaxProxyAttempts,
};
