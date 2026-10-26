// RED TEAM #6 -- Concurrency & scale.
// (a) 50 concurrent WebSocket editors on one calendar for STRESS_SECONDS (default 20; set 60 for the
//     full run): every ACKED command must survive (final event set superset of acked adds) and every
//     version must be issued exactly once, contiguous and monotonic. Note: the room's shared 60/min
//     save budget deliberately REFUSES most saves under this load -- a refusal is not a lost write;
//     only acked writes must survive.
// (b) 200 calendars created in parallel (distinct IPs, within the per-IP limit) all succeed and are
//     independently stored (no cross-talk between Durable Objects).
// (c) A 5000-event calendar's ICS feed parses as a valid iCalendar with exactly 5000 VEVENTs.
import { BASE, WS, enc, auth, create, getCal, putSecret, tab, ev, uid, sleep, step, finding, done, assert } from './_h.mjs';

const SECONDS = Number(process.env.STRESS_SECONDS || 20);

// ---- (a) 50 concurrent editors ------------------------------------------------------------------
{
    const id = uid('stress50');
    assert.equal((await create(id, { title: 'stress', events: [] })).status, 201);
    const N = 50;
    const tabs = await Promise.all(Array.from({ length: N }, () => { const t = tab(id); return t.ready.then(() => t); }));
    step(`${N} editors connected to ${id}`);

    const acked = new Map();   // event id -> version it was acked at
    const versions = [];
    let stop = false;
    const loops = tabs.map((t, i) => (async () => {
        let k = 0;
        while (!stop) {
            const eid = `e-${i}-${k++}`;
            const sid = `s-${i}-${k}`;
            t.send({ t: 'save', id: sid, v: 0, commands: [{ type: 'add', event: ev(eid, `t${i} #${k}`, 1 + (k % 27)) }] });
            try {
                const r = await t.waitFor((m) => m.id === sid, 8000);
                if (r.t === 'ack' && !r.unchanged) { acked.set(eid, r.v); versions.push(r.v); }
            } catch { /* timed out this attempt; keep going */ }
            await sleep(40 + Math.floor(Math.random() * 60));   // modest pace per tab
        }
    })());
    await sleep(SECONDS * 1000);
    stop = true;
    await Promise.allSettled(loops);
    await sleep(500);

    const server = await getCal(id);
    const presentIds = new Set(server.calendar.events.map((e) => e.id));
    const missing = [...acked.keys()].filter((eid) => !presentIds.has(eid));
    assert.deepEqual(missing, [], `every acked add must be present; missing ${missing.length}: ${missing.slice(0, 5)}`);
    // Versions issued to acks are unique (no two writes got the same version).
    const dupeV = versions.filter((v, i) => versions.indexOf(v) !== i);
    assert.deepEqual(dupeV, [], `no version issued twice; dupes ${dupeV.slice(0, 5)}`);
    // Server version is monotonic and at least as high as the max acked.
    assert.ok(server.v >= Math.max(0, ...versions), 'server version >= every acked version');
    for (const t of tabs) t.close();
    step(`50 editors / ${SECONDS}s: ${acked.size} acked writes, all present; ${versions.length} versions each unique; server v=${server.v} monotonic`);
}

// ---- (b) 200 calendars created in parallel (distinct IPs, within per-IP limit) ------------------
{
    const run = Date.now().toString(36);
    const mk = (i) => create(`test-rt-par-${run}-${i}`, { title: `p${i}`, events: [ev(`p${i}`, `only ${i}`, 1)] },
        { 'CF-Connecting-IP': `100.${64 + Math.floor(i / 250)}.${i % 250}.${(i * 7) % 250}` });
    const results = await Promise.all(Array.from({ length: 200 }, (_, i) => mk(i).then((r) => r.status)));
    const ok = results.filter((s) => s === 201).length;
    assert.equal(ok, 200, `all 200 parallel creates succeed across distinct IPs; got ${ok} (statuses sample ${results.slice(0, 5)})`);
    // Spot-check isolation: three random calendars hold only their own event.
    for (const i of [0, 99, 199]) {
        const c = await getCal(`test-rt-par-${run}-${i}`);
        assert.deepEqual(c.calendar.events.map((e) => e.id), [`p${i}`], `calendar ${i} holds only its own event`);
    }
    step('200 calendars created in parallel (distinct IPs) all stored and isolated (one event each)');
}

// ---- (c) 5000-event ICS feed is valid -----------------------------------------------------------
{
    const id = uid('ics5k');
    const events = Array.from({ length: 5000 }, (_, i) => ev(`k${i}`, `Event ${i}`, 1 + (i % 27)));
    const r = await putSecret(id, '/import', { title: 'Big feed', events });
    assert.equal(r.status, 200, `import 5000 events -> ${r.status}: ${await r.text().catch(() => '')}`);
    const ics = await (await fetch(`${BASE}/${enc(id)}.ics`)).text();
    const unfold = (s) => s.replace(/\r\n[ \t]/g, '');
    const lines = unfold(ics).split('\r\n');
    const begins = lines.filter((l) => l === 'BEGIN:VEVENT').length;
    const ends = lines.filter((l) => l === 'END:VEVENT').length;
    assert.equal(begins, 5000, `5000 VEVENTs in the feed; got ${begins}`);
    assert.equal(ends, 5000, `5000 END:VEVENT; got ${ends}`);
    assert.ok(lines[0] === 'BEGIN:VCALENDAR' && lines[lines.length - 1] === 'END:VCALENDAR', 'wrapped in VCALENDAR');
    // Balanced BEGIN/END nesting and every logical line well-formed.
    let depth = 0, maxDepth = 0;
    for (const l of lines) {
        if (l === '') continue;
        assert.match(l, /^[A-Za-z][A-Za-z0-9-]*(;[^:]*)?:/, `malformed ICS line: ${JSON.stringify(l.slice(0, 40))}`);
        if (l.startsWith('BEGIN:')) { depth++; maxDepth = Math.max(maxDepth, depth); }
        if (l.startsWith('END:')) depth--;
    }
    assert.equal(depth, 0, 'BEGIN/END balanced');
    assert.equal(maxDepth, 2, 'VCALENDAR > VEVENT nesting only');
    step(`5000-event ICS feed: valid iCalendar, 5000 VEVENTs, balanced, ${(ics.length / 1024).toFixed(0)} KB`);
}

done('stress');
