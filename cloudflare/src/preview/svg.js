/**
 * The preview renderer: every pastecal image is an SVG string built here, then (for PNG) rasterized by
 * render.js. One builder serves the link-preview cards (static site card, per-calendar card), and is
 * meant to serve the Pro live calendar images next.
 *
 * Text is laid out with a FontSet (fonts.js), which measures and splits it into runs; nothing here
 * trusts a string: every piece of user text passes escapeXml, every color passes safeColor.
 * No external references, scripts, styles or links ever: the SVG is safe to serve as-is.
 */
import { escapeXml, xmlText, clean, safeColor, onColor } from './text.js';
import { logoSvg, LOGO_COLOR, LOGO_COLOR_DARK } from './logo.js';
import { WEEKDAYS, MONTHS } from './time.js';

export const THEMES = {
    light: { bg: '#ffffff', surface: '#f9fafb', soft: '#f5f6f8', line: '#ebecef', text: '#1c1c1e', text2: '#374151', muted: '#6b7280', accent: '#d6124f', onAccent: '#ffffff', brand: LOGO_COLOR, weekend: '#fafafb' },
    dark: { bg: '#1e1e1e', surface: '#2a2a2a', soft: '#26272c', line: '#373737', text: '#ececf0', text2: '#c4c6cc', muted: '#999999', accent: '#ff5c8d', onAccent: '#1c1c1e', brand: LOGO_COLOR_DARK, weekend: '#232326' },
};
export const SYSTEM_STACK = "Figtree, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

// The app's palette (app.js DEFAULT_COLORS + EXTRA_COLORS), and its upgrade of three old defaults.
export const DEFAULT_COLORS = ['#3f51b5', '#e3165b', '#d0442f', '#2e7d32', '#ff9800', '#03a9f4', '#757575', '#27282f',
    '#827717', '#c0ca33', '#00836f', '#8e24aa', '#880e4f', '#bf360c', '#455a64', '#00bfa5'];
const UPGRADE = { '#ff6652': '#d0442f', '#4caf50': '#2e7d32', '#9e9e9e': '#757575' };
/** An event's color from its type (1-based) and the calendar's stored palette; always a safe #rrggbb. */
export function eventColor(type, colors) {
    const i = Math.max(1, parseInt(type, 10) || 1) - 1;
    const stored = Array.isArray(colors) ? safeColor(colors[i]) : null;
    if (stored) return UPGRADE[stored] || stored;
    return DEFAULT_COLORS[i] || DEFAULT_COLORS[0];
}

// ---- text drawing ----------------------------------------------------------------------------
/**
 * A Pen draws text with a FontSet. `emoji` maps an emoji grapheme to a data: URI (PNG path); `system`
 * fonts mode writes one <text> per string in the system font stack (SVG path, the viewer's fonts draw it).
 */
export class Pen {
    constructor(fontSet, emoji = {}) { this.fs = fontSet; this.emoji = emoji; }
    width(text, size, weight = 500) { return this.fs.measure(clean(text), weight, size); }
    fit(text, size, weight, max) { return this.fs.fit(clean(text), weight, size, max); }
    wrap(text, size, weight, max, lines) { return this.fs.wrap(clean(text), weight, size, max, lines); }
    /** Text at (x, baseline y). anchor: start | middle | end. Extra attrs: letterSpacing, opacity. */
    text(x, y, str, { size = 16, weight = 500, fill = '#000', anchor = 'start', spacing = 0 } = {}) {
        const s = clean(str);
        if (!s) return '';
        const runs = this.fs.runs(s, weight, size);
        const total = runs.reduce((a, r) => a + r.width, 0) + spacing * Math.max(0, [...s].length - 1);
        let cx = anchor === 'middle' ? x - total / 2 : anchor === 'end' ? x - total : x;
        const ls = spacing ? ` letter-spacing="${spacing}"` : '';
        if (this.fs.system) {
            return `<text x="${r1(cx)}" y="${r1(y)}" font-family="${SYSTEM_STACK}" font-size="${size}" font-weight="${weight}" fill="${fill}"${ls}>${escapeXml(s)}</text>`;
        }
        let out = '';
        for (const r of runs) {
            if (r.emoji) {
                const uri = this.emoji[r.emoji];
                if (uri) out += `<image x="${r1(cx + size * 0.075)}" y="${r1(y - size * 0.86)}" width="${r1(size)}" height="${r1(size)}" href="${uri}"/>`;
            } else {
                const fam = r.family || 'Figtree';
                // A run's leading spaces are not drawn (resvg drops them): start the text after them.
                const lead = /^\s*/.exec(r.text)[0], body = r.text.slice(lead.length);
                const lx = lead ? cx + this.fs.measure(lead, weight, size) + spacing * lead.length : cx;
                if (body) out += `<text xml:space="preserve" x="${r1(lx)}" y="${r1(y)}" font-family="${escapeXml(fam)}" font-size="${size}" font-weight="${r.weight || weight}" fill="${fill}"${ls}>${xmlText(body)}</text>`;
            }
            cx += r.width + (spacing ? spacing * [...r.text].length : 0);
        }
        return out;
    }
}
const r1 = (n) => Math.round(n * 10) / 10;
const rect = (x, y, w, h, rx, fill, extra = '') => `<rect x="${r1(x)}" y="${r1(y)}" width="${r1(Math.max(0, w))}" height="${r1(Math.max(0, h))}" rx="${rx}" fill="${fill}"${extra}/>`;
const svgOpen = (w, h, outW = w, label = 'pastecal') => `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(outW)}" height="${Math.round(h * outW / w)}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${escapeXml(label)}">`;

