/**
 * One rule for when two spellings are the same calendar name: public/services/CalendarName.js key().
 *
 * Until Oct 2026 it was written three ways: the directory lowercased ("royal city " and "royal city" were two rows),
 * the registry trimmed and lowercased, the pages lowercased; none normalized Unicode, so the NFD "Nuñez" some phones
 * send was not the NFC "Nuñez" stored. Now the Worker imports the same file the pages load.
 *   1. the key of real-world tricky names (table)
 *   2. every code point: key(key(x)) === key(x), and NFD and NFC spellings key alike
 *   3. the server's directory key (SlugService.normalizeSlug), the registry and the pages' checks use it
 *   4. guard: nothing else in cloudflare/src or public lowercases a calendar, view or handle name (every lowercasing
 *      is listed here with its reason; a new one, or a stale entry, fails)
 *
 * Run: node --test test/unit/name-key.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', '..');
const CalendarName = require('../../public/services/CalendarName.js');
const { key } = CalendarName;
const NFD = (s) => s.normalize('NFD');

// [name, its key, why]
const TABLE = [
    ['Nuñez', 'nuñez', 'NFC (one code point ñ)'],
    [NFD('Nuñez'), 'nuñez', 'NFD (n + combining tilde, some phones) keys as the NFC spelling'],
    ['TEAM NUÑEZ', 'team nuñez', 'real name; inner space kept'],
    [NFD('TEAM NUÑEZ'), 'team nuñez', 'its NFD spelling'],
    ['  soccer', 'soccer', 'leading spaces trimmed'],
    ['soccer  ', 'soccer', 'trailing spaces trimmed'],
    ['Soccer', 'soccer', 'case'],
    ['SOCCER', 'soccer', 'case'],
    [' soccer　', 'soccer', 'NBSP and the ideographic space are surrounding spaces too'],
    ['royal city', 'royal city', 'one inner space'],
    ['royal  city', 'royal  city', 'two inner spaces: another name'],
    ['Royal City ', 'royal city', 'trailing space and case'],
    ['d&d8', 'd&d8', '& kept'],
    ['50%off', '50%off', '% kept'],
    ['50% Off', '50% off', '% and a space'],
    ['a+b', 'a+b', '+ kept (a literal plus, never a space)'],
    ['a?b', 'a?b', '? kept: a name may hold it (validId allows it; the path is percent-encoded)'],
    ['강아지봉사', '강아지봉사', 'Korean: no case, unchanged (and NFC keeps each syllable one character)'],
    [NFD('강아지봉사'), '강아지봉사', 'Korean decomposed into jamo keys as the syllables'],
    ['🎉 Party', '🎉 party', 'emoji kept'],
    ['İstanbul', 'i̇stanbul', 'Turkish capital dotted I: locale-free lowercase, i + combining dot'],
    ['ISTANBUL', 'istanbul', 'so it is another name than İstanbul (as written; no Turkish locale rules)'],
    ['Straße', 'straße', 'ß kept (no case folding to ss)'],
    ['STRASSE', 'strasse', 'another name than Straße'],
    ['STRAẞE', 'straße', 'capital sharp s lowercases to ß: the same name as Straße'],
    ['ΟΔΟΣ', 'οδος', 'Greek: final sigma at the end of a word'],
    ['ΟΔΟΣ ΚΑΛΗ', 'οδος καλη', 'final sigma before a space'],
    ['Å', 'å', 'the Angstrom sign is canonically Å (NFC)'],
    ['ﬁsh', 'ﬁsh', 'NFKC is NOT applied: the ligature stays'],
    ['ＡＢＣ', 'ａｂｃ', 'full-width letters lowercase but stay full-width (no NFKC)'],
    ['', '', 'empty'],
    [null, '', 'null'],
    [undefined, '', 'undefined'],
];

test('the key of real-world tricky names', () => {
    for (const [name, want, why] of TABLE) assert.equal(key(name), want, `${JSON.stringify(name)}: ${why}`);
    assert.notEqual(key('royal city'), key('royal  city'), 'two inner spaces stay distinct');
    assert.notEqual(key('İstanbul'), key('ISTANBUL'));
    assert.notEqual(key('Straße'), key('STRASSE'));
    assert.equal(CalendarName.same('  Soccer', 'SOCCER '), true);
    assert.equal(CalendarName.same(NFD('Nuñez '), 'NUÑEZ'), true);
});

test('every code point: keys are fixed points, and NFD and NFC spellings key alike', () => {
    let checked = 0;
    for (let cp = 0; cp < 0x30000; cp++) {
        if (cp >= 0xd800 && cp <= 0xdfff) continue;
        for (const pre of ['', 'Σ', 'a ']) {
            for (const mark of ['', '́', '̇', 'ͅ', '̈́']) {
                const s = pre + String.fromCodePoint(cp) + mark;
                const k = key(s);
                if (key(k) !== k) assert.fail(`not a fixed point: U+${cp.toString(16)} ${JSON.stringify(mark)}`);
                if (key(s.normalize('NFD')) !== k || key(s.normalize('NFC')) !== k) assert.fail(`NFD/NFC differ: U+${cp.toString(16)} ${JSON.stringify(mark)}`);
                if (k !== k.normalize('NFC')) assert.fail(`key not NFC: U+${cp.toString(16)}`);
                checked++;
            }
        }
    }
    assert.ok(checked > 2e6);
});

test('legacyKey is the old lowercase-only key; newName lowercases and NFCs a new name but never trims (stress A19)', () => {
    assert.equal(CalendarName.legacyKey('Royal City '), 'royal city ');
    assert.equal(CalendarName.newName('Royal City '), 'royal city ');
    assert.equal(CalendarName.newName(NFD('Nuñez')), 'nuñez');
    assert.equal(CalendarName.newName(NFD('Nuñez')).length, 5);
});

test('the server: the directory key, reserved words and handles use CalendarName.key', async () => {
    const { SlugService, nameProblem, namesSkeleton } = await import(path.join(root, 'cloudflare/src/SlugService.js'));
    for (const [name, want] of TABLE) assert.equal(SlugService.normalizeSlug(name), want, JSON.stringify(name));
    assert.equal(SlugService.legacySlugKey('Royal City '), 'royal city ');
    assert.equal(SlugService.isReserved(' API '), true, 'a reserved word with spaces around it is still reserved');
    assert.equal(nameProblem(' Kalid ', 'handle'), null, 'a handle is trimmed and lowercased by the key');
    assert.equal(namesSkeleton(' Past-ecaI '), namesSkeleton('pastecal'));
    const src = fs.readFileSync(path.join(root, 'cloudflare/src/CalendarDirectory.js'), 'utf8');
    assert.match(src, /import CalendarName from '\.\.\/\.\.\/public\/services\/CalendarName\.js'/, 'the directory imports the pages\' file');
    assert.match(src, /INSERT INTO rooms \(id, name_key, source, created_at\) VALUES \(\?, \?, \?, \?\)`, id, key\(id\)/, 'the registry\'s name_key is the key');
});

test('the pages load CalendarName.js before SlugManager.js (index and nativecal)', () => {
    for (const f of ['public/index.html', 'public/nativecal/index.html']) {
        const html = fs.readFileSync(path.join(root, f), 'utf8');
        const a = html.indexOf('/services/CalendarName.js'), b = html.indexOf('/services/SlugManager.js');
        assert.ok(a > 0 && a < b, `${f}: CalendarName.js, then SlugManager.js`);
    }
});

test('the page\'s checks compare names by key: a view link name, its own calendar\'s name, suggestions', () => {
    const ctx = vm.createContext({ console });
    vm.runInContext(fs.readFileSync(path.join(root, 'public/services/CalendarName.js'), 'utf8'), ctx);
    vm.runInContext(fs.readFileSync(path.join(root, 'public/services/SlugManager.js'), 'utf8') + ';this.SlugManager = SlugManager;', ctx);
    const S = ctx.SlugManager;
    assert.equal(S.viewNameProblem('team-a', 'Team-A '), 'That’s already this link’s name.');
    assert.equal(S.viewNameProblem('soccer', 'other', 'Soccer '), S.OWN_NAME_MESSAGE, 'calendar "Soccer " (a trailing space) is the name soccer');
    assert.equal(S.viewNameProblem('soccer', 'other', NFD('soccer')), S.OWN_NAME_MESSAGE);
    assert.equal(S.newCalendarName('Royal City '), 'royal city ', 'a new calendar keeps its trailing space (A19)');
    assert.deepEqual([...S.suggestSlugs('  Soccer ', 2026)].slice(0, 1), ['soccer-2']);
});

// ---- the guard ----------------------------------------------------------------------------------------------------
// Every lowercasing in cloudflare/src and public (vendor and the retired js-old-components excepted), outside
// CalendarName.js. A name is lowercased ONLY through CalendarName (key, legacyKey, newName). Each entry: the file, a
// text found on the line (each listed line must exist: a stale entry fails), and why it is not a name's key.
const NOT_A_NAME = 'not a calendar, view or handle name';
const STORAGE = 'a browser storage key: its formula is what earlier visits stored under, and changing it would lose them (an editor key lost = a locked calendar that can no longer be edited)';
const ALLOW = [
    // whole files that never handle a name
    ['cloudflare/src/TestInbox.js', '*', 'email headers and addresses'],
    ['cloudflare/src/RoomInsight.js', '*', 'IP addresses and referrer hosts'],
    ['cloudflare/src/preview/text.js', '*', 'colors'],
    ['public/selftest.js', '*', 'tag names'],
    ['public/services/EventZone.js', '*', 'time zone search'],
    ['public/services/ICSImport.js', '*', 'Windows time zone names'],
    ['public/utils/utils.js', '*', 'locales, units and search folding of event text'],
    ['public/nativecal/components/cardKit.js', '*', 'typed times and dates'],
    ['public/nativecal/components/NativeCalendar.js', '*', 'settings values and time labels'],
    ['public/account.html', '*', 'the word "delete" typed to confirm'],
    ['public/dev/pro.js', '*', 'an email'],
    ['public/demo/views.html', '*', 'button labels'],
    // single lines
    ['cloudflare/src/Accounts.js', "get('Content-Type')", 'a header'],
    ['cloudflare/src/Accounts.js', 'email', 'emails'],
    ['cloudflare/src/Accounts.js', "'sub_dev_' + body.calendarId.toLowerCase()", 'a fake subscription id built for tests (ACCOUNTS_DEV_MODE), never a key'],
    ['cloudflare/src/index.js', "k.toLowerCase().startsWith('x-pc-')", 'header names'],
    ['cloudflare/src/index.js', 'const email', 'an email'],
    ['cloudflare/src/CalendarRoom.js', 't.accent.toLowerCase()', 'a theme color'],
    ['cloudflare/src/CalendarDirectory.js', "SQL's lower() knows only ASCII", 'a comment saying why SQL lower() is not used'],
    ['public/app.js', 'window.location.href.toLowerCase()', 'reads ?v= / ?view= query options (the name in the path is read elsewhere, exactly)'],
    ['public/app.js', "(q.get('v') || q.get('view') || '').toLowerCase()", 'a view option'],
    ['public/app.js', "e.key.toLowerCase() === 'z'", 'a key press'],
    ['public/app.js', 'const k = e.key.toLowerCase()', 'a key press'],
    ['public/app.js', 'view_param.toLowerCase()', 'a view option'],
    ['public/app.js', 'unitParam.slice(1).toLowerCase()', 'a unit option'],
    ['public/app.js', 'buttonLabel.toLowerCase()', 'a button label'],
    ['public/app.js', "String(source).toLowerCase().normalize('NFKD')", 'builds a NEW ASCII name suggestion from a title ("Soccer Fall 2026" -> "soccer-fall-2026"); not a key'],
    ['public/app.js', 'x.toLowerCase()', 'am/pm'],
    ['public/app.js', 'currentView.toLowerCase()', 'a view option'],
    ['public/app.js', 'customViewMatch[2].toLowerCase()', 'a unit'],
    ['public/app.js', "navigator.language || 'en-US').toLowerCase()", 'a locale'],
    ['public/app.js', 'p.charAt(0).toLowerCase()', 'sentence text'],
    ['public/app.js', 'parts[0].toLowerCase()', 'a locale'],
    ['public/app.js', 'locale.toLowerCase()', 'a locale'],
    ['public/app.js', ".replace(/\\W+/g, '_').toLowerCase()", 'an analytics field name'],
    ['public/app.js', 'UPGRADE[String(c).toLowerCase()]', 'a color'],
    ['public/app.js', 'const v = val.trim().toLowerCase()', 'a typed setting'],
    ['public/app.js', 'el.tagName.toLowerCase()', 'a tag name'],
    ['public/app.js', "'pastecal_pro_welcomed:' + String(this.calendar.id).toLowerCase()", STORAGE],
    ['public/app.js', "'pastecal_editor_link:' + String(this.calendar.id).toLowerCase()", STORAGE],
    ['public/app.js', "'pc_notes_hidden:' + String(this.calendar.id).toLowerCase()", STORAGE],
    ['public/nativecal/app.js', "this.urlParams.get('v') || '').toLowerCase()", 'a view option'],
    ['public/nativecal/app.js', "this.urlParams.get('unit') || '').toLowerCase()", 'a unit option'],
    ['public/nativecal/app.js', "e.key.toLowerCase() === 'z'", 'a key press'],
    ['public/nativecal/app.js', 'parts[0].toLowerCase()', 'a locale'],
    ['public/nativecal/app.js', 'locale.toLowerCase()', 'a locale'],
    ['public/nativecal/app.js', 'const v = val.trim().toLowerCase()', 'a typed setting'],
    ['public/nativecal/app.js', 'el.tagName.toLowerCase()', 'a tag name'],
    ['public/components/Pro.js', "String(id).toLowerCase() + '|' + feature", STORAGE],
    ['public/components/Pro.js', "String(id).toLowerCase() + '#' + name", STORAGE],
    ['public/components/Pro.js', "'pastecal_editor_link:' + String(this.calendarId).toLowerCase()", STORAGE],
    ['public/components/ProInsight.js', 'String(id).toLowerCase()', STORAGE + ' (the intent saved across a page change)'],
    ['public/services/EditorKeys.js', 'String(id', STORAGE + ' (must match the inline writer in index.html)'],
    ['public/index.html', "decodeURIComponent(location.pathname.split('/').filter(Boolean)[0] || '').toLowerCase()", STORAGE + ' (must match EditorKeys.js)'],
    ['public/pro/done.html', "'pastecal_editor_link:' + proCalendar.toLowerCase()", STORAGE],
    ['public/pro/done.html', 'String(c.id).toLowerCase() === proCalendar.toLowerCase()', 'picks a title to show for the calendar just upgraded (the page loads no services); a miss shows the id'],
    ['public/pricing.html', 'const k = c.id.toLowerCase()', 'ids here pass ID (/^[A-Za-z0-9_-]{1,100}$/): ASCII, no spaces, so the key is the lowercase; the page loads no services'],
    ['public/pricing.html', 'RESERVED.has(id.toLowerCase())', 'the same ASCII-only ids (ID test first)'],
    ['public/services/CloudCalendarService.js', 'new URL(ref).hostname.toLowerCase()', 'a referrer host'],
    ['public/utils/analytics.js', 'id !== id.toLowerCase()', 'tells a random 5-character id (mixed case) from a chosen one; a property, not a key'],
];
const LOWER = /\.toLowerCase\s*\(|\.toLocaleLowerCase\s*\(|\blower\s*\(/i;

function files(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (!['vendor', 'js-old-components', 'node_modules'].includes(e.name)) files(p, out); }
        else if (/\.(js|mjs|html)$/.test(e.name)) out.push(p);
    }
    return out;
}

test('guard: no calendar, view or handle name is lowercased outside CalendarName.js', () => {
    const used = new Set(), bad = [];
    for (const f of [...files(path.join(root, 'cloudflare/src')), ...files(path.join(root, 'public'))]) {
        const rel = path.relative(root, f);
        if (rel === 'public/services/CalendarName.js') continue;
        fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
            if (!LOWER.test(line)) return;
            const hit = ALLOW.findIndex(([file, text]) => file === rel && (text === '*' || line.includes(text)));
            if (hit < 0) bad.push(`${rel}:${i + 1}: ${line.trim().slice(0, 140)}`);
            else used.add(hit);
        });
    }
    assert.deepEqual(bad, [], `Lowercasing outside CalendarName.js. A name's key is CalendarName.key(name) (CalendarName.same(a, b) to compare);
if this is not a name, list it in ALLOW with why:\n  ${bad.join('\n  ')}`);
    const stale = ALLOW.filter((_, i) => !used.has(i)).map(([f, t]) => `${f}: ${t}`);
    assert.deepEqual(stale, [], 'ALLOW entries that match nothing any more (remove them)');
});

test('guard: one shared file -- the Worker imports the pages\' CalendarName.js, and nobody defines a key of its own', () => {
    for (const f of files(path.join(root, 'cloudflare/src'))) {
        const src = fs.readFileSync(f, 'utf8');
        if (/CalendarName\.\w+\(/.test(src)) assert.match(src, /import CalendarName from '(\.\.\/)+public\/services\/CalendarName\.js'/, path.relative(root, f));
        assert.doesNotMatch(src, /const nameKey\s*=/, `${path.relative(root, f)}: use CalendarName.key`);
    }
    assert.equal(fs.readdirSync(path.join(root, 'cloudflare/src')).filter((f) => /CalendarName/i.test(f)).length, 0, 'no copy in the Worker');
});
