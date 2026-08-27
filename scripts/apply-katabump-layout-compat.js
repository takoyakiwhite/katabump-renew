const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

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
    fs.writeFileSync(filePath, source, 'utf8');
    touched.add(item.file);
}

console.log(`KataBump layout compatibility applied to: ${[...touched].join(', ') || 'nothing (already applied)'}`);
