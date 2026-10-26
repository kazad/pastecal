/**
 * GUARD (root 5, Oct 26 2026): every date and time a person may type into the native card's pickers, as one table of
 * (input, locale, today, expected). The parser (public/nativecal/components/cardKit.js TIME_FORMS, DATE_FORMS, the
 * look-ahead rules under them, and endAt for an end time's day) is one table too; each of its rows must be exercised here, so a new form comes with
 * its cases.
 *
 * Why: the forms were added one bug at a time -- F11 (an end before the start), F12 ("jan 5" in October), F20
 * ("13/10"), S05 (an 11 PM - midnight event's end "11:30p" read on the next day: 24h 30m), S08 (de-DE "28.10."
 * refused, the dots read as spaces) -- each fixed where it was found, the next form still missing.
 * Run: node --test test/unit/typed-forms.test.js
 */
process.env.TZ = 'America/Los_Angeles';
const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('../../public/nativecal/components/cardKit.js');

const SAT = '2026-10-24';   // Saturday Oct 24 2026
const day = (s) => { const [y, m, d] = s.split('-').map(Number); return K.wallDate(y, m - 1, d); };   // (the card's dates are wall values)
const ymd = (d) => d && `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
const hm = (m) => m == null ? null : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

// [input, locale, today, expected date (or null: refused), the month shown when not today's]
const DATES = [
  ['today', 'en-US', SAT, '2026-10-24'],
  ['Today', 'de-DE', SAT, '2026-10-24'],
  ['tomorrow', 'en-US', SAT, '2026-10-25'],
  ['tmrw', 'en-US', SAT, '2026-10-25'],
  ['yesterday', 'en-US', SAT, '2026-10-23'],
  ['fri', 'en-US', SAT, '2026-10-30'],
  ['Friday', 'en-GB', SAT, '2026-10-30'],
  ['saturday', 'en-US', SAT, '2026-10-31'],              // the next one, never today
  ['mon', 'en-US', '2026-12-30', '2027-01-04'],         // across New Year
  ['2026-10-28', 'en-US', SAT, '2026-10-28'],
  ['2026-10-28', 'de-DE', SAT, '2026-10-28'],
  ['2027-2-3', 'en-US', SAT, '2027-02-03'],
  ['2026-02-30', 'en-US', SAT, null],
  // Day first with dots: German, Polish, Russian, Czech... (S08)
  ['28.10.', 'de-DE', SAT, '2026-10-28'],
  ['28.10', 'de-DE', SAT, '2026-10-28'],
  ['28.10.2026', 'de-DE', SAT, '2026-10-28'],
  ['28.10.26', 'de-DE', SAT, '2026-10-28'],
  ['5.1.', 'de-DE', SAT, '2027-01-05'],                 // the coming January
  ['28.10.', 'en-US', SAT, '2026-10-28'],               // dots are day first wherever they are typed
  ['10.28.', 'de-DE', SAT, null],                       // no 28th month
  ['31.2.', 'de-DE', SAT, null],
  // Slashes: month first in en-US, day first in day-first locales, and whichever is possible anywhere.
  ['10/28', 'en-US', SAT, '2026-10-28'],
  ['10/28/2026', 'en-US', SAT, '2026-10-28'],
  ['2/3/27', 'en-US', SAT, '2027-02-03'],
  ['5/10', 'en-US', SAT, '2027-05-10'],
  ['5/10', 'en-GB', SAT, '2026-10-05'],
  ['5/10', 'de-DE', SAT, '2026-10-05'],
  ['5/10', 'fr-FR', SAT, '2026-10-05'],
  ['10/5', 'ja-JP', SAT, '2026-10-05'],                 // year-first locales write month before day
  ['28/10', 'en-GB', SAT, '2026-10-28'],
  ['28/10', 'en-US', SAT, '2026-10-28'],                // only day-first reads (F20)
  ['13/10', 'en-US', SAT, '2026-10-13'],
  ['10/13', 'en-US', SAT, '2026-10-13'],
  ['10/13', 'en-GB', SAT, '2026-10-13'],                // only month-first reads
  ['28/10/2026', 'en-GB', SAT, '2026-10-28'],
  ['10-28', 'en-US', SAT, '2026-10-28'],
  ['13/13', 'en-US', SAT, null],
  // Month names (English), either order, with or without a year.
  ['oct 28', 'en-US', SAT, '2026-10-28'],
  ['Oct 28', 'de-DE', SAT, '2026-10-28'],
  ['October 28, 2027', 'en-US', SAT, '2027-10-28'],
  ['oct 28th', 'en-US', SAT, '2026-10-28'],
  ['28 oct', 'en-GB', SAT, '2026-10-28'],
  ['28 October 2027', 'en-GB', SAT, '2027-10-28'],
  ['28. oct', 'de-DE', SAT, '2026-10-28'],
  ['feb 30', 'en-US', SAT, null],
  ['feb 29', 'en-US', SAT, '2028-02-29'],               // the next leap year
  // Look-ahead without a year (F12): the coming one, or one in the last few weeks; the month shown counts.
  ['jan 5', 'en-US', SAT, '2027-01-05'],
  ['1/5', 'en-US', SAT, '2027-01-05'],
  ['apr 5', 'en-US', SAT, '2027-04-05'],
  ['oct 20', 'en-US', SAT, '2026-10-20'],
  ['oct 30', 'en-US', SAT, '2026-10-30', '2026-11-01'],
  ['mar 3', 'en-US', SAT, '2028-03-03', '2028-03-01'],
  ['dec 30', 'en-US', '2027-01-05', '2026-12-30'],
  // A lone number is that day of the month shown.
  ['5', 'en-US', SAT, '2026-12-05', '2026-12-09'],
  ['28', 'de-DE', SAT, '2026-10-28'],
  ['31', 'en-US', SAT, null, '2026-11-01'],
  // Refused.
  ['', 'en-US', SAT, null],
  ['someday', 'en-US', SAT, null],
  ['next week', 'en-US', SAT, null],
];

// [input, clock ('12' or '24'), expected minutes as HH:MM (or null: refused)]
const TIMES = [
  ['5p', '12', '17:00'], ['5 pm', '12', '17:00'], ['5 p.m.', '12', '17:00'], ['5:30 pm', '12', '17:30'], ['530p', '12', '17:30'],
  ['9:15a', '12', '09:15'], ['11 PM', '12', '23:00'], ['12a', '12', '00:00'], ['12p', '12', '12:00'], ['12:30 AM', '12', '00:30'],
  ['noon', '12', '12:00'], ['Midnight', '24', '00:00'],
  ['5:30', '12', '17:30'], ['9', '12', '09:00'], ['07:00', '12', '07:00'], ['17:30', '12', '17:30'], ['17.30', '24', '17:30'], ['1730', '24', '17:30'],
  ['5', '24', '05:00'], ['0', '24', '00:00'], ['23:59', '24', '23:59'],
  ['', '12', null], ['25', '12', null], ['13pm', '12', null], ['0p', '12', null], ['5:75', '12', null], ['24:00', '24', null], ['soon', '12', null],
];

// The end time look-ahead (cardKit.endAt, read against the start): [start, end, typed, expected end (wall time) or null]
const ENDS = [
  ['2026-10-27 23:00', '2026-10-28 00:00', '11:30p', '2026-10-27 23:30'],   // S05: 11 PM - midnight, not 24h 30m
  ['2026-10-27 23:00', '2026-10-27 23:30', '1a', '2026-10-28 01:00'],       // F11: before the start = after midnight
  ['2026-10-27 23:00', '2026-10-28 00:00', 'midnight', '2026-10-28 00:00'],
  ['2026-10-27 22:00', '2026-10-28 02:00', '11p', '2026-10-28 23:00'],      // an end past midnight keeps its own date
  ['2026-10-27 22:00', '2026-10-28 02:00', '3a', '2026-10-28 03:00'],
  ['2026-10-27 17:00', '2026-10-27 18:00', '7p', '2026-10-27 19:00'],
  ['2026-10-27 17:00', '2026-10-27 18:00', '5p', null],                     // the start itself
  ['2026-10-26 10:00', '2026-10-28 15:00', '4p', '2026-10-28 16:00'],       // a longer event keeps the day it ends
  ['2026-10-26 10:00', '2026-10-28 15:00', '9a', '2026-10-28 09:00'],
  ['2026-03-08 00:30', '2026-03-08 01:00', '2:30a', null],                // a time Los Angeles skips that day
];
const at = (s) => { const [d, t] = s.split(' '); const [h, m] = t.split(':').map(Number); return K.at(day(d), h * 60 + m); };
const local = (d) => d && `${ymd(d)} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;

