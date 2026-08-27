const { CONFIG } = require('./config');

function compactText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

async function bodyText(page) {
    try {
        return compactText(await page.locator('body').innerText());
    } catch {
        return '';
    }
}

function findDateNearLabel(value, labels) {
    const source = compactText(value);
    for (const label of labels) {
        const match = source.match(new RegExp(`${label}[^\\d]*(\\d{4}-\\d{2}-\\d{2})`, 'i'));
        if (match) return match[1];
    }
    return null;
}

function expiryFromText(value) {
    return findDateNearLabel(value, ['Expiry', 'Expires?']);
}

function notReadyFromText(value) {
    const source = compactText(value);
    const index = source.search(/You can't renew your server yet|You will be able to as of/i);
    return index >= 0 ? source.slice(index, index + 300) : null;
}

function successFromText(value) {
    return /renew(?:al)?\s+(?:successful|completed)|renewed successfully|successfully renewed/i.test(String(value || ''));
}

async function waitForDashboard(page) {
    const start = Date.now();
    while (Date.now() - start < CONFIG.dashboardTimeoutMs) {
        if (/dashboard/i.test(page.url())) return true;
        if (await page.getByRole('link', { name: 'See', exact: true }).first().isVisible().catch(() => false)) return true;
        await page.waitForTimeout(400);
    }
    return false;
}

async function openServer(page) {
    const see = page.getByRole('link', { name: 'See', exact: true }).first();
    if (await see.isVisible().catch(() => false)) {
        await see.click();
        await page.waitForTimeout(700);
    }
    return true;
}

async function clickOuterRenew(page) {
    const candidates = [
        page.getByRole('button', { name: 'Renew', exact: true }).first(),
        page.locator('button').filter({ hasText: /^Renew$/i }).first(),
    ];
    for (const candidate of candidates) {
        if (await candidate.isVisible().catch(() => false)) {
            await candidate.click();
            return true;
        }
    }
    return false;
}

async function waitForRenewModal(page) {
    const start = Date.now();
    while (Date.now() - start < CONFIG.modalTimeoutMs) {
        const candidates = [
            page.locator('div.modal.show').last(),
            page.locator('div[role="dialog"]').last(),
            page.locator('.modal').last(),
        ];
        for (const modal of candidates) {
            if (await modal.isVisible().catch(() => false)) return modal;
        }
        await page.waitForTimeout(250);
    }
    return null;
}

async function getRenewConfirmButton(modal) {
    const selectors = [
        modal.locator('div.modal-footer button.btn.btn-primary').filter({ hasText: /^Renew$/i }).first(),
        modal.getByRole('button', { name: 'Renew', exact: true }).first(),
        modal.locator('button').filter({ hasText: /^Renew$/i }).last(),
    ];
    for (const button of selectors) {
        if (await button.isVisible().catch(() => false)) return button;
    }
    return null;
}

async function readRenewState(page, modal) {
    const pageBody = await bodyText(page);
    const modalBody = compactText(await modal?.innerText().catch(() => '') || '');
    return {
        pageText: pageBody,
        modalText: modalBody,
        expiry: expiryFromText(pageBody) || expiryFromText(modalBody),
        notReady: notReadyFromText(pageBody) || notReadyFromText(modalBody),
        success: successFromText(pageBody) || successFromText(modalBody),
        url: page.url(),
    };
}

module.exports = {
    compactText,
    bodyText,
    expiryFromText,
    notReadyFromText,
    successFromText,
    waitForDashboard,
    openServer,
    clickOuterRenew,
    waitForRenewModal,
    getRenewConfirmButton,
    readRenewState,
};
