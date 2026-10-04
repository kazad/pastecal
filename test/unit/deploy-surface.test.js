/**
 * What `firebase deploy --only functions` will try to ship.
 *
 * On Sep 24 a production fix could not deploy at all: the Pro/Stripe prototype
 * declared secrets that do not exist yet, and Firebase refuses the whole functions
 * deploy when any declared secret is missing. Drafts must not ride along with fixes,
 * so the deployable set is pinned here -- adding a function is a deliberate edit to
 * this list, and Pro stays out until PRO_BILLING=on.
 *
 * Run: node --test test/unit/deploy-surface.test.js   (Node 20/22)
 */
const test = require('node:test');
const assert = require('node:assert/strict');

test('only live functions are exported for deploy; Pro billing stays dark', () => {
  delete process.env.PRO_BILLING;
  const mod = require('../../functions/index.js');
  const exported = Object.keys(mod).filter((k) => k !== '_internal').sort();
  assert.deepEqual(exported, [
    'createPublicLink', 'generateICSV2', 'indexReadOnlySlug', 'indexSlug',
    'lookupCalendar', 'recordHistory', 'removePublicView', 'shadowToCloudflare', 'sweepDeviceBuckets', 'syncPublicView',
  ]);
});
