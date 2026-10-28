/**
 * Every failure is said in the page, never by a browser alert, a promise that rejects into nothing, or an empty
 * result that reads as success (app-stress-3 A05, A07, A08, A09, A12).
 *
 * Each past instance had one of three shapes, and each shape has a check here:
 *   1. alert(): the view link lookup (A08), Share's Rename (A07, via SlugManager), the homepage claim on /beta. A
 *      browser dialog says nothing where the person was looking, blocks the page, and tests can't see it.
 *   2. A promise chain with no rejection handler in a user action: Share's Rename (.then with no catch: an
 *      uncaught error and nothing on screen, A07); Save & share (no failure path at all: "Loading…" forever, A05).
 *   3. A data call that turns a failure into "nothing": loadUndoEntries returned [] on a 503 (Activity said
 *      "Nothing has changed", A09); lookupCalendar returned found:false offline (a view link "not found"); a failed
 *      existence check said "taken"; createWithId called nobody on a 500.
 * The browser side (each network call made to fail, a message visible, no page error) is
 * cloudflare/test/failure-paths.spec.js.
 *
 * Run: node --test test/unit/failure-paths.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTab } = require('../cloud-loader.js');

const PUBLIC = path.join(__dirname, '..', '..', 'public');
const rel = (f) => path.relative(PUBLIC, f);

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name);
        if (e.isDirectory()) walk(f, out);
        else if (/\.(js|html)$/.test(e.name)) out.push(f);
    }
    return out;
}

// Not app code: third-party libraries, and the pre-Vue app no page loads (cloudflare/src only reserves its name).
const NOT_APP = [/^vendor\//, /^js-old-components\//];
const APP_FILES = walk(PUBLIC).filter((f) => !NOT_APP.some((r) => r.test(rel(f))));

// Comments say "it was an alert()" and must not count; strings and code do.
// (Each comment keeps its line breaks, so a line number found below is the file's own.)
const blank = (m) => m.replace(/[^\n]/g, '');
const withoutComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/<!--[\s\S]*?-->/g, blank).replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');

test('no alert() in app code (a failure is said in the page: inline where it happened, or the toast)', () => {
    // Allowlist: none. Every past alert had an in-page place to say the same thing.
    const ALLOWED = new Map();
    const found = [];
    for (const f of APP_FILES) {
        const src = withoutComments(fs.readFileSync(f, 'utf8'));
        const re = /(^|[^\w.$])(window\.)?alert\s*\(/g;
        let m;
        while ((m = re.exec(src))) {
            const line = src.slice(0, m.index).split('\n').length;
            if (!ALLOWED.has(`${rel(f)}:${line}`)) found.push(`${rel(f)}:${line}`);
        }
    }
    assert.deepEqual(found, [], `alert() in app code: say it in the page instead:\n${found.join('\n')}`);
});

// ---- promise chains -----------------------------------------------------------------------------------------

/** Index just past the bracket that closes the one at `open`, skipping strings and template literals. */
function closeOf(src, open) {
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        const c = src[i];
        if (c === '"' || c === "'" || c === '`') {
            for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
            continue;
        }
        if (c === '(' || c === '{' || c === '[') depth++;
        else if (c === ')' || c === '}' || c === ']') { depth--; if (!depth) return i + 1; }
    }
    return -1;
}
/** Is there a comma at the top level of the call whose parens open at `open` (then(ok, fail))? */
function twoArgs(src, open) {
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        const c = src[i];
        if (c === '"' || c === "'" || c === '`') { for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++; continue; }
        if (c === '(' || c === '{' || c === '[') depth++;
        else if (c === ')' || c === '}' || c === ']') { depth--; if (!depth) return false; }
        else if (c === ',' && depth === 1) return true;
    }
    return false;
}

