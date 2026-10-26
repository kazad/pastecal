/**
 * CalendarPath -- the one way to put a calendar's name (or a view link's id) into a URL.
 *
 * A calendar's name is any text: real ones include "50% off", "a?b", "TEAM NUÑEZ", "d&d8", "강아지봉사" and names
 * ending in a space. Pasted raw into a path, "?" starts a query, "%" starts an escape, "#" a fragment, and a trailing
 * space is dropped: Share's links for "a?b" opened a blank calendar called "a", and claiming "50% fun" saved it, then
 * landed on a blank draft (stress A03, A04). Every page and Worker path to a calendar is built here, encoded
 * (encodeURIComponent: "@" too, so an old calendar named "@x" is never read as a handle). test/unit/url-paths.test.js
 * fails on a path built any other way.
 *
 *   of(name)            '/50%25%20off'            the calendar's page (its edit address)
 *   view(id)            '/view/ab12cd34'          a view link
 *   at(handle, name)    '/@kalid/soccer'          a Pro @link
 *   feed(path)          path + '.ics'             a page's calendar feed
 *
 * Pure. Loaded as a script (window.CalendarPath), required by node tests, imported by the Worker.
 */
(function (root) {
    'use strict';
    const enc = (v) => encodeURIComponent(String(v ?? ''));
    const CalendarPath = {
        of: (name) => `/${enc(name)}`,
        view: (id) => `/view/${enc(id)}`,
        at: (handle, name) => `/@${enc(handle)}/${enc(name)}`,
        feed: (path) => `${path}.ics`,
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = CalendarPath;
    else root.CalendarPath = CalendarPath;
})(typeof window !== 'undefined' ? window : globalThis);