/** The brand lockup: mark + "pastecal" wordmark (Figtree 800, the logo's indigo), left at x, centered on cy. */
function lockup(pen, x, cy, size, color, { tagline = null, taglineFill = '#6b7280' } = {}) {
    let s = logoSvg(x, cy - size / 2, size, color);
    const wx = x + size * 1.22, fs = size * 0.78;
    s += pen.text(wx, cy + fs * 0.35, 'pastecal', { size: fs, weight: 800, fill: color, spacing: -fs * 0.01 });
    if (tagline) {
        const w = pen.width('pastecal', fs, 800);
        s += pen.text(wx + w + fs * 0.45, cy + fs * 0.33, tagline, { size: fs * 0.84, weight: 500, fill: taglineFill });
    }
    return s;
}

// ---- 1. the static site card (public/img/og-card.png) ------------------------------------------
export function siteCard(pen) {
    const W = 1200, H = 630, t = THEMES.light;
    let s = svgOpen(W, H, W, 'pastecal: Add events. Paste your link. Done.');
    s += rect(0, 0, W, H, 0, t.bg);
    // Right: a soft indigo field holding a mini month.
    s += rect(660, 0, 540, H, 0, '#eef0fa');
    s += lockup(pen, 72, 104, 60, t.brand);
    s += pen.text(72, 274, 'Add events.', { size: 74, weight: 800, fill: t.text, spacing: -1.2 });
    s += pen.text(72, 364, 'Paste your link.', { size: 74, weight: 800, fill: t.text, spacing: -1.2 });
    s += pen.text(72, 454, 'Done.', { size: 74, weight: 800, fill: t.accent, spacing: -1.2 });
    s += pen.text(72, 540, 'Shared calendars. No sign-ups.', { size: 30, weight: 500, fill: t.muted });
    s += miniMonth(pen, 712, 92, 436, 446);
    return s + '</svg>';
}

// A decorative month (October, today the 24th) with event bars in the app's palette.
function miniMonth(pen, x, y, w, h) {
    const t = THEMES.light;
    let s = `<rect x="${x + 2}" y="${y + 10}" width="${w}" height="${h}" rx="22" fill="#1c1c1e" opacity="0.07"/>`;
    s += `<rect x="${x}" y="${y + 4}" width="${w}" height="${h}" rx="22" fill="#1c1c1e" opacity="0.05"/>`;
    s += rect(x, y, w, h, 22, '#ffffff');
    s += pen.text(x + 28, y + 52, 'October', { size: 28, weight: 800, fill: t.text });
    // the "Share" pill, as in the app's header
    s += rect(x + w - 120, y + 26, 92, 36, 18, t.accent);
    s += pen.text(x + w - 74, y + 50, 'Share', { size: 17, weight: 700, fill: '#ffffff', anchor: 'middle' });
    const gx = x + 20, gy = y + 92, cw = (w - 40) / 7, ch = 64;
    'SMTWTFS'.split('').forEach((d, i) => { s += pen.text(gx + cw * i + cw / 2, gy, d, { size: 15, weight: 700, fill: t.muted, anchor: 'middle' }); });
    // October 2026 starts on a Thursday (col 4); 5 rows shown.
    const first = 4;
    const bars = { 2: ['#3f51b5', 1], 6: ['#e3165b', 1], 9: ['#2e7d32', 2], 13: ['#ff9800', 1], 15: ['#3f51b5', 1], 20: ['#03a9f4', 1], 22: ['#e3165b', 1], 25: ['#2e7d32', 1], 27: ['#3f51b5', 1], 29: ['#ff9800', 2] };
    const second = { 13: '#3f51b5', 22: '#2e7d32', 27: '#d0442f' };
    for (let row = 0; row < 5; row++) {
        const ly = gy + 16 + row * ch;
        s += `<line x1="${gx}" y1="${ly}" x2="${gx + cw * 7}" y2="${ly}" stroke="${t.line}" stroke-width="1.5"/>`;
        for (let col = 0; col < 7; col++) {
            const day = row * 7 + col - first + 1;
            if (day < 1 || day > 31) continue;
            const cx = gx + cw * col;
            if (day === 24) {
                s += `<circle cx="${cx + cw / 2}" cy="${ly + 18}" r="13" fill="${t.accent}"/>`;
                s += pen.text(cx + cw / 2, ly + 24, String(day), { size: 15, weight: 800, fill: '#ffffff', anchor: 'middle' });
            } else {
                s += pen.text(cx + cw / 2, ly + 24, String(day), { size: 15, weight: 600, fill: col === 0 || col === 6 ? t.muted : t.text2, anchor: 'middle' });
            }
            if (bars[day]) {
                const [c, span] = bars[day];
                const spanCols = Math.min(span, 7 - col);
                s += rect(cx + 5, ly + 34, cw * spanCols - 10, 10, 5, c);
            }
            if (second[day]) s += rect(cx + 5, ly + 48, cw - 10, 10, 5, second[day]);
        }
    }
    return s;
}