test('every typed date: (input, locale, today) -> date', () => {
  const got = DATES.map(([s, loc, today, , ref]) => ymd(K.parseDate(s, day(today), ref ? day(ref) : day(today), loc)));
  assert.deepEqual(got.map((g, i) => `${DATES[i][0]} (${DATES[i][1]}) -> ${g}`), DATES.map((r) => `${r[0]} (${r[1]}) -> ${r[3]}`));
});

test('every typed time: (input, clock) -> minutes', () => {
  assert.deepEqual(TIMES.map(([s, f]) => `${s} (${f}) -> ${hm(K.parseTime(s, f))}`), TIMES.map(([s, f, want]) => `${s} (${f}) -> ${want}`));
});

test('an end time typed: the look-ahead decides its day', () => {
  assert.deepEqual(ENDS.map(([s, e, typed]) => `${s}-${e} "${typed}" -> ${local(K.endAt(at(s), at(e), K.parseTime(typed), 'America/Los_Angeles'))}`),
    ENDS.map(([s, e, typed, want]) => `${s}-${e} "${typed}" -> ${want}`));
});

test('the locale\'s order comes from Intl', () => {
  assert.deepEqual(['en-US', 'en-GB', 'de-DE', 'fr-FR', 'ja-JP', 'zh-CN', 'en-CA', undefined].map(K.dateOrder), ['mdy', 'dmy', 'dmy', 'dmy', 'ymd', 'ymd', K.dateOrder('en-CA'), K.dateOrder(undefined)]);
});

test('each form in the parser is exercised by a row above (a new form comes with its cases)', () => {
  const dateText = (s) => String(s).trim().toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ');
  const timeText = (s) => String(s).trim().toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ');
  const firstDate = (s) => K.DATE_FORMS.findIndex((f) => f.re.test(dateText(s)));
  const firstTime = (s) => K.TIME_FORMS.findIndex((f) => f.re.test(timeText(s)));
  const dates = new Set(DATES.filter((r) => r[3]).map((r) => firstDate(r[0])));
  const times = new Set(TIMES.filter((r) => r[2]).map((r) => firstTime(r[0])));
  assert.deepEqual(K.DATE_FORMS.map((f, i) => `${f.form}: ${dates.has(i)}`), K.DATE_FORMS.map((f) => `${f.form}: true`));
  assert.deepEqual(K.TIME_FORMS.map((f, i) => `${f.form}: ${times.has(i)}`), K.TIME_FORMS.map((f) => `${f.form}: true`));
});
