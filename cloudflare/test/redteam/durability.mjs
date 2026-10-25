// RED TEAM #7 -- Durability across a wrangler restart (data loss / crash recovery).
// Durable Object state is SQLite persisted to --persist-to, so a kill/restart mid-session must lose
// no ACKED write, must keep the version, and must keep the history (so undo still works after the
// clients reconnect). Two phases, orchestrated by the harness (see the companion bash in the report):
//   PHASE=save   STATEFILE=<path>  -> create a calendar, save events, record acked ids + version
//   PHASE=verify STATEFILE=<path>  -> (after the server was killed and restarted) assert all acked
//                                     writes are present, version preserved, history intact (undo).
import { readFileSync, writeFileSync } from 'node:fs';
import { BASE, enc, create, getCal, tab, ev, uid, sleep, step, finding, done, assert } from './_h.mjs';

const PHASE = process.env.PHASE || 'save';
const STATEFILE = process.env.STATEFILE || '/tmp/pc-redteam-durability.json';

if (PHASE === 'save') {
    const id = uid('durable');
    assert.equal((await create(id, { title: 'Durable', events: [] })).status, 201);
    const t = tab(id); await t.ready;
    const acked = [];
    for (let i = 0; i < 15; i++) {
        const r = await t.save([{ type: 'add', event: ev(`d${i}`, `durable event ${i}`, 1 + i) }]);
        if (r.t === 'ack' && !r.unchanged) acked.push({ id: `d${i}`, v: r.v });
    }
    // Also an edit + a remove, so history has varied kinds to undo.
    await t.save([{ type: 'update', key: 'd0', changes: { title: 'edited before crash' } }]);
    const beforeV = (await getCal(id)).v;
    t.close();
    writeFileSync(STATEFILE, JSON.stringify({ id, acked, beforeV }));
    step(`PHASE save: ${acked.length} acked events on ${id}, version ${beforeV}; recorded to ${STATEFILE}`);
    console.log(`\nSTATE: id=${id} acked=${acked.length} v=${beforeV}`);
    done('durability(save)');
} else {
    const { id, acked, beforeV } = JSON.parse(readFileSync(STATEFILE, 'utf8'));
    // A fresh client reconnects after the restart.
    const server = await getCal(id);
    assert.ok(server && server.calendar && server.calendar.id === id, 'calendar survived the restart');
    const present = new Set(server.calendar.events.map((e) => e.id));
    const missing = acked.filter((a) => !present.has(a.id)).map((a) => a.id);
    assert.deepEqual(missing, [], `no acked write lost across restart; missing ${missing}`);
    assert.ok(server.v >= beforeV, `version preserved/monotonic across restart (was ${beforeV}, now ${server.v})`);
    // The edit survived too.
    const d0 = server.calendar.events.find((e) => e.id === 'd0');
    assert.equal(d0.title, 'edited before crash', 'the pre-crash edit survived');
    // History survives, so undo still works after reconnect.
    const hist = await (await fetch(`${BASE}/cal/${enc(id)}/history`)).json();
    assert.ok(Array.isArray(hist) && hist.length > 0, 'history survived the restart (undo available)');
    // A reconnecting socket gets the full snapshot and can keep editing.
    const t = tab(id); const snap = await t.ready;
    assert.equal(snap.v, server.v, 'reconnecting socket sees the preserved version');
    const r = await t.save([{ type: 'add', event: ev('after-restart', 'added after restart', 28) }]);
    assert.equal(r.t, 'ack', 'editing works after the restart');
    t.close();
    step(`PHASE verify: all ${acked.length} acked writes survived, v ${beforeV}->${server.v}, ${hist.length} history rows, edits resume`);
    done('durability(verify)');
}
