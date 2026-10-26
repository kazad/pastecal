/**
 * Fonts for the preview renderer: which font draws each character, and how wide it is.
 *
 * resvg (the rasterizer) neither wraps nor measures text, and it does not reliably fall back from
 * one font to another per glyph, so layout happens here: a FontSet splits a string into runs, each
 * drawn by one font that has every glyph in it, and measures them from the fonts' own advance widths.
 * Figtree (the app's font, bundled) draws Latin text. Anything else -- Korean, Cyrillic, Arabic... --
 * comes from a fallback font the caller loaded (a Google Fonts subset of just those characters), and
 * emoji are drawn as Twemoji images. A character no font has is left out, so a card never shows tofu.
 *
 * Pure: parsing and measuring only. Fetching fallbacks lives in render.js.
 */
import { graphemes, isEmoji } from './text.js';

// ---- a minimal TrueType reader: family name, weight, unitsPerEm, cmap (formats 4 and 12), advances ----
export function parseFont(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tables = {};
    const n = dv.getUint16(4);
    for (let i = 0; i < n; i++) {
        const o = 12 + i * 16;
        const tag = String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
        tables[tag] = dv.getUint32(o + 8);
    }
    const upem = dv.getUint16(tables.head + 18);
    const numH = dv.getUint16(tables.hhea + 34);
    const weight = tables['OS/2'] ? dv.getUint16(tables['OS/2'] + 4) : 400;
    const advances = new Uint16Array(numH);
    for (let i = 0; i < numH; i++) advances[i] = dv.getUint16(tables.hmtx + i * 4);
    const glyphAdvance = (gid) => advances[Math.min(gid, numH - 1)];

    // cmap: prefer a format 12 (full Unicode) subtable, else format 4 (BMP).
    const cmap = new Map();
    const c = tables.cmap, subs = dv.getUint16(c + 2);
    let f4 = null, f12 = null;
    for (let i = 0; i < subs; i++) {
        const platform = dv.getUint16(c + 4 + i * 8), enc = dv.getUint16(c + 6 + i * 8), off = c + dv.getUint32(c + 8 + i * 8);
        const format = dv.getUint16(off);
        if (format === 12 && (platform === 3 || platform === 0)) f12 = off;
        if (format === 4 && ((platform === 3 && enc === 1) || platform === 0)) f4 = off;
    }
    if (f12 != null) {
        const groups = dv.getUint32(f12 + 12);
        for (let g = 0; g < groups; g++) {
            const o = f12 + 16 + g * 12, start = dv.getUint32(o), end = dv.getUint32(o + 4), gid = dv.getUint32(o + 8);
            for (let cp = start; cp <= end && cp - start < 70000; cp++) cmap.set(cp, gid + cp - start);
        }
    } else if (f4 != null) {
        const segX2 = dv.getUint16(f4 + 6), ends = f4 + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
        for (let s = 0; s < segX2 / 2; s++) {
            const end = dv.getUint16(ends + s * 2), start = dv.getUint16(starts + s * 2);
            const delta = dv.getInt16(deltas + s * 2), ro = dv.getUint16(ranges + s * 2);
            for (let cp = start; cp <= end && cp !== 0xffff; cp++) {
                let gid;
                if (ro === 0) gid = (cp + delta) & 0xffff;
                else {
                    const gi = ranges + s * 2 + ro + (cp - start) * 2;
                    gid = dv.getUint16(gi);
                    if (gid) gid = (gid + delta) & 0xffff;
                }
                if (gid) cmap.set(cp, gid);
            }
        }
    }

    // name ID 1 (family), Windows Unicode first: the exact name resvg matches font-family against.
    let family = '';
    if (tables.name != null) {
        const nt = tables.name, count = dv.getUint16(nt + 2), strOff = nt + dv.getUint16(nt + 4);
        for (let i = 0; i < count && !family; i++) {
            const r = nt + 6 + i * 12;
            const platform = dv.getUint16(r), nameId = dv.getUint16(r + 6), len = dv.getUint16(r + 8), off = dv.getUint16(r + 10);
            if (nameId !== 1 || (platform !== 3 && platform !== 0)) continue;
            let s = '';
            for (let k = 0; k < len; k += 2) s += String.fromCharCode(dv.getUint16(strOff + off + k));
            family = s;
        }
    }
    return {
        family, weight, upem, buffer: bytes,
        has: (cp) => cmap.has(cp),
        // Advance of one code point in em units (0 if missing).
        advance: (cp) => (cmap.has(cp) ? glyphAdvance(cmap.get(cp)) / upem : 0),
    };
}

