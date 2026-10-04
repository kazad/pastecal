// Phase 3 comprehensive verification test suite against wrangler dev.
// Tests: Name directory, View-only links without id leaks, RFC 5545 ICS generation + 304 caching,
// History table with deltas, and Author signal continuity.
import assert from 'node:assert/strict';

const BASE = process.env.BASE || 'http://localhost:8787';
const WS_BASE = BASE.replace(/^http/, 'ws');
const SECRET = process.env.IMPORT_SECRET || 'dev-secret';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const at = (d, h) => new Date(Date.UTC(2026, 9, d, h)).toISOString();
let n = 0;
const step = (s) => console.log(`  ok ${++n} - ${s}`);

function wsTab(url) {
    const ws = new WebSocket(url);
    const got = [];
    ws.addEventListener('message', (ev) => got.push(JSON.parse(ev.data)));
    const waitFor = (pred, ms = 4000) => new Promise((resolve, reject) => {
        const start = Date.now();
        const poll = () => {
            const hit = got.find(pred);
            if (hit) return resolve(hit);
            if (Date.now() - start > ms) return reject(new Error('timed out waiting for message'));
            setTimeout(poll, 20);
        };
        poll();
    });
    return {
        ws,
        got,
        waitFor,
        ready: waitFor((m) => m.t === 'snapshot'),
        send: (m) => ws.send(JSON.stringify(m)),
        close: () => ws.close()
    };
}

console.log('Running Phase 3 tests...');

// -----------------------------------------------------------------------------
// 1. Directory & Case-Insensitive Lookup
// -----------------------------------------------------------------------------
const calId = `TestTeam_${Date.now()}`;
const createRes = await fetch(`${BASE}/cal/${encodeURIComponent(calId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        title: 'Team Alpha',
        options: { notes: 'private team notes' },
        events: [{ id: 'evt-1', title: 'Kickoff', start: at(5, 10), end: at(5, 11), type: 1 }]
    })
});
assert.equal(createRes.status, 201, 'Calendar created');
step('created calendar with mixed-case ID');

// Wait brief moment for background directory registration
await sleep(100);

// Lookup via exact case
let lookupRes = await (await fetch(`${BASE}/api/lookup?slug=${encodeURIComponent(calId)}`)).json();
assert.equal(lookupRes.found, true);
assert.equal(lookupRes.actualSlug, calId);
assert.equal(lookupRes.isReadOnly, false);
step('exact-case lookup via GET /api/lookup succeeds');

// Lookup via lowercase
const lowerSlug = calId.toLowerCase();
lookupRes = await (await fetch(`${BASE}/api/lookup?slug=${encodeURIComponent(lowerSlug)}`)).json();
assert.equal(lookupRes.found, true);
assert.equal(lookupRes.actualSlug, calId);
step('case-insensitive lookup resolves to stored casing');

// Callable POST /lookupCalendar compatibility
const callableRes = await (await fetch(`${BASE}/lookupCalendar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { slug: lowerSlug } })
})).json();
assert.equal(callableRes.data?.found, true);
assert.equal(callableRes.data?.actualSlug, calId);
step('callable POST /lookupCalendar returns expected envelope');

// -----------------------------------------------------------------------------
// 2. Public View-Only Link & Leak Prevention
// -----------------------------------------------------------------------------
// Create a view with custom slug
const viewSlug = `custom-view-${Date.now()}`;
const createViewRes = await (await fetch(`${BASE}/api/create-view`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceCalendarId: calId, customSlug: viewSlug })
})).json();
assert.equal(createViewRes.ok, true);
assert.equal(createViewRes.publicViewId, viewSlug);
step('POST /api/create-view creates public view mapping');

// Lookup the view slug
const viewLookup = await (await fetch(`${BASE}/api/lookup?slug=${encodeURIComponent(viewSlug)}`)).json();
assert.equal(viewLookup.found, true);
assert.equal(viewLookup.isReadOnly, true);
assert.equal(viewLookup.targetId, calId);
step('directory lookup on view slug returns isReadOnly: true and points to targetId');

// Connect to view-only WebSocket
const viewTab = wsTab(`${WS_BASE}/cal/view/${encodeURIComponent(viewSlug)}/ws`);
const viewSnap = await viewTab.ready;
assert.equal(viewSnap.t, 'snapshot');
// CRITICAL PRIVACY CHECK: View must NOT leak the underlying editable calendar id!
assert.equal(viewSnap.calendar.id, viewSlug, 'view snapshot id must equal viewSlug');
assert.notEqual(viewSnap.calendar.id, calId, 'view snapshot MUST NOT leak source calendar id');
assert.equal(viewSnap.calendar.options.publicViewId, undefined, 'view snapshot must not leak publicViewId');
step('view-only WebSocket snapshot masks calendar id and sanitizes options');

