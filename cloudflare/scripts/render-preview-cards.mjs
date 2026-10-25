// Renders link-preview cards with the Worker's own renderer (src/preview), in node.
//   node cloudflare/scripts/render-preview-cards.mjs            -> public/img/og-card.png (the static site card)
//   node cloudflare/scripts/render-preview-cards.mjs <outdir>   -> also sample calendar cards in <outdir>, for review
// Fallback fonts and emoji are fetched the way the Worker fetches them (Google Fonts, Twemoji).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { setup, prepare, toPng } from '../src/preview/render.js';
import { Pen, siteCard, calendarCard } from '../src/preview/svg.js';
import { cardModel, describe } from '../src/preview/model.js';

const src = new URL('../src/', import.meta.url);
const read = (p) => readFileSync(new URL(p, src));
await setup(read('vendor/resvg-2.6.2/index_bg.wasm'), { 500: read('vendor/fonts/Figtree-500.ttf'), 700: read('vendor/fonts/Figtree-700.ttf'), 800: read('vendor/fonts/Figtree-800.ttf') });

async function render(build, strings, file, width = 1200) {
    const { fontSet, emoji } = await prepare(strings);
    const svg = build(new Pen(fontSet, emoji));
    const t = performance.now();
    const png = await toPng(svg, fontSet, width);
    writeFileSync(file, png);
    console.log(`${file}  ${png.length} bytes  ${(performance.now() - t).toFixed(1)} ms`);
}

await render((pen) => siteCard(pen), [], new URL('../../public/img/og-card.png', import.meta.url));

const out = process.argv[2];
if (out) {
    mkdirSync(out, { recursive: true });
    const now = Date.parse('2026-10-24T20:00:00Z');
    const pdt = (d, h = 0, m = 0) => new Date(Date.parse(`${d}T00:00:00Z`) + (h + 7) * 3600000 + m * 60000).toISOString();
    const allDay = (d, days = 1) => ({ start: pdt(d), end: new Date(Date.parse(pdt(d)) + days * 86400000).toISOString(), isAllDay: true });
    const ev = (title, type, when) => ({ id: title + type, title, type, ...when });
    const samples = {
        choir: { title: 'Riverside Youth Choir', events: [
            ev('Sectionals', 1, allDay('2026-10-25')), ev('Full rehearsal', 2, { start: pdt('2026-10-28', 19), end: pdt('2026-10-28', 21) }),
            ev('Fall concert', 4, { start: pdt('2026-11-01', 18, 30), end: pdt('2026-11-01', 20) }), ev('Old thing', 3, allDay('2026-10-01')),
            ev('Tuesday warmups', 5, { start: pdt('2026-10-06', 18), end: pdt('2026-10-06', 18, 30), recurrencerule: 'FREQ=WEEKLY;BYDAY=TU;INTERVAL=1;' })] },
        emoji: { title: '🎄 Family Holidays 2026 — Ñuñez & 강아지봉사 🐶', events: [
            ev('Thanksgiving 🦃 at Grandma’s', 3, allDay('2026-11-26')), ev('Cookie swap 🍪', 5, { start: pdt('2026-12-05', 14), end: pdt('2026-12-05', 16) }),
            ev('Привет party', 6, { start: pdt('2026-12-12', 19), end: pdt('2026-12-12', 22) })] },
        long: { title: 'Northside Elementary School Parent Teacher Association Volunteer Schedule for the 2026–2027 School Year and Beyond', events: Array.from({ length: 30 }, (_, i) =>
            ev(`Volunteer shift ${i + 1}: library book sorting and the very long description of what happens`, (i % 8) + 1, { start: pdt(`2026-11-${String(i + 1).padStart(2, '0')}`, 15), end: pdt(`2026-11-${String(i + 1).padStart(2, '0')}`, 17) })) },
        empty: { title: 'Book club', events: [ev('Last month', 1, allDay('2026-09-12'))] },
        untitled: { title: '', events: [ev('', 2, allDay('2026-10-30'))] },
        pro: { title: 'Acme Design Team', pro: true, hideBranding: true, colors: ['#0f766e', '#7c3aed', 'javascript:alert(1)'], events: [
            ev('Sprint review', 1, { start: pdt('2026-10-27', 10), end: pdt('2026-10-27', 11) }), ev('Offsite', 2, allDay('2026-11-03', 2)), ev('Bad color', 3, allDay('2026-11-09'))] },
    };
    for (const [name, cal] of Object.entries(samples)) {
        const model = cardModel(cal, now);
        console.log(name, '|', describe(cal, now));
        await render((pen) => calendarCard(pen, model), [[model.title, 800], [model.title, 700], ...model.events.map((e) => [e.title, 700])], `${out}/card-${name}.png`);
    }
}
