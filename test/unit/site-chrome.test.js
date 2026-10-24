// Every static page carries the shared header and footer from scripts/site-chrome/.
// The pages are copies (no build step), so this fails when a partial or a page drifts.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const PAGES = ['pricing', 'pricing-next', 'help', 'about', 'privacy', 'terms', 'report', 'signin'].map(n => `public/${n}.html`);
const partial = (n) => fs.readFileSync(path.join(root, 'scripts/site-chrome', n), 'utf8').trim();
const FIX = 'Run `node scripts/sync-site-chrome.mjs` to fix it.';

for (const rel of PAGES) {
    test(`${rel} has the shared header and footer`, () => {
        const html = fs.readFileSync(path.join(root, rel), 'utf8');
        for (const [name, file] of [['site-header', 'header.html'], ['site-footer', 'footer.html']]) {
            const m = html.match(new RegExp(`<!-- ${name} -->\\n([\\s\\S]*?)\\n<!-- /${name} -->`));
            assert.ok(m, `${rel} has no <!-- ${name} --> markers. ${FIX}`);
            assert.equal(m[1], partial(file), `${rel}: ${name} differs from scripts/site-chrome/${file}. ${FIX}`);
        }
        assert.match(html, /<link rel="stylesheet" href="\/site\.css">/, `${rel} does not link /site.css. ${FIX}`);
        assert.match(html, /<link rel="stylesheet" href="\/tokens\.css">/, `${rel} does not link /tokens.css. ${FIX}`);
    });
}

test('the footer links to every page the header and footer promise', () => {
    const footer = partial('footer.html');
    for (const href of ['/', '/pricing', '/help', '/about', '/privacy', '/terms', '/report']) {
        assert.ok(footer.includes(`href="${href}"`), `footer is missing ${href}`);
    }
});
