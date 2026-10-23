// Page security headers, plain node: `node test/headers.test.mjs`.
// public/_headers (pages served straight from the assets) and SecurityHeaders.js (pages the Worker
// serves) must say the same thing; edit pages may not be framed, /view/* may (embeds).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cspFor, applySecurityHeaders } from '../src/SecurityHeaders.js';

let n = 0; const step = (s) => console.log(`  ok ${++n} - ${s}`);

// Parse _headers into [{ pattern, set: {name: value}, detach: [names] }].
const rules = [];
for (const line of readFileSync(new URL('../../public/_headers', import.meta.url), 'utf8').split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    if (!/^\s/.test(line)) { rules.push({ pattern: line.trim(), set: {}, detach: [] }); continue; }
    const t = line.trim(), r = rules[rules.length - 1];
    if (t.startsWith('!')) r.detach.push(t.slice(1).trim().toLowerCase());
    else { const i = t.indexOf(':'); r.set[t.slice(0, i).trim().toLowerCase()] = t.slice(i + 1).trim(); }
}
// What a path ends up with: rules in order, matching like Cloudflare's splats; a repeated header
// joins with ", " (which, for CSP, would be TWO enforced policies), "!" removes.
function headersFor(path) {
    const out = {};
    for (const r of rules) {
        if (r.pattern.startsWith('https://')) continue;
        const re = new RegExp('^' + r.pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
        if (!re.test(path)) continue;
        for (const d of r.detach) delete out[d];
        for (const [k, v] of Object.entries(r.set)) out[k] = out[k] ? `${out[k]}, ${v}` : v;
    }
    return out;
}

for (const path of ['/', '/my-team', '/beta/x', '/view/ab12cd34ef']) {
    const h = headersFor(path);
    assert.equal(h['content-security-policy'], cspFor(path), `${path}: _headers CSP differs from SecurityHeaders.js`);
    assert.equal(h['x-content-type-options'], 'nosniff');
    assert.equal(h['referrer-policy'], 'strict-origin-when-cross-origin');
}
step('_headers and SecurityHeaders.js give every page the same CSP, nosniff and Referrer-Policy');

assert.match(cspFor('/my-team'), /frame-ancestors 'none'$/);
assert.match(cspFor('/'), /frame-ancestors 'none'$/);
assert.match(cspFor('/view/ab12cd34ef'), /frame-ancestors \*$/);
assert.equal((headersFor('/view/x')['content-security-policy'].match(/frame-ancestors/g) || []).length, 1, 'view pages get ONE policy');
step("edit pages: frame-ancestors 'none'; /view/*: frame-ancestors * (one policy, not two)");

for (const d of ["object-src 'none'", "base-uri 'self'", "form-action 'self'", "default-src 'self'"]) assert.ok(cspFor('/x').includes(d), d);
step('object-src none, base-uri self, form-action self, default-src self');

const h = new Headers({ 'Content-Type': 'text/html; charset=utf-8' });
applySecurityHeaders(h, '/view/abc');
assert.match(h.get('Content-Security-Policy'), /frame-ancestors \*$/);
const js = new Headers({ 'Content-Type': 'text/javascript' });
applySecurityHeaders(js, '/app.js');
assert.equal(js.get('Content-Security-Policy'), null); assert.equal(js.get('X-Content-Type-Options'), 'nosniff');
step('the Worker sets the CSP on HTML only, nosniff on everything');

console.log('headers tests passed');
