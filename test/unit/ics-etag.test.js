/**
 * The feed's ETag hashes everything the feed says (cloudflare/src/index.js serveFeed, ICSService.etagSource).
 *
 * It hashed the view link and the events only, so after a calendar was renamed a calendar app asking "changed?"
 * (If-None-Match) was told 304 Not Modified and kept the old name (stress A11); the calendar's zone, which now decides
 * how every series is written, was not in it either. Now: the whole feed but its DTSTAMP lines. The Worker test
 * (cloudflare/test/hardening.test.mjs) asks the real route.
 *
 * Run: node --test test/unit/ics-etag.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const cal = () => ({ id: 'c', title: 'Old name', options: { tz: 'America/Los_Angeles', notes: 'n' }, lastEditedAt: Date.UTC(2026, 9, 20),
    events: [{ id: 'w', title: 'Practice', start: '2026-10-07T00:00:00.000Z', end: '2026-10-07T01:00:00.000Z', recurrencerule: 'FREQ=WEEKLY;BYDAY=TU;' }] });

test('every change a calendar app would show changes what the ETag hashes; nothing else does', async () => {
    const { ICSService } = await import('../../cloudflare/src/ICSService.js');
    const src = (c, o) => ICSService.etagSource(ICSService.generateICS(c, 'c', o));
    const base = src(cal());
    assert.equal(src(cal()), base, 'the same calendar hashes the same');
    assert.equal(src({ ...cal(), lastEditedAt: undefined }), src({ ...cal(), lastEditedAt: undefined }), 'without lastEditedAt too (DTSTAMP is now)');
    assert.equal(src({ ...cal(), options: { ...cal().options, notes: 'other' } }), base, 'notes are not in the feed');
    const changed = {
        title: { ...cal(), title: 'New name' },
        zone: { ...cal(), options: { tz: 'Europe/London' } },
        event: { ...cal(), events: [{ ...cal().events[0], title: 'Game' }] },
    };
    for (const [what, c] of Object.entries(changed)) assert.notEqual(src(c), base, what);
    assert.notEqual(src(cal(), { viewUrl: 'https://pastecal.com/view/abc' }), base, 'the view link');
    const ics = ICSService.generateICS(cal(), 'c');
    assert.ok(ics.includes('DTSTAMP:20261020T000000Z'), 'DTSTAMP is when the calendar last changed');
});
