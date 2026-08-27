const fs = require('fs');
const path = require('path');

const filePath = path.resolve(__dirname, '..', 'action_renew.js');
let source = fs.readFileSync(filePath, 'utf8');

const marker = "console.log('Renew 模态框已识别。');";
const waitBlock = `${marker}\n                    // 新版 KataBump 页面在点击外层 Renew 后需要时间异步初始化验证区域。\n                    // 固定等待 10 秒，避免验证组件尚未完成渲染时被误判为 captcha_required。\n                    console.log('[Renew阶段] 模态框已出现，等待 10 秒让验证组件完成初始化...');\n                    await page.waitForTimeout(10000);\n                    console.log('[Renew阶段] 10 秒等待完成，重新检测验证组件。');`;

if (!source.includes(marker)) {
    if (source.includes("[Renew阶段] 模态框已出现，等待 10 秒让验证组件完成初始化...")) {
        console.log('Renew modal 10-second wait already applied.');
        process.exit(0);
    }
    throw new Error('Expected Renew modal marker not found in action_renew.js');
}

if (!source.includes(waitBlock)) {
    source = source.replace(marker, waitBlock);
}

const altchaPatterns = [
    {
        from: `const hasAltchaInModal2 = /Protected by ALTCHA/i.test(modalText)\n                        || await modal.locator('altcha-widget, [data-altcha], .altcha').count().catch(() => 0) > 0;`,
        to: `const hasAltchaInModal2 = await modal.locator('altcha-widget, [data-altcha], .altcha, input[type="checkbox"]').count().catch(() => 0) > 0;`
    },
    {
        from: `const hasAltchaInModal = /Protected by ALTCHA/i.test(modalText)\n                        || await modal.locator('altcha-widget, [data-altcha], .altcha').count().catch(() => 0) > 0;`,
        to: `const hasAltchaInModal = await modal.locator('altcha-widget, [data-altcha], .altcha, input[type="checkbox"]').count().catch(() => 0) > 0;`
    }
];

for (const item of altchaPatterns) {
    if (source.includes(item.from)) {
        source = source.replace(item.from, item.to);
    } else if (!source.includes(item.to)) {
        console.log('ALTCHA layout pattern not present; leaving existing detection unchanged.');
    }
}

fs.writeFileSync(filePath, source, 'utf8');
console.log('Renew modal 10-second wait and stale ALTCHA-label compatibility applied.');
