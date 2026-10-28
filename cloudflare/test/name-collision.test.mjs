// Name collisions, against `wrangler dev` with ACCOUNTS_DEV_MODE=1 (the directory's dev-plant hook):
//   - editable always wins: no write path turns an editable calendar's directory row into a view row
//     (create-view, register from a room, bulk backfill in either order);
//   - a custom view name that is a calendar's (its own included) is refused, with reason 'calendar';
//   - the admin collision route lists a planted collision (self and cross), 403 without the secret, and
//     make-editable repairs it; the repaired calendar's own view link keeps working.
//
//   scripts/test-all.sh --only name-collision
import assert from 'node:assert/strict';

const BASE = process.env.BASE || 'http://localhost:8787';
const SECRET = process.env.IMPORT_SECRET || 'dev-secret';
let n = 0; const step = (s) => console.log(`  ok ${++n} - ${s}`);
const T = Date.now().toString(36);
const name = (p) => `nc${p}${T}${Math.floor(Math.random() * 1e4)}`;
const url = (id, sub = '') => `${BASE}/cal/${encodeURIComponent(id)}${sub}`;
const admin = { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' };
const at = (d) => new Date(Date.UTC(2026, 9, d, 9)).toISOString();
const ev = (id) => ({ id, title: id, start: at(1), end: at(1).replace('T09', 'T10'), type: 1 });
// PUT /import (not rate-limited like POST): a calendar with one event; it registers itself in the directory.
const make = async (id, options = {}) => {
    const r = await fetch(url(id, '/import'), { method: 'PUT', headers: admin, body: JSON.stringify({ id, title: id, options, events: [ev('e1')] }) });
    assert.equal(r.status, 200, `import ${id}`);
};
const lookup = async (slug) => (await fetch(`${BASE}/api/lookup?slug=${encodeURIComponent(slug)}`)).json();
const settle = async (slug, pred, ms = 4000) => {
    const t0 = Date.now(); let last;
    while (Date.now() - t0 < ms) { last = await lookup(slug); if (pred(last)) return last; await new Promise((r) => setTimeout(r, 50)); }
    return last;
};
const editable = (l) => l.found && l.isReadOnly === false;
const view = (body) => fetch(`${BASE}/api/create-view`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const plant = (row, headers = admin) => fetch(`${BASE}/api/admin/directory/dev-plant`, { method: 'POST', headers, body: JSON.stringify(row) });
const collisions = async (q, headers = admin) => fetch(`${BASE}/api/admin/directory/collisions${q}`, { headers });

// ---- 1. a custom view name that is a calendar's is refused ----------------------------------
const foo = name('foo'), bar = name('bar');
await make(foo); await make(bar);
assert.ok(editable(await settle(foo, editable)), 'foo registered as editable');
for (const [source, slug] of [[foo, foo], [foo, foo.toUpperCase()], [bar, foo]]) {
    const r = await view({ sourceCalendarId: source, customSlug: slug });
    assert.equal(r.status, 409, `view ${slug} of ${source}`);
    const out = await r.json();
    assert.equal(out.error, 'already-exists'); assert.equal(out.reason, 'calendar');
}
assert.ok(editable(await lookup(foo)), 'the directory still says foo is editable');
step('create-view refuses a name that is a calendar (its own, any case, or another), reason "calendar"; foo stays editable');

let r;

// ---- 2. register: a room whose view id is its own name never turns its row into a view ------
const selfish = name('selfish');
await make(selfish, { publicViewId: selfish });
await new Promise((res) => setTimeout(res, 500));
assert.ok(editable(await settle(selfish, editable)), 'a calendar whose view id is its own name stays editable');
await make(selfish, { publicViewId: selfish, note: 'again' });   // a second import registers again
await new Promise((res) => setTimeout(res, 500));
assert.ok(editable(await lookup(selfish)), 'still editable after a re-import');
step('import (register) of a calendar whose view id is its own name leaves the row editable');

// ---- 3. bulk backfill: editable wins, in either order -----------------------------------------
r = await fetch(`${BASE}/api/directory/backfill`, { method: 'POST', headers: admin, body: JSON.stringify([{ actualSlug: foo, isReadOnly: true, targetId: bar }]) });
let out = await r.json();
assert.equal(r.status, 200); assert.deepEqual(out.skipped, [foo]);
assert.ok(editable(await lookup(foo)), 'backfill did not replace foo');
const ab = name('ab'), ba = name('ba');
r = await fetch(`${BASE}/api/directory/backfill`, { method: 'POST', headers: admin, body: JSON.stringify([
    { actualSlug: ab, isReadOnly: false, targetId: ab }, { actualSlug: ab, isReadOnly: true, targetId: bar },   // editable, then view
    { actualSlug: ba, isReadOnly: true, targetId: bar }, { actualSlug: ba, isReadOnly: false, targetId: ba },   // view, then editable
]) });
out = await r.json();
assert.deepEqual(out.skipped, [ab]);
assert.ok(editable(await lookup(ab)), 'editable then view: editable');
assert.ok(editable(await lookup(ba)), 'view then editable: editable');
r = await fetch(`${BASE}/api/directory/backfill`, { method: 'POST', body: '[]' });
assert.equal(r.status, 403);
step('backfill never replaces an editable row with a view (either order in one batch; skipped names reported)');

// ---- 4. the collision route lists planted collisions, and the repair fixes them --------------
const self = name('self'), crossA = name('crossa'), crossB = name('crossb');
await make(self, { publicViewId: self });
await make(crossA); await make(crossB);
await settle(self, editable); await settle(crossB, editable);
assert.equal((await plant({ actualSlug: self, isReadOnly: true, targetId: self }, { 'Content-Type': 'application/json' })).status, 403);
assert.equal((await plant({ actualSlug: self, isReadOnly: true, targetId: self })).status, 200);       // the July 2025 shape
assert.equal((await plant({ actualSlug: crossB, isReadOnly: true, targetId: crossA })).status, 200);   // a view named like another calendar
assert.equal((await lookup(self)).isReadOnly, true, 'planted: the directory says self is a view');

assert.equal((await collisions('?scope=self', {})).status, 403);
assert.equal((await collisions('', { Authorization: 'Bearer wrong' })).status, 403);
let found = (await (await collisions('?scope=self')).json()).collisions;
assert.ok(found.some((c) => c.name === self && c.kind === 'self' && c.calendarId === self), 'scope=self lists the self collision');
assert.ok(!found.some((c) => c.name === crossB), 'scope=self does not list the cross one');
assert.ok(!found.some((c) => c.name === name('none')), 'nothing else');

// The full scan, a few rows a page.
const all = []; let after = '', pages = 0;
do {
    const page = await (await collisions(`?limit=3&after=${encodeURIComponent(after)}`)).json();
    all.push(...page.collisions); after = page.next; pages++;
} while (after && pages < 500);
assert.ok(pages > 1, 'paginated');
assert.ok(all.some((c) => c.name === self && c.kind === 'self'), 'full scan: self');
assert.ok(all.some((c) => c.name === crossB && c.kind === 'cross' && c.calendarId === crossB && c.row.target_id === crossA), 'full scan: cross');
assert.ok(!all.some((c) => c.name === foo || c.name === bar), 'editable rows are not collisions');
step('the collision route lists planted self and cross collisions (scope=self: SQL; full scan paginated); 403 without the secret');

// /view/<self> works while planted (the view row), and after the repair (its own view id).
assert.equal((await fetch(`${BASE}/cal/view/${self}`)).status, 200);
const repair = (body, headers = admin) => fetch(`${BASE}/api/admin/directory/make-editable`, { method: 'POST', headers, body: JSON.stringify(body) });
assert.equal((await repair({ name: self, calendarId: self }, { 'Content-Type': 'application/json' })).status, 403);
assert.equal((await repair({ name: name('ghost'), calendarId: name('ghost') })).status, 404, 'no such calendar');
assert.equal((await repair({ name: self, calendarId: crossA })).status, 400, 'calendarId must be this name');
r = await repair({ name: self, calendarId: self });
out = await r.json();
assert.equal(r.status, 200); assert.equal(out.ok, true);
assert.equal(out.before.is_readonly, 1); assert.equal(out.after.is_readonly, 0); assert.equal(out.after.target_id, self);
assert.ok(editable(await lookup(self)), 'repaired: editable');
assert.equal((await fetch(`${BASE}/cal/view/${self}`)).status, 200, 'its view link still opens (its own view id)');
const vcal = (await (await fetch(`${BASE}/cal/view/${self}`)).json()).calendar;
assert.equal(vcal.id, self); assert.equal(vcal.options.publicViewId, undefined, 'served as a view');
assert.equal((await fetch(`${BASE}/cal/view/${foo}`)).status, 404, 'an edit name that is not its view id is no view link');
r = await repair({ name: self, calendarId: self });
assert.equal(r.status, 409, 'already editable: nothing to repair');
found = (await (await collisions('?scope=self')).json()).collisions;
assert.ok(!found.some((c) => c.name === self), 'gone from the list');
// The room re-registering (an import) keeps it editable.
await make(self, { publicViewId: self, note: 'after repair' });
await new Promise((res) => setTimeout(res, 500));
assert.ok(editable(await lookup(self)), 'still editable after the room registers again');
step('make-editable repairs it (403 without the secret, 404 no calendar, 409 when not a view); /view/<name> keeps working');

r = await repair({ name: crossB, calendarId: crossB });
assert.equal(r.status, 200);
assert.ok(editable(await lookup(crossB)), 'cross repaired: the calendar of that name has it');
assert.equal((await fetch(`${BASE}/cal/view/${crossB}`)).status, 404, 'and the other calendar\'s view link under that name ends (why the script asks)');
step('a cross collision can be repaired too (the other calendar\'s view link under that name then ends)');

console.log(`${n} checks passed`);
