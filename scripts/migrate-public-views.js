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
 * Run it AFTER deploying the functions: an older syncPublicView would copy the editable id
 * straight back.
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

    for (const [pvid, view] of Object.entries(views)) {
        const owner = view && view.id;
        if (!owner || owner === pvid) continue;           // already migrated, or no owner on record
        legacy++;
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

    console.log(`\n${legacy} legacy view(s), ${conflicts} conflict(s).` +
        (apply ? ' Migrated.' : ' Dry run; add --yes to apply.'));
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
