#!/usr/bin/env node
// Builds pastecal.com/templates (public/templates.html) and one page per template (public/templates/<slug>.html)
// from public/utils/templates.js plus the short copy below. "Use this template" opens /?template=<id>.
// Pictures: scripts/shoot-templates.mjs. The shared header/footer are applied at the end (sync-site-chrome.mjs).
//   node scripts/build-templates.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const T = require('../public/utils/templates.js');

// One entry per template id. Plain and specific: who it's for, what it does, three tips.
export const COPY = {
  space: { slug: 'shared-space', name: 'Shared space booking', short: 'A room everyone books: who has it, and when.',
    who: 'Apartment buildings, offices, studios, community rooms',
    intro: 'One calendar for a room everyone shares. People add their booking, everyone can see what is taken, and nobody has to make an account.',
    tips: ['Put the apartment or name in the title, so you know who to ask.', 'Give closures their own color so they stand out.', 'Post the view link in the building chat; share the edit link with residents.'] },
  out: { slug: 'whos-out', name: "Who's out", short: 'Vacations, sick days and working from home, for a small team.',
    who: 'Small teams and offices',
    intro: "Vacations, sick days and work-from-home days in one place, so nobody has to ask who's around.",
    tips: ['Add yourself even for half a day.', 'All-day events keep the grid easy to read.', 'Everyone can add it to their own phone calendar.'] },
  family: { slug: 'family', name: 'Family calendar', short: "Lessons, appointments and who's driving.",
    who: 'Families, including grandparents and sitters',
    intro: "Lessons, appointments and who's driving, in one link the whole family can edit. Grandparents and sitters too, with no app to install.",
    tips: ['Write a name in the title when something needs a driver.', 'Keep the emergency contacts in the notes.', 'Each person can follow it in their own phone calendar.'] },
  team: { slug: 'sports-team', name: 'Sports team schedule', short: 'Practices, games and snack duty.',
    who: 'Youth teams, adult leagues, coaches and parents',
    intro: 'Practices, games and snack duty in one place. Parents add it to their phone calendar once, and changes show up on their own.',
    tips: ['Put the field and rainout rule in the notes.', 'Use one color for games and another for practice.', 'Share the view link with families; keep the edit link for coaches.'] },
  shifts: { slug: 'volunteer-shifts', name: 'Volunteer shift schedule', short: 'Post shifts; people put their name in to take one.',
    who: 'Food banks, events, clubs, schools',
    intro: 'Post the shifts and let volunteers sign up by putting their name in one. Open shifts are a different color, so the gaps are easy to spot.',
    tips: ['Name open shifts "Open shift" so they are easy to find.', "If someone can't make it, they change it back to Open.", 'Put the address and the door to use in the notes.'] },
  guests: { slug: 'guest-room', name: 'Guest room calendar', short: 'Who is staying, and when to clean.',
    who: 'Families with a shared guest room or cabin',
    intro: 'Who is staying in the guest room, with cleaning days between visits. Relatives add their dates without having to ask first.',
    tips: ['Add tentative dates as Hold, then change them once they are set.', 'Put the Wi-Fi details in the notes.', 'Works the same for a shared cabin or beach house.'] },
  club: { slug: 'club', name: 'Club or class calendar', short: 'Meetings, reading and events for a group.',
    who: 'Book clubs, classes, hobby groups',
    intro: 'Meetings, readings and the occasional outing, for a group that meets regularly. Members can see where the next one is.',
    tips: ['Put the host in each meeting so people know where to go.', 'Use the notes for the current book or topic.', 'Members can follow it in their phone calendar.'] },
  oncall: { slug: 'on-call-rota', name: 'On-call rotation', short: "Who's on call this week, with handoffs and swaps.",
    who: 'Support teams, dispatch, clinics, IT',
    intro: "A weekly on-call rotation everyone can see. Swaps go on the calendar, so there's never a question about who has the pager.",
    tips: ['Use all-day events that run the whole shift.', 'Add swaps as their own color so they stand out.', 'Keep escalation steps in the notes.'] },
  office: { slug: 'office-hours', name: 'Office hours', short: 'When and where to find you, with changes as they happen.',
    who: 'Teachers, TAs, advisors, managers',
    intro: 'When and where people can find you. If you cancel or move a session, everyone following the calendar sees it right away.',
    tips: ['Put the room or link in each event.', 'Mark cancellations instead of deleting them.', 'Students can add it to their phone calendar.'] },
  carpool: { slug: 'carpool', name: 'Carpool schedule', short: "Who's driving, mornings and afternoons.",
    who: 'Parents sharing school runs, commuters',
    intro: "Who's driving each morning and afternoon. Families swap by changing the name, and everyone can see the week at a glance.",
    tips: ['One color for mornings, another for afternoons.', 'Put the pickup spot in the notes.', 'Ask families to follow it in their phone calendar.'] },
  chores: { slug: 'chores', name: 'Chore chart', short: 'A rotation of household jobs everyone can see.',
    who: 'Roommates and families',
    intro: 'A simple rotation of household jobs that everyone can see and change. No app to install, no accounts to share.',
    tips: ['Rotate names week to week.', 'Add one-off jobs as their own color.', 'Keep the shopping list in the notes.'] },
  trip: { slug: 'trip-plan', name: 'Trip planner', short: 'Flights, places to stay and plans, for a group.',
    who: 'Friends and families traveling together',
    intro: 'Flights, where you are staying and what you want to do, in one calendar the whole group can add to.',
    tips: ['Use multi-day events for where you are staying.', 'Put confirmation numbers in the event notes.', 'Everyone can follow it on their phone while traveling.'] },
};

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const head = (title, desc, url) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="https://pastecal.com${url}">
<meta property="og:site_name" content="pastecal">
<meta property="og:type" content="website">
<meta property="og:url" content="https://pastecal.com${url}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="https://pastecal.com/img/og-card.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" type="image/png" href="/img/icons/favicon-96x96.png" sizes="96x96">
<link rel="icon" type="image/svg+xml" href="/img/icons/favicon.svg">
<link rel="apple-touch-icon" sizes="180x180" href="/img/icons/apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700;800&display=swap"><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/components.css">
<script>try{var m=(JSON.parse(localStorage.getItem('pastecal_global_settings'))||{}).darkMode||'auto';document.documentElement.setAttribute('data-theme',m==='dark'||(m==='auto'&&matchMedia('(prefers-color-scheme: dark)').matches)?'dark':'light')}catch(e){}</script>
<link rel="stylesheet" href="/legal.css">
<link rel="stylesheet" href="/site.css">
<link rel="stylesheet" href="/templates.css">
</head>
<body>
<!-- site-header -->
<!-- /site-header -->
`;
const foot = `<!-- site-footer -->
<!-- /site-footer -->
</body></html>
`;
const pic = (id, name) => `<img class="tpl-pic" src="/img/templates/${id}.jpg" alt="${esc(name)} template: a month on pastecal" width="818" height="640" loading="lazy">`;

function indexPage(list) {
  const cards = list.map(({ id, c }) => `  <a class="tpl-card" href="/templates/${c.slug}" data-from="templates-gallery">
    ${pic(id, c.name)}
    <span class="tpl-card-name">${esc(c.name)}</span>
    <span class="tpl-card-short">${esc(c.short)}</span>
  </a>`).join('\n');
  return head('Calendar templates · pastecal', 'Free shared calendar templates: sports teams, volunteer shifts, room booking, on-call, family and more. Start from one, change anything, share the link. No sign-up.', '/templates')
    + `<main class="tpl-main">