/** Each .then( chain in src with no rejection handler: [{ line, text }]. A returned chain is the caller's to handle. */
function unhandledChains(src) {
    const out = [], seen = new Set();
    const re = /\.then\s*\(/g;
    let m;
    while ((m = re.exec(src))) {
        if (seen.has(m.index)) continue;
        let i = m.index, handled = false;
        // The whole chain: .then(...) .then(...) .catch(...) .finally(...)
        for (;;) {
            const link = /^\.\s*(then|catch|finally)\s*\(/.exec(src.slice(i));
            if (!link) break;
            seen.add(i);
            const open = i + link[0].length - 1;
            if (link[1] === 'catch' || (link[1] === 'then' && twoArgs(src, open))) handled = true;
            const end = closeOf(src, open);
            if (end < 0) break;
            i = end;
            while (/\s/.test(src[i] || '')) i++;
        }
        const lineStart = src.lastIndexOf('\n', m.index) + 1;
        const lineText = src.slice(lineStart, src.indexOf('\n', m.index)).trim();
        if (/^return\b/.test(lineText)) handled = true;
        if (!handled) out.push({ line: src.slice(0, m.index).split('\n').length, text: lineText.slice(0, 100) });
    }
    return out;
}

test('the chain parser itself: finds a missing catch, accepts .catch, then(ok, fail) and a returned chain', () => {
    assert.equal(unhandledChains('a.then(() => { x(); });').length, 1);
    assert.equal(unhandledChains('a.then(() => { x("(" ); }).then(y);').length, 1);
    assert.equal(unhandledChains('a.then(() => x()).catch(() => {});').length, 0);
    assert.equal(unhandledChains('a.then((r) => f(r, 2), (e) => g(e));').length, 0);
    assert.equal(unhandledChains('a.then(f)\n  .then(g)\n  .catch(h);').length, 0);
    assert.equal(unhandledChains('function f() {\n  return a.then(g);\n}').length, 0);
});

test('every promise chain in app code handles its failure (.catch or then(ok, fail)), so nothing rejects into nothing', () => {
    // Chains on promises that cannot reject.
    const NEVER_REJECTS = [
        /^if \(document\.fonts && document\.fonts\.ready\) document\.fonts\.ready\.then\(/,   // FontFaceSet.ready never rejects
        /ProBilling\.load\(\)\.then\(/,                                                     // ProBilling.load ends in .catch(() => true)
    ];
    const found = [];
    for (const f of APP_FILES.filter((x) => x.endsWith('.js'))) {
        for (const c of unhandledChains(withoutComments(fs.readFileSync(f, 'utf8')))) {
            if (NEVER_REJECTS.some((r) => r.test(c.text))) continue;
            found.push(`${rel(f)}:${c.line}  ${c.text}`);
        }
    }
    assert.deepEqual(found, [], `a promise chain with no rejection handler (add .catch that says what happened):\n${found.join('\n')}`);
});

// ---- the data layer: a failure is not "nothing" -------------------------------------------------------------

const res = (status, body = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
function tabWith(fetchImpl) {
    const tab = loadTab();
    tab.ctx.fetch = fetchImpl;
    tab.ctx.console = { log() {}, warn() {}, error() {} };
    return tab.Cloud;
}
const offline = async () => { throw new TypeError('Failed to fetch'); };

test('loadUndoEntries: a 503 or no connection rejects; it never says "no changes" ([]) when nobody knows', async () => {
    for (const f of [async () => res(503), offline]) {
        const Cloud = tabWith(f);
        await assert.rejects(Cloud.loadUndoEntries('team'), 'a failed read rejects');
    }
    const ok = tabWith(async () => res(200, [{ key: 'k', savedAt: 1 }]));
    assert.equal((await ok.loadUndoEntries('team')).length, 1);
    const none = tabWith(async () => res(200, []));
    assert.equal((await none.loadUndoEntries('team')).length, 0, 'an empty history is still []');
});

test('lookupCalendar: offline or a 500 carries an error, so "couldn\'t look it up" is never shown as "not found"', async () => {
    for (const f of [async () => res(500), offline]) {
        const out = await tabWith(f).lookupCalendar('some-view');
        assert.ok(out.error, `an error is reported: ${JSON.stringify(out)}`);
        assert.equal(out.data.found, false);
    }
    const nf = await tabWith(async () => res(200, { found: false })).lookupCalendar('some-view');
    assert.equal(nf.error, undefined, 'a real "not found" has no error');
});

test('checkExists: when the server can\'t be asked, the "couldn\'t check" callback runs (not "taken", never "free")', async () => {
    for (const f of [offline, async (u, o) => (o && o.method === 'HEAD' ? res(503) : res(200, { found: false }))]) {
        const Cloud = tabWith(f);
        const said = await new Promise((resolve) => Cloud.checkExists('free-name', () => resolve('taken'), () => resolve('free'), () => resolve('failed')));
        assert.equal(said, 'failed');
    }
    const free = tabWith(async (u, o) => (o && o.method === 'HEAD' ? res(404) : res(200, { found: false })));
    assert.equal(await new Promise((r) => free.checkExists('x', () => r('taken'), () => r('free'), () => r('failed'))), 'free');
});

test('createWithId: a refusal, a 500 or no connection calls onError (the page stops "Loading…" and says so), never success', async () => {
    for (const [f, want] of [[async () => res(500, { ok: false }), 500], [async () => res(400, { ok: false, error: 'bad_id' }), 400], [offline, 0]]) {
        const Cloud = tabWith(f);
        const got = await new Promise((resolve) => {
            Cloud.createWithId('team', { title: 'T', options: {}, events: [] }, () => resolve('success'), { onError: (e) => resolve(e) });
            setTimeout(() => resolve('nothing'), 500);
        });
        assert.equal(typeof got, 'object', `told: ${JSON.stringify(got)}`);
        assert.equal(got.status, want);
    }
});

// ---- names: refused before a request that can't work --------------------------------------------------------

function slugManager() {
    const vm = require('node:vm');
    const ctx = vm.createContext({ console });
    vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'services/SlugManager.js'), 'utf8') + ';this.SlugManager = SlugManager;', ctx);
    return ctx.SlugManager;
}

test('SlugManager: names the server refuses are said in words before any request (A05 "#", A07 own name / "my team!")', () => {
    const S = slugManager();
    assert.equal(typeof S.nameProblem, 'function');
    for (const bad of ['team#1', 'a.b', 'x/y', 'a$b', 'a[b]']) assert.match(S.nameProblem(bad) || '', /can.t contain/, bad);
    for (const ok of ['team-1', 'TEAM NUÑEZ', 'd&d8', '강아지봉사', 'royal city ']) assert.equal(S.nameProblem(ok), null, ok);
    assert.match(S.viewNameProblem('ABC123', 'abc123') || '', /already this link/);
    assert.match(S.viewNameProblem('my team!', 'abc123') || '', /letters, numbers/);
    assert.equal(S.viewNameProblem('my-team', 'abc123'), null);
    assert.match(S.linkErrorMessage({ code: 'already-exists' }), /taken/);
    // A view link named after its calendar took the calendar's edit link (Oct 28 2026): refused, and said so.
    assert.equal(S.viewNameProblem('Kazumichi', 'abc123', 'kazumichi'), 'That’s this calendar’s edit link name. Pick a different one, so the view link can’t be used to edit.');
    assert.equal(S.viewNameProblem('kazumichi-view', 'abc123', 'kazumichi'), null);
    assert.match(S.linkErrorMessage({ code: 'already-exists', reason: 'calendar' }), /taken/);   // another calendar's name
    assert.match(S.linkErrorMessage(new TypeError('Failed to fetch')), /connection/);
});

test('SlugManager.createReadOnlyLink rethrows with words for the page (userMessage), and shows nothing itself', async () => {
    const vm = require('node:vm');
    const ctx = vm.createContext({ console: { log() {}, error() {} }, alert: () => { throw new Error('alert() called'); } });
    vm.runInContext(`var CalendarDataService = { createPublicLink: async () => { const e = new Error('Slug is already taken'); e.code = 'already-exists'; throw e; } };`
        + fs.readFileSync(path.join(PUBLIC, 'services/SlugManager.js'), 'utf8') + ';this.SlugManager = SlugManager;', ctx);
    await assert.rejects(ctx.SlugManager.createReadOnlyLink({ id: 'c', options: {} }, { customSlug: 'taken-one' }), (e) => /taken/i.test(e.userMessage || ''));
});
