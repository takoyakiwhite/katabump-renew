const assert = require('assert');
const {
    EXIT_CODE,
    proxyFromEnv,
    expiryFromText,
    notReadyFromText,
    successFromText
} = require('../lib/renew_engine');

function tests() {
    assert.strictEqual(EXIT_CODE.SUCCESS, 0);
    assert.strictEqual(proxyFromEnv(null), null);
    assert.strictEqual(proxyFromEnv('not-a-url'), null);

    const proxy = proxyFromEnv('http://user:pa%40ss@127.0.0.1:8080');
    assert.deepStrictEqual(proxy, {
        server: 'http://127.0.0.1:8080',
        host: '127.0.0.1',
        port: 8080,
        username: 'user',
        password: 'pa@ss'
    });

    assert.strictEqual(expiryFromText('Expiry: 2026-08-31'), '2026-08-31');
    assert.strictEqual(expiryFromText('Expires: 2026-09-02'), '2026-09-02');
    assert.strictEqual(expiryFromText('Nothing useful here'), null);

    const notReady = notReadyFromText("Renew You can't renew your server yet You will be able to as of tomorrow");
    assert.ok(notReady && /can't renew your server yet/i.test(notReady));
    assert.strictEqual(notReadyFromText('Renew now'), null);

    assert.strictEqual(successFromText('Renew successful'), true);
    assert.strictEqual(successFromText('Server renewed successfully'), true);
    assert.strictEqual(successFromText('Renew This will extend the life of your server.'), false);
}

tests();
console.log('renew_engine.test.js: ok');
