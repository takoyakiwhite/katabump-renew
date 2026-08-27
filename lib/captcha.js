function isTurnstileUrl(url) {
    return /challenges\.cloudflare\.com|turnstile/i.test(String(url || ''));
}

function normalizeBodyText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

async function pageHasTurnstile(page, scope = page) {
    try {
        if (page.frames().some(frame => isTurnstileUrl(frame.url()))) return true;
    } catch { }

    try {
        return await scope.locator(
            '.cf-turnstile, iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]'
        ).count() > 0;
    } catch {
        return false;
    }
}

async function turnstileDiagnostics(page) {
    const result = {
        frameCount: 0,
        challengeFrames: [],
        widgetCount: 0,
        visibleWidgets: 0,
        scriptLoaded: false,
        apiPresent: false,
        verificationFailed: false,
    };

    try {
        const frames = page.frames();
        result.frameCount = frames.length;
        result.challengeFrames = frames
            .map(frame => frame.url())
            .filter(isTurnstileUrl)
            .map(url => url.slice(0, 200));
    } catch { }

    try {
        const widgets = page.locator('.cf-turnstile, [data-sitekey], #cf-turnstile');
        result.widgetCount = await widgets.count();
        const count = Math.min(result.widgetCount, 10);
        for (let i = 0; i < count; i += 1) {
            if (await widgets.nth(i).isVisible().catch(() => false)) result.visibleWidgets += 1;
        }
    } catch { }

    try {
        const info = await page.evaluate(() => {
            const scripts = Array.from(document.querySelectorAll('script[src]')).map(s => s.src || '');
            const body = (document.body && document.body.innerText) || '';
            return {
                scriptLoaded: scripts.some(src => /challenges\.cloudflare\.com|turnstile/i.test(src)),
                apiPresent: typeof window.turnstile !== 'undefined',
                verificationFailed: /Verification failed/i.test(body)
                    || (/Troubleshoot/i.test(body) && /cloudflare/i.test(body)),
            };
        });
        Object.assign(result, info);
    } catch { }

    return result;
}

function validBox(box, viewport) {
    if (!box || box.width < 50 || box.height < 20) return false;
    if (!viewport) return true;
    return !(box.right < 0 || box.bottom < 0 || box.x > viewport.width || box.y > viewport.height);
}

async function getViewport(page) {
    try {
        return page.viewportSize() || await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    } catch {
        return { width: 1280, height: 720 };
    }
}

async function clickTurnstile(page) {
    const viewport = await getViewport(page);
    const frames = page.frames().filter(frame => isTurnstileUrl(frame.url()));

    for (const frame of frames) {
        try {
            const element = await frame.frameElement();
            const box = element ? await element.boundingBox() : null;
            if (!validBox(box, viewport)) continue;
            const x = box.x + Math.min(28, Math.max(18, box.width * 0.12));
            const y = box.y + box.height / 2;
            await page.mouse.move(x, y, { steps: 4 });
            await page.mouse.click(x, y);
            return { clicked: true, method: 'frame' };
        } catch { }
    }

    try {
        const widgets = page.locator('.cf-turnstile, [data-sitekey], #cf-turnstile');
        const count = await widgets.count();
        for (let i = 0; i < count; i += 1) {
            const widget = widgets.nth(i);
            if (!(await widget.isVisible().catch(() => false))) continue;
            const box = await widget.boundingBox();
            if (!validBox(box, viewport)) continue;
            const x = box.x + Math.min(28, Math.max(18, box.width * 0.12));
            const y = box.y + box.height / 2;
            await page.mouse.click(x, y);
            return { clicked: true, method: 'widget' };
        }
    } catch { }

    return { clicked: false, method: null };
}

async function solveTurnstile(page, stage, config, sleep) {
    const present = await pageHasTurnstile(page);
    if (!present) return { present: false, solved: false, attempts: 0 };

    console.log(`[${stage}] 检测到真实 Cloudflare Turnstile。`);
    let attempts = 0;

    for (let attempt = 1; attempt <= config.turnstileRetryLimit; attempt += 1) {
        attempts = attempt;
        if (!(await pageHasTurnstile(page))) return { present: true, solved: true, attempts: attempt - 1 };

        const click = await clickTurnstile(page);
        if (click.clicked) {
            console.log(`[${stage}] Turnstile 点击已发送（${click.method}，第 ${attempt}/${config.turnstileRetryLimit} 次）。`);
            await sleep(2_500);
        } else {
            console.log(`[${stage}] 未找到有效 Turnstile 点击目标（第 ${attempt}/${config.turnstileRetryLimit} 次）。`);
        }

        const deadline = Date.now() + config.turnstileTimeoutMs;
        while (Date.now() < deadline) {
            const info = await turnstileDiagnostics(page);
            if (info.verificationFailed) {
                return { present: true, solved: false, attempts: attempt, verificationFailed: true, info };
            }
            if (!await pageHasTurnstile(page)) {
                return { present: true, solved: true, attempts: attempt, info };
            }
            await sleep(config.turnstileDetectPollMs);
        }
    }

    return { present: true, solved: false, attempts };
}

module.exports = {
    isTurnstileUrl,
    normalizeBodyText,
    pageHasTurnstile,
    turnstileDiagnostics,
    clickTurnstile,
    solveTurnstile,
};
