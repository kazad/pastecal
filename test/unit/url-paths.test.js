/**
 * Root-cause guard: a calendar's name put into a URL without encoding.
 *
 * A calendar's name is any text ("50% off", "a?b", "TEAM NUÑEZ", "d&d8", "강아지봉사", "trail "). Built as
 * "/" + calendar.id, "?" started a query, "%" an escape and "#" a fragment: Share's edit link, "This view" and the edit
 * feed for "a?b" opened another, empty calendar, and claiming "50% fun" on the homepage saved it, then landed on a
 * blank draft (stress A03, A04). Every path to a calendar is built by public/services/CalendarPath.js (or, in a page
 * that does not load it, with encodeURIComponent).
 *
 * This fails on a path built from a name/id/slug/handle without either, in the page or the Worker, unless the line is
 * listed below with why it is not a URL or cannot hold such a character.
 *
 * Run: node --test test/unit/url-paths.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '../..');

// What names a calendar, a view link, a short name or a handle.
const NAMEISH = /\b(?:\w*(?:id|Id|ID|slug|Slug|name|Name|handle|Handle)\w*|calendar(?:\.\w+)*)\b/;
const SAFE = /^\s*(?:encodeURIComponent|CalendarPath\.|esc\(CalendarPath\.|enc\()/;
// Lines that build text, a storage key or an internal address, not a link a person or calendar app follows. A listed
// line that changes (or a new one) must be looked at again.
const NOT_A_PATH = [
    /pastecal\.com\/\$\{this\.poll\.calendarId\}\/poll/,            // poll.html: the address shown as text
    /'Release ' \+ host \+ '\/' \+ x\.name/,                         // account.html: a confirm() sentence
    /'Point ' \+ host \+ '\/' \+ x\.name/,                           // account.html: an aria-label
    /host \+ '\/' \+ x\.name \+ ' now opens'/,                       // account.html: a status sentence
    /text: host \+ '\/' \+ x\.name/,                                 // account.html: link text (the href is encoded)
    /text: host \+ '\/' \+ c\.id/,                                   // account.html: link text (the href is encoded)
    /text: host \+ '\/@' \+ A\.handle/,                              // account.html: link text
    /text: host \+ '\/' \+ n/,                                       // account.html: link text
    /textContent = location\.host \+ '\/' \+ c\.id/,                 // pricing.html: text
    /`You already have @\$\{g\.handle\.handle\}\/\$\{name\}\.`/,     // Names.js: an error message
    /pastecal\.com\/@\$\{h\}\/\$\{esc\(l\.name\)\}/,                 // Names.js: link text (the href is CalendarPath)
    /esc\('@' \+ handle \+ '\/' \+ name\)/,                          // Names.js: a meta tag's content (a name, not a URL)
    /title = hit\.title \|\| `@\$\{handle\}\/\$\{name\}`/,           // Names.js: a page title
    /due\.push\('@' \+ h\.handle, \.\.\.links\.map\(\(l\) => `@\$\{h\.handle\}\/\$\{l\.name\}`\)\)/, // Accounts.js: directory aliases
    /`Plus for \$\{title \?/,                                        // Accounts.js: a Stripe description sentence
    /Move calendar to pastecal\.com\/\$\{newId\}\?/,                 // app.js: a confirm() sentence
    /\[`calendar_authors\/\$\{calendarId\}\/\$\{uid\}`\]/,          // AuthorSignal.js: a Firebase key (Firebase escapes it)
    /ref\(`calendar_authors\/\$\{calendarId\}\/\$\{uid\}`\)/,       // AuthorSignal.js: a Firebase key
    /\[`calendars\/\$\{key\}`\]/,                                   // CalendarDataService.js: a Firebase key
    /\{ type: 'schedule', where: `\$\{args\.requestType\}\/\$\{context/, // app.js: an error label
    /PRODID:-\/\/PasteCal\/\/\$\{this\.escapeText\(id\)\}\/\/EN/,     // ICSService.js: the feed's PRODID text
    /calendarTarget\('\/' \+ m\[1\], ''\)/,                          // preview/route.js: re-parses a path that is still encoded
    /\$\('handleLink'\)\.textContent = host \+ '\/@' \+ A\.handle/,      // account.html: link text (the href is encoded)
    /'Upgraded and locked to you, at its own ' \+ host \+ '\/@'/,      // account.html: a sentence
    /\$\('shortOk'\)\.textContent = host \+ '\/' \+ x\.name/,          // account.html: a sentence
    /'Show on my page \(' \+ host \+ '\/@' \+ A\.handle/,              // account.html: a label
    /ref\('\/history\/' \+ calendarId\)/,                             // app.js: a Firebase key (retired backend)
    /ref\('\/history_meta\/' \+ (calendarId|this\.calendar\.id) \+ '\/lastEditedAt'\)/, // a Firebase key (retired backend)
    /v-text="'pastecal\.com\/' \+ slugTaken\.slug"/,                  // index.html: text
];

function files(dir, out = []) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) { if (!['vendor', 'node_modules', 'js-old-components', 'dev'].includes(ent.name)) files(p, out); }
        else if (/\.(m?js|html)$/.test(ent.name)) out.push(p);
    }
    return out;
}

/** Every "/" + <name> and `.../${<name>}` built without CalendarPath or encodeURIComponent: ['file:line: text']. */
function unencodedPaths() {
    const bad = [];
    for (const f of [...files(path.join(ROOT, 'public')), ...files(path.join(ROOT, 'cloudflare/src'))]) {
        const rel = path.relative(ROOT, f).split(path.sep).join('/');
        const lines = fs.readFileSync(f, 'utf8').split('\n');
        lines.forEach((line, i) => {
            const code = line.replace(/^\s*(\/\/|\*).*$/, '').replace(/\s\/\/\s.*$/, '');
            if (!code.trim() || NOT_A_PATH.some((re) => re.test(code))) return;
            const hits = [];
            // '/' + x, "/" + x, '/@' + x, 'something/' + x
            for (const m of code.matchAll(/['"][^'"\n]*\/@?['"]\s*\+\s*([^;,)}\]]+)/g)) hits.push(m[1]);
            // `.../${x}` (and `/@${x}`)
            for (const m of code.matchAll(/\/@?\$\{([^}]+)\}/g)) hits.push(m[1]);
            for (const expr of hits) {
                if (SAFE.test(expr) || !NAMEISH.test(expr)) continue;
                bad.push(`${rel}:${i + 1}: ${line.trim().slice(0, 140)}`);
                break;
            }
        });
    }
    return bad;
}

