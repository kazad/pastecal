// The app's markup is one big Vue template: a stray closing tag silently moves everything after it
// (the toast, the Save & share prompt) out of the app, and nothing errors. Oct 2026: an extra
// </div> in the homepage pricing cards broke Undo and Save & share.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const html = (f) => fs.readFileSync(path.join(__dirname, '..', '..', 'public', f), 'utf8');
const body = (s) => s.slice(s.indexOf('<body')).replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '');

for (const tag of ['div', 'section', 'aside', 'template', 'button', 'details']) {
    test(`index.html: every <${tag}> is closed exactly once`, () => {
        const b = body(html('index.html'));
        const open = (b.match(new RegExp(`<${tag}\\b`, 'g')) || []).length;
        const close = (b.match(new RegExp(`</${tag}>`, 'g')) || []).length;
        assert.equal(close, open, `<${tag}>: ${open} opened, ${close} closed`);
    });
}