// Attempting to edit via view-only socket must be refused
viewTab.send({
    t: 'save',
    id: 'view-hack-1',
    v: viewSnap.v,
    commands: [{ type: 'add', event: { id: 'bad-1', title: 'Hacked', start: at(5, 12), end: at(5, 13), type: 1 } }]
});
const viewErr = await viewTab.waitFor((m) => m.t === 'error' && m.id === 'view-hack-1');
assert.equal(viewErr.code, 'read_only');
step('writes on view-only WebSocket are rejected with code: read_only');
viewTab.close();

// -----------------------------------------------------------------------------
// 3. RFC 5545 ICS Feeds & ETag 304 Caching
// -----------------------------------------------------------------------------
// GET /:slug.ics
const icsRes = await fetch(`${BASE}/${encodeURIComponent(calId)}.ics`);
assert.equal(icsRes.status, 200);
assert.match(icsRes.headers.get('content-type'), /text\/calendar/i);
const etag = icsRes.headers.get('etag');
assert.ok(etag, 'ETag header is present');
const icsText = await icsRes.text();
assert.match(icsText, /^BEGIN:VCALENDAR/m);
assert.match(icsText, /SUMMARY:Kickoff/m);
assert.match(icsText, /END:VCALENDAR$/m);
step('GET /:slug.ics returns valid RFC 5545 iCalendar data');

// Case-insensitive ICS lookup
const lowerIcsRes = await fetch(`${BASE}/${encodeURIComponent(lowerSlug)}.ics`);
assert.equal(lowerIcsRes.status, 200);
assert.equal(lowerIcsRes.headers.get('etag'), etag);
step('ICS request on lowercased slug resolves and returns matching ETag');

// ETag 304 Not Modified
const cachedIcsRes = await fetch(`${BASE}/${encodeURIComponent(calId)}.ics`, {
    headers: { 'If-None-Match': etag }
});
assert.equal(cachedIcsRes.status, 304, 'ETag match yields 304 Not Modified');
step('ICS feed supports 304 Not Modified when ETag matches');

// View ICS: GET /view/:viewId.ics
const viewIcsRes = await fetch(`${BASE}/view/${encodeURIComponent(viewSlug)}.ics`);
assert.equal(viewIcsRes.status, 200);
const viewIcsText = await viewIcsRes.text();
assert.match(viewIcsText, /SUMMARY:Kickoff/m);
step('GET /view/:viewId.ics generates feed for public view');

// -----------------------------------------------------------------------------
// 4. History Table, Deltas, & Author Signal
// -----------------------------------------------------------------------------
const authorUid = 'browser-uid-xyz123';
const editTab = wsTab(`${WS_BASE}/cal/${encodeURIComponent(calId)}/ws?author=${authorUid}`);
const editSnap = await editTab.ready;

// Perform an edit (updating title of Kickoff)
editTab.send({
    t: 'save',
    id: 'edit-1',
    v: editSnap.v,
    commands: [{
        type: 'update',
        key: { id: 'evt-1' },
        changes: { title: 'Kickoff (Rescheduled)', start: at(5, 14), end: at(5, 15) }
    }]
});
const ackEdit = await editTab.waitFor((m) => m.t === 'ack' && m.id === 'edit-1');
assert.ok(ackEdit);
step('applied edit to calendar');

// Check GET /cal/<id>/history
const historyRes = await (await fetch(`${BASE}/cal/${encodeURIComponent(calId)}/history`)).json();
assert.ok(Array.isArray(historyRes), 'History returns an array');
assert.ok(historyRes.length >= 1, 'History has entries');
const latest = historyRes[0];
assert.equal(latest.kind, 'edited');
assert.equal(latest.changed, 1);
assert.equal(latest.changedEvents?.length, 1);
assert.equal(latest.changedEvents[0].from.title, 'Kickoff');
assert.equal(latest.changedEvents[0].to.title, 'Kickoff (Rescheduled)');
step('history table records structured delta with from/to');

// Check author tracking: GET /cal/<id>/authors
const authorsRes = await (await fetch(`${BASE}/cal/${encodeURIComponent(calId)}/authors`)).json();
assert.ok(Array.isArray(authorsRes), 'Authors returns an array');
const authorEntry = authorsRes.find((a) => a.uid === authorUid);
assert.ok(authorEntry, 'Author uid is recorded');
assert.ok(authorEntry.editCount >= 1, 'Edit count incremented');
assert.ok(authorEntry.days?.length >= 1, 'Days array recorded');
step('author signal continuity tracked in authors table');

editTab.close();
console.log('All Phase 3 tests passed successfully!\n');
