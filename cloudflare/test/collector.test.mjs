import assert from 'node:assert/strict';
import { toDataPoints, handleCollect, scrubError } from '../src/Collector.js';

const ev = (name, params = {}, path = '/abc') => ({ name, params, path });

// shape + privacy
const [a] = toDataPoints({ events: [ev('page_perf', { ttfb_ms: 120, lcp_ms: 900, cls: 0.01, browser: 'safari', device: 'phone', cached: 'no' }, '/secretcal')] }, 'US');
assert.deepEqual(a.indexes, ['page_perf']);
assert.deepEqual(a.blobs, ['page_perf', 'classic', 'safari', 'phone', 'US', '', 'no', '']);
assert.deepEqual(a.doubles, [120, 0, 900, 0, 0.01, 0, 1]);
// trial events keep their one value in blob6 (detail)
for (const [name, params, detail] of [['trial_feature_used', { feature: 'stats_pro' }, 'stats_pro'], ['trial_converted', { interval: 'month' }, 'month'],
    ['trial_lapsed', { mode: 'readonly' }, 'readonly'], ['trial_started', { trial_surface: 'lock' }, 'lock']]) {
    assert.equal(toDataPoints({ events: [ev(name, params)] }, 'US')[0].blobs[5], detail, name);
}
// the launch funnel's other two (scripts/ux.sh trials): contact type, nudge action; test traffic never lands
assert.equal(toDataPoints({ events: [ev('contact_submitted', { type: 'report' })] })[0].blobs[5], 'report');
assert.equal(toDataPoints({ events: [ev('subscribe_nudge', { action: 'shown' })] })[0].blobs[5], 'shown');
// the new calendar opt-in keeps both values: what was done and where
assert.equal(toDataPoints({ events: [ev('new_ui', { action: 'opt_in', source: 'footer' })] })[0].blobs[5], 'opt_in_footer');
assert.equal(toDataPoints({ events: [ev('new_ui', { action: 'feedback_sent', source: 'pill' })] })[0].blobs[5], 'feedback_sent_pill');
assert.equal(toDataPoints({ events: [ev('trial_reminder_clicked', {})] })[0].blobs[0], 'trial_reminder_clicked');
assert.equal(toDataPoints({ events: [ev('trial_started', { trial_surface: 'lock', surface: 'test' })] }).length, 0, 'surface=test is dropped');
// pro_beta_joined keeps where it was joined (beta_surface) in detail; an earlier detail key still wins
assert.equal(toDataPoints({ events: [ev('pro_beta_joined', { beta_surface: 'stats', surface: 'web' })] })[0].blobs[5], 'stats');
assert.equal(toDataPoints({ events: [ev('x', { kind: 'pro', beta_surface: 'share' })] })[0].blobs[5], 'pro');
assert.equal(toDataPoints({ events: [ev('pro_beta_joined', { beta_surface: 'stats', surface: 'test' })] }).length, 0, 'test events still dropped');
assert.ok(!JSON.stringify(a).includes('secretcal'), 'calendar path must never be stored');

// js_error keeps its message and file:line (blob9, blob10), with URLs cut to their origin and quoted text masked
const je = toDataPoints({ events: [ev('js_error', { kind: 'error', message: "Cannot read properties of undefined (reading 'Subject')", where: 'app.js:2985' })] })[0];
assert.equal(je.blobs[5], 'error'); assert.equal(je.blobs[8], "Cannot read properties of undefined (reading 'Subject')"); assert.equal(je.blobs[9], 'app.js:2985');
assert.equal(scrubError('Failed to fetch https://pastecal.com/cal/secret-id/history?x=1'), 'Failed to fetch https://pastecal.com/…');
assert.equal(scrubError('Unexpected token \'D\', "Dr. Patel bio"... is not valid JSON'), 'Unexpected token \'D\', "…"... is not valid JSON');
assert.equal(toDataPoints({ events: [ev('js_error', { message: 'x'.repeat(500) })] })[0].blobs[8].length, 200);
assert.equal(toDataPoints({ events: [ev('event_added', { message: 'not kept' })] })[0].blobs.length, 8, 'only js_error carries text');

