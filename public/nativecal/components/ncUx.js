/**
 * NativeCal has two looks while we decide:
 *   v1 (default)  laid out exactly like the Syncfusion calendar people use today
 *   v2 (?ux=2)    the redesign: readable colors and type, drag to create, undo
 *                 instead of "are you sure", "this and following", phone sheets
 * index.html stamps data-ux="2" on <html> from the URL before anything renders, so
 * CSS scopes on [data-ux="2"] and components ask NcUx.v2(). Both write the same data.
 */
const NcUx = {
    v2: () => typeof document !== 'undefined' && document.documentElement.dataset.ux === '2',

    /** Black or white text, whichever has more contrast on this background (WCAG). */
    textOn(hex) {
        const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
        if (!m) return '#fff';
        const n = parseInt(m[1], 16), ch = [n >> 16, (n >> 8) & 255, n & 255].map(v => {
            v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        });
        const L = 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
        const white = 1.05 / (L + 0.05), dark = (L + 0.05) / (0.0116 + 0.05);   // dark = #1c1c1e
        return white >= dark ? '#fff' : '#1c1c1e';
    },
};
if (typeof window !== 'undefined') window.NcUx = NcUx;
