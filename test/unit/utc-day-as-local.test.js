/**
 * Root-cause guard: a UTC date read as a person's day.
 *
 * `date.toISOString().slice(0, 10)` is the UTC date. At local midnight east of UTC it is the day before: Share's
 * "This view" link, made in Tokyo or Auckland on Saturday Oct 24, said date=2026-10-23 (stress A06). Its mirror image,
 * `new Date('2026-10-24')`, is UTC midnight: Friday evening in the Americas. A day a person sees is formatted from the
 * local fields (Utils.localDay) and parsed as local (Utils.parseDate, or 'T12:00:00' appended).
 *
 * This fails on any such pattern in code that runs (the page, the Worker) unless the file is listed below with WHY
 * the UTC date is the right one there, and with how many times it does it (a new one in a listed file fails too).
 *
 * Run: node --test test/unit/utc-day-as-local.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '../..');
const PATTERNS = [
    /\.toISOString\(\)\s*\.\s*(?:slice|substring|substr)\(\s*0\s*,\s*10\s*\)/g,
    /\.toISOString\(\)\s*\.\s*split\(\s*['"]T['"]\s*\)/g,
    /\.toJSON\(\)\s*\.\s*(?:slice|substring|substr)\(\s*0\s*,\s*10\s*\)/g,
    /new Date\(\s*['"`]\d{4}-\d{2}-\d{2}['"`]\s*\)/g,
    /Date\.parse\(\s*['"`]\d{4}-\d{2}-\d{2}['"`]\s*\)/g,
];
// UTC on purpose: file -> [count, why].
const UTC_ON_PURPOSE = {
    'cloudflare/src/ICSService.js': [1, 'formatDate: an all-day DATE from a UTC-midnight instant built by the +13h read rule'],
    'cloudflare/src/preview/time.js': [1, 'isoDay: a day number is UTC midnight of that date by construction'],
    'cloudflare/src/CalendarRoom.js': [2, 'server-side buckets: author activity days and daily snapshot keys, in UTC'],
    'cloudflare/src/RoomInsight.js': [1, 'Pro stats day buckets, in UTC (the server has no viewer zone)'],
    'cloudflare/src/Waitlist.js': [1, 'a per-day rate bucket on the server, in UTC'],
    'public/services/AuthorSignal.js': [1, 'an informational key; distinct days are counted from the server timestamp'],
    'public/components/ProInsight.js': [1, 'an all-day date key from a UTC-midnight instant built by the +13h read rule'],
};

function files(dir, out = []) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) { if (!['vendor', 'node_modules', 'js-old-components'].includes(ent.name)) files(p, out); }
        else if (/\.(m?js|html)$/.test(ent.name)) out.push(p);
    }
    return out;
}

test('no UTC date is read as a person\'s day (toISOString().slice(0, 10), new Date(\'YYYY-MM-DD\'))', () => {
    const found = {};
    for (const f of [...files(path.join(ROOT, 'public')), ...files(path.join(ROOT, 'cloudflare/src'))]) {
        const rel = path.relative(ROOT, f).split(path.sep).join('/');
        const src = fs.readFileSync(f, 'utf8');
        for (const re of PATTERNS) {
            for (const m of src.matchAll(re)) {
                const line = src.slice(0, m.index).split('\n').length;
                const before = src.slice(src.lastIndexOf('\n', m.index) + 1, m.index);
                if (/\/\/|^\s*\*/.test(before)) continue;   // (a comment saying not to)
                (found[rel] = found[rel] || []).push(`${rel}:${line}: ${src.split('\n')[line - 1].trim().slice(0, 120)}`);
            }
        }
    }
    const bad = [];
    for (const [rel, hits] of Object.entries(found)) {
        const ok = UTC_ON_PURPOSE[rel];
        if (!ok || hits.length !== ok[0]) bad.push(...hits);
    }
    assert.deepEqual(bad, [], 'a day a person sees: Utils.localDay(date) to write it, Utils.parseDate / "T12:00:00" to read it');
});

test('Utils.localDay is the local date, the one Utils.parseDate reads back, in Tokyo, Auckland and Los Angeles', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public/utils/utils.js'), 'utf8');
    const window = {};
    new Function('window', 'localStorage', 'document', `${src}; return window;`)(window, { getItem: () => null, setItem() {} }, { addEventListener() {} });
    for (const zone of ['Asia/Tokyo', 'Pacific/Auckland', 'America/Los_Angeles']) {
        const was = process.env.TZ;
        process.env.TZ = zone;
        try {
            const sat = new Date(2026, 9, 24);   // local midnight, Saturday Oct 24
            assert.equal(window.Utils.localDay(sat), '2026-10-24', zone);
            assert.equal(window.Utils.parseDate(window.Utils.localDay(sat)).getTime(), sat.getTime(), zone);
        } finally { if (was === undefined) delete process.env.TZ; else process.env.TZ = was; }
    }
});
