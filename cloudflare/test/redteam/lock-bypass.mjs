// RED TEAM #1 -- Lock bypass on a Pro-locked calendar.
// Complements cloudflare/test/lock.test.mjs with angles it does not cover: forged headers UNDER
// the dev session header, editor-key brute force + shared-budget starvation, query-param smuggling,
// case-variant data isolation, and the admin route surface. Every write that should be refused is
// asserted to change nothing (version + event set unchanged).
import { BASE, enc, auth, admin, create, getCal, putSecret, tab, ev, uid, sleep, step, finding, done, assert } from './_h.mjs';

const id = uid('lock');
const OWNER = uid('owner');

// Setup: a real calendar, one event, then lock it for OWNER (Pro). Capture the editor key.
assert.equal((await create(id, { title: 'Team', events: [ev('a', 'first', 1)] })).status, 201);
const locked = await admin(id, 'lock', { ownerId: OWNER, plan: 'pro' });
assert.equal(locked.status, 200, JSON.stringify(locked.body));
const KEY = locked.body.editorKey;
assert.match(KEY, /^[A-Za-z0-9_-]{22}$/);
const baseline = await getCal(id);
step(`locked calendar ${id} ready (v=${baseline.v}, 1 event), owner=${OWNER}`);

const unchanged = async (msg) => { const c = await getCal(id); assert.equal(c.v, baseline.v, `${msg}: version moved`); assert.equal(c.calendar.events.length, 1, `${msg}: event count changed`); };

// ---- 1a. Forged X-PC-User is stripped EVEN with UNSAFE_DEV_SESSION_HEADER on -------------------
// The dev header takes the user ONLY from X-Dev-Session-User (loopback); a client's own X-PC-User
// is always deleted by the Worker (forRoom). So spoofing X-PC-User: <owner> must not grant write.
{
    const spoof = tab(id, { headers: { 'X-PC-User': OWNER } });
    const snap = await spoof.ready;
    assert.equal(snap.canEdit, false, 'X-PC-User from a client must not grant owner edit');
    const r = await spoof.save([{ type: 'add', event: ev('x', 'via X-PC-User', 2) }]);
    assert.equal(r.code, 'locked');
    // Also try X-PC-User on the HTTP create/import path.
    assert.equal((await create(id, { title: 'nope', events: [] }, { 'X-PC-User': OWNER })).status, 409);
    assert.equal((await fetch(`${BASE}/cal/${enc(id)}/import`, { method: 'PUT', headers: { 'X-PC-User': OWNER, 'Content-Type': 'application/json' }, body: JSON.stringify({ id, title: 'x', events: [] }) })).status, 403);
    await unchanged('forged X-PC-User');
    spoof.close();
    step('a client X-PC-User:<owner> is stripped even with the dev session header on; no write, no 403-less import');
}

// ---- 1b. Editor-key brute force closes the socket at 5 and never starves the owner -------------
// A wrong key must burn only the guesser's own per-tab budget, never the calendar's shared 60/min:
// otherwise a stranger could lock the real owner out by guessing.
{
    const g = tab(id); await g.ready;
    let lastAuth;
    for (let i = 0; i < 6; i++) lastAuth = await g.authKey(`wrong-key-${i}`).catch((e) => ({ err: e.message }));
    await sleep(100);
    const ci = g.closedInfo();
    assert.ok(ci && ci.code === 1008, `socket should be closed 1008 after 5 wrong keys; got ${JSON.stringify(ci)}`);
    // The owner (dev session) can still save: the shared budget was not consumed by the guesser.
    const owner = tab(id, { headers: { 'X-Dev-Session-User': OWNER } });
    const osnap = await owner.ready;
    assert.equal(osnap.canEdit, true, 'owner via dev session can edit');
    const r = await owner.save([{ type: 'add', event: ev('owner-ok', 'owner still writes', 3) }]);
    assert.equal(r.t, 'ack', 'owner not starved by brute-force guessing');
    owner.close(); g.close();
    step('editor-key brute force: socket closed (1008) at 5 wrong keys; owner is not rate-limited out');
}

// reset baseline to current (owner just added one legit event)
const b2 = await getCal(id);

