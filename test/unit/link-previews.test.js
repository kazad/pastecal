/**
 * Link previews for calendar links (cloudflare/src/preview): which paths get calendar tags, that every
 * user string is escaped in them, that the card never shows past events or notes, and that a missing,
 * failing or slow calendar leaves the page exactly as it was.
 *
 * Run: node --test test/unit/link-previews.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = (p) => import(path.join(__dirname, '../../cloudflare/src/preview', p));
const DAY = 86400000;
const NOW = Date.parse('2026-10-24T20:00:00Z');                 // a Saturday, 1pm in Los Angeles
const pdtMidnight = (d) => new Date(Date.parse(`${d}T07:00:00Z`)).toISOString();   // an LA author's all-day start
const at = (d, h) => new Date(Date.parse(`${d}T00:00:00Z`) + (h + 7) * 3600000).toISOString();

const choir = () => ({
    v: 7, title: 'Riverside "Youth" <Choir> & Friends', tz: 'America/Los_Angeles',
    colors: ['#3f51b5', 'javascript:alert(1)', 'url(x)'],
    events: [
        { id: 1, title: 'Sectionals', start: pdtMidnight('2026-10-25'), end: pdtMidnight('2026-10-26'), isAllDay: true, type: 1 },
        { id: 2, title: 'Full <b>rehearsal</b>', description: 'door code 4321', start: at('2026-10-27', 19), end: at('2026-10-27', 21), type: 2 },
        { id: 3, title: 'Last week', start: at('2026-10-17', 19), end: at('2026-10-17', 21), type: 3 },
        { id: 4, title: 'Earlier today', start: at('2026-10-24', 9), end: at('2026-10-24', 10), type: 4 },
        { id: 5, title: 'Concert', start: at('2026-11-01', 18), end: at('2026-11-01', 20), type: 4 },
        { id: 6, title: 'Fourth', start: pdtMidnight('2026-11-05'), end: pdtMidnight('2026-11-06'), isAllDay: true, type: 5 },
    ],
});

test('only calendar pages get calendar tags: /<name> and /view/<id>, not site pages, files or embeds', async () => {
    const { calendarTarget } = await src('meta.js');
    assert.deepEqual(calendarTarget('/kalid', ''), { kind: 'edit', id: 'kalid' });
    assert.deepEqual(calendarTarget('/kalid/', ''), { kind: 'edit', id: 'kalid' });
    assert.deepEqual(calendarTarget('/view/ab12cd34', '?date=2026-10-25&view=month'), { kind: 'view', id: 'ab12cd34' });
    assert.deepEqual(calendarTarget('/TEAM%20NU%C3%91EZ', ''), { kind: 'edit', id: 'TEAM NUÑEZ' });
    for (const p of ['/', '/pricing', '/about', '/help', '/view', '/api', '/beta', '/signin', '/app.js', '/img/og-card.png', '/view/a/b', '/a/b', '/bad%zz', '/og']) {
        assert.equal(calendarTarget(p, ''), null, p);
    }
    assert.equal(calendarTarget('/kalid', '?embed=1'), null, 'embeds keep the generic tags');
    assert.equal(calendarTarget('/view/x1', '?view=week&embed'), null);
});

test('every value in the tags is escaped, and the block has the full set of tags', async () => {
    const { calendarMeta } = await src('meta.js');
    const block = calendarMeta('https://pastecal.com', { kind: 'edit', id: 'a"b<c>' },
        { title: 'T "q" <script>alert(1)</script> & \u0007', description: 'Sat Oct 25 · <img src=x onerror=alert(1)>', stamp: '7-20261024' });
    assert.ok(!/<script|<img/i.test(block), 'no markup gets through');
    assert.match(block, /<meta property="og:title" content="T &quot;q&quot; &lt;script&gt;alert\(1\)&lt;\/script&gt; &amp;">/);
    assert.match(block, /<meta property="og:url" content="https:\/\/pastecal\.com\/a%22b%3Cc%3E">/);
    assert.match(block, /<meta property="og:image" content="https:\/\/pastecal\.com\/og\/a%22b%3Cc%3E\.png\?v=7-20261024">/);
    for (const tag of ['og:site_name" content="pastecal"', 'og:image:width" content="1200"', 'og:image:height" content="630"',
        'twitter:card" content="summary_large_image"', 'og:description', 'twitter:image', '<link rel="canonical"']) {
        assert.ok(block.includes(tag), tag);
    }
    const view = calendarMeta('https://pastecal.com', { kind: 'view', id: 'v1' }, { title: 'X', description: 'Y', stamp: '1' });
    assert.match(view, /og:url" content="https:\/\/pastecal\.com\/view\/v1"/);
    assert.match(view, /og:image" content="https:\/\/pastecal\.com\/og\/view\/v1\.png/);
});

test('index.html carries the marked block once, and injection replaces exactly that block', async () => {
    const { injectMeta, metaBlock, META_START, META_END } = await src('meta.js');
    const html = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');
    assert.equal(html.split(META_START).length, 2);
    assert.equal(html.split(META_END).length, 2);
    const head = html.slice(html.indexOf(META_START), html.indexOf(META_END));
    for (const tag of ['og:site_name', 'og:image" content="https://pastecal.com/img/og-card.png"', 'og:image:width', 'twitter:card', '<title>']) assert.ok(head.includes(tag), tag);
    assert.equal((html.match(/<title>/g) || []).length, 1, 'the page title lives inside the block');
    const block = metaBlock({ title: 'Choir', description: 'd', url: 'https://pastecal.com/c', image: 'https://pastecal.com/og/c.png' });
    const out = injectMeta(html, block);
    assert.ok(out.includes('<title>Choir</title>'));
    assert.ok(!out.includes('The shared calendar nobody has to sign up for</title>'));
    assert.equal(out.slice(0, html.indexOf(META_START)), html.slice(0, html.indexOf(META_START)), 'before the block: unchanged');
    assert.ok(out.endsWith(html.slice(html.indexOf(META_END) + META_END.length)), 'after the block: unchanged');
    assert.equal(injectMeta('<html>no markers</html>', block), '<html>no markers</html>');
});

test('the description lists the next events with dates; no past events, no notes', async () => {
    const { describe } = await src('model.js');
    const d = describe(choir(), NOW);
    assert.equal(d, 'Sun Oct 25 · Sectionals · Tue Oct 27 · Full <b>rehearsal</b> · Sun Nov 1 · Concert');
    assert.ok(!d.includes('Last week') && !d.includes('Earlier today'), 'ended events are not shown');
    assert.ok(!d.includes('4321'), 'notes never appear');
    assert.equal(describe({ title: 'x', events: [choir().events[2]] }, NOW), 'No upcoming events');
    assert.equal(describe({ title: 'x', events: [] }, NOW), 'No upcoming events');
});

test('recurring events: the next occurrences, minus deleted ones, in the authors\' time zone', async () => {
    const { describe, cardModel } = await src('model.js');
    const cal = { title: 'Weekly', tz: 'America/Los_Angeles', events: [
        { id: 'w', title: 'Practice', start: at('2026-10-06', 18), end: at('2026-10-06', 19), recurrencerule: 'FREQ=WEEKLY;BYDAY=TU;INTERVAL=1;', recurrenceException: '20261028T010000Z' },
        { id: 'z', title: 'Zone hint', start: pdtMidnight('2026-09-01'), end: pdtMidnight('2026-09-02'), isAllDay: true },
    ] };
    // Tuesday Oct 27 6pm PDT (Oct 28 01:00Z) was deleted: next are Nov 3 and Nov 10 (6pm PST after the change).
    assert.equal(describe(cal, NOW), 'Tue Nov 3 · Practice · Tue Nov 10 · Practice · Tue Nov 17 · Practice');
    const m = cardModel(cal, NOW);
    assert.equal(m.events[0].time, '6pm', 'wall-clock time holds across daylight saving');
    assert.ok(m.more > 40, 'the rest of the series is counted');
});

test('card model: escaped-safe colors, Pro branding setting, fallback title', async () => {
    const { cardModel } = await src('model.js');
    const m = cardModel(choir(), NOW);
    assert.equal(m.events.length, 3);
    assert.deepEqual(m.events.map((e) => e.title), ['Sectionals', 'Full <b>rehearsal</b>', 'Concert']);
    assert.equal(m.events[1].color, '#e3165b', 'a stored color that is not a color falls back to the default palette');
    assert.equal(m.events[0].time, null);
    assert.equal(m.events[1].time, '7pm');
    assert.equal(m.more, 1);
    assert.equal(m.branded, true);
    assert.equal(cardModel({ ...choir(), pro: true, hideBranding: true }, NOW).branded, false);
    assert.equal(cardModel({ title: '   ', events: [] }, NOW).title, 'A shared calendar');
});

test('the card SVG escapes user text, drops characters XML forbids, and references nothing outside', async () => {
    const { calendarCard, siteCard, Pen } = await src('svg.js');
    const { FontSet, parseFont } = await src('fonts.js');
    const font = (w) => { const f = parseFont(fs.readFileSync(path.join(__dirname, `../../cloudflare/src/vendor/fonts/Figtree-${w}.ttf`))); f.family = 'Figtree'; return f; };
    const fsSet = new FontSet({ primary: { 500: font(500), 700: font(700), 800: font(800) } });
    const pen = new Pen(fsSet, {});
    const svg = calendarCard(pen, { title: 'A <script>x</script> & "q" \u0000\u0008\ud800', branded: true, more: 2,
        events: [{ title: '</text><image href="https://evil/x.png"/>', color: '"/><script>', day: Date.UTC(2026, 9, 25), time: '7pm' }] });
    assert.ok(!/<script|<image|href="/i.test(svg), 'no markup, links or images from user text');
    assert.ok(svg.includes('&lt;/text&gt;&lt;image href=&quot;'), 'it is shown as text');
    assert.ok(svg.includes('&lt;script&gt;'));
    assert.ok(!/[\u0000-\u0008]/.test(svg));
    assert.ok(!/[\ud800-\udfff]/.test(svg.replace(/[\ud800-\udbff][\udc00-\udfff]/g, '')), 'no lone surrogates');
    assert.match(svg, /fill="#3f51b5" fill-rule="evenodd"/, 'the logo, in the logo color');
    assert.match(svg, /width="1200" height="630"/);
    assert.ok(siteCard(pen).includes('Paste your link.'));
    // Long titles wrap to two lines and end with an ellipsis; nothing runs past the right edge.
    const long = calendarCard(pen, { title: 'Northside Elementary Parent Teacher Association Volunteer Schedule for the Entire School Year', events: [], branded: true });
    assert.equal((long.match(/font-size="56"/g) || []).length, 2);
    assert.ok(long.includes('…'));
});

test('the logo in the renderer is the app\'s logo, path for path', async () => {
    const { LOGO_PATH } = await src('logo.js');
    const file = fs.readFileSync(path.join(__dirname, '../../public/img/pastecal.logo.svg'), 'utf8');
    assert.equal(LOGO_PATH, file.match(/\sd="([^"]+)"/)[1].replace(/\s+/g, ' ').trim());
});

// What the room's preview route sends (CalendarRoom.previewData): the events plus the all-day starts.
// `raw: true` rooms answer as a room running older code would: the whole calendar.
const asPreview = (cal) => (cal.raw ? cal.body : { ...cal, zoneSamples: cal.events.filter((e) => e.isAllDay).map((e) => e.start) });

// A fake Worker env: a directory and rooms answering like the real ones.
function fakeEnv({ lookup = {}, rooms = {}, delayMs = 0, fail = false } = {}) {
    const later = (v) => new Promise((resolve, reject) => setTimeout(() => (fail ? reject(new Error('boom')) : resolve(v)), delayMs));
    return {
        DIRECTORY: { idFromName: () => 'g', get: () => ({ fetch: async (u) => later(Response.json(lookup[new URL(u).searchParams.get('slug')] || { found: false })) }) },
        CALENDARS: { idFromName: (n) => n, get: (n) => ({ fetch: async (u) => { assert.match(String(u), /^http:\/\/internal\/cal\/[^/]+\/preview$/); return later(rooms[n] ? Response.json(asPreview(rooms[n])) : Response.json({}, { status: 404 })); } }) },
    };
}
const page = () => new Response(fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8'), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });

test('calendar pages: tags about the calendar; edit and view links share the view-safe values', async () => {
    const { previewPage } = await src('page.js');
    const env = fakeEnv({ lookup: { ut6uc46ub4: { found: true, isReadOnly: true, targetId: 'choir', actualSlug: 'ut6uc46ub4' }, choir: { found: true, isReadOnly: false, targetId: 'choir', actualSlug: 'choir' } }, rooms: { choir: choir() } });
    const edit = await (await previewPage(new Request('https://pastecal.com/choir', { headers: { 'User-Agent': 'Slackbot-LinkExpanding 1.0' } }), env, page(), { kind: 'edit', id: 'choir' }, NOW)).text();
    const view = await (await previewPage(new Request('https://pastecal.com/view/ut6uc46ub4', { headers: { 'User-Agent': 'Slackbot-LinkExpanding 1.0' } }), env, page(), { kind: 'view', id: 'ut6uc46ub4' }, NOW)).text();
    assert.match(edit, /og:title" content="Riverside &quot;Youth&quot; &lt;Choir&gt; &amp; Friends"/);
    assert.match(edit, /og:description" content="Sun Oct 25 · Sectionals · Tue Oct 27 · Full &lt;b&gt;rehearsal&lt;\/b&gt; · Sun Nov 1 · Concert"/);
    assert.match(edit, /og:image" content="https:\/\/pastecal\.com\/og\/choir\.png\?v=7-20261024-AmericaLosAn"/);
    const desc = (h) => h.match(/og:description" content="([^"]*)"/)[1];
    assert.equal(desc(view), desc(edit));
    assert.ok(!view.includes('/choir'), 'a view link\'s tags never name the calendar behind it');
    assert.match(view, /og:url" content="https:\/\/pastecal\.com\/view\/ut6uc46ub4"/);
});

test('a missing, failing or slow calendar leaves the page exactly as it was', async () => {
    const { previewPage, BOT_BUDGET_MS } = await src('page.js');
    const PAGE_BUDGET_MS = BOT_BUDGET_MS;     // only preview fetchers wait for a calendar; people never do
    const original = await page().text();
    const cases = {
        missing: fakeEnv(),
        failing: fakeEnv({ fail: true, rooms: { choir: choir() } }),
        slow: fakeEnv({ delayMs: PAGE_BUDGET_MS + 300, lookup: { choir: { found: true, targetId: 'choir' } }, rooms: { choir: choir() } }),
        viewOfEditName: fakeEnv({ lookup: { choir: { found: true, isReadOnly: false, targetId: 'choir' } }, rooms: { choir: choir() } }),
        // Not in the directory: no room is asked (it would be created empty for every scanned path).
        notInDirectory: fakeEnv({ rooms: { choir: choir() } }),
        // A room on older code answers /preview with {v, calendar}: not mistaken for an empty calendar.
        olderRoom: fakeEnv({ lookup: { choir: { found: true, targetId: 'choir' } }, rooms: { choir: { raw: true, body: { v: 3, calendar: choir() } } } }),
    };
    for (const [name, env] of Object.entries(cases)) {
        const kind = name === 'viewOfEditName' ? 'view' : 'edit';
        const t = Date.now();
        const res = await previewPage(new Request('https://pastecal.com/choir', { headers: { 'User-Agent': 'Slackbot-LinkExpanding 1.0' } }), env, page(), { kind, id: 'choir' }, NOW);
        assert.equal(res.status, 200, name);
        assert.equal(await res.text(), original, name);
        assert.ok(Date.now() - t < PAGE_BUDGET_MS + 250, `${name}: waits no longer than the budget`);
    }
    // Not HTML (a 404 from the assets, say): passed through untouched.
    const notHtml = new Response('nope', { status: 404 });
    assert.equal(await previewPage(new Request('https://pastecal.com/x', { headers: { 'User-Agent': 'Slackbot-LinkExpanding 1.0' } }), fakeEnv(), notHtml, { kind: 'edit', id: 'x' }, NOW), notHtml);
});

test('link-preview fetchers wait longer than the page budget for the real tags (a miss is cached by them); people get the static page', async () => {
    const { previewPage, PAGE_BUDGET_MS, BOT_BUDGET_MS } = await src('page.js');
    const env = fakeEnv({ delayMs: PAGE_BUDGET_MS + 200, lookup: { choir: { found: true, targetId: 'choir' } }, rooms: { choir: choir() } });
    assert.ok(BOT_BUDGET_MS >= 1500);
    for (const ua of ['facebookexternalhit/1.1', 'Slackbot-LinkExpanding 1.0', 'Mozilla/5.0 (compatible; Discordbot/2.0)', 'WhatsApp/2.23', 'Twitterbot/1.0', 'LinkedInBot/1.0']) {
        const req = new Request('https://pastecal.com/choir', { headers: { 'User-Agent': ua } });
        const html = await (await previewPage(req, env, page(), { kind: 'edit', id: 'choir' }, NOW)).text();
        assert.match(html, /og:title" content="Riverside/, ua);
    }
    const person = new Request('https://pastecal.com/choir', { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) Safari/605.1.15' } });
    assert.ok(!(await (await previewPage(person, env, page(), { kind: 'edit', id: 'choir' }, NOW)).text()).includes('og:title" content="Riverside'));
});

test('the card version stamp changes with the calendar, the date and the branding setting', async () => {
    const { cardStamp } = await src('page.js');
    const a = cardStamp({ v: 7 }, NOW);
    assert.equal(a, '7-20261024');
    assert.notEqual(cardStamp({ v: 8 }, NOW), a);
    assert.notEqual(cardStamp({ v: 7 }, NOW + DAY), a);
    assert.notEqual(cardStamp({ v: 7, pro: true, hideBranding: true }, NOW), a);
});

// ---- the calendar's own time zone (options.tz), and never a guessed clock time ----
test('a calendar with its time zone: an LA 5pm practice is "Tue · 5pm" on the card and Tue Oct 27 in the description', async () => {
    const { cardModel, describe } = await src('model.js');
    const cal = { v: 3, title: 'Soccer', tz: 'America/Los_Angeles', events: [{ id: 'p', title: 'Practice', start: at('2026-10-27', 17), end: at('2026-10-27', 18), type: 1 }] };
    const m = cardModel(cal, NOW);
    assert.equal(m.events[0].time, '5pm');
    assert.equal(new Date(m.events[0].day).getUTCDay(), 2, 'Tuesday');
    assert.equal(describe(cal, NOW), 'Tue Oct 27 · Practice');
});

test('no stored time zone and no confident guess: dates and weekdays, no clock times (never a wrong time)', async () => {
    const { cardModel, describe, chooseZone } = await src('model.js');
    const cal = { v: 3, title: 'Soccer', events: [{ id: 'p', title: 'Practice', start: at('2026-10-27', 10), end: at('2026-10-27', 11), type: 1 }] };
    assert.equal(chooseZone(cal, null).noTimes, true);
    const m = cardModel(cal, NOW);
    assert.equal(m.events[0].time, null, 'no clock time');
    assert.equal(m.tzLabel, '');
    assert.equal(describe(cal, NOW), 'Tue Oct 27 · Practice');
    // One or two all-day events are not enough to trust a zone; three that agree are.
    const allDay = (d) => ({ id: d, title: 'x', start: pdtMidnight(d), end: pdtMidnight(d), isAllDay: true });
    assert.equal(chooseZone({ events: [allDay('2026-09-01'), allDay('2026-09-02')] }, null).noTimes, true);
    const three = { events: [allDay('2026-09-01'), allDay('2026-09-02'), allDay('2026-09-03'), cal.events[0]] };
    assert.deepEqual([chooseZone(three, null).tz, chooseZone(three, null).noTimes], ['America/Los_Angeles', false]);
    assert.equal(cardModel(three, NOW).events.find((e) => e.title === 'Practice').time, '10am');
    // An invalid stored zone is ignored, not trusted.
    assert.equal(chooseZone({ ...cal, tz: 'Mars/Olympus' }, null).noTimes, true);
});

test('the card stamp changes when a time zone is stored (it does not bump the version)', async () => {
    const { cardStamp } = await src('page.js');
    assert.notEqual(cardStamp({ v: 3 }, NOW), cardStamp({ v: 3, tz: 'America/Los_Angeles' }, NOW));
});

test('the app sends its time zone: on create (when the calendar has none) and with each save', () => {
    const cloud = fs.readFileSync(path.join(__dirname, '../../public/services/CloudCalendarService.js'), 'utf8');
    assert.match(cloud, /Intl\.DateTimeFormat\(\)\.resolvedOptions\(\)\.timeZone/);
    assert.match(cloud, /!body\.options\.tz\) body\.options = \{ \.\.\.body\.options, tz \}/, 'never replaces a tz the options already carry');
    assert.match(cloud, /t: 'save', id, v: room\.v, commands, author, writer, \.\.\.\(tz \? \{ tz \} : \{\}\)/);
});

// ---- cost: only link-preview fetchers get per-calendar tags; people get the static page with no lookup ----
function stubEnv(cal) {
    const calls = { directory: 0, room: 0 };
    const env = {
        DIRECTORY: { idFromName: () => 'g', get: () => ({ fetch: async () => { calls.directory++; return Response.json({ found: true, targetId: 'room-1', isReadOnly: false }); } }) },
        CALENDARS: { idFromName: () => 'r', get: () => ({ fetch: async () => { calls.room++; return Response.json(cal); } }) },
    };
    return { env, calls };
}
const pageRes = () => new Response(fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8'), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const req = (ua) => new Request('https://pastecal.com/soccer', { headers: { 'User-Agent': ua } });
const previewCal = { v: 4, title: 'U10 Soccer', tz: 'America/Los_Angeles', colors: null, zoneSamples: [], pro: false, hideBranding: false,
    events: [{ id: 'p', title: 'Practice', start: at('2026-10-27', 17), end: at('2026-10-27', 18), type: 1 }] };

test('a person opening a calendar link gets the static page at once: no directory or room lookup', async () => {
    const { previewPage } = await src('page.js');
    const { env, calls } = stubEnv(previewCal);
    for (const ua of ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', '']) {
        const html = await (await previewPage(req(ua), env, pageRes(), { kind: 'edit', id: 'soccer' }, NOW)).text();
        assert.ok(html.includes('The shared calendar nobody has to sign up for</title>'), 'the static tags');
        assert.ok(!html.includes('U10 Soccer'));
    }
    assert.deepEqual(calls, { directory: 0, room: 0 }, 'zero lookups for people');
});

test('link-preview fetchers get the calendar\'s tags, and the rendered tags are cached briefly', async () => {
    const { previewPage, isPreviewBot } = await src('page.js');
    const bots = ['facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)', 'Twitterbot/1.0', 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
        'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)', 'WhatsApp/2.23.20.0', 'LinkedInBot/1.0', 'TelegramBot (like TwitterBot)',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0',
        'Mozilla/5.0 (compatible; Applebot/0.1)', 'Mozilla/5.0 (compatible; Googlebot/2.1)', 'Mozilla/5.0 (compatible; bingbot/2.0)', 'SkypeUriPreview Preview/0.5',
        'Mozilla/5.0 (compatible; Embedly/0.2)', 'LinkPreview/1.0', 'OpenGraph.xyz checker'];
    for (const ua of bots) assert.ok(isPreviewBot(req(ua)), ua);
    const store = new Map();
    globalThis.caches = { default: { match: async (k) => (store.has(k.url) ? new Response(store.get(k.url)) : undefined), put: async (k, r) => { store.set(k.url, await r.text()); } } };
    try {
        const { env, calls } = stubEnv(previewCal);
        const html = await (await previewPage(req(bots[2]), env, pageRes(), { kind: 'edit', id: 'soccer' }, NOW)).text();
        assert.ok(html.includes('<title>U10 Soccer · pastecal</title>'));
        assert.match(html, /<meta name="description" content="Tue Oct 27 · Practice">/);
        assert.deepEqual(calls, { directory: 1, room: 1 });
        const again = await (await previewPage(req(bots[0]), env, pageRes(), { kind: 'edit', id: 'soccer' }, NOW)).text();
        assert.ok(again.includes('<title>U10 Soccer · pastecal</title>'));
        assert.deepEqual(calls, { directory: 1, room: 1 }, 'the second fetch is served from the cache');
    } finally { delete globalThis.caches; }
});
