const assert = require('assert');

const config = require('../lib/config');
const captcha = require('../lib/captcha');
const page = require('../lib/katabump_page');
const result = require('../lib/result');
const browser = require('../lib/browser');

function tests() {
    assert.ok(config.CONFIG.targetUrl.includes('/auth/login'));
    assert.deepStrictEqual(config.CONFIG.viewport, { width: 1280, height: 720 });
    assert.strictEqual(config.EXIT_CODE.SUCCESS, 0);
    assert.strictEqual(captcha.isTurnstileUrl('https://challenges.cloudflare.com/turnstile/v0/api.js'), true);
    assert.strictEqual(captcha.isTurnstileUrl('https://dashboard.katabump.com/auth/login'), false);
    assert.strictEqual(captcha.normalizeBodyText('  Renew\n  This   will extend  '), 'Renew This will extend');

    assert.strictEqual(page.expiryFromText('Expiry: 2026-08-31'), '2026-08-31');
    assert.strictEqual(page.expiryFromText('Nothing'), null);
    assert.ok(page.notReadyFromText("Renew You can't renew your server yet"));
    assert.strictEqual(page.notReadyFromText('Renew now'), null);
    assert.strictEqual(page.successFromText('Server renewed successfully'), true);
    assert.strictEqual(page.successFromText('Renew This will extend the life of your server.'), false);

    const r = result.makeResult({ exitCode: 0, status: 'success', accounts: [{ status: 'success' }] });
    assert.strictEqual(result.statusToCode('success'), 0);
    assert.strictEqual(result.summarizeStatus(r.accounts), 'success');
    assert.ok(result.formatNotification(r).includes('自动续期完成'));
    assert.strictEqual(result.mergeCode(0, 1), 1);
    assert.strictEqual(result.mergeCode(1, 0), 1);

    assert.strictEqual(typeof browser.launchBrowser, 'function');
    assert.strictEqual(typeof browser.preparePage, 'function');
}

tests();
console.log('katabump_modules.test.js: ok');
