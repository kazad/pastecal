// This browser's pastecal id (public/services/AuthorSignal.js uid/uidNow/ready): a random id made once and
// kept in localStorage, adopting an existing Firebase uid once for continuity; Firebase's own records keep
// using the Firebase uid (firebaseUid). Owner decision, Oct 2026: no blocker can make a creator unrecognizable.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const FILE = path.join(__dirname, '../../public/services/AuthorSignal.js');
function fakeStorage(init = {}) {
    const m = new Map(Object.entries(init));
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k),
        key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; }, _m: m };
}
// A fresh copy of the module with its own globals.
function load({ storage = fakeStorage(), firebase, pcNoProdSideEffects = false } = {}) {
    delete require.cache[require.resolve(FILE)];
    global.localStorage = storage;
    global.window = { pcNoProdSideEffects };
    if (firebase === undefined) delete global.firebase; else global.firebase = firebase;
    const A = require(FILE);
    A.WAIT_MS = 60;
    return { A, storage };
}
// A Firebase whose first auth state arrives after `delay` ms with `user` (null: no restored user).
function fakeFirebase({ currentUser = null, user = null, delay = 10 } = {}) {
    const auth = { currentUser, onAuthStateChanged(cb) { const t = setTimeout(() => { auth.currentUser = user; cb(user); }, delay); return () => clearTimeout(t); } };
    return { apps: [{}], auth: () => auth };
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test.afterEach(() => { delete global.localStorage; delete global.window; delete global.firebase; });

test('no Firebase (blocked, staging, local CF): a random id at once, kept and reused', () => {
    const { A, storage } = load();
    const id = A.uid();
    assert.match(id, UUID);
    assert.equal(storage.getItem('pastecal_browser_id'), id);
    assert.equal(A.uid(), id);
    const again = load({ storage }).A;                        // the next page load
    assert.equal(again.uid(), id);
});

test('a kept id wins over a Firebase uid', () => {
    const { A } = load({ storage: fakeStorage({ pastecal_browser_id: 'kept-1' }), firebase: fakeFirebase({ currentUser: { uid: 'fb-1' } }) });
    assert.equal(A.uid(), 'kept-1');
    assert.equal(A.firebaseUid(), 'fb-1', 'Firebase records still use the Firebase uid');
});

test('continuity: a browser with a Firebase uid adopts it once as its pastecal id', () => {
    const { A, storage } = load({ firebase: fakeFirebase({ currentUser: { uid: 'fb-restored' } }) });
    assert.equal(A.uid(), 'fb-restored');
    assert.equal(storage.getItem('pastecal_browser_id'), 'fb-restored');
    // Firebase's own localStorage record, read without waiting for the SDK
    const s2 = fakeStorage({ 'firebase:authUser:AIzaKey:[DEFAULT]': JSON.stringify({ uid: 'fb-in-storage' }) });
    assert.equal(load({ storage: s2, firebase: fakeFirebase({ delay: 5000 }) }).A.uid(), 'fb-in-storage');
});

test('Firebase still restoring: ready() waits for its user and adopts the uid; a new browser gets a fresh id', async () => {
    let { A } = load({ firebase: fakeFirebase({ user: { uid: 'fb-late' }, delay: 15 }) });
    assert.equal(A.uid(), null, 'undecided for a moment');
    assert.equal(await A.ready(), 'fb-late');
    assert.equal(A.uid(), 'fb-late');
    ({ A } = load({ firebase: fakeFirebase({ user: null, delay: 5 }) }));
    assert.match(await A.ready(), UUID, 'no existing user: a pastecal id, never the anonymous uid made later');
});

test('Firebase never answers (blocked mid-way): ready() still gives an id after the wait', async () => {
    const { A } = load({ firebase: fakeFirebase({ user: { uid: 'never' }, delay: 10000 }) });
    const id = await A.ready();
    assert.match(id, UUID);
});

test('creating a calendar can\'t wait: uidNow() decides, and a later Firebase uid never replaces it', async () => {
    const { A } = load({ firebase: fakeFirebase({ user: { uid: 'fb-after' }, delay: 20 }) });
    const id = A.uidNow();
    assert.match(id, UUID);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(A.uid(), id, 'stable: the calendar it just made stays its own');
});

test('localStorage blocked: an id for this page load, never null', () => {
    const blocked = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, key: () => null, length: 0 };
    const { A } = load({ storage: blocked });
    const id = A.uid();
    assert.match(id, UUID);
    assert.equal(A.uid(), id);
});

test('the app sends the pastecal id: Pro calls, the creation POST and the sign-in verify', () => {
    const fs = require('fs'), root = path.join(__dirname, '../..');
    const pro = fs.readFileSync(path.join(root, 'public/components/Pro.js'), 'utf8');
    assert.match(pro, /AuthorSignal\.ready\(\)/, 'proAuthorReady waits through AuthorSignal.ready');
    const cloud = fs.readFileSync(path.join(root, 'public/services/CloudCalendarService.js'), 'utf8');
    assert.match(cloud, /AuthorSignal\.uidNow\(\)/, 'createWithId decides the id at once');
    assert.match(fs.readFileSync(path.join(root, 'public/signin.html'), 'utf8'), /localStorage\.getItem\('pastecal_browser_id'\)/);
    const sig = fs.readFileSync(FILE, 'utf8');
    assert.match(sig, /_recordingUid[\s\S]*?return this\.firebaseUid\(\)/, 'Firebase records stay keyed by auth.uid');
});
