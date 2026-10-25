// Pro Unlimited names (cloudflare/src/SlugService.js nameProblem, STATIC_PAGE_NAMES): a handle or a top-level
// short name can never shadow a page or folder the site serves, and the format rules hold.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const load = () => import(path.join(root, 'cloudflare/src/SlugService.js'));

test('every top-level entry of public/ is a reserved short name', async () => {
    const { STATIC_PAGE_NAMES, nameProblem } = await load();
    for (const entry of fs.readdirSync(path.join(root, 'public'))) {
        const name = entry.replace(/\.[a-z0-9]+$/i, '').toLowerCase();
        assert.ok(STATIC_PAGE_NAMES.has(name), `public/${entry}: add "${name}" to STATIC_PAGE_NAMES`);
        if (/^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(name)) assert.ok(nameProblem(name, 'short'), `${name} must be refused as a short name`);
    }
});

test('handles and short names: 3-30 of a-z 0-9 -, no reserved words; links under a handle: 1-40', async () => {
    const { nameProblem } = await load();
    for (const ok of ['ann', 'kalid', 'soccer-club', 'a1b', 'x'.repeat(30)]) assert.equal(nameProblem(ok, 'handle'), null, ok);
    for (const no of ['ab', '-ann', 'ann-', 'an n', 'ann_b', 'x'.repeat(31), '@ann', 'ann.ics', 'pricing', 'account', 'api', 'view', 'signin', 'admin', 'help']) {
        assert.ok(nameProblem(no, 'handle'), `${no} should be refused`);
    }
    assert.equal(nameProblem('Kalid', 'handle'), null, 'case-insensitive: lowercased first');
    for (const ok of ['s', 'soccer', 'u10-girls', 'x'.repeat(40), 'pricing']) assert.equal(nameProblem(ok, 'link'), null, ok);
    for (const no of ['', '-a', 'a-', 'a/b', 'x'.repeat(41), 'a.ics']) assert.ok(nameProblem(no, 'link'), `${no} should be refused`);
});

test('new calendars may not start with "@" or be named account (server and both apps)', () => {
    assert.match(fs.readFileSync(path.join(root, 'cloudflare/src/index.js'), 'utf8'), /RESERVED_CALENDAR_NAMES\.has\(id\.toLowerCase\(\)\) \|\| id\.startsWith\('@'\)/);
    for (const f of ['public/services/CloudCalendarService.js', 'public/services/CalendarDataService.js']) {
        assert.match(fs.readFileSync(path.join(root, f), 'utf8'), /'account'\]\.includes\(String\(id \|\| ''\)\.toLowerCase\(\)\) \|\| String\(id \|\| ''\)\.startsWith\('@'\)/, f);
    }
    assert.match(fs.readFileSync(path.join(root, 'cloudflare/wrangler.jsonc'), 'utf8'), /"\/@\*",/, 'production sends /@... to the Worker');
});
