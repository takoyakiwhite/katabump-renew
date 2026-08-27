const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const { buildBrowserLaunchOptions } = require('./runtime_helpers');

chromium.use(stealth);

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const CHROME_BOOT_TIMEOUT_MS = Math.min(90_000, Math.max(10_000, Number(process.env.CHROME_BOOT_TIMEOUT_MS) || 35_000));

function createTurnstileInitScript() {
    return `
(function () {
    try {
        if (window.self !== window.top) {
            const originalAttachShadow = Element.prototype.attachShadow;
            Element.prototype.attachShadow = function(init) {
                const root = originalAttachShadow.call(this, init);
                try {
                    const publish = () => {
                        const checkbox = root && root.querySelector('input[type="checkbox"]');
                        if (!checkbox) return false;
                        const rect = checkbox.getBoundingClientRect();
                        if (rect.width <= 0 || rect.height <= 0 || !innerWidth || !innerHeight) return false;
                        window.__katabump_turnstile_point = {
                            xRatio: (rect.left + rect.width / 2) / innerWidth,
                            yRatio: (rect.top + rect.height / 2) / innerHeight
                        };
                        return true;
                    };
                    if (!publish() && root) {
                        const observer = new MutationObserver(() => {
                            if (publish()) observer.disconnect();
                        });
                        observer.observe(root, { childList: true, subtree: true });
                    }
                } catch { }
                return root;
            };
        }
    } catch { }
})();
`;
}

function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            const port = address && typeof address === 'object' ? address.port : null;
            server.close(error => error ? reject(error) : resolve(port));
        });
    });
}

function waitForChromeDebugPort(port, child, timeoutMs) {
    const startedAt = Date.now();
    return new Promise(resolve => {
        let pollTimer = null;
        let settled = false;

        const cleanup = () => {
            if (pollTimer) clearInterval(pollTimer);
            child.removeListener('exit', onExit);
            child.removeListener('error', onError);
        };
        const finish = result => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(result);
        };
        const onExit = (code, signal) => finish({ ok: false, reason: `chrome_exit:${code ?? 'null'}:${signal ?? 'null'}` });
        const onError = error => finish({ ok: false, reason: `chrome_error:${error.message}` });
        const poll = () => {
            const request = http.get(`http://127.0.0.1:${port}/json/version`, response => {
                response.resume();
                if (response.statusCode >= 200 && response.statusCode < 300) finish({ ok: true });
            });
            request.setTimeout(1000, () => request.destroy());
            request.on('error', () => { });
            if (Date.now() - startedAt >= timeoutMs) finish({ ok: false, reason: 'chrome_cdp_timeout' });
        };

        child.once('exit', onExit);
        child.once('error', onError);
        poll();
        pollTimer = setInterval(poll, 500);
    });
}

async function launchBrowser(proxy) {
    const launchOptions = buildBrowserLaunchOptions(null);
    const port = await getFreePort();
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `katabump-chrome-${process.pid}-`));
    const args = [
        ...launchOptions.args,
        '--remote-debugging-address=127.0.0.1',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${userDataDir}`,
        '--proxy-bypass-list=<-loopback>'
    ];
    if (proxy?.server) args.push(`--proxy-server=${proxy.server}`);

    let child = null;
    try {
        child = spawn(CHROME_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: false });
        const boot = await waitForChromeDebugPort(port, child, CHROME_BOOT_TIMEOUT_MS);
        if (!boot.ok) throw new Error(boot.reason);

        const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
        const context = browser.contexts()[0];
        if (!context) throw new Error('Chrome CDP returned no BrowserContext');

        if (proxy?.username && proxy?.password && typeof context.setHTTPCredentials === 'function') {
            await context.setHTTPCredentials({ username: proxy.username, password: proxy.password });
        }

        let closed = false;
        return {
            browser,
            context,
            child,
            userDataDir,
            async close() {
                if (closed) return;
                closed = true;
                try { await browser.close(); } catch { }
                if (child && child.exitCode === null) {
                    try { child.kill('SIGTERM'); } catch { }
                    await new Promise(resolve => setTimeout(resolve, 500));
                    if (child.exitCode === null) {
                        try { child.kill('SIGKILL'); } catch { }
                    }
                }
                try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { }
            }
        };
    } catch (error) {
        if (child && child.exitCode === null) {
            try { child.kill('SIGTERM'); } catch { }
            await new Promise(resolve => setTimeout(resolve, 250));
            if (child.exitCode === null) {
                try { child.kill('SIGKILL'); } catch { }
            }
        }
        try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { }
        throw error;
    }
}

async function preparePage(context) {
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    await page.addInitScript({ content: createTurnstileInitScript() });
    return page;
}

module.exports = { launchBrowser, preparePage, createTurnstileInitScript };
