/**
 * One rule for what a calendar or view name may be (functions/slug-rules.js).
 *
 * It used to live in four places that disagreed: the router capped at 39 chars, the claim
 * box accepted anything ("My Carpool 1" hung on Loading with PERMISSION_DENIED, "a.b1"
 * threw inside the SDK, "x/y" wrote calendars/x/y), functions had its own reserved list,
 * and the database rules had none ("nativecal" and "view" were claimable). These tests
 * pin the shared module and, because the rules file cannot import JavaScript, assert that
 * the regexes written into database.rules.json are exactly the ones built here.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '../..');
const R = require('../../functions/slug-rules.js');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('the browser copy is byte-identical to functions/ (scripts/sync-shared.sh)', () => {
    assert.equal(read('public/utils/slug-rules.js'), read('functions/slug-rules.js'));
});

test('slugify: what people type becomes a claimable name', () => {
    assert.equal(R.slugify('My Carpool 1', { final: true }), 'my-carpool-1');
    assert.equal(R.slugify('a.b1', { final: true }), 'a-b1');
    assert.equal(R.slugify('x/y', { final: true }), 'x-y');
    assert.equal(R.slugify('Café  Crème!!', { final: true }), 'cafe-creme');
    assert.equal(R.slugify('Trip-2025', { final: true }), 'trip-2025');
    assert.equal(R.slugify('  -lead- ', { final: true }), 'lead');
    // While typing, a trailing space must survive as a hyphen or "my cal" can't be typed.
    assert.equal(R.slugify('my '), 'my-');
    assert.equal(R.slugify('x'.repeat(80)).length, R.MAX);
    for (const typed of ['My Carpool 1', 'a.b1', 'x/y', 'Team #3 [A]', '$$$abc']) {
        const s = R.slugify(typed, { final: true });
        assert.ok(R.isClaimable(s), `${typed} -> ${s} should be claimable`);
    }
});

test('check: every way a name can be wrong has its own message', () => {
    assert.equal(R.check('').code, 'empty');
    assert.equal(R.check('ab').code, 'short');
    assert.equal(R.check('a'.repeat(51)).code, 'long');
    assert.equal(R.check('a'.repeat(50)).ok, true);
    assert.equal(R.check('My-Cal').code, 'chars');
    assert.equal(R.check('a.b1').code, 'chars');
    assert.equal(R.check('x/y').code, 'chars');
    const reserved = R.check('nativecal');
    assert.equal(reserved.code, 'reserved');
    assert.match(reserved.message, /reserved/);
    assert.doesNotMatch(reserved.message, /Invalid slug format/);
    assert.equal(R.check('soccer-team_2026').ok, true);
});

test('reserved: routes, rewrites and every directory served from public/', () => {
    for (const w of ['view', 'nativecal', 'api', 'admin', 'help']) assert.ok(R.isReserved(w), w);
    const dirs = fs.readdirSync(path.join(ROOT, 'public'), { withFileTypes: true })
        .filter(d => d.isDirectory()).map(d => d.name.toLowerCase())
        .filter(n => /^[a-z0-9_-]+$/.test(n));
    for (const d of dirs) assert.ok(R.isReserved(d), `public/${d}/ must be reserved`);
    for (const w of R.RESERVED) assert.match(w, /^[a-z0-9_-]+$/, `${w} must be slug-shaped`);
    assert.equal(new Set(R.RESERVED).size, R.RESERVED.length, 'no duplicates');
});

test('router: anything that may exist routes, including 45-char and legacy mixed-case keys', () => {
    assert.ok(R.isRoutable('a'.repeat(45)), 'a 45-char name used to reload as the homepage');
    assert.ok(R.isRoutable('N2U5H6CH'), 'legacy mixed-case keys still open');
    assert.ok(R.isRoutable('team'), 'a calendar created before a word was reserved still opens');
    assert.ok(!R.isRoutable('a.b'));
    assert.ok(!R.isRoutable(''));
    // Every name that can be claimed can be opened again.
    for (const s of ['abc', 'a'.repeat(50), 'x_y-z']) assert.ok(R.CLAIM.test(s) && R.isRoutable(s));
    for (const app of ['public/app.js', 'public/nativecal/app.js']) {
        const src = read(app);
        assert.match(src, /SlugRules\.isRoutable\(urlslug\)/, `${app} routes with the shared rule`);
        assert.doesNotMatch(src, /urlslug\.length < 40/, `${app} must not keep its own cap`);
    }
});

test('database.rules.json creates calendars under exactly this rule', () => {
    const rules = JSON.parse(read('database.rules.json'));
    const cal = rules.rules.calendars.$id;
    const write = cal['.write'];
    const regexes = [...write.matchAll(/\$id\.matches\(\/(.*?)\/\)/g)].map(m => m[1]);
    assert.deepEqual(regexes, [R.CLAIM.source, R.RESERVED_PATTERN.source],
        'rules regexes drifted from functions/slug-rules.js -- regenerate them from it');
    assert.match(write, /newData\.child\('id'\)\.val\(\) === \$id/, 'a new node must name itself');
    assert.match(write, /^data\.exists\(\) \|\|/, 'existing (legacy) calendars stay writable');
});

test('rules allow-list of top-level calendar keys == CalendarDataService.CALENDAR_KEYS', () => {
    const rules = JSON.parse(read('database.rules.json'));
    const cal = rules.rules.calendars.$id;
    const named = Object.keys(cal).filter(k => !k.startsWith('.') && !k.startsWith('$')).sort();
    const src = read('public/services/CalendarDataService.js');
    const m = /static CALENDAR_KEYS = \[([^\]]*)\]/.exec(src);
    const keys = m[1].split(',').map(s => s.trim().replace(/'/g, '')).filter(Boolean).sort();
    assert.deepEqual(named, keys);
    // META_KEYS are written on every sync; they must be allowed.
    const meta = /static META_KEYS = \[([^\]]*)\]/.exec(src)[1].split(',').map(s => s.trim().replace(/'/g, ''));
    for (const k of meta) assert.ok(keys.includes(k), k);
    // Unknown keys may persist where they already exist (legacy data) but never be added.
    assert.equal(cal.$other['.validate'], 'data.exists()');
});

test('functions validates view names with the same rule (case-insensitively)', () => {
    const { SlugService } = require('../../functions/index.js')._internal;
    assert.equal(SlugService.validateSlug('Team-Schedule'), true);
    assert.equal(SlugService.validateSlug('nativecal'), false);
    assert.equal(SlugService.checkSlug('view').code, 'reserved');
    assert.equal(SlugService.validateSlug('ab'), false);
    assert.equal(SlugService.validateSlug('a.b1'), false);
});
