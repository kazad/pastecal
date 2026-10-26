// The admin archive action (CalendarRoom.archiveTestCalendar), against `wrangler dev --persist-to $PERSIST`.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:8787', SECRET = process.env.IMPORT_SECRET || 'dev-secret', PERSIST = process.env.PERSIST;
let n = 0; const step = (s) => console.log(`  ok ${++n} - ${s}`);
const at = (d) => new Date(Date.UTC(2026, 10, d, 9)).toISOString();
const create = (id) => fetch(`${BASE}/cal/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify({ title: 'T', events: [{ id: 'a', title: 'Standup', start: at(2), end: at(2).replace('T09', 'T10') }] }) });
const archive = (id, auth = true) => fetch(`${BASE}/cal/${encodeURIComponent(id)}/archive`, { method: 'POST', headers: auth ? { Authorization: `Bearer ${SECRET}` } : {} });
function r2(key) {
    const f = `/tmp/archive-test-${process.pid}.json`; rmSync(f, { force: true });
    try { execFileSync(process.execPath, ['node_modules/.bin/wrangler', 'r2', 'object', 'get', `pastecal-backups/${key}`, '--local', '--persist-to', PERSIST, '--file', f], { stdio: 'pipe' }); return JSON.parse(readFileSync(f, 'utf8')); }
    catch { return null; }
}

const t = `test-arch-${Date.now()}-42`, real = `realcal${Date.now()}`;
assert.equal((await create(t)).status, 201); assert.equal((await create(real)).status, 201);

assert.equal((await archive(t, false)).status, 403);
step('archive without the secret is refused');

const rr = await (await archive(real)).json();
assert.equal(rr.ok, false); assert.equal((await fetch(`${BASE}/cal/${real}`)).status, 200);
step('a calendar whose name does not start with "test" is refused, and stays');

const before = (await (await fetch(`${BASE}/cal/${t}`)).json()).calendar;
const r = await (await archive(t)).json();
assert.equal(r.ok, true, JSON.stringify(r));
const saved = r2(`archive/test-calendars/${encodeURIComponent(t)}.json`);
assert.ok(saved, 'no archive object'); assert.deepEqual(saved.calendar, before);
step('the archive copy in R2 equals the calendar as it was');

assert.equal((await fetch(`${BASE}/cal/${t}`)).status, 404);
const lk = await (await fetch(`${BASE}/api/lookup?slug=${t}`)).json();
assert.equal(lk.found, false);
step('afterwards the calendar answers 404 and its name is no longer in the directory');

assert.equal((await (await archive(t)).json()).missing, true);
step('archiving again is a harmless no-op');
console.log(`\n${n} checks passed`); process.exit(0);
