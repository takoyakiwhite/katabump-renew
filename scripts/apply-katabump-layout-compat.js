const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

const renewFallbackHelpers = `

// --- Renew 阶段动态 Cloudflare 兼容 ---
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
                hasCf = await page.locator('.cf-turnstile, iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]').count() > 0;
            } catch (e) { }
        }

        if (hasCf) {
            console.log('[Renew阶段] 检测到动态 Cloudflare Turnstile。');
            return true;
        }

        if (Date.now() - lastLogAt >= 3000) {
            lastLogAt = Date.now();
            console.log('[Renew阶段] 等待结果/验证初始化... ' + Math.round((Date.now() - startedAt) / 1000) + 's');
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
        console.log('[Renew阶段] 开始处理 Cloudflare Turnstile（第 ' + round + '/2 轮）。');
        const solved = await solveTurnstileIfPresent(page, 'Renew阶段', 15, 6000);
        console.log('[Renew阶段] Cloudflare 处理结果: ' + (solved ? '已发送点击' : '未能点击/未检测到'));

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
    { file: 'action_renew.js', from: "const emailInput = page.getByRole('textbox', { name: 'Email' });", to: "const emailInput = page.locator('input[type=\"email\"]').first();" },
    { file: 'action_renew.js', from: "const pwdInput = page.getByRole('textbox', { name: 'Password' });", to: "const pwdInput = page.locator('input[type=\"password\"]');" },
    { file: 'action_renew.js', from: "await emailInput.fill(user.username);\n\n                    const pwdInput", to: "await emailInput.fill(user.username);\n                    await page.waitForTimeout(1000);\n\n                    const pwdInput" },
    { file: 'action_renew.js', from: "await pwdInput.fill(user.password);\n\n                    await page.waitForTimeout(500);", to: "await pwdInput.fill(user.password);\n                    await page.waitForTimeout(3000);" },
    { file: 'action_renew.js', from: "const confirmBtn = modal.getByRole('button', { name: 'Renew' });", to: "let confirmBtn = modal.locator('div.modal-footer button.btn.btn-primary').filter({ hasText: /^Renew$/i }).first();\n                    if (!(await confirmBtn.isVisible().catch(() => false))) {\n                        confirmBtn = modal.getByRole('button', { name: 'Renew' }).first();\n                    }" },
    { file: 'renew.js', from: "const emailInput = page.getByRole('textbox', { name: 'Email' });", to: "const emailInput = page.locator('input[type=\"email\"]').first();" },
    { file: 'renew.js', from: "const pwdInput = page.getByRole('textbox', { name: 'Password' });", to: "const pwdInput = page.locator('input[type=\"password\"]');" },
    { file: 'renew.js', from: "await emailInput.fill(user.username);\n                const pwdInput", to: "await emailInput.fill(user.username);\n                await page.waitForTimeout(1000);\n                const pwdInput" },
    { file: 'renew.js', from: "await pwdInput.fill(user.password);\n                await page.waitForTimeout(500);", to: "await pwdInput.fill(user.password);\n                await page.waitForTimeout(3000);" },
    { file: 'renew.js', from: "const confirmBtn = modal.getByRole('button', { name: 'Renew' });", to: "let confirmBtn = modal.locator('div.modal-footer button.btn.btn-primary').filter({ hasText: /^Renew$/i }).first();\n                    if (!(await confirmBtn.isVisible().catch(() => false))) {\n                        confirmBtn = modal.getByRole('button', { name: 'Renew' }).first();\n                    }" }
];

for (const item of replacements) {
    const filePath = path.join(root, item.file);
    let source = fs.readFileSync(filePath, 'utf8');
    if (!source.includes(item.from)) {
        if (source.includes(item.to)) continue;
        throw new Error('Expected layout pattern not found in ' + item.file + ': ' + item.from);
    }
    source = source.replace(item.from, item.to);

    if (item.file === 'action_renew.js' && !source.includes('async function confirmRenewWithDynamicCloudflare')) {
        const marker = '// ============================================================\n//  主流程\n// ============================================================';
        if (!source.includes(marker)) throw new Error('Main flow marker not found in action_renew.js');
        source = source.replace(marker, renewFallbackHelpers + '\n\n' + marker);
    }

    fs.writeFileSync(filePath, source, 'utf8');
}

// Renew 页面中的 “Protected by ALTCHA”/checkbox 是页面结构噪声，不能作为验证码存在的依据。
// 只保留真正的 Cloudflare Turnstile iframe/frame 检测；正常 Renew 直接点击并等待约 10 秒。
{
    const filePath = path.join(root, 'action_renew.js');
    let source = fs.readFileSync(filePath, 'utf8');

    const verificationSection = /\s*\/\/ 识别弹窗验证类型：[\s\S]*?\s*\/\/ 点击确认 Renew 前，读取旧 Expiry/;
    if (verificationSection.test(source)) {
        source = source.replace(verificationSection, `
                    // Renew Modal 中可能存在 ALTCHA/checkbox 字样，但当前布局不要求用户完成该验证。
                    // 只有真实 Cloudflare Turnstile frame/widget 才进入验证码处理。
                    const hasCfInModal = await modal.locator('.cf-turnstile, iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]').count().catch(() => 0) > 0;
                    if (hasCfInModal) {
                        console.log('[Renew阶段] 检测到真实 Cloudflare Turnstile，尝试处理。');
                        const turnstileResult = await solveTurnstileIfPresent(page, 'Renew阶段', 15, 6000);
                        console.log('[Renew阶段] Turnstile 检测结果: ' + (turnstileResult ? '已处理' : '未能处理/无需点击'));
                    } else {
                        console.log('[Renew阶段] 未检测到 Cloudflare Turnstile，正常继续 Renew。');
                    }

                    // 点击确认 Renew 前，读取旧 Expiry`);
    }

    const altchaBlock = /\s*\/\/ 【ALTCHA 前置检测】[\s\S]*?(?=\s*\/\/ 检查 3: 成功文本)/;
    if (altchaBlock.test(source)) {
        source = source.replace(altchaBlock, `
                    // 当前 Renew 页面不需要 ALTCHA/checkbox 操作。
                    // 点击 Confirm 后等待 10 秒；期间若异步出现真正的 Cloudflare Turnstile，再处理。
                    const confirmBtn = await findRenewConfirmButton(modal);
                    if (!(await confirmBtn.isVisible().catch(() => false))) {
                        console.log('确认 Renew 按钮不可见，刷新重试。');
                        continue;
                    }

                    const renewConfirmResult = await confirmRenewWithDynamicCloudflare(page, modal, confirmBtn);
                    console.log('[Renew阶段] Confirm 流程完成，动态 Cloudflare=' + (renewConfirmResult.cloudflareHandled ? '已处理' : '未出现'));

                    // Confirm 后重新读取页面状态，后续统一成功/Expiry/not_ready 判断。
                    const pageTextAfterClick = await getPageText(page);
                    const modalTextAfterClick = await modal.innerText().catch(() => '');
                    const modalVisibleAfterClick = await modal.isVisible().catch(() => false);
                    const currentUrlAfterClick = page.url();
                    console.log('[诊断] 点击后 URL: ' + currentUrlAfterClick);
                    console.log('[诊断] 点击后 modal visible: ' + modalVisibleAfterClick);
                    console.log('[诊断] 点击后页面文本片段: ' + pageTextAfterClick.substring(0, 300));

                    // 检查 1: not_ready
                    const notReadyAfter = detectNotReady(pageTextAfterClick);
                    if (notReadyAfter) {
                        console.log('   >> ⏳ 暂无法续期 (after click)。停止重试。');
                        console.log('   >> 页面提示:', typeof notReadyAfter === 'string' ? notReadyAfter : notReadyAfter.raw);
                        runStatus = 'not_ready';
                        blockMessage = typeof notReadyAfter === 'string' ? notReadyAfter : notReadyAfter.raw;
                        renewSuccess = false;
                        await dumpDebugSnapshot(page, 'not_ready_after_' + attempt);
                        break;
                    }

                    // 不再使用 detectCaptchaRequired/普通 checkbox 判断 Renew 验证码。
`);
    }

    fs.writeFileSync(filePath, source, 'utf8');
}

console.log('KataBump layout + Renew Cloudflare compatibility applied.');
