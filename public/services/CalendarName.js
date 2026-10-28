/**
 * CalendarName -- the one rule for when two spellings are the same calendar name.
 *
 *   key(name)        the name's key: surrounding spaces trimmed, lowercased, Unicode NFC. "Soccer", "SOCCER",
 *                    "  soccer" and "soccer " share the key "soccer"; "royal  city" (two inner spaces) stays its own.
 *                    Used by the directory (its `normalized` column and the rooms registry's name_key), every
 *                    reserved-word and view-name check, and every comparison of two names, in the Worker and the pages.
 *   legacyKey(name)  the directory's key before Oct 2026 (lowercase only). Read as a fallback until every row is
 *                    re-keyed (scripts/rekey-directory.mjs); never written.
 *   newName(typed)   the exact name a NEW calendar is saved under, from the app's name box: lowercased and NFC, never
 *                    trimmed (a name that came from the address, "royal city ", is kept: stress A19). Not a key.
 *
 * A key only decides which spellings count as one name. A calendar's stored id never changes: its data lives at
 * idFromName(exact id), so "Foo" and "foo" stay two calendars, each opening at its own exact name (ExactNames.js),
 * and any other spelling with the same key follows the directory.
 *
 * Why exactly this, and nothing more (real names, Oct 2026: 1,742 of 5,077 with capitals, 40 with surrounding
 * spaces, 110 with inner spaces, 33 non-ASCII such as "TEAM NUÑEZ" and "강아지봉사"):
 *   - trim: a space before or after a name is invisible in a link and on a page; people never mean two calendars.
 *     String.prototype.trim also removes NBSP and the ideographic space (U+3000) that phone keyboards insert.
 *   - inner spaces kept: "royal city" and "royal  city" look different when typed, and folding them would merge
 *     calendars that exist today for nothing anyone asked for.
 *   - NFC: "ñ" typed as one character or as "n" + a combining tilde (some phones, macOS file names) is the same
 *     letter. NFC, not NFKC: compatibility folding would merge "ﬁ" with "fi" and full-width with ASCII letters,
 *     which are different names to their owners (no real case asks for it).
 *   - toLowerCase, not toLocaleLowerCase: the same answer on every server and browser, whatever the locale. So
 *     "İstanbul" keys as "i̇stanbul" (with a combining dot) and "ISTANBUL" as "istanbul": two names, as written.
 *     No full case folding: "Straße" and "STRASSE" stay two names ("ẞ", the capital sharp s, lowercases to "ß",
 *     so "STRAẞE" is "Straße"); Greek "ΟΔΟΣ" keys with its final sigma ("οδος"), as lowercase Greek is written.
 *   - NFC last: lowercasing can leave a sequence NFC would reorder (Greek letters with an iota subscript), so
 *     normalizing after it makes every key a fixed point (key(key(x)) === key(x)) and makes the NFD and NFC
 *     spellings of any name key alike (test/unit/name-key.test.js checks both over every code point).
 *
 * Pure. Loaded as a script (window.CalendarName), required by node tests, imported by the Worker -- one file, so the
 * pages and the server can never disagree. test/unit/name-key.test.js fails if a calendar, view or handle name is
 * lowercased anywhere else.
 */
(function (root) {
    'use strict';
    const CalendarName = {
        key: (name) => String(name ?? '').trim().toLowerCase().normalize('NFC'),
        legacyKey: (name) => String(name ?? '').toLowerCase(),
        newName: (typed) => String(typed ?? '').toLowerCase().normalize('NFC'),
        same: (a, b) => CalendarName.key(a) === CalendarName.key(b),
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = CalendarName;
    else root.CalendarName = CalendarName;
})(typeof window !== 'undefined' ? window : globalThis);
