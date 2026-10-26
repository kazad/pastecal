/**
 * Guards for app-stress-3's roots that are not failure paths (those are failure-paths.test.js):
 *
 *   D. A lazily loaded library assumed to be there (A13: Ctrl+P in the first seconds printed "Scan to add it to your
 *      phone calendar." with no code, because the QR library loads 4 s after the page). Every script the app loads
 *      late is used behind a typeof check, and the page text that describes its output shows only with that output.
 *   E. A change of state that is only seen, never heard (A21: Share's "Copied" renamed a button and nothing was
 *      announced). One polite live region (Utils.announce) carries copy, the save status and toasts; the toast has
 *      no region of its own (two regions read every message twice).
 *   A14. Settings offered "5:00 AM" with 24-hour time chosen: times in Settings come from the chosen format
 *      (clockTime), never as typed AM/PM text (the Time format picker's own examples excepted).
 *   A18. Search compared lowercase only: "cafe" missed "Café meetup" (both calendars use Utils.searchFold).
 * The browser side is cloudflare/test/app-ux.spec.js.
 *
 * Run: node --test test/unit/app-ux-guards.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PUBLIC = path.join(__dirname, '..', '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');
const APP = read('app.js'), HTML = read('index.html');

test('D: every library the app loads late is used only behind a typeof check', () => {
    // Scripts the app adds itself after load: `sc.src = '/vendor/<lib>/<file>.js'`. Their globals, by file.
    const GLOBAL_OF = { 'qrcode.js': 'qrcode' };
    const lazy = [...APP.matchAll(/\.src = '\/vendor\/[^']+\/([^'/]+\.js)'/g)].map((m) => m[1]);
    assert.ok(lazy.length, 'found the late-loaded scripts (the pattern above is out of date if not)');
    for (const file of lazy) {
        const g = GLOBAL_OF[file];
        assert.ok(g, `${file} is loaded late: name its global in GLOBAL_OF and keep its uses guarded`);
        const uses = [...APP.matchAll(new RegExp(`\\b${g}\\(`, 'g'))];
        for (const u of uses) {
            const line = APP.slice(APP.lastIndexOf('\n', u.index) + 1, APP.indexOf('\n', u.index));
            assert.match(line, new RegExp(`typeof ${g} === 'function'`), `${g}() used without checking it has loaded: ${line.trim().slice(0, 120)}`);
        }
    }
});

test('D: the printed "Scan to add it" line shows only with its QR code (printQr), never alone', () => {
    const scan = /<[^>]*v-if="([^"]*)"[^>]*>\s*Scan to add it to your phone calendar\./.exec(HTML);
    assert.ok(scan, 'the Scan line has its own v-if');
    assert.match(scan[1], /\bprintQr\b/, `the Scan line's condition: ${scan[1]}`);
});

test('E: the toast has no live region of its own; it, copy and the offline line speak through Utils.announce', () => {
    const toast = read('components/ToastNotification.js');
    const template = /template:\s*\/\*\s*html\s*\*\/\s*`([\s\S]*?)`/.exec(toast)[1];
    assert.doesNotMatch(template, /aria-live|role="status"|role="alert"/, 'a second live region reads every toast twice');
    assert.match(toast, /display\([^)]*\)\s*\{[\s\S]{0,400}Utils\.announce\(/, 'display() announces');
    // Every copy that shows "Copied": Share's links (app.js copyLink) and /beta's buttons (nativecal/app.js copyToClipboard).
    const method = (src, name) => { const i = src.indexOf(`\n        ${name}(`); assert.ok(i > 0, name); return src.slice(i, src.indexOf('\n        },', i)); };
    assert.match(method(APP, 'copyLink'), /Utils\.announce\(/, 'copyLink says "Copied" to screen readers');
    assert.match(method(read('nativecal/app.js'), 'copyToClipboard'), /Utils\.announce\(/, '/beta\'s copy says "Copied" to screen readers');
    assert.match(APP, /offlineNotice\([^)]*\)\s*\{[^\n]*Utils\.announce\(/, 'the offline line is announced');
    const utils = read('utils/utils.js');
    assert.match(utils, /function announce\(/);
    assert.equal((utils.match(/setAttribute\('aria-live', 'polite'\)/g) || []).length, 1, 'one region');
});

test('E: announce() keeps one region, says each message, and says the same words twice when they come twice', async () => {
    const el = { id: 'pc-live', textContent: '', attrs: {}, style: {}, setAttribute(k, v) { this.attrs[k] = v; } };
    let made = 0;
    const document = { body: { appendChild() { made++; } }, getElementById: () => (made ? el : null), createElement: () => el, addEventListener() {} };
    const ctx = vm.createContext({ window: {}, document, setTimeout, clearTimeout, console, MutationObserver: undefined });
    vm.runInContext(read('utils/utils.js'), ctx);
    const U = ctx.window.Utils;
    U.announce('Copied to clipboard');
    assert.equal(el.textContent, 'Copied to clipboard');
    U.announce('Copied to clipboard');
    assert.equal(el.textContent, '', 'emptied first, so the repeat is a change');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(el.textContent, 'Copied to clipboard');
    assert.equal(made, 1, 'one region for the page');
    assert.equal(el.attrs['aria-live'], 'polite');
});

test('A14: no time of day is typed as AM/PM text in Settings (the time format picker\'s own examples excepted)', () => {
    const settings = HTML.slice(HTML.indexOf('data-testid="settings-me"'), HTML.indexOf('data-testid="settings-me"') + 20000);
    const picker = /<select id="set-time-format"[\s\S]*?<\/select>/.exec(settings)[0];
    const rest = settings.replace(picker, '');
    const typed = [...rest.matchAll(/>\s*([^<{]*\b\d{1,2}(:\d{2})?\s?[AP]M\b[^<]*)</g)].map((m) => m[1].trim());
    assert.deepEqual(typed, [], 'use clockTime(h) so 24-hour time reads 05:00');
    assert.match(HTML, /id="set-start-hour"[\s\S]{0,400}clockTime\(/);
});

test('A14: clockTime follows the chosen format', () => {
    const src = /\n {8}clockTime\(h, m = 0\) \{[\s\S]*?\n {8}\},/.exec(APP)[0];
    const ctx = vm.createContext({});
    vm.runInContext(`this.mk = (fmt) => ({ globalSettings: { timeFormat: fmt }, ${src.trim().replace(/,$/, '')} })`, ctx);
    assert.deepEqual([0, 5, 9, 12, 17].map((h) => ctx.mk('24').clockTime(h)), ['00:00', '05:00', '09:00', '12:00', '17:00']);
    assert.deepEqual([0, 5, 9, 12, 17].map((h) => ctx.mk('12').clockTime(h)), ['12:00 AM', '5:00 AM', '9:00 AM', '12:00 PM', '5:00 PM']);
});

test('A18: search folds case and accents, in both calendars\' search', () => {
    const ctx = vm.createContext({ window: {}, document: undefined, setTimeout, clearTimeout, console });
    vm.runInContext(read('utils/utils.js'), ctx);
    const f = ctx.window.Utils.searchFold;
    assert.ok(f('Café meetup').includes(f('cafe')));
    assert.ok(f('TEAM NUÑEZ').includes(f('nunez')));
    assert.ok(f('Crème brûlée night').includes(f('creme brulee')));
    assert.ok(f('강아지봉사 모임').includes(f('강아지')), 'Hangul stays whole syllables');
    assert.ok(!f('Cafe').includes(f('caff')));
    for (const file of ['app.js', 'nativecal/app.js']) {
        const body = /\n {8}searchEvents\(\) \{[\s\S]*?\n {8}\},/.exec(read(file))[0];
        assert.match(body, /Utils\.searchFold\(/, `${file} searchEvents folds accents`);
        assert.doesNotMatch(body, /\.toLowerCase\(\)\.includes/, `${file} searchEvents still compares lowercase only`);
    }
});
