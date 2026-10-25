/**
 * Every event in a calendar feed carries the calendar's VIEW link (Oct 25 2026): people following in
 * Google, Apple or Outlook see where the calendar lives. Never the edit link: a calendar app shows an
 * event's notes to anyone who can see the event, so an edit name there would hand out edit access.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('url');

const load = () => import(pathToFileURL(path.join(__dirname, '../../cloudflare/src/ICSService.js')).href).then((m) => m.ICSService || m.default);

const cal = {
    id: 'secret-edit-name',
    title: 'U10 Soccer',
    options: { publicViewId: 'Ab3xY' },
    events: [
        { id: 'e1', title: 'Practice', description: 'Field 3', start: '2026-11-03T17:00:00.000Z', end: '2026-11-03T18:00:00.000Z' },
        { id: 'e2', title: 'Game', description: '', start: '2026-11-07T17:00:00.000Z', end: '2026-11-07T18:00:00.000Z' },
    ],
};
const unfold = (ics) => ics.replace(/\r\n[ \t]/g, '');

test('each event names the view link after its own notes, and as URL', async () => {
    const ICS = await load();
    const ics = unfold(ICS.generateICS(cal, 'Ab3xY', { viewUrl: 'https://pastecal.com/view/Ab3xY' }));
    assert.match(ics, /DESCRIPTION:Field 3\\n\\nCalendar: https:\/\/pastecal\.com\/view\/Ab3xY/);
    assert.match(ics, /DESCRIPTION:Calendar: https:\/\/pastecal\.com\/view\/Ab3xY/, 'an event with no notes gets just the link');
    assert.equal((ics.match(/^URL:https:\/\/pastecal\.com\/view\/Ab3xY$/gm) || []).length, 2);
    assert.ok(!ics.includes('secret-edit-name'), 'the edit name never appears in a feed');
});

test('without a view link, events keep only their own notes', async () => {
    const ICS = await load();
    const ics = unfold(ICS.generateICS(cal, 'Ab3xY'));
    assert.match(ics, /DESCRIPTION:Field 3\r\n/);
    assert.ok(!/^URL:/m.test(ics));
});