// Combining marks, joiners and variation selectors: drawn with the character before them.
const ZERO_WIDTH = /[̀-ͯ​-‍︀-️]/u;

/**
 * A FontSet over parsed fonts. `primary` is {weight: font} (Figtree 500/700/800). `fallbacks` is a list
 * of parsed fonts, tried in order for characters the primary lacks. `emoji`: 'image' to lay emoji out
 * as 1em images (the PNG path), 'text' to leave them in the text (the SVG path, drawn by the viewer).
 * `system: true` (the SVG path) keeps every character: the viewer's own fonts will draw them, and
 * unknown widths are estimated.
 */
export class FontSet {
    constructor({ primary, fallbacks = [], emoji = 'image', system = false }) {
        this.primary = primary; this.fallbacks = fallbacks; this.emoji = emoji; this.system = system;
    }
    font(weight) {
        const ws = Object.keys(this.primary).map(Number);
        const w = ws.reduce((a, b) => (Math.abs(b - weight) < Math.abs(a - weight) ? b : a), ws[0]);
        return this.primary[w];
    }
    // Which font draws grapheme g at this weight: the primary, a fallback, 'emoji', 'guess' (system), or null.
    pick(g, weight) {
        if (isEmoji(g)) return 'emoji';
        const cp = g.codePointAt(0);
        const p = this.font(weight);
        if (p.has(cp) || ZERO_WIDTH.test(g)) return p;
        let best = null;
        for (const f of this.fallbacks) if (f.has(cp) && (!best || Math.abs(f.weight - weight) < Math.abs(best.weight - weight))) best = f;
        if (best) return best;
        return this.system ? 'guess' : null;
    }
    // Width of grapheme g in em.
    widthOf(g, font) {
        if (font === 'emoji') return 1.15;
        if (font === 'guess') return /[ᄀ-ᇿ⺀-鿿가-힯豈-﫿＀-￯]/u.test(g) ? 1 : 0.62;
        let w = 0;
        for (const ch of g) w += font.advance(ch.codePointAt(0));
        return w;
    }
    /**
     * Split text into runs [{text, font, family, weight, width}] at `size` px; emoji runs carry `emoji: g`.
     * Characters nothing can draw are dropped (never tofu).
     */
    runs(text, weight, size) {
        const out = [];
        for (const g of graphemes(text)) {
            const font = this.pick(g, weight);
            if (!font) continue;
            const width = this.widthOf(g, font) * size;
            if (font === 'emoji' && this.emoji === 'image') { out.push({ emoji: g, width, text: g }); continue; }
            const key = font === 'emoji' || font === 'guess' ? 'sys' : font;
            const last = out[out.length - 1];
            if (last && !last.emoji && last.key === key) { last.text += g; last.width += width; continue; }
            out.push({ key, text: g, width, family: typeof key === 'object' ? key.family : null, weight: typeof key === 'object' ? key.weight : weight });
        }
        return out;
    }
    measure(text, weight, size) {
        return this.runs(text, weight, size).reduce((a, r) => a + r.width, 0);
    }
    /** text cut to fit maxWidth (with an ellipsis), by graphemes. */
    fit(text, weight, size, maxWidth) {
        if (this.measure(text, weight, size) <= maxWidth) return text;
        const g = graphemes(text);
        let lo = 0, hi = g.length;
        while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            if (this.measure(g.slice(0, mid).join('').trimEnd() + '…', weight, size) <= maxWidth) lo = mid; else hi = mid - 1;
        }
        return g.slice(0, lo).join('').trimEnd() + '…';
    }
    /** Greedy word wrap into at most maxLines lines; the last one is cut with an ellipsis. */
    wrap(text, weight, size, maxWidth, maxLines) {
        const words = text.split(/(\s+)/).filter((w) => w !== '');
        const lines = [];
        let cur = '';
        for (let i = 0; i < words.length; i++) {
            const next = cur + words[i];
            if (!cur || this.measure(next.trimEnd(), weight, size) <= maxWidth) { cur = next; continue; }
            lines.push(cur.trimEnd()); cur = words[i].trimStart();
            if (lines.length === maxLines) { cur = ''; lines[maxLines - 1] = this.fit(lines[maxLines - 1] + ' ' + words.slice(i).join('').trim(), weight, size, maxWidth); break; }
        }
        if (cur && lines.length < maxLines) lines.push(cur.trimEnd());
        // A single word wider than the line (long names without spaces, CJK): cut it.
        return lines.map((l, i) => (i === lines.length - 1 || this.measure(l, weight, size) > maxWidth ? this.fit(l, weight, size, maxWidth) : l));
    }
}

