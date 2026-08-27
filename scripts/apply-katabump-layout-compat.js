const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

const renewFallbackHelpers = `

// --- Renew 阶段动态 Cloudflare 兼容 ---
// 正常路径：点击 Confirm 后等待 10 秒。
// 如果 Turnstile 在这 10 秒内异步出现，则处理验证；验证完成后仅在 modal 仍存在时再次 Confirm。
async function waitForRenewCloudflare(page, modal, timeoutMs = 10000) {
    const startedAt = Date.now();
    let lastLogAt = 0;

    while (Date.now() - startedAt < timeoutMs) {
        let hasCf = false;
        try {
            hasCf = page.frames().some((frame) => {
                try {
                    return /challenges\\.cloudflare\\.com|turnstile/i.test(frame.url() || '');
                } catch (e) {
                    return false;
                }
            });
        } catch (e) { }

        if (!hasCf) {
            try {
                hasCf = await page.locator(
                    '.cf-turnstile, iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]'
                ).count() > 0;
            } catch (e) { }
        }

        if (hasCf) {
            console.log('[Renew阶段] 检测到动态 Cloudflare Turnstile。');
            return true;
        }

        if (Date.now() - lastLogAt >= 3000) {
            lastLogAt = Date.now();
            console.log(`[Renew阶段] 等待结果/验证初始化... ${Math.round((Date.now() - startedAt) / 1000)}s`);
        }
        await page.waitForTimeout(500);
    }

    return false;
}

async function findRenewConfirmButton(modal) {
    let button = modal.locator('div.modal-footer button.btn.btn-primary').filter({ hasText: /^Renew$/i }).first();
    if (!(await button.isVisible().catch(() => false))) {
        button = modal.getByRole('button', { name: 'Renew' }).first();
    }
    return button;
}

async function confirmRenewWithDynamicCloudflare(page, modal, confirmBtn) {
    console.log('[Renew阶段] 点击确认 Renew。');
    await confirmBtn.click();
    console.log('[Renew阶段] Confirm 已点击，开始等待 10 秒；期间持续检测延迟出现的 Cloudflare。');

    let cloudflareHandled = false;

    for (let round = 1; round <= 2; round++) {
        const hasCf = await waitForRenewCloudflare(page, modal, 10000);
        if (!hasCf) {
            console.log('[Renew阶段] 10 秒等待结束，未检测到 Cloudflare。');
            break;
        }

        cloudflareHandled = true;
        console.log(`[Renew阶段] 开始处理 Cloudflare Turnstile（第 ${round}/2 轮）。`);
        const solved = await solveTurnstileIfPresent(page, 'Renew阶段', 15, 6000);
        console.log(`[Renew阶段] Cloudflare 处理结果: ${solved ? '已发送点击' : '未能点击/未检测到'}`);

        await page.waitForTimeout(2000);

        const modalVisible = await modal.isVisible().catch(() => false);
        if (!modalVisible) {
            console.log('[Renew阶段] 验证后 Renew modal 已关闭，认为请求已进入结果阶段。');
            break;
        }

        const nextConfirm = await findRenewConfirmButton(modal);
        if (!(await nextConfirm.isVisible().catch(() => false))) {
            console.log('[Renew阶段] 验证后 Confirm 不可见，停止重复点击。');
            break;
        }

        if (round >= 2) {
            console.log('[Renew阶段] Cloudflare 已连续处理两轮，停止继续重复点击。');
            break;
        }

        console.log('[Renew阶段] Cloudflare 验证后 modal 仍存在，再次点击 Confirm。');
        await nextConfirm.click();
        console.log('[Renew阶段] 第二次 Confirm 已点击，继续等待 10 秒。');
    }

    return { cloudflareHandled };
}
`;

