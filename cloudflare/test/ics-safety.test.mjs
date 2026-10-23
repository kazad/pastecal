// ICS feed line safety (ICSService), plain node: `node test/ics-safety.test.mjs`.
// Every value written into the feed must stay on its own content line: a stored id, rule or
// title holding CR/LF must not be able to start a new property or a new VEVENT.
import assert from 'node:assert/strict';
import { ICSService } from '../src/ICSService.js';

let n = 0; const step = (s) => console.log(`  ok ${++n} - ${s}`);
const at = (d, h) => new Date(Date.UTC(2026, 9, d, h)).toISOString();
const INJECT = '\r\nBEGIN:VEVENT\r\nSUMMARY:x';
const unfold = (ics) => ics.replace(/\r\n[ \t]/g, '');
const lines = (ics) => unfold(ics).split('\r\n');
const count = (ics, line) => lines(ics).filter((l) => l === line).length;
// Every logical line is NAME[;params]:value, and the only line breaks are the CRLFs between lines.
const wellFormed = (ics) => {
    assert.ok(!/\r(?!\n)|(?<!\r)\n/.test(ics), 'a bare CR or LF reached the feed');
    for (const l of lines(ics)) assert.match(l, /^[A-Z-]+[;:]/, `malformed line: ${JSON.stringify(l)}`);
    assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(unfold(ics).replace(/\r\n/g, '')), 'a control character reached the feed');
};

// 1. Injection attempts through id, recurrenceID, recurrencerule, title, description and the calendar title.
const cal = {
    title: `Team${INJECT}`,
    events: [
        { id: `evil${INJECT}`, title: `Party${INJECT}`, description: `bring\u0000snacks${INJECT}\u0007`, start: at(5, 10), end: at(5, 11) },
        { id: 'series1', title: 'Standup', start: at(6, 9), end: at(6, 10), recurrencerule: `FREQ=DAILY;COUNT=3${INJECT}` },
        { id: 'series2', title: 'Weekly', start: at(7, 9), end: at(7, 10), recurrencerule: 'FREQ=WEEKLY;BYDAY=WE;INTERVAL=1;UNTIL=20261231T000000Z' },
        { id: 'occ1', recurrenceID: `series2${INJECT}`, recurrenceException: '20261014T090000Z', title: 'Moved', start: at(14, 11), end: at(14, 12) },
    ],
};
const ics = ICSService.generateICS(cal, 'team');
wellFormed(ics);
assert.equal(count(ics, 'BEGIN:VEVENT'), 4, 'exactly one VEVENT per stored event');
assert.equal(count(ics, 'END:VEVENT'), 4);
assert.equal(lines(ics).filter((l) => l === 'SUMMARY:x').length, 0, 'no injected SUMMARY line');
step('CR/LF in id, recurrenceID, rule, title, description and calendar title cannot start a new line or VEVENT');

// 2. A rule with anything outside the rule alphabet is dropped: the event is published once.
const standup = unfold(ics).split('BEGIN:VEVENT').find((b) => b.includes('SUMMARY:Standup'));
assert.ok(!/RRULE/.test(standup), 'an unsafe rule must be dropped, not emitted');
assert.match(unfold(ics), /RRULE:FREQ=WEEKLY;BYDAY=WE;INTERVAL=1;UNTIL=20261231T000000Z/);
assert.equal(ICSService.safeRule('FREQ=WEEKLY;BYDAY=MO,WE'), 'FREQ=WEEKLY;BYDAY=MO,WE');
assert.equal(ICSService.safeRule('FREQ=DAILY"'), null);
assert.equal(ICSService.safeRule('FREQ=DAILY\nX'), null);
step('a valid RRULE is kept as-is; one with other characters is dropped and the event stays single');

// 3. UIDs: real ids pass through unchanged; unsafe characters are percent-encoded, deterministically.
for (const id of ['aaa921bf-3429-4510-a607-4bc394c9c600', '1712345678901', 42, '"aaa921bf-3429"']) {
    assert.equal(ICSService.safeUid(id), String(id));
}
assert.equal(ICSService.safeUid('a\r\nb;c,d\\e%f g'), 'a%0D%0Ab%3Bc%2Cd%5Ce%25f%20g');
assert.equal(ICSService.safeUid('ñ'), '%C3%B1');
const uids = lines(ics).filter((l) => l.startsWith('UID:'));
assert.ok(uids.includes(`UID:${ICSService.safeUid(`series2${INJECT}`)}`), 'an override keeps the same (encoded) UID as its series');
step('UIDs: real ids unchanged, unsafe characters percent-encoded');

// 4. Text escaping (RFC 5545 3.3.11) and folding at 75 octets.
assert.equal(ICSService.escapeText('a\\b;c,d\r\ne\rf\ng\u0001h\th'), 'a\\\\b\\;c\\,d\\ne\\nf\\ng' + 'h\th');
const long = ICSService.generateICS({ title: 'T', events: [{ id: 'l', title: 'ü'.repeat(200), start: at(1, 1), end: at(1, 2) }] }, 'x');
for (const l of long.split('\r\n')) assert.ok(Buffer.byteLength(l, 'utf8') <= 75, `line over 75 octets: ${l.length}`);
wellFormed(long);
step('text values escaped (backslash, semicolon, comma, newline); lines folded at 75 octets');

// 5. The calendar name in PRODID is escaped too.
const named = ICSService.generateICS({ title: 'T', events: [] }, 'a;b\r\nX:y');
wellFormed(named);
assert.ok(lines(named).includes('PRODID:-//PasteCal//a\\;b\\nX:y//EN'));
step('PRODID carries the calendar name escaped');

console.log('ics safety tests passed');
