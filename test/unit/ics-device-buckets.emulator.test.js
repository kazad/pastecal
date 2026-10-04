/**
 * ICS subscriber estimation, and the privacy properties it depends on.
 *
 * The ICS protocol has no client id -- polling is anonymous by design -- so the
 * only way to estimate how many devices subscribe to a feed is user-agent plus
 * IP. Both are personal data under GDPR, and a meaningful share of pastecal's
 * traffic is EU (a Berlin student union is among the top referrers).
 *
 * So the estimate is built on hashes that are deliberately un-reversible and
 * short-lived. These tests exist because "we hash it" is easy to claim and easy
 * to quietly break: a refactor that stored the raw UA, or dropped the salt, or
 * stopped rotating daily, would leave the counts looking identical while turning
 * an anonymous estimate into a log of who reads which calendar.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

if (!process.env.FIREBASE_DATABASE_EMULATOR_HOST) {
    throw new Error(
        'FIREBASE_DATABASE_EMULATOR_HOST is not set. Run via `npm run test:unit` ' +
        '(wraps this in `firebase emulators:exec --only database`), not `node --test` directly.'
    );
}

const admin = require('../../functions/node_modules/firebase-admin');
const { _internal } = require('../../functions/index.js');
const {
    recordIcsStat, clientFamily, clientIpOf, deviceSaltSecret, sweepAllDeviceBuckets,
    DEVICE_BUCKET_TTL_DAYS, DEVICE_SALT_PATH, SWEEP_CURSOR_PATH, _resetDeviceSaltCache,
} = _internal;

// Pure-function tests use a fixed secret; the recordIcsStat tests use the stored one.
const SECRET = Buffer.alloc(32, 7);
const deviceBucket = (ua, ip, day) => _internal.deviceBucket(ua, ip, SECRET, day);

const db = admin.database();
const today = () => new Date().toISOString().slice(0, 10);

async function cleanup(id) {
    await db.ref('calendar_stats').child(id).remove();
}

const IOS = 'iOS/26.6 (23G71) dataaccessd/1.0';
const IOS_OTHER = 'iOS/26.5.2 (23F84) dataaccessd/1.0';
const MAC = 'macOS/26.6.2 (25G83) dataaccessd/1.0';
const GOOGLE = 'Google-Calendar-Importer';

// --- the privacy properties ------------------------------------------------------------

test('deviceBucket: the raw user-agent and IP never appear in the bucket', () => {
    const b = deviceBucket(IOS, '203.0.113.5');
    assert.ok(b, 'a normal client should get a bucket');
    assert.equal(b.length, 8);
    assert.match(b, /^[0-9a-f]{8}$/);
    // The whole point: nothing recoverable survives.
    assert.ok(!b.includes('203'), 'bucket must not contain any part of the IP');
    assert.ok(!/ios|dataaccessd/i.test(b), 'bucket must not contain any part of the UA');
});

test('deviceBucket: the same device on the same day collapses to one bucket', () => {
    // Without this the "estimate" would just be a request count.
    assert.equal(deviceBucket(IOS, '203.0.113.5'), deviceBucket(IOS, '203.0.113.5'));
});

test('deviceBucket: different devices land in different buckets', () => {
    const a = deviceBucket(IOS, '203.0.113.5');
    const b = deviceBucket(IOS_OTHER, '203.0.113.9');
    const c = deviceBucket(MAC, '198.51.100.2');
    assert.equal(new Set([a, b, c]).size, 3);
});

test('deviceBucket: the same IP with different clients is not merged', () => {
    // One household NAT can hold several devices; merging them would undercount
    // in a way that looks like churn.
    assert.notEqual(deviceBucket(IOS, '203.0.113.5'), deviceBucket(MAC, '203.0.113.5'));
});

test('deviceBucket: aggregators get no bucket at all', () => {
    // Google fetches server-side for every subscriber, so one Google IP may be one
    // person or five hundred. Counting it as a device would be a fabricated number.
    assert.equal(deviceBucket(GOOGLE, '66.102.8.1'), null);
    assert.equal(deviceBucket('WordPress/7.1 ICS Calendar/12.1.3.1', '93.184.1.1'), null);
    assert.equal(deviceBucket('Microsoft Exchange (Windows NT 10.0)', '40.1.1.1'), null);
});

test('deviceBucket: a missing user-agent is not counted as a device', () => {
    assert.equal(deviceBucket('', '203.0.113.5'), null);
    assert.equal(deviceBucket(undefined, '203.0.113.5'), null);
});

test('clientFamily: classifies the clients actually seen in production', () => {
    assert.equal(clientFamily(IOS), 'apple_ios');
    assert.equal(clientFamily(MAC), 'apple_macos');
    assert.equal(clientFamily(GOOGLE), 'google');
    assert.equal(clientFamily('ICSx5/2.4.3 (ical4j/3.2.19 okhttp/5.3.2 Android/16)'), 'android');
    assert.equal(clientFamily('Evolution/3.60.2'), 'desktop_linux');
    assert.equal(clientFamily('WordPress/7.1 ICS Calendar/12.1.3.1'), 'wordpress');
    assert.equal(clientFamily(''), 'other');
});

// --- what actually gets written ---------------------------------------------------------

test('recordIcsStat: writes a device bucket, and no identifying data alongside it', async () => {
    const id = 'DeviceBucketProbe';
    try {
        await recordIcsStat(id, { bytes: 1200, wasNotModified: false, userAgent: IOS, ip: '203.0.113.5' });

        const snap = await db.ref('calendar_stats').child(id).once('value');
        const val = snap.val();

        const buckets = Object.keys(val.devices[today()]);
        assert.equal(buckets.length, 1);

        // The strongest assertion in this file: scan the entire stored record for
        // anything that could identify the subscriber.
        const serialized = JSON.stringify(val);
        assert.ok(!serialized.includes('203.0.113.5'), 'the IP must never be stored');
        assert.ok(!serialized.includes('dataaccessd'), 'the raw user-agent must never be stored');
        assert.ok(!serialized.includes('23G71'), 'the OS build number must never be stored');
    } finally {
        await cleanup(id);
    }
});

test('recordIcsStat: repeated polls from one device stay one bucket', async () => {
    const id = 'RepeatPollProbe';
    try {
        for (let i = 0; i < 5; i++) {
            await recordIcsStat(id, { wasNotModified: true, userAgent: IOS, ip: '203.0.113.5' });
        }
        const snap = await db.ref(`calendar_stats/${id}/devices/${today()}`).once('value');
        assert.equal(Object.keys(snap.val()).length, 1, 'five polls, one device');

        const count = await db.ref(`calendar_stats/${id}/icsRequestCount`).once('value');
        assert.equal(count.val(), 5, 'request count still counts every poll');
    } finally {
        await cleanup(id);
    }
});

test('recordIcsStat: distinct devices produce distinct buckets', async () => {
    const id = 'MultiDeviceProbe';
    try {
        await recordIcsStat(id, { wasNotModified: true, userAgent: IOS, ip: '203.0.113.5' });
        await recordIcsStat(id, { wasNotModified: true, userAgent: IOS_OTHER, ip: '203.0.113.9' });
        await recordIcsStat(id, { wasNotModified: true, userAgent: MAC, ip: '198.51.100.2' });

        const snap = await db.ref(`calendar_stats/${id}/devices/${today()}`).once('value');
        assert.equal(Object.keys(snap.val()).length, 3);
    } finally {
        await cleanup(id);
    }
});

test('recordIcsStat: aggregator traffic is counted separately, never as a device', async () => {
    const id = 'AggregatorProbe';
    try {
        await recordIcsStat(id, { wasNotModified: true, userAgent: GOOGLE, ip: '66.102.8.1' });
        await recordIcsStat(id, { wasNotModified: true, userAgent: GOOGLE, ip: '66.102.8.2' });

        const val = (await db.ref('calendar_stats').child(id).once('value')).val();
        assert.equal(val.devices, undefined, 'aggregators must not create device buckets');
        assert.equal(val.aggregatorHits[today()], 2);
        assert.equal(val.clients.google, 2);
    } finally {
        await cleanup(id);
    }
});

test('recordIcsStat: the client mix is recorded without any identity', async () => {
    const id = 'ClientMixProbe';
    try {
        await recordIcsStat(id, { wasNotModified: true, userAgent: IOS, ip: '1.1.1.1' });
        await recordIcsStat(id, { wasNotModified: true, userAgent: MAC, ip: '1.1.1.2' });
        await recordIcsStat(id, { wasNotModified: true, userAgent: GOOGLE, ip: '66.102.8.1' });

        const clients = (await db.ref(`calendar_stats/${id}/clients`).once('value')).val();
        assert.equal(clients.apple_ios, 1);
        assert.equal(clients.apple_macos, 1);
        assert.equal(clients.google, 1);
    } finally {
        await cleanup(id);
    }
});

// --- retention ---------------------------------------------------------------------------

test('sweep: buckets older than the TTL are deleted', async () => {
    const id = 'SweepProbe';
    try {
        const old = new Date(Date.now() - (DEVICE_BUCKET_TTL_DAYS + 5) * 86400000)
            .toISOString().slice(0, 10);
        const recent = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);

        await db.ref('calendar_stats').child(id).update({
            [`devices/${old}/aaaaaaaa`]: true,
            [`devices/${recent}/bbbbbbbb`]: true,
            [`aggregatorHits/${old}`]: 4,
        });

        // A live request is what triggers the sweep.
        await recordIcsStat(id, { wasNotModified: true, userAgent: IOS, ip: '203.0.113.5' });

        const devices = (await db.ref(`calendar_stats/${id}/devices`).once('value')).val() || {};
        assert.equal(devices[old], undefined, 'expired day must be swept');
        assert.ok(devices[recent], 'in-window day must survive');
        assert.ok(devices[today()], "today's bucket must survive");

        const agg = (await db.ref(`calendar_stats/${id}/aggregatorHits`).once('value')).val() || {};
        assert.equal(agg[old], undefined, 'expired aggregator day must be swept too');
    } finally {
        await cleanup(id);
    }
});

test('sweep: runs at most once a day per calendar', async () => {
    // A feed polled 8,000 times must not pay for 8,000 range reads.
    const id = 'SweepRateProbe';
    try {
        await recordIcsStat(id, { wasNotModified: true, userAgent: IOS, ip: '203.0.113.5' });
        const marker = await db.ref(`calendar_stats/${id}/devicesSweptOn`).once('value');
        assert.equal(marker.val(), today());

        // Plant an expired day AFTER the marker is set; a second request the same
        // day should skip the sweep and leave it in place.
        const old = new Date(Date.now() - (DEVICE_BUCKET_TTL_DAYS + 5) * 86400000)
            .toISOString().slice(0, 10);
        await db.ref(`calendar_stats/${id}/devices/${old}/cccccccc`).set(true);

        await recordIcsStat(id, { wasNotModified: true, userAgent: MAC, ip: '198.51.100.2' });

        const devices = (await db.ref(`calendar_stats/${id}/devices`).once('value')).val() || {};
        assert.ok(devices[old], 'sweep should not have re-run on the same day');
    } finally {
        await cleanup(id);
    }
});

// --- the salt ---------------------------------------------------------------------------

test('deviceBucket: the same device lands in a different bucket on a different day', () => {
    // The daily rotation is what stops buckets from linking a device across days.
    assert.notEqual(deviceBucket(IOS, '203.0.113.5', '2026-10-01'), deviceBucket(IOS, '203.0.113.5', '2026-10-02'));
});

test('deviceBucket: no secret, no bucket', () => {
    // Hashing without the secret would make every bucket testable against a known IP.
    assert.equal(_internal.deviceBucket(IOS, '203.0.113.5', null), null);
});

test('deviceBucket: a different secret gives a different bucket', () => {
    assert.notEqual(
        _internal.deviceBucket(IOS, '203.0.113.5', Buffer.alloc(32, 1)),
        _internal.deviceBucket(IOS, '203.0.113.5', Buffer.alloc(32, 2)));
});

test('device salt: one device hashes to the same bucket across instances and cold starts', async () => {
    // The per-process random salt this replaced counted one phone once per instance
    // that served it, inflating the estimate with every scale-out.
    const id = 'SaltStableProbe';
    try {
        await recordIcsStat(id, { wasNotModified: true, userAgent: IOS, ip: '203.0.113.5' });
        _resetDeviceSaltCache();   // what a cold start on another instance looks like
        await recordIcsStat(id, { wasNotModified: true, userAgent: IOS, ip: '203.0.113.5' });
        const snap = await db.ref(`calendar_stats/${id}/devices/${today()}`).once('value');
        assert.equal(Object.keys(snap.val()).length, 1, 'two instances, one device');
    } finally {
        await cleanup(id);
    }
});

test('device salt: created once, stored server-side, and unreadable by clients', async () => {
    _resetDeviceSaltCache();
    const a = await deviceSaltSecret();
    _resetDeviceSaltCache();
    const b = await deviceSaltSecret();
    assert.ok(a.equals(b), 'a second instance must reuse the stored secret, not mint its own');
    assert.equal(a.length, 32);

    const host = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
    const ns = new URL(admin.app().options.databaseURL).hostname.split('.')[0];
    const res = await fetch(`http://${host}/${DEVICE_SALT_PATH}.json?ns=${ns}`);
    assert.equal(res.status, 401, 'the secret must not be readable without admin access');
});

// --- client IP --------------------------------------------------------------------------

test('clientIpOf: ignores a client-supplied leftmost X-Forwarded-For', () => {
    // Google's front end appends the real peer on the right; anything left of it is
    // whatever the client sent.
    const req = { headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.5' } };
    assert.equal(clientIpOf(req), '203.0.113.5');
});

test('clientIpOf: prefers the IP Hosting\'s CDN saw, since XFF then ends in CDN hops', () => {
    const req = { headers: { 'fastly-client-ip': '203.0.113.5', 'x-forwarded-for': '6.6.6.6, 151.101.1.1' } };
    assert.equal(clientIpOf(req), '203.0.113.5');
});

test('clientIpOf: falls back to the socket peer', () => {
    assert.equal(clientIpOf({ headers: {}, socket: { remoteAddress: '198.51.100.2' } }), '198.51.100.2');
});

// --- the scheduled sweep ----------------------------------------------------------------

test('scheduled sweep: expires buckets on calendars nobody polls any more', async () => {
    // The opportunistic sweep only runs when a feed is requested, so an abandoned feed
    // kept its last buckets forever.
    const ids = ['SchedSweepA', 'SchedSweepB', 'SchedSweepC'];
    const old = new Date(Date.now() - (DEVICE_BUCKET_TTL_DAYS + 5) * 86400000).toISOString().slice(0, 10);
    const recent = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
    try {
        await db.ref(SWEEP_CURSOR_PATH).remove();
        for (const id of ids) {
            await db.ref('calendar_stats').child(id).update({
                icsRequestCount: 3,
                [`devices/${old}/aaaaaaaa`]: true,
                [`devices/${recent}/bbbbbbbb`]: true,
                [`aggregatorHits/${old}`]: 2,
            });
        }

        // Bounded: a run that can examine only part of the calendars stops and leaves a
        // cursor, and the next run picks up after it.
        let runs = 0;
        let result;
        do {
            result = await sweepAllDeviceBuckets({ pageSize: 2, maxPerRun: 2 });
            assert.ok(result.examined <= 2, 'a run must respect its bound');
            runs++;
        } while (!result.reachedEnd && runs < 50);
        assert.ok(result.reachedEnd);
        assert.equal((await db.ref(SWEEP_CURSOR_PATH).once('value')).val(), null, 'cursor wraps after the end');

        for (const id of ids) {
            const val = (await db.ref('calendar_stats').child(id).once('value')).val();
            assert.equal(val.devices[old], undefined, `${id}: expired day must be swept`);
            assert.ok(val.devices[recent], `${id}: in-window day must survive`);
            assert.equal(val.aggregatorHits, undefined, `${id}: expired aggregator day must be swept`);
            assert.equal(val.icsRequestCount, 3, `${id}: counters are not touched`);
        }
    } finally {
        await Promise.all(ids.map(cleanup));
        await db.ref(SWEEP_CURSOR_PATH).remove();
    }
});

// The Admin SDK holds its RTDB socket open, so without this the process lingers after
// the last assertion and `node --test` never advances to the next file -- which silently
// skipped the lookup-calendar suite entirely once this file was added.
test.after(async () => {
    await admin.app().delete();
});
