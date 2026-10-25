// RED TEAM #4 (XSS) -- setup for the in-browser render check.
// Creates a calendar whose title, event title, description and category name carry hostile HTML /
// script / RTL / emoji payloads, then prints the URL to open. The browser verification (that the
// rendered app ESCAPES these, i.e. no <script>/<img onerror> executes and the text shows literally)
// is driven separately with Playwright against http://localhost:8910/<id>. This script also asserts
// the server stores and returns the payloads VERBATIM: the server is not an HTML context, so the
// escaping contract lives entirely in the client renderer (Vue text interpolation) -- this fixes
// where the defense must be and gives the browser step a stable, repeatable fixture.
import { BASE, enc, create, getCal, ev, uid, step, done, assert } from './_h.mjs';

const MARK = 'XSSPROBE';
const payloads = {
    img: `<img src=x onerror="window.${MARK}_img=1">`,
    script: `<script>window.${MARK}_script=1<\/script>`,
    svg: `<svg onload="window.${MARK}_svg=1">`,
    attr: `" onmouseover="window.${MARK}_attr=1" x="`,
    rtl: '‮RTLOVERRIDE‬',
    emoji: '😀🗓️',
    entity: '&lt;b&gt;&amp;',
};

const id = uid('xss');
const title = `Team ${payloads.img}${payloads.rtl}`;
const events = [
    ev('x1', `Lunch ${payloads.script}`, 1, { description: `Notes ${payloads.svg}`, type: '1' }),
    ev('x2', `Dinner ${payloads.attr}`, 2, { description: payloads.entity }),
    ev('x3', `Party ${payloads.emoji}`, 3),
];
// Category names live in options (rendered in the legend/settings).
const options = { categoryNames: { 1: `Work ${payloads.img}`, 2: `Fun ${payloads.script}` } };

assert.equal((await create(id, { title, options, events })).status, 201);
const cal = (await getCal(id)).calendar;
// Verbatim round-trip: the server neither escapes nor strips the payloads (they are data).
assert.equal(cal.title, title, 'server returns the hostile title verbatim');
assert.ok(cal.events.find((e) => e.id === 'x1').title.includes('<script>'), 'event title verbatim');
assert.ok(cal.events.find((e) => e.id === 'x2').title.includes('onmouseover'), 'attribute-break payload verbatim');
step('server stored/returned hostile HTML/script/RTL/emoji payloads verbatim (escaping is the client renderer\'s job)');

console.log(`\nOPEN IN BROWSER:  ${BASE}/${enc(id)}`);
console.log(`CALENDAR ID:      ${id}`);
console.log('After load, in the page: check that NO window.XSSPROBE_* flag is set and payloads show as literal text.');
done('xss-setup');