const replacements = [
    {
        file: 'action_renew.js',
        from: "const emailInput = page.getByRole('textbox', { name: 'Email' });",
        to: "const emailInput = page.locator('input[type=\"email\"]').first();"
    },
    {
        file: 'action_renew.js',
        from: "const pwdInput = page.getByRole('textbox', { name: 'Password' });",
        to: "const pwdInput = page.locator('input[type=\"password\"]');"
    },
    {
        file: 'action_renew.js',
        from: "await emailInput.fill(user.username);\n\n                    const pwdInput",
        to: "await emailInput.fill(user.username);\n                    await page.waitForTimeout(1000);\n\n                    const pwdInput"
    },
    {
        file: 'action_renew.js',
        from: "await pwdInput.fill(user.password);\n\n                    await page.waitForTimeout(500);",
        to: "await pwdInput.fill(user.password);\n                    await page.waitForTimeout(3000);"
    },
    {
        file: 'action_renew.js',
        from: "const confirmBtn = modal.getByRole('button', { name: 'Renew' });",
        to: "let confirmBtn = modal.locator('div.modal-footer button.btn.btn-primary').filter({ hasText: /^Renew$/i }).first();\n                    if (!(await confirmBtn.isVisible().catch(() => false))) {\n                        confirmBtn = modal.getByRole('button', { name: 'Renew' }).first();\n                    }"
    },
    {
        file: 'action_renew.js',
        from: "const confirmBtnAfterCb = modal.getByRole('button', { name: 'Renew' });",
        to: "let confirmBtnAfterCb = modal.locator('div.modal-footer button.btn.btn-primary').filter({ hasText: /^Renew$/i }).first();\n                            if (!(await confirmBtnAfterCb.isVisible().catch(() => false))) {\n                                confirmBtnAfterCb = modal.getByRole('button', { name: 'Renew' }).first();\n                            }"
    },
    {
        file: 'renew.js',
        from: "const emailInput = page.getByRole('textbox', { name: 'Email' });",
        to: "const emailInput = page.locator('input[type=\"email\"]').first();"
    },
    {
        file: 'renew.js',
        from: "const pwdInput = page.getByRole('textbox', { name: 'Password' });",
        to: "const pwdInput = page.locator('input[type=\"password\"]');"
    },
    {
        file: 'renew.js',
        from: "await emailInput.fill(user.username);\n                const pwdInput",
        to: "await emailInput.fill(user.username);\n                await page.waitForTimeout(1000);\n                const pwdInput"
    },
    {
        file: 'renew.js',
        from: "await pwdInput.fill(user.password);\n                await page.waitForTimeout(500);",
        to: "await pwdInput.fill(user.password);\n                await page.waitForTimeout(3000);"
    },
    {
        file: 'renew.js',
        from: "const confirmBtn = modal.getByRole('button', { name: 'Renew' });",
        to: "let confirmBtn = modal.locator('div.modal-footer button.btn.btn-primary').filter({ hasText: /^Renew$/i }).first();\n                    if (!(await confirmBtn.isVisible().catch(() => false))) {\n                        confirmBtn = modal.getByRole('button', { name: 'Renew' }).first();\n                    }"
    },
    {
        file: 'action_renew.js',
        from: "await confirmBtn.click();\n                    console.log('Confirm Renew clicked.');\n\n                    // 点击后等待响应\n                    await page.waitForTimeout(2000);",
        to: "const renewConfirmResult = await confirmRenewWithDynamicCloudflare(page, modal, confirmBtn);\n                    console.log(`[Renew阶段] Confirm 流程完成，动态 Cloudflare=${renewConfirmResult.cloudflareHandled ? '已处理' : '未出现'}`);"
    }
];

const touched = new Set();

for (const item of replacements) {
    const filePath = path.join(root, item.file);
    let source = fs.readFileSync(filePath, 'utf8');
    if (!source.includes(item.from)) {
        const alreadyApplied = source.includes(item.to);
        if (alreadyApplied) continue;
        throw new Error(`Expected layout pattern not found in ${item.file}: ${item.from}`);
    }
    source = source.replace(item.from, item.to);

    // 仅对 action_renew.js 注入一次 Renew 动态 Cloudflare helper。
    if (item.file === 'action_renew.js' && !source.includes('async function confirmRenewWithDynamicCloudflare')) {
        const marker = '// ============================================================\n//  主流程\n// ============================================================';
        if (!source.includes(marker)) {
            throw new Error('Main flow marker not found in action_renew.js');
        }
        source = source.replace(marker, renewFallbackHelpers + '\n\n' + marker);
    }

    fs.writeFileSync(filePath, source, 'utf8');
    touched.add(item.file);
}

console.log(`KataBump layout + Renew Cloudflare compatibility applied to: ${[...touched].join(', ') || 'nothing (already applied)'}`);
