const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'action_renew.js');
let source = fs.readFileSync(filePath, 'utf8');

// The hardened layout compatibility script now owns the Renew flow.
// Keep this legacy step idempotent because the workflow still invokes it.
if (source.includes('async function confirmRenewWithDynamicCloudflare')) {
    console.log('Legacy no-captcha patch skipped: hardened Renew Cloudflare flow is already installed.');
    process.exit(0);
}

const replacements = [
    {
        from: `const hasAltchaInModal = /Protected by ALTCHA/i.test(modalText)\n                        || await modal.locator('altcha-widget, [data-altcha], .altcha').count().catch(() => 0) > 0;`,
        to: `const hasAltchaInModal = false; // 当前 KataBump Renew 布局无 Cloudflare/ALTCHA 验证`
    },
    {
        from: `// 点击后等待响应\n                    await page.waitForTimeout(2000);`,
        to: `// 当前 Renew 页面点击确认后需要等待约 10 秒完成续期\n                    console.log('   >> Renew 已点击，等待 10 秒让服务器完成续期...');\n                    await page.waitForTimeout(10000);`
    }
];

for (const { from, to } of replacements) {
    if (!source.includes(from)) {
        if (source.includes(to)) continue;
        throw new Error(`Expected pattern not found in action_renew.js: ${from}`);
    }
    source = source.replace(from, to);
}

fs.writeFileSync(filePath, source, 'utf8');
console.log('KataBump legacy Renew no-captcha/10s-wait compatibility applied.');
