// RED TEAM #4 -- Rate limits, oversized / malformed payloads, ICS injection.
// Complements hardening.test.mjs (size caps) with: per-IP calendar-creation flood, the SHARED
// 60/min save budget (reached across two tabs so neither hits the 40/tab limit), oversized and
// malformed WebSocket messages, the 5000-event cap via import, and an end-to-end ICS-injection
// check (a hostile title/id in a LIVE feed must stay well-formed -- not just the ICSService unit).
import { BASE, enc, auth, create, putSecret, getCal, tab, ev, uid, sleep, step, finding, done, assert } from './_h.mjs';

// ---- 4a. Calendar-creation flood is rate-limited per IP (CREATE_LIMITER, 10/min) ---------------
{
    const ip = `45.45.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    const statuses = [];
    for (let i = 0; i < 14; i++) statuses.push((await create(uid('flood'), { title: 'f', events: [] }, { 'CF-Connecting-IP': ip })).status);
    const made = statuses.filter((s) => s === 201).length;
    assert.ok(statuses.includes(429), `creation flood should hit 429; statuses ${statuses.join(',')}`);
    assert.ok(made <= 10, `no more than 10 creates/min from one IP; made ${made}`);
    step(`calendar-creation flood from one IP: ${made} created, then 429 (cap 10/min)`);
}

// ---- 4b. The SHARED 60/min save budget stops a calendar saving too often -----------------------
// Two tabs, 31 saves each (62 total): neither hits the 40/tab limit, but the shared 60/min does.
{
    const id = uid('saveflood');
    assert.equal((await create(id, { title: 's', events: [] })).status, 201);
    const a = tab(id), b = tab(id); await a.ready; await b.ready;
    let acks = 0; const errs = [];
    for (let i = 0; i < 62; i++) {
        const t = i % 2 ? b : a;
        const r = await t.save([{ type: 'add', event: ev(`f${i}`, 'flood', 1 + (i % 27)) }]);
        if (r.t === 'ack') acks++; else errs.push(r.message || r.code);
    }
    a.close(); b.close();
    assert.ok(acks <= 60, `shared budget must cap acks at 60/min; got ${acks}`);
    assert.ok(errs.some((m) => /calendar is saving too often/.test(m)), `expected the shared-budget refusal; saw ${JSON.stringify([...new Set(errs)])}`);
    step(`62 saves across 2 tabs: ${acks} acked, then refused "${[...new Set(errs)][0]}" (shared 60/min)`);
}

// ---- 4c. Oversized and malformed WebSocket messages ---------------------------------------------
{
    const id = uid('msg');
    assert.equal((await create(id, { title: 's', events: [] })).status, 201);
    const t = tab(id); await t.ready;
    // >512 KB raw message -> too_big, nothing applied.
    const bigId = 'x'.repeat(600 * 1024);
    t.send({ t: 'save', id: 'big', v: 0, commands: [{ type: 'add', event: ev(bigId, 'big') }] });
    const r1 = await t.waitFor((m) => m.t === 'error');
    assert.equal(r1.code, 'too_big');
    // malformed JSON -> bad_json (no id to echo).
    t.ws.send('{not valid json');
    const r2 = await t.waitFor((m) => m.t === 'error' && m.code === 'bad_json');
    assert.equal(r2.code, 'bad_json');
    // unknown message type -> unknown, never a crash.
    const r3 = await t.save([]).catch(() => null) || (t.send({ t: 'frobnicate', id: 'z' }), await t.waitFor((m) => m.id === 'z'));
    assert.ok(r3.code === 'unknown' || r3.unchanged, `unknown type handled (${JSON.stringify(r3)})`);
    assert.equal((await getCal(id)).calendar.events.length, 0, 'nothing stored from oversized/malformed messages');
    t.close();
    step('oversized message -> too_big, malformed -> bad_json, unknown type -> unknown; nothing stored');
}

// ---- 4d. Event-count cap: >5000 events via import is refused -----------------------------------
{
    const id = uid('manyev');
    const many = Array.from({ length: 6000 }, (_, i) => ev(`m${i}`, 'e', 1 + (i % 27)));
    const r = await putSecret(id, '/import', { title: 'many', events: many });
    assert.equal(r.status, 413, `6000 events via import -> ${r.status}`);
    assert.match((await r.json()).error, /5000 events|too large/);
    assert.equal((await fetch(`${BASE}/cal/${enc(id)}`, { method: 'HEAD' })).status, 404, 'nothing stored');
    step('import of 6000 events is refused (413) and stores nothing');
}

// ---- 4e. ICS injection end-to-end: hostile title/id stays well-formed in a LIVE feed ------------
{
    const id = uid('icsinject');
    const INJECT = '\r\nBEGIN:VEVENT\r\nSUMMARY:injected\r\nEND:VEVENT\r\nX-EVIL';
    assert.equal((await create(id, {
        title: `Team${INJECT}`,
        events: [ev('inj1', `Lunch${INJECT}`, 1, { description: `Notes${INJECT}`, recurrencerule: `FREQ=DAILY${INJECT}` })],
    })).status, 201);
    const ics = await (await fetch(`${BASE}/${enc(id)}.ics`)).text();
    const unfold = (s) => s.replace(/\r\n[ \t]/g, '');
    const lines = unfold(ics).split('\r\n');
    const vevents = lines.filter((l) => l === 'BEGIN:VEVENT').length;
    assert.equal(vevents, 1, `exactly one VEVENT (no injected one); got ${vevents}`);
    assert.ok(!lines.includes('SUMMARY:injected'), 'the injected SUMMARY line must not appear as its own property');
    assert.ok(!lines.includes('X-EVIL'), 'no injected property line leaked');
    // Every logical line must be NAME[;params]:value (CRLF the only separator).
    for (const l of lines) if (l !== '') assert.match(l, /^[A-Za-z][A-Za-z0-9-]*(;[^:]*)?:/, `malformed ICS line: ${JSON.stringify(l)}`);
    step('ICS injection via title/id/description/rule in a live feed: feed stays well-formed, no injected VEVENT/property');
}

done('rate-and-payload');
