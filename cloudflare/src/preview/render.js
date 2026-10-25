/**
 * SVG -> PNG with resvg (WebAssembly), plus the fallback fonts and emoji a string needs.
 *
 * The wasm module and Figtree are passed in (setup), so this file runs in the Worker (route.js imports
 * them as modules) and in node (scripts read them from disk). Fallback fonts are Google Fonts subsets of
 * exactly the characters needed (?text=), and emoji are Twemoji SVGs; both are fetched with a deadline
 * and cached, and anything that does not arrive in time is simply left out of the picture.
 *
 * Vendored (src/vendor): @resvg/resvg-wasm 2.6.2 (MPL-2.0), Figtree 500/700/800 from Google Fonts (OFL),
 * rrule 2.8.1 (BSD-3-Clause). Regenerate the static card with cloudflare/scripts/render-preview-cards.mjs.
 */
import { initWasm, Resvg } from '../vendor/resvg-2.6.2/index.mjs';
import { parseFont, FontSet, neededFallbacks, neededEmoji } from './fonts.js';
import { twemojiCode } from './text.js';

let ready = null;                 // the wasm init, once per isolate
let primary = null;               // {500, 700, 800}: parsed Figtree

/** Once per isolate: wasm (a WebAssembly.Module or bytes) and Figtree {weight: ArrayBuffer|Uint8Array}. */
export function setup(wasm, figtree) {
    if (!ready) ready = initWasm(wasm).catch((e) => { ready = null; throw e; });
    if (!primary) {
        primary = {};
        for (const [w, buf] of Object.entries(figtree)) { const f = parseFont(buf); f.family = 'Figtree'; primary[w] = f; }
    }
    return ready;
}

export function primaryFonts() { return primary; }

/** A FontSet for the SVG output: the viewer's own fonts draw it, measured as if Figtree. */
export function systemFontSet() { return new FontSet({ primary, emoji: 'text', system: true }); }

const FONT_TTL = 30 * 86400;
/**
 * Fallback fonts and emoji images for these strings ([[text, weight], ...]). `fetcher(url)` returns a
 * Response (fetch, or a cached fetch); everything must arrive within `deadlineMs`.
 * -> {fontSet, emoji: {grapheme: dataURI}, fallbackBuffers}
 */
export async function prepare(strings, { fetcher = fetch, deadlineMs = 2500 } = {}) {
    const base = new FontSet({ primary, emoji: 'image' });
    const wanted = neededFallbacks(base, strings);
    const emojis = neededEmoji(strings).slice(0, 24);
    const timeout = new Promise((resolve) => setTimeout(resolve, deadlineMs, 'timeout'));
    const fonts = [], emoji = {};
    const jobs = [
        ...wanted.map(async (w) => {
            const css = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(w.family).replace(/%20/g, '+')}:wght@${w.weight}&text=${encodeURIComponent(w.text)}`;
            const r = await fetcher(css);
            if (!r.ok) return;
            const m = /url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/.exec(await r.text());
            if (!m) return;
            const f = await fetcher(m[1]);
            if (!f.ok) return;
            fonts.push(parseFont(new Uint8Array(await f.arrayBuffer())));
        }),
        ...emojis.map(async (g) => {
            const r = await fetcher(`https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/svg/${twemojiCode(g)}.svg`);
            if (!r.ok) return;
            const text = await r.text();
            if (!/^<svg[\s>]/.test(text.trim()) || /<script|href=|xlink:/i.test(text)) return;   // twemoji are plain paths
            emoji[g] = 'data:image/svg+xml;base64,' + b64(new TextEncoder().encode(text));
        }),
    ].map((p) => p.catch(() => { /* a missing fallback only drops those characters */ }));
    await Promise.race([Promise.all(jobs), timeout]);
    return { fontSet: new FontSet({ primary, fallbacks: [...fonts], emoji: 'image' }), emoji: { ...emoji } };
}

function b64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
}

/** Rasterize: the SVG at `width` px wide, with Figtree and the fallbacks in fontSet. -> Uint8Array PNG */
export async function toPng(svg, fontSet, width) {
    await ready;
    const buffers = [...Object.values(primary), ...(fontSet.fallbacks || [])].map((f) => f.buffer);
    const r = new Resvg(svg, {
        fitTo: { mode: 'width', value: Math.round(width) },
        font: { fontBuffers: buffers, defaultFontFamily: 'Figtree', loadSystemFonts: false },
        imageRendering: 0, shapeRendering: 2, textRendering: 1,
    });
    const img = r.render();
    const png = img.asPng();
    img.free?.(); r.free?.();
    return png;
}

export { FONT_TTL };
