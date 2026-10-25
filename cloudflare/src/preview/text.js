/**
 * Text safety for link previews and calendar images. Every string a calendar holds (its title, event
 * titles) is written by whoever had the edit link, so it is untrusted: it goes into HTML attributes
 * (meta tags) and SVG text, and each has its own escaping. Pure functions, no Worker APIs.
 */

// Characters XML 1.0 does not allow at all (one of them makes resvg and browsers reject the whole SVG):
// C0 controls except tab/LF/CR, DEL..C1 controls, lone surrogates, U+FFFE/U+FFFF. Bidi overrides are
// dropped too, so a title can't flip the text after it.
const INVALID = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f￾￿‪-‮⁦-⁩]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** One line of display text: invalid characters gone, whitespace (incl. newlines) collapsed. */
export function clean(s) {
    return String(s ?? '').replace(INVALID, '').replace(/\s+/g, ' ').trim();
}

/** For an HTML attribute value in double quotes (and text content). */
export function escapeHtml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** For SVG text and attribute values. clean() first, so the result is always well-formed XML. */
export function escapeXml(s) {
    return clean(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** For SVG text whose spacing matters (a run inside a line): invalid characters dropped, nothing trimmed. */
export function xmlText(s) {
    return String(s ?? '').replace(INVALID, '').replace(/[\t\r\n]/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** At most n user-perceived characters (graphemes), with an ellipsis when cut. */
export function clip(s, n) {
    const str = clean(s);
    const g = graphemes(str);
    if (g.length <= n) return str;
    return g.slice(0, Math.max(1, n - 1)).join('').trimEnd() + '…';
}

const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('en', { granularity: 'grapheme' }) : null;
export function graphemes(s) {
    const str = String(s ?? '');
    return segmenter ? Array.from(segmenter.segment(str), (x) => x.segment) : Array.from(str);
}

// An emoji grapheme: a pictograph, a flag (regional indicator pair) or a keycap.
export function isEmoji(g) {
    return /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u.test(g);
}

// Twemoji's file name for an emoji grapheme: code points in hex, joined by '-', with VS16 dropped
// unless the sequence has a zero-width joiner (their own rule).
export function twemojiCode(g) {
    const cps = Array.from(g, (c) => c.codePointAt(0));
    const list = cps.includes(0x200d) ? cps : cps.filter((c) => c !== 0xfe0f);
    return list.map((c) => c.toString(16)).join('-');
}

// A color safe for an SVG attribute, or null. Calendar colors come from options.colors, which any tab writes.
export function safeColor(c) {
    const s = String(c ?? '').trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(s)) return s;
    if (/^#[0-9a-f]{3}$/.test(s)) return '#' + s.slice(1).split('').map((x) => x + x).join('');
    return null;
}

// WCAG relative luminance of #rrggbb, and the better of white / near-black text on it
// (ScheduleAdapter.onColor does the same for event chips in the app).
function lum(hex) {
    const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
export function contrast(a, b) {
    const x = lum(a), y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
export const ON_LIGHT = '#ffffff', ON_DARK = '#1c1c1e';
export function onColor(hex) {
    return contrast(hex, ON_DARK) > contrast(hex, ON_LIGHT) ? ON_DARK : ON_LIGHT;
}