test('every calendar path is built encoded (CalendarPath or encodeURIComponent), in the page and the Worker', () => {
    assert.deepEqual(unencodedPaths(), [], 'build it with CalendarPath.of / .view / .at (or encodeURIComponent in a page without it)');
});

test('CalendarPath keeps every name a calendar may have, and reads back as it', () => {
    const CalendarPath = require('../../public/services/CalendarPath.js');
    for (const name of ['50% off', 'a?b', 'TEAM NUÑEZ', 'sp!x', 'd&d8', '강아지봉사', 'trail ', ' lead', 'a#b', '@old', 'plain-name_1']) {
        const p = CalendarPath.of(name);
        assert.ok(/^\/[^/?#\s]+$/.test(p), `${JSON.stringify(name)} -> ${p}: one path segment, no ?, #, space`);
        assert.equal(decodeURIComponent(new URL(p, 'https://pastecal.com').pathname.slice(1)), name);
        assert.equal(decodeURIComponent(new URL(CalendarPath.view(name), 'https://pastecal.com').pathname.split('/')[2]), name);
    }
    assert.equal(CalendarPath.at('kalid', 'soccer'), '/@kalid/soccer');
    assert.equal(CalendarPath.feed(CalendarPath.of('a?b')), '/a%3Fb.ics');
});