// native vs classic from the path
assert.equal(toDataPoints({ events: [ev('x', {}, '/nativecal/foo')] })[0].blobs[1], 'native');
// The opt-in new calendar on an ordinary calendar link: the page says renderer native (analytics.js baseParams).
assert.equal(toDataPoints({ events: [ev('event_added', { renderer: 'native' }, '/my-team')] })[0].blobs[1], 'native');
assert.equal(toDataPoints({ events: [ev('event_added', {}, '/my-team')] })[0].blobs[1], 'classic');

// first_event_seconds + detail
const b = toDataPoints({ events: [ev('event_added', { first_event_seconds: 12, source: 'grid' })] })[0];
assert.equal(b.doubles[5], 12); assert.equal(b.blobs[5], 'grid');

// hostile / junk input is dropped, never throws
assert.deepEqual(toDataPoints(null), []);
assert.deepEqual(toDataPoints({ events: 'x' }), []);
assert.equal(toDataPoints({ events: [ev('Bad Name!'), ev(''), { name: 5 }, ev('ok'), ev('t', { surface: 'test' })] }).length, 1);
assert.equal(toDataPoints({ events: Array.from({ length: 500 }, () => ev('ok')) }).length, 20);
assert.deepEqual(toDataPoints({ events: [ev('ok', { ttfb_ms: 'NaN', lcp_ms: Infinity })] })[0].doubles.slice(0, 3), [0, 0, 0]);
assert.equal(toDataPoints({ events: [ev('ok', { source: 'x'.repeat(500) })] })[0].blobs[5].length, 40);

// handler: always 204, writes points, tolerates a missing binding and bad bodies
const written = [];
const env = { EVENTS: { writeDataPoint: (p) => written.push(p) } };
const BROWSER = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const post = (body, ua = BROWSER) => new Request('https://x/api/collect', { method: 'POST', headers: { 'User-Agent': ua }, body });
assert.equal((await handleCollect(post(JSON.stringify({ events: [ev('a'), ev('b')] })), env)).status, 204);
assert.equal(written.length, 2);
assert.equal((await handleCollect(post('{not json'), env)).status, 204);
assert.equal((await handleCollect(post('x'.repeat(20000)), env)).status, 204);
assert.equal(written.length, 2);
assert.equal((await handleCollect(post('{}'), {})).status, 204);
// Headless browsers and our own scripts and audits are not counted (Insight.isBot); still a 204.
for (const ua of ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/140.0.0.0 Safari/537.36',
    BROWSER + ' pastecal-audit', 'node', 'Python-urllib/3.12', '']) {
    assert.equal((await handleCollect(post(JSON.stringify({ events: [ev('a')] }), ua), env)).status, 204);
}
assert.equal(written.length, 2, 'automation writes nothing');
console.log('collector tests passed');

// The homepage experiment variant rides along so conversion and returns can be split by it.
assert.equal(toDataPoints({ events: [ev('event_added', { hv: 'b' })] })[0].blobs[7], 'b');

// Per-IP rate limit: over it, the batch is dropped, never read, and the answer is still 204.
{
    const seen = [], keys = [];
    let allow = 2;
    const limited = { EVENTS: { writeDataPoint: (p) => seen.push(p) }, COLLECT_LIMITER: { limit: async ({ key }) => { keys.push(key); return { success: allow-- > 0 }; } } };
    const req = () => new Request('https://x/api/collect', { method: 'POST', headers: { 'CF-Connecting-IP': '203.0.113.7', 'User-Agent': BROWSER }, body: JSON.stringify({ events: [ev('a')] }) });
    for (let i = 0; i < 4; i++) assert.equal((await handleCollect(req(), limited)).status, 204);
    assert.equal(seen.length, 2, 'only the batches under the limit are written');
    assert.deepEqual([...new Set(keys)], ['collect:203.0.113.7']);
    console.log('collector rate-limit tests passed');
}