// ---- 1c. Query/header smuggling to downgrade or escape the lock --------------------------------
// ?view=<anything> or X-View-Id on the EDIT socket makes the tab view-only (read), never a writer,
// and must not expose edit-only data. A locked calendar still refuses the write.
{
    const q = tab(id, { query: `?view=${enc(id)}` });
    const snap = await q.ready;
    assert.equal(snap.canEdit, false, '?view= on the edit socket does not grant write');
    const r = await q.save([{ type: 'add', event: ev('smuggle', 'via view param', 4) }]);
    assert.ok(r.code === 'locked' || r.code === 'read_only', `refused; got ${r.code}`);
    q.close();
    const h = tab(id, { headers: { 'X-View-Id': id } });
    const hs = await h.ready;
    assert.equal(hs.canEdit, false, 'X-View-Id on the edit socket does not grant write');
    assert.ok((await h.save([{ type: 'add', event: ev('smuggle2', 'x', 4) }])).code);
    h.close();
    const c = await getCal(id); assert.equal(c.v, b2.v, 'smuggling changed nothing');
    step('?view= / X-View-Id on the edit socket yield a read-only tab; writes refused, nothing changed');
}

// ---- 1d. Case-variant id is a SEPARATE calendar: no shared data, no lock leak ------------------
// Writing to FOO when Foo is locked must not touch the locked calendar's events or lock.
{
    const variant = id.toUpperCase();
    const r = await create(variant, { title: 'variant', events: [ev('v1', 'attacker event', 5)] });
    assert.ok(r.status === 201 || r.status === 409, `variant create: ${r.status}`);
    await sleep(150);
    const vstatus = await admin(variant, 'lock-status');
    assert.equal(vstatus.body.locked, false, 'the case variant is NOT locked (separate room)');
    const real = await getCal(id);
    assert.equal(real.locked, true, 'the real calendar is still locked');
    assert.ok(!real.calendar.events.some((e) => e.id === 'v1'), 'attacker event did not leak into the locked calendar');
    step('a case-variant id is a separate, unlocked calendar; its writes never reach the locked one');
}

// ---- 1e. Revoked / rotated key is dead on a brand-new socket -----------------------------------
{
    const rot = await admin(id, 'rotate-editor-key', { ownerId: OWNER });
    assert.equal(rot.body.ok, true);
    const KEY2 = rot.body.editorKey;
    assert.notEqual(KEY2, KEY);
    const fresh = tab(id); await fresh.ready;
    assert.equal((await fresh.authKey(KEY)).ok, false, 'the pre-rotation key is refused on a new socket');
    assert.equal((await fresh.authKey(KEY2)).ok, true, 'the new key works');
    assert.equal((await fresh.save([{ type: 'add', event: ev('k2', 'by new key', 6) }])).t, 'ack');
    fresh.close();
    step('a rotated-away editor key is refused on a fresh socket; the new key edits');
}

// ---- 1f. Admin lock routes are unreachable without the secret (any method) ---------------------
{
    for (const [m, op] of [['POST', 'lock'], ['POST', 'unlock'], ['POST', 'rotate-editor-key'], ['GET', 'lock-status'], ['POST', 'create-editor-link'], ['POST', 'set-pro-settings']]) {
        const r = await fetch(`${BASE}/api/admin/cal/${enc(id)}/${op}`, { method: m, body: m === 'POST' ? '{"ownerId":"attacker"}' : undefined });
        assert.ok(r.status === 403 || r.status === 404, `${m} admin/${op} without secret -> ${r.status}`);
        const r2 = await fetch(`${BASE}/api/admin/cal/${enc(id)}/${op}`, { method: m, headers: { Authorization: 'Bearer wrong' }, body: m === 'POST' ? '{"ownerId":"attacker"}' : undefined });
        assert.ok(r2.status === 403 || r2.status === 404, `${m} admin/${op} wrong secret -> ${r2.status}`);
    }
    // Internal-only owner ops (create-editor-link, set-pro-settings) are not even exposed on the admin surface.
    const owned = await admin(id, 'create-editor-link', { ownerId: OWNER, label: 'x' });
    assert.ok(owned.status === 404, `create-editor-link is not an admin op (got ${owned.status})`);
    const st = await admin(id, 'lock-status');
    assert.equal(st.body.ownerId, OWNER, 'lock still owned by the real owner after all attempts');
    step('admin lock routes need the secret; non-ADMIN_LOCK_OPS (create-editor-link/set-pro-settings) are not exposed there');
}

done('lock-bypass');
