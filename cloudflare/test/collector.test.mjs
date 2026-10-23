import assert from 'node:assert/strict';
import { toDataPoints, handleCollect } from '../src/Collector.js';

const ev = (name, params = {}, path = '/abc') => ({ name, params, path });

// shape + privacy
const [a] = toDataPoints({ events: [ev('page_perf', { ttfb_ms: 120, lcp_ms: 900, cls: 0.01, browser: 'safari', device: 'phone', cached: 'no' }, '/secretcal')] }, 'US');
assert.deepEqual(a.indexes, ['page_perf']);
assert.deepEqual(a.blobs, ['page_perf', 'classic', 'safari', 'phone', 'US', '', 'no', '']);
assert.deepEqual(a.doubles, [120, 0, 900, 0, 0.01, 0, 1]);
assert.ok(!JSON.stringify(a).includes('secretcal'), 'calendar path must never be stored');

// native vs classic from the path
assert.equal(toDataPoints({ events: [ev('x', {}, '/nativecal/foo')] })[0].blobs[1], 'native');

// first_event_seconds + detail
const b = toDataPoints({ events: [ev('event_added', { first_event_seconds: 12, source: 'grid' })] })[0];
assert.equal(b.doubles[5], 12); assert.equal(b.blobs[5], 'grid');

// hostile / junk input is dropped, never throws
assert.deepEqual(toDataPoints(null), []);
assert.deepEqual(toDataPoints({ events: 'x' }), []);
assert.equal(toDataPoints({ events: [ev('Bad Name!'), ev(''), { name: 5 }, ev('ok'), ev('t', { surface: 'test' })] }).length, 1);
assert.equal(toDataPoints({ events: Array.from({ length: 500 }, () => ev('ok')) }).length, 50);
assert.deepEqual(toDataPoints({ events: [ev('ok', { ttfb_ms: 'NaN', lcp_ms: Infinity })] })[0].doubles.slice(0, 3), [0, 0, 0]);
assert.equal(toDataPoints({ events: [ev('ok', { source: 'x'.repeat(500) })] })[0].blobs[5].length, 40);

// handler: always 204, writes points, tolerates a missing binding and bad bodies
const written = [];
const env = { EVENTS: { writeDataPoint: (p) => written.push(p) } };
const post = (body) => new Request('https://x/api/collect', { method: 'POST', body });
assert.equal((await handleCollect(post(JSON.stringify({ events: [ev('a'), ev('b')] })), env)).status, 204);
assert.equal(written.length, 2);
assert.equal((await handleCollect(post('{not json'), env)).status, 204);
assert.equal((await handleCollect(post('x'.repeat(20000)), env)).status, 204);
assert.equal(written.length, 2);
assert.equal((await handleCollect(post('{}'), {})).status, 204);
console.log('collector tests passed');

// The homepage experiment variant rides along so conversion and returns can be split by it.
assert.equal(toDataPoints({ events: [ev('event_added', { hv: 'b' })] })[0].blobs[7], 'b');
