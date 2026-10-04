#!/usr/bin/env node
/**
 * One-time migration for read-only views made before ownership bindings existed.
 *
 * Those mirrors carry `id` = the EDITABLE calendar's slug, and /calendars_readonly is
 * world-readable, so every legacy view link also hands out edit access. syncPublicView
 * stops publishing it on the next edit of each calendar, but a calendar nobody edits keeps
 * leaking until this runs. For each legacy view it records the binding that syncPublicView
 * now requires (/public_views, /public_views_by_calendar), then rewrites `id` to the view's
 * own id.
 *
 *   node scripts/migrate-public-views.js          # dry run: list what would change
 *   node scripts/migrate-public-views.js --yes    # do it
 *
 * Run it AFTER deploying the functions (an older syncPublicView would copy the editable id
 * straight back) and promptly: until it runs, a legacy view can be claimed by the calendar
 * its mirror names. Safe to re-run.
 */
const path = require('path');
const admin = require(path.join(__dirname, '../functions/node_modules/firebase-admin'));

const apply = process.argv[2] === '--yes';
if (process.argv[2] && !apply) {
    console.error('usage: migrate-public-views.js [--yes]');
    process.exit(2);
}

admin.initializeApp({
    credential: admin.credential.cert(
        require(path.join(__dirname, '../internal/keys/pastecal-web-firebase-adminsdk-scf60-24fc54f2df.json'))),
    databaseURL: 'https://pastecal-web-default-rtdb.firebaseio.com',
});
const db = admin.database();

(async () => {
    const views = (await db.ref('calendars_readonly').once('value')).val() || {};
    const bindings = (await db.ref('public_views').once('value')).val() || {};
    let legacy = 0, conflicts = 0;

    let orphans = 0;
    for (const [pvid, view] of Object.entries(views)) {
        const owner = view && view.id;
        if (!owner || owner === pvid) continue;           // already migrated, or no owner on record
        legacy++;
        // The old code never removed a deleted calendar's view, so some mirrors name an
        // owner that no longer exists. Binding those to the slug would hand the view (and its
        // ICS subscribers) to whoever recreates it; a tombstone, which can never equal a
        // calendar id, keeps the frozen view serving and unclaimable.
        const ownerExists = (await db.ref(`calendars/${owner}/id`).once('value')).exists();
        if (!ownerExists && !bindings[pvid]) {
            orphans++;
            console.log(`  ORPHAN ${pvid}: owner calendar is gone -- tombstoned`);
            if (apply) {
                await db.ref().update({
                    [`public_views/${pvid}`]: `!deleted:${Date.now()}`,
                    [`calendars_readonly/${pvid}/id`]: pvid,
                });
            }
            continue;
        }
        if (bindings[pvid] && bindings[pvid] !== owner) {
            conflicts++;
            console.log(`  CONFLICT ${pvid}: bound to ${bindings[pvid]}, mirror names ${owner} -- left alone`);
            continue;
        }
        console.log(`  ${pvid}  <- ${apply ? owner : '(owner hidden in dry run)'}`);
        if (!apply) continue;
        await db.ref().update({
            [`public_views/${pvid}`]: owner,
            [`public_views_by_calendar/${owner}/${pvid}`]: true,
            [`calendars_readonly/${pvid}/id`]: pvid,
        });
    }

    // Index the history written before /history_index existed, here rather than on the
    // first write after deploy: loadIndex's fallback reads a calendar's whole log, up to
    // ~14MB, and concurrent first writes could run an instance out of memory.
    // Keys only (REST shallow read): the Admin SDK has no shallow read, and pulling all of
    // /history to list its children is the whole log for every calendar at once.
    const { access_token } = await admin.app().options.credential.getAccessToken();
    const res = await fetch(`${admin.app().options.databaseURL}/history.json?shallow=true`,
        { headers: { Authorization: `Bearer ${access_token}` } });
    if (!res.ok) throw new Error(`shallow read of /history failed: HTTP ${res.status}`);
    const histKeys = Object.keys((await res.json()) || {});
    let indexed = 0;
    for (const calId of histKeys) {
        if ((await db.ref(`history_index/${calId}`).limitToFirst(1).once('value')).exists()) continue;
        const log = (await db.ref(`history/${calId}`).once('value')).val() || {};
        const rows = {};
        for (const [k, v] of Object.entries(log)) rows[k] = { k: (v && v.kind) || 'edited', t: (v && v.savedAt) || 0, s: (v && v.savedAt) || 0, ck: '' };
        indexed++;
        if (apply) await db.ref(`history_index/${calId}`).update(rows);
    }
    console.log(`${indexed} calendar history log(s) ${apply ? 'indexed' : 'to index'}.`);

    console.log(`\n${legacy} legacy view(s), ${orphans} orphan(s) tombstoned, ${conflicts} conflict(s).` +
        (apply ? ' Migrated.' : ' Dry run; add --yes to apply.'));
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