<h1>Calendar templates</h1>
<p class="tpl-lede">Start from one of these, change anything, and share the link. Nobody has to sign up.</p>
<div class="tpl-grid">
${cards}
</div>
<p class="tpl-blank">Or <a href="/" data-from="templates-gallery">start with a blank calendar</a>.</p>
</main>
` + foot;
}

function detailPage(id, c, list) {
  const b = T.build(id, new Date(2026, 9, 1));
  const labels = b.typeLabels.filter((l) => !/^Type \d+$/.test(l));
  const sample = b.events.slice(0, 5).map((e) => `<li>${esc(e.title)}</li>`).join('');
  const others = list.filter((x) => x.id !== id).slice(0, 6).map(({ c: o }) => `<a href="/templates/${o.slug}" data-from="templates-detail">${esc(o.name)}</a>`).join('');
  return head(`${c.name} template · pastecal`, `${c.intro} Free, no sign-up.`, `/templates/${c.slug}`)
    + `<main class="tpl-main tpl-detail">
<p class="tpl-crumb"><a href="/templates">Templates</a></p>
<h1>${esc(c.name)}</h1>
<p class="tpl-lede">${esc(c.intro)}</p>
<p><a class="pc-btn pc-btn--primary tpl-use" href="/?template=${id}" data-from="templates-detail" data-testid="use-template">Use this template</a></p>
${pic(id, c.name).replace(' loading="lazy"', '')}
<div class="tpl-cols">
  <section><h2>Good for</h2><p>${esc(c.who)}</p>
  <h2>What's in it</h2><p class="tpl-labels">${labels.map((l) => `<span class="pc-pill">${esc(l)}</span>`).join(' ')}</p><ul class="tpl-sample">${sample}</ul></section>
  <section><h2>Tips</h2><ul>${c.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
  <p class="tpl-fine">Everything is an example. Change the names and dates, delete what you don't need, then press Save &amp; share.</p></section>
</div>
<h2>Other templates</h2>
<p class="tpl-others">${others} <a href="/templates" data-from="templates-detail">All templates</a></p>
</main>
` + foot;
}

const list = T.all().map(({ id }) => ({ id, c: COPY[id] }));
const missing = list.filter((x) => !x.c).map((x) => x.id);
if (missing.length) { console.error('no copy for', missing.join(', ')); process.exit(1); }
fs.mkdirSync(path.join(root, 'public/templates'), { recursive: true });
fs.writeFileSync(path.join(root, 'public/templates.html'), indexPage(list));
for (const { id, c } of list) fs.writeFileSync(path.join(root, `public/templates/${c.slug}.html`), detailPage(id, c, list));
// The sitemap: the pages worth finding in search (never a calendar's edit link).
const urls = ['/', '/templates', ...list.map(({ c }) => `/templates/${c.slug}`), '/pricing', '/help', '/about'];
fs.writeFileSync(path.join(root, 'public/sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>https://pastecal.com${u}</loc></url>`).join('\n')}\n</urlset>\n`);
console.log(`wrote public/templates.html, ${list.length} template pages and public/sitemap.xml`);
// The shared header and footer (scripts/site-chrome), so a rebuilt page is never left without them.
execFileSync(process.execPath, [path.join(root, 'scripts/sync-site-chrome.mjs')], { stdio: 'ignore' });
