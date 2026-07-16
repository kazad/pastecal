/**
 * Stress / fuzz tests for the event write path and ICS generation.
 *
 * The "Server error generating ICS" incident came from an input shape nobody anticipated:
 * an event with no start/end. Example-based tests only cover the shapes we thought of.
 * These tests throw the adversarial cross-product at both layers and assert INVARIANTS
 * rather than specific outputs:
 *
 *   Event constructor  — must never throw, whatever it is handed.
 *   Event.isComplete() — must never throw, and must never green-light an unusable event.
 *   generateICS()      — must never throw, must always emit a parseable calendar, and must
 *                        never emit a VEVENT lacking DTSTART/DTEND (the 500 condition).
 *
 * Run: npm run test:unit   (node 20/22 — see test/README.md)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { ICSService } = require('../../functions/index.js')._internal;

function loadEventClass() {
  const src = fs.readFileSync(
    path.join(__dirname, '../../public/models/Event.js'), 'utf8');
  return new Function('Utils', `${src}; return Event;`)({ uuidv4: () => 'generated-uuid' });
}
const Event = loadEventClass();

// Every hostile value we can think of for a date field.
const HOSTILE_DATES = [
  undefined, null, '', '   ', 'garbage', 'not-a-date', 0, -1, NaN, Infinity, -Infinity,
  '2026-13-45T99:99:99Z',      // structurally date-ish, semantically invalid
  '0000-00-00T00:00:00.000Z',
  '9999-12-31T23:59:59.999Z',  // far future, but legal
  '1970-01-01T00:00:00.000Z',  // epoch — falsy-adjacent traps
  new Date('invalid'),         // Invalid Date object
  new Date(ISO()),             // legit Date object
  {}, [], true, false,
  '2026-05-27',                // date without time
  Number.MAX_SAFE_INTEGER,
];
function ISO() { return '2026-05-27T10:00:00.000Z'; }

const HOSTILE_TEXT = [
  undefined, null, '', 0, false, NaN, {}, [],
  'x'.repeat(10_000),                  // very long
  'emoji 🎉🔥 unicode ünïcödé',
  'semi;colon,comma\\backslash\nnewline\r\ncrlf',
  'BEGIN:VEVENT\nSUMMARY:injected',    // ICS injection attempt
  '<script>alert(1)</script>',
  '\u0000\u0001\u001F control chars',
  '../../etc/passwd',
];

const countEvents = (ics) => (ics.match(/BEGIN:VEVENT/g) || []).length;

// String(Object.create(null)) throws ("Cannot convert object to primitive value"), which
// would blow up an assertion message instead of reporting the real failure.
const label = (v) => {
  try { return String(v); } catch { return '[unstringifiable]'; }
};

// --- Event constructor: must never throw --------------------------------------------------

test('stress: Event constructor never throws on hostile date input', () => {
  let cases = 0;
  for (const start of HOSTILE_DATES) {
    for (const end of HOSTILE_DATES) {
      cases++;
      // Both the stored shape (start/end) and the Syncfusion shape (StartTime/EndTime).
      assert.doesNotThrow(
        () => new Event({ title: 'X', start, end }),
        `start=${label(start)} end=${label(end)} (stored shape)`);
      assert.doesNotThrow(
        () => new Event({ Subject: 'X', StartTime: start, EndTime: end }),
        `StartTime=${label(start)} EndTime=${label(end)} (syncfusion shape)`);
    }
  }
  assert.ok(cases >= 400, `expected a real cross-product, got ${cases}`);
});

test('stress: Event constructor never throws on hostile text input', () => {
  for (const text of HOSTILE_TEXT) {
    assert.doesNotThrow(
      () => new Event({ title: text, description: text, start: ISO(), end: ISO() }),
      `title=${label(text).slice(0, 40)}`);
  }
});

test('stress: Event constructor never leaves a field undefined', () => {
  // Firebase rejects the ENTIRE write if any field is undefined — this invariant is
  // what keeps a bad event from silently killing an unrelated save.
  for (const start of HOSTILE_DATES) {
    for (const text of HOSTILE_TEXT) {
      const e = new Event({ title: text, start, end: start });
      const undef = Object.entries(e).filter(([, v]) => v === undefined).map(([k]) => k);
      assert.deepEqual(undef, [], `undefined fields for start=${label(start)}`);
    }
  }
});

test('stress: Event constructor tolerates garbage options objects', () => {
  for (const opts of [{}, { id: null }, { type: 'not-a-number' }, { start: {} }]) {
    assert.doesNotThrow(() => new Event(opts), `opts=${JSON.stringify(opts)}`);
  }
});

// --- isComplete(): must never green-light an unusable event -------------------------------

test('stress: isComplete never throws and never approves an unusable event', () => {
  for (const start of HOSTILE_DATES) {
    for (const end of HOSTILE_DATES) {
      const e = new Event({ title: 'X', start, end });

      let complete;
      assert.doesNotThrow(() => { complete = e.isComplete(); },
        `isComplete threw on start=${label(start)} end=${label(end)}`);

      // The invariant that matters: if isComplete() says yes, ICS generation MUST be
      // able to render it. Anything it approves must survive formatDateTime.
      if (complete) {
        assert.doesNotThrow(
          () => ICSService.createEventBlock(e),
          `isComplete approved an event that ICS cannot render: ` +
          `start=${label(start)} end=${label(end)}`);
      }
    }
  }
});

test('stress: static isComplete never throws on arbitrary values', () => {
  const junk = [null, undefined, 0, '', 'str', [], {}, NaN, true, () => {},
    { start: {} }, { start: [], end: [] }, Object.create(null)];
  for (const v of junk) {
    let out;
    assert.doesNotThrow(() => { out = Event.isComplete(v); }, `threw on ${label(v)}`);
    assert.equal(typeof out, 'boolean', `must return a boolean for ${label(v)}`);
  }
});

// --- generateICS: must never throw, never emit a broken VEVENT ----------------------------

test('stress: generateICS never throws on hostile events', () => {
  for (const start of HOSTILE_DATES) {
    for (const end of HOSTILE_DATES) {
      const event = { id: 'x', title: 'T', description: 'd', start, end };
      assert.doesNotThrow(
        () => ICSService.generateICS({ events: [event] }, 'stress'),
        `generateICS threw on start=${label(start)} end=${label(end)}`);
    }
  }
});

test('stress: generateICS never emits a VEVENT missing DTSTART or DTEND', () => {
  // This is the exact 500 condition. Whatever we feed it, every emitted VEVENT must
  // carry both endpoints — otherwise we have shipped an unusable feed.
  for (const start of HOSTILE_DATES) {
    for (const end of HOSTILE_DATES) {
      const ics = ICSService.generateICS(
        { events: [{ id: 'x', title: 'T', description: 'd', start, end }] }, 'stress');

      const blocks = countEvents(ics);
      assert.equal(blocks, (ics.match(/DTSTART:/g) || []).length,
        `VEVENT without DTSTART for start=${label(start)}`);
      assert.equal(blocks, (ics.match(/DTEND:/g) || []).length,
        `VEVENT without DTEND for end=${label(end)}`);
      assert.doesNotMatch(ics, /DTSTART:undefined|DTEND:undefined|DTSTART:null|DTEND:null/,
        `leaked undefined/null into output for start=${label(start)}`);
    }
  }
});

test('stress: generateICS never throws on hostile text and never breaks structure', () => {
  for (const text of HOSTILE_TEXT) {
    let ics;
    assert.doesNotThrow(() => {
      ics = ICSService.generateICS(
        { events: [{ id: text, title: text, description: text, start: ISO(), end: ISO() }] },
        'stress');
    }, `threw on text=${label(text).slice(0, 40)}`);

    assert.match(ics, /^BEGIN:VCALENDAR/);
    assert.match(ics, /END:VCALENDAR$/);
  }
});

test('stress: a malformed event never suppresses its valid siblings', () => {
  // The heart of the incident: one bad row cost all 29 events. However many bad rows
  // we interleave, every good row must still come through.
  const good = (n) => ({ id: `good-${n}`, title: `Good ${n}`, description: '',
    start: ISO(), end: '2026-05-27T13:00:00.000Z' });

  for (const start of HOSTILE_DATES) {
    const bad = { id: 'bad', title: 'Bad', description: '', start, end: start };
    const events = [good(1), bad, good(2), bad, good(3)];
    const ics = ICSService.generateICS({ events }, 'stress');

    for (const n of [1, 2, 3]) {
      assert.match(ics, new RegExp(`UID:good-${n}\\b`),
        `good event ${n} was dropped when sibling had start=${label(start)}`);
    }
  }
});

test('stress: generateICS survives a large calendar of mixed-validity events', () => {
  // 2000 events, every third one malformed in a rotating way.
  const events = [];
  for (let i = 0; i < 2000; i++) {
    if (i % 3 === 0) {
      events.push({ id: `bad-${i}`, title: 'Bad', description: '',
        start: HOSTILE_DATES[i % HOSTILE_DATES.length], end: null });
    } else {
      events.push({ id: `ok-${i}`, title: `E${i}`, description: '',
        start: ISO(), end: '2026-05-27T13:00:00.000Z' });
    }
  }

  let ics;
  assert.doesNotThrow(() => { ics = ICSService.generateICS({ events }, 'big'); });

  const emitted = countEvents(ics);
  assert.equal(emitted, (ics.match(/DTSTART:/g) || []).length,
    'every emitted VEVENT must have a DTSTART even at scale');
  assert.ok(emitted > 1200, `expected the ~1333 valid events, got ${emitted}`);
  assert.match(ics, /END:VCALENDAR$/);
});

test('stress: generateICS survives hostile calendarData wrappers', () => {
  for (const data of [null, undefined, {}, { events: null }, { events: [] },
    { events: [null] }, { events: [undefined, null] }, { events: 'not-an-array' },
    { events: {} }]) {
    assert.doesNotThrow(
      () => ICSService.generateICS(data, 'stress'),
      `threw on calendarData=${JSON.stringify(data)}`);
  }
});
