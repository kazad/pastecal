/**
 * /pro/done (Stripe's success page) must never revoke editor links: it used to POST
 * /api/pro/editor-key, which replaces every link, whenever this browser had none stored.
 * It now lists links and makes one named 'Editors' link only when there are none.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../../public/pro/done.html'), 'utf8');

test('/pro/done never calls the revoking editor-key route; it lists links and creates one only when there are none', () => {
    assert.ok(!html.includes('/api/pro/editor-key'), 'no call to /api/pro/editor-key');
    assert.match(html, /api\('GET', '\/api\/pro\/editor-links\?calendar='/);
    assert.match(html, /api\('POST', '\/api\/pro\/editor-links', \{ calendarId: proCalendar, label: 'Editors' \}\)/);
    assert.match(html, /if \(r\.data\.length\)/, 'existing links: point to Share instead of making another');
});
