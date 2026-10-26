/**
 * /signin must not sign anyone in just by being opened (login CSRF, link scanners): it peeks at the
 * link's email and calls /api/auth/verify only from the Continue button's click handler.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../../public/signin.html'), 'utf8');

test('/signin peeks on load and verifies only on a click', () => {
    const peekAt = html.indexOf("post('/api/auth/peek')");
    const clickAt = html.indexOf("confirm.addEventListener('click'");
    const verifyAt = html.indexOf("post('/api/auth/verify')");
    assert.ok(peekAt > 0, 'peeks');
    assert.ok(clickAt > 0 && verifyAt > clickAt, 'verify is inside the click handler');
    assert.equal(html.split('/api/auth/verify').length - 1, 2, 'one call to verify (plus the comment)');
    assert.match(html, /Sign in to pastecal as /);
});
