// RED TEAM #2 -- View-link leakage.
// A view-only link holder must never learn the calendar's EDIT id (knowing it is full edit access
// on an unlocked calendar). Probe every public surface reachable from a view slug and assert the
// edit id never appears: the view JSON, the view socket snapshot + pushed changes, the view ICS
// feed, /api/lookup, /lookupCalendar, and error messages. Also verifies publicViewId is stripped
// from the view's options so a viewer can't reconstruct the link graph.
import { BASE, enc, auth, create, getCal, tab, ev, uid, randomIp, sleep, step, finding, done, assert } from './_h.mjs';

// Give the edit id a distinctive marker so any leak is unmistakable in a blob of text.
const EDIT = uid('secret-editid') + '-ZZmarker';
assert.equal((await create(EDIT, { title: 'Private edit name', events: [ev('e1', 'lunch', 1)] })).status, 201);

// Make a read-only link for it.
const mk = await fetch(`${BASE}/api/create-view`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': randomIp() }, body: JSON.stringify({ sourceCalendarId: EDIT }) });
const mkBody = await mk.text();
assert.equal(mk.status, 200, mkBody);
const VIEW = JSON.parse(mkBody).publicViewId;
assert.ok(VIEW && VIEW !== EDIT, `view id ${VIEW} distinct from edit id`);
step(`edit id ${EDIT} has view link ${VIEW}`);

const leaks = [];
const scan = (what, text) => { if (typeof text === 'string' && text.includes(EDIT)) leaks.push(what); };

// 1. The view JSON (GET /cal/view/<viewId>).
const vjson = await (await fetch(`${BASE}/cal/view/${enc(VIEW)}`)).text();
scan('GET /cal/view/<id>', vjson);
const vobj = JSON.parse(vjson);
assert.equal(vobj.calendar.id, VIEW, 'view JSON reports the view id as the calendar id');
assert.equal(vobj.calendar.options?.publicViewId, undefined, 'publicViewId stripped from the view JSON');
step('GET /cal/view reports id=viewId and drops publicViewId');

// 2. The view socket: snapshot + a live change pushed while a viewer is connected.
const viewer = tab(VIEW, { path: '/cal/view/', sub: '' });   // /cal/view/<id> upgrade (no /ws suffix for views)
const vsnap = await viewer.ready;
assert.equal(vsnap.calendar.id, VIEW);
assert.equal(vsnap.canEdit, false, 'the view socket cannot edit');
// Writing a save over the view socket is refused.
const w = await viewer.save([{ type: 'add', event: ev('hack', 'x', 2) }]).catch((e) => ({ err: e.message }));
assert.ok(w.code === 'read_only' || w.err, `view socket save refused (${JSON.stringify(w)})`);
// An editor edits the real calendar; the viewer receives the change -- must carry no edit id.
const editor = tab(EDIT); await editor.ready;
assert.equal((await editor.save([{ type: 'add', event: ev('e2', 'dinner', 2) }])).t, 'ack');
await viewer.waitFor((m) => m.t === 'change');
for (const m of viewer.got) scan('view socket message', JSON.stringify(m));
editor.close(); viewer.close();
step('the view socket: read-only, receives live changes, and no message carries the edit id');

// 3. The view ICS feed.
const ics = await (await fetch(`${BASE}/view/${enc(VIEW)}.ics`)).text();
scan('view ICS body', ics);
assert.match(ics, /BEGIN:VCALENDAR/, 'view ICS is a real feed');
// The Content-Disposition names the view slug, not the edit id.
const icsRes = await fetch(`${BASE}/view/${enc(VIEW)}.ics`);
scan('view ICS Content-Disposition', icsRes.headers.get('content-disposition') || '');
step('the view ICS feed and its headers do not contain the edit id');

// 4. Lookups must not resolve a view slug back to the edit id (publicLookup strips targetId).
const lk = await (await fetch(`${BASE}/api/lookup?slug=${enc(VIEW)}`)).json();
scan('/api/lookup', JSON.stringify(lk));
assert.equal(lk.isReadOnly, true);
assert.equal(lk.targetId, undefined, '/api/lookup must not expose targetId for a read-only slug');
const lc = await (await fetch(`${BASE}/lookupCalendar`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: { slug: VIEW } }) })).json();
scan('/lookupCalendar', JSON.stringify(lc));
assert.equal(lc.data.targetId, undefined, '/lookupCalendar must not expose targetId');
step('/api/lookup and /lookupCalendar for a view slug never return the edit id (targetId)');

// 5. Error messages: a bad view slug, and probing the edit-only endpoints with the view id.
const probes = [
    ['view 404', `${BASE}/cal/view/${enc(VIEW)}x`],
    ['history via viewId', `${BASE}/cal/${enc(VIEW)}/history`],
    ['authors via viewId', `${BASE}/cal/${enc(VIEW)}`],
];
for (const [what, u] of probes) scan(what, await (await fetch(u)).text());
// The edit-name history of the view id (a calendar literally named like the view slug) does not exist
// and must not fall through to the source calendar's history.
const vh = await (await fetch(`${BASE}/cal/${enc(VIEW)}`)).json();
assert.notEqual(vh?.calendar?.id, EDIT, 'GET /cal/<viewId> (as an edit name) does not serve the source calendar');
step('error paths and edit-name probes with the view id never surface the source edit id');

if (leaks.length) finding('CRITICAL', `edit id leaked via: ${[...new Set(leaks)].join(', ')}`);
else step('NO EDIT-ID LEAK on any probed surface');

done('view-leak');
