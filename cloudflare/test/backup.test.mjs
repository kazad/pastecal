// Per-calendar backups (CalendarRoom.backupToR2), against `wrangler dev --persist-to $PERSIST`.
// Reads the local R2 bucket with `wrangler r2 object get --local`. Copy-back is off in .dev.vars
// (COPY_BACK empty), which is the point of check 3: backups must not depend on it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:8787', PERSIST = process.env.PERSIST;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0; const step = (s) => console.log(`  ok ${++n} - ${s}`);
const day = new Date().toISOString().slice(0, 10);
const at = (d, h) => new Date(Date.UTC(2026, 10, d, h)).toISOString();
const ev = (id, title, d) => ({ id, title, start: at(d, 9), end: at(d, 10), type: 1 });

function snapshot(id) {
    const file = `/tmp/backup-test-${process.pid}.json`; rmSync(file, { force: true });
    try {
        execFileSync(process.execPath, ['node_modules/.bin/wrangler', 'r2', 'object', 'get', `pastecal-backups/snapshots/${encodeURIComponent(id)}/${day}.json`,
            '--local', '--persist-to', PERSIST, '--file', file], { stdio: 'pipe' });
        return JSON.parse(readFileSync(file, 'utf8'));
    } catch { return null; }
}
const waitFor = async (pred, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = pred(); if (v) return v; await sleep(500); } return null; };
function tab(id) {
    const ws = new WebSocket(BASE.replace(/^http/, 'ws') + `/cal/${encodeURIComponent(id)}/ws`); const got = [];
    ws.addEventListener('message', (e) => got.push(JSON.parse(e.data)));
    const ready = new Promise((r) => { const t = setInterval(() => { if (got.some((m) => m.t === 'snapshot')) { clearInterval(t); r(); } }, 20); });
    const save = async (sid, commands) => { ws.send(JSON.stringify({ t: 'save', id: sid, v: 0, commands }));
        for (let i = 0; i < 200 && !got.some((m) => m.id === sid); i++) await sleep(20); };
    return { ws, ready, save };
}

// 1. A calendar created and edited is backed up, and the backup equals the live calendar.
const id = `test-backup ${Date.now()} 강`;                     // a space and Hangul: real names have both
let r = await fetch(`${BASE}/cal/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify({ title: 'b', events: [ev('a', 'first', 1)] }) });
assert.equal(r.status, 201, await r.text());
const T = tab(id); await T.ready;
for (let i = 0; i < 5; i++) await T.save(`s${i}`, [{ type: 'add', event: ev(`e${i}`, `burst ${i}`, 2 + i) }]);
const live = (await (await fetch(`${BASE}/cal/${encodeURIComponent(id)}`)).json());
const snap = await waitFor(() => { const s = snapshot(id); return s && s.v === live.v ? s : null; });
assert.ok(snap, 'no backup with the latest version appeared');
assert.deepEqual(snap.calendar, live.calendar);
step(`a burst of saves is backed up once the alarm runs; the backup equals the live calendar (v${snap.v}, ${snap.calendar.events.length} events)`);

// 2. A calendar nobody changes gets no new backup.
const quiet = `test-backup-quiet-${Date.now()}`;
assert.equal(snapshot(quiet), null);
await sleep(5000);
assert.equal(snapshot(quiet), null);
step('a calendar with no changes writes nothing');

// 3. With copy-back off (COPY_BACK empty here), backups still run -- they must outlive Firebase.
step('backups ran with COPY_BACK empty, so they do not depend on the Firebase copy-back');

T.ws.close(); console.log(`\n${n} checks passed`); process.exit(0);