// ---- 2. the calendar link card (/og/<id>.png) ---------------------------------------------------
/**
 * model: {title, events: [{title, color, day (day number), time ("7pm"|null)}] (at most 3), more (count
 * beyond those), branded (show the pastecal footer), tzLabel}
 */
export function calendarCard(pen, model) {
    const W = 1200, H = 630, t = THEMES.light, X = 72, R = W - 72;
    let s = svgOpen(W, H, W, clean(model.title) || 'A shared calendar');
    s += rect(0, 0, W, H, 0, t.bg);
    s += rect(0, 0, W, 10, 0, t.brand);
    const footerTop = model.branded ? 540 : H;
    // Title: one line at 68px, else two at 56px.
    const title = clean(model.title) || 'A shared calendar';
    let lines = [title], ts = 68;
    if (pen.width(title, 68, 800) > R - X) { ts = 56; lines = pen.wrap(title, 56, 800, R - X, 2); }
    let y = 64 + ts * 0.86;
    for (const l of lines) { s += pen.text(X, y, l, { size: ts, weight: 800, fill: t.text, spacing: -ts * 0.012 }); y += ts * 1.14; }
    const top = y - ts * 1.14 + 44;
    const evs = model.events || [];
    if (!evs.length) {
        const h = Math.min(170, footerTop - 40 - top);
        const wy = top + Math.max(0, (footerTop - 40 - top - h) / 2);
        s += rect(X, wy, R - X, h, 20, t.surface, ` stroke="${t.line}" stroke-width="2"`);
        s += calIcon(X + 48, wy + h / 2 - 28, 56, t.muted);
        s += pen.text(X + 128, wy + h / 2 + 12, 'No upcoming events', { size: 36, weight: 700, fill: t.text2 });
    } else {
        const rowH = 84, gap = 18;
        const listH = evs.length * rowH + (evs.length - 1) * gap;
        let ry = top + Math.max(0, (footerTop - 36 - top - listH) / 2);
        for (const e of evs) {
            const d = new Date(e.day);
            // date tile
            s += rect(X, ry, 84, rowH, 16, t.soft);
            s += pen.text(X + 42, ry + 28, MONTHS[d.getUTCMonth()], { size: 19, weight: 700, fill: t.accent, anchor: 'middle' });
            s += pen.text(X + 42, ry + 67, String(d.getUTCDate()), { size: 38, weight: 800, fill: t.text, anchor: 'middle' });
            // chip with the event's title, then weekday and time
            const meta = WEEKDAYS[d.getUTCDay()] + (e.time ? ` · ${e.time}` : '');
            const metaW = pen.width(meta, 28, 500);
            const cx = X + 84 + 22, maxChip = R - cx - metaW - 24;
            const label = pen.fit(e.title || '(No title)', 32, 700, maxChip - 48);
            const cw = pen.width(label, 32, 700) + 48;
            const color = safeColor(e.color) || DEFAULT_COLORS[0];
            s += rect(cx, ry + 10, cw, rowH - 20, 14, color);
            s += pen.text(cx + 24, ry + rowH / 2 + 11, label, { size: 32, weight: 700, fill: onColor(color) });
            s += pen.text(cx + cw + 22, ry + rowH / 2 + 10, meta, { size: 28, weight: 500, fill: t.muted });
            ry += rowH + gap;
        }
    }
    if (model.branded) {
        s += `<line x1="0" y1="${footerTop}" x2="${W}" y2="${footerTop}" stroke="${t.line}" stroke-width="2"/>`;
        s += lockup(pen, X, footerTop + 45, 40, t.brand, { tagline: '· Shared calendars. No sign-ups.', taglineFill: t.muted });
    }
    const right = [model.more > 0 ? `+${model.more} more` : null].filter(Boolean).join(' · ');
    if (right) s += pen.text(R, model.branded ? footerTop + 55 : H - 40, right, { size: 28, weight: 600, fill: t.muted, anchor: 'end' });
    return s + '</svg>';
}

// A small calendar glyph (outline), for empty states.
function calIcon(x, y, size, color) {
    const k = size / 24;
    return `<g transform="translate(${x} ${y}) scale(${k})" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/></g>`;
}