// ---- which Google Fonts family draws a character Figtree lacks ----
const SCRIPTS = [
    [/[ᄀ-ᇿ㄰-㆏가-힯]/u, 'Noto Sans KR'],
    [/[぀-ヿㇰ-ㇿ]/u, 'Noto Sans JP'],
    [/[⺀-⿟　-〿㐀-䶿一-鿿豈-﫿＀-￯]/u, 'Noto Sans SC'],
    [/[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/u, 'Noto Sans Arabic'],
    [/[֐-׿]/u, 'Noto Sans Hebrew'],
    [/[฀-๿]/u, 'Noto Sans Thai'],
    [/[ऀ-ॿ]/u, 'Noto Sans Devanagari'],
    [/[ঀ-৿]/u, 'Noto Sans Bengali'],
    [/[஀-௿]/u, 'Noto Sans Tamil'],
    [/[԰-֏]/u, 'Noto Sans Armenian'],
    [/[Ⴀ-ჿ]/u, 'Noto Sans Georgian'],
    [/[←-⯿]/u, 'Noto Sans Symbols 2'],
];
/**
 * The fallback fonts a set of strings needs: [{family, weight, text}] -- the characters the primary
 * lacks, grouped by Google Fonts family and weight. `strings` is [[text, weight], ...].
 * Japanese text keeps its Han characters in the JP font, so a name reads in one style.
 */
export function neededFallbacks(fontSet, strings) {
    const groups = new Map();
    for (const [text, weight] of strings) {
        const gs = graphemes(text);
        const hasKana = gs.some((g) => /[぀-ヿ]/u.test(g));
        for (const g of gs) {
            if (isEmoji(g) || ZERO_WIDTH.test(g)) continue;
            const cp = g.codePointAt(0);
            if (fontSet.font(weight).has(cp) || cp < 0x20) continue;
            let family = 'Noto Sans';
            for (const [re, fam] of SCRIPTS) if (re.test(g)) { family = fam; break; }
            if (family === 'Noto Sans SC' && hasKana) family = 'Noto Sans JP';
            const w = weight >= 750 ? 800 : weight >= 600 ? 700 : 500;
            const key = `${family}|${w}`;
            if (!groups.has(key)) groups.set(key, { family, weight: w, chars: new Set() });
            for (const ch of g) groups.get(key).chars.add(ch);
        }
    }
    return [...groups.values()].map((x) => ({ family: x.family, weight: x.weight, text: [...x.chars].sort().join('') }));
}

/** Every emoji grapheme in the strings. */
export function neededEmoji(strings) {
    const out = new Set();
    for (const [text] of strings) for (const g of graphemes(text)) if (isEmoji(g)) out.add(g);
    return [...out];
}
