/**
 * The daily full archive's health check and restore diff (cloudflare/src/archive-format.js). The Worker suite
 * (cloudflare/test/db-archive.test.mjs) runs the real job, routes and restore; this covers the cases it can't
 * reach quickly: an archive older than 26 hours, a failed read, and the diff's edge cases.
 *
 * Run: node --test test/unit/backup-archive.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { gzipSync } = require('zlib');

const load = () => import(path.join(__dirname, '../../cloudflare/src/archive-format.js'));
const H = 3600000, NOW = Date.UTC(2026, 9, 28, 12);
const newest = (meta, hoursAgo = 3) => ({ key: 'archive/daily/2026-10-28.json.gz', date: '2026-10-28', size: 4e6,
    uploaded: new Date(NOW - hoursAgo * H), meta: { finishedAt: new Date(NOW - hoursAgo * H).toISOString(), count: '5000', failed: '0', ...meta } });

test('health: a fresh, whole archive is ok', async () => {
    const { evaluateHealth } = await load();
    const h = evaluateHealth({ newest: newest({}), now: NOW, editable: 5100 });
    assert.equal(h.ok, true, h.problems.join('; '));
    assert.equal(h.newest.count, 5000); assert.equal(h.newest.ageHours, 3);
});

test('health: missing, stale (over 26h), short (under 95%) and failed reads are problems', async () => {
    const { evaluateHealth } = await load();
    assert.match(evaluateHealth({ newest: null, now: NOW, editable: 10 }).problems[0], /no daily full archive/);
    const stale = evaluateHealth({ newest: newest({}, 27), now: NOW, editable: 5000 });
    assert.equal(stale.ok, false); assert.match(stale.problems[0], /27\.0 hours old, over 26/);
    assert.equal(evaluateHealth({ newest: newest({}, 25.9), now: NOW, editable: 5000 }).ok, true);
    const short = evaluateHealth({ newest: newest({ count: '94' }), now: NOW, editable: 100 });
    assert.match(short.problems[0], /holds 94 calendars \(\+0 absent names\), under 95% of the directory's 100/);
    // Names that lead to no calendar were looked up (absent): they count toward coverage...
    assert.equal(evaluateHealth({ newest: newest({ count: '90', absent: '6' }), now: NOW, editable: 100 }).ok, true);
    // ...but more of them than calendars is a problem of its own (an id bug, say).
    assert.match(evaluateHealth({ newest: newest({ count: '40', absent: '60' }), now: NOW, editable: 100 }).problems[0], /more names leading nowhere \(60\) than calendars \(40\)/);
    assert.equal(evaluateHealth({ newest: newest({ count: '95' }), now: NOW, editable: 100 }).ok, true);
    assert.match(evaluateHealth({ newest: newest({ failed: '2' }), now: NOW, editable: 5000 }).problems[0], /2 calendar\(s\) could not be read/);
    assert.match(evaluateHealth({ newest: newest({ count: undefined }), now: NOW, editable: 5 }).problems[0], /no calendar count/);
});

test('health: no finishedAt falls back to the upload time', async () => {
    const { evaluateHealth } = await load();
    const n = newest({}, 30); delete n.meta.finishedAt;
    assert.match(evaluateHealth({ newest: n, now: NOW, editable: 1 }).problems[0], /30\.0 hours old/);
});

test('diff: added (back after the restore), removed, changed, title and notes', async () => {
    const { diffCalendars } = await load();
    const ev = (id, title, rid) => ({ id, title, start: '2026-11-01T09:00:00Z', end: '2026-11-01T10:00:00Z', ...(rid ? { recurrenceID: rid } : {}) });
    const archived = { title: 'A', options: { notes: 'n1' }, events: [ev('1', 'one'), ev('2', 'two'), ev('3', 'series'), ev('3', 'moved', 'x')] };
    const live = { title: 'B', options: { notes: 'n2' }, events: [ev('1', 'one'), ev('2', 'TWO'), ev('9', 'stray')] };
    const d = diffCalendars(archived, live);
    assert.deepEqual([d.added, d.removed, d.changed], [2, 1, 1]);
    assert.deepEqual(d.addedTitles, ['series', 'moved']); assert.deepEqual(d.removedTitles, ['stray']); assert.deepEqual(d.changedTitles, ['two']);
    assert.equal(d.titleChanged, true); assert.equal(d.notesChanged, true); assert.equal(d.same, false);
    assert.equal(diffCalendars(archived, archived).same, true);
    const gone = diffCalendars(archived, null);
    assert.equal(gone.liveEvents, null); assert.equal(gone.added, 4); assert.equal(gone.same, false);
});

test('findInArchive: the exact id only, from a gzip of JSON lines', async () => {
    const { findInArchive } = await load();
    const lines = [{ t: 'archive', version: 1 }, { t: 'dir', row: { actual_slug: 'Team' } },
        { t: 'cal', id: 'Team', v: 1, calendar: { id: 'Team', events: [] } }, { t: 'cal', id: 'team', v: 2, calendar: { id: 'team', events: [] } },
        { t: 'cal', id: 'a "quoted" name ', v: 3, calendar: { id: 'x', events: [] } }, { t: 'end', count: 3 }];
    const body = () => new Response(gzipSync(lines.map((l) => JSON.stringify(l)).join('\n') + '\n')).body;
    assert.equal((await findInArchive(body(), 'team')).v, 2);
    assert.equal((await findInArchive(body(), 'Team')).v, 1);
    assert.equal((await findInArchive(body(), 'a "quoted" name ')).v, 3);
    assert.equal(await findInArchive(body(), 'nobody'), null);
});
