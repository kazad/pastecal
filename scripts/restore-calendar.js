#!/usr/bin/env node
/**
 * List or restore a calendar's server-side history (the /history node written by the
 * recordHistory trigger -- see functions/index.js and docs/backups.md).
 *
 *   node scripts/restore-calendar.js <slug>                 # list snapshots
 *   node scripts/restore-calendar.js <slug> <entryKey>      # show one snapshot in full
 *   node scripts/restore-calendar.js <slug> <entryKey> --yes  # write it back
 *
 * Restoring writes events/title/options to /calendars/<slug> with update(), so the id
 * and anything else on the node are left alone; the syncPublicView trigger then mirrors
 * the change to /calendars_readonly, so shared /view/ links pick it up without a
 * separate write. The write itself is a recordable change, so the state being replaced
 * lands in /history too -- a restore is undoable.
 *
 * Read the snapshot before restoring. A snapshot that is itself empty means the damage
 * predates it, and writing it over live data destroys whatever has been re-entered.
 */
const path = require('path');
const admin = require(path.join(__dirname, '../functions/node_modules/firebase-admin'));

const [slug, entryKey, flag] = process.argv.slice(2);
if (!slug) {
    console.error('usage: restore-calendar.js <slug> [entryKey] [--yes]');
    process.exit(2);
}

admin.initializeApp({
    credential: admin.credential.cert(
        require(path.join(__dirname, '../internal/keys/pastecal-web-firebase-adminsdk-scf60-24fc54f2df.json'))),
    databaseURL: 'https://pastecal-web-default-rtdb.firebaseio.com',
});
const db = admin.database();

const count = (c) => { const e = c && c.events; return Array.isArray(e) ? e.filter(Boolean).length : (e ? Object.keys(e).length : 0); };

(async () => {
    const live = (await db.ref(`calendars/${slug}`).once('value')).val();
    const hist = (await db.ref(`history/${slug}`).once('value')).val() || {};
    const entries = Object.entries(hist).sort((a, b) => a[1].savedAt - b[1].savedAt);

    console.log(`live /calendars/${slug}: ${live ? `${count(live)} events, title "${live.title || ''}"` : '(missing)'}`);
    console.log(`history entries: ${entries.length}\n`);

    if (!entryKey) {
        for (const [key, e] of entries) {
            console.log(`  ${key}  ${new Date(e.savedAt).toISOString()}  ${String(e.kind).padEnd(7)}  ` +
                `${String(e.eventCount).padStart(5)} events  -${e.removed} ~${e.changed}  "${e.title || ''}"`);
        }
        console.log('\nre-run with an entry key to inspect it, and --yes to restore it.');
        process.exit(0);
    }

    const entry = hist[entryKey];
    if (!entry) { console.error(`no history entry ${entryKey} for ${slug}`); process.exit(1); }

    console.log(`snapshot ${entryKey} (${new Date(entry.savedAt).toISOString()}, ${entry.kind}):`);
    console.log(`  title   : "${entry.title || ''}"`);
    console.log(`  options : ${JSON.stringify(entry.options)}`);
    console.log(`  events  : ${entry.events.length}`);
    for (const e of entry.events.slice(0, 40)) console.log(`     - ${String(e.title || '(untitled)').slice(0, 50).padEnd(52)} ${String(e.start || '').slice(0, 16)}`);
    if (entry.events.length > 40) console.log(`     ... +${entry.events.length - 40} more`);

    if (flag !== '--yes') {
        console.log(`\ndry run. This would replace ${count(live)} live events with ${entry.events.length}. Add --yes to do it.`);
        process.exit(0);
    }

    await db.ref(`calendars/${slug}`).update({
        events: entry.events,
        title: entry.title ?? '',
        options: entry.options ?? {},
    });
    const after = (await db.ref(`calendars/${slug}`).once('value')).val();
    console.log(`\nrestored. live now has ${count(after)} events, title "${after.title || ''}".`);
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
