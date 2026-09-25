/**
 * NativeCal's icons: Lucide (lucide.dev, ISC license, lucide-static 1.48.0), inlined so
 * the calendar needs no icon font or extra request. One line style everywhere instead
 * of text glyphs, which render differently per font and platform.
 *
 *   <nc-icon name="chevron-left" :size="20"></nc-icon>
 */
const NC_ICONS = {
    'chevron-left': '<path d="m15 18-6-6 6-6" />',
    'chevron-right': '<path d="m9 18 6-6-6-6" />',
    'chevron-up': '<path d="m18 15-6-6-6 6" />',
    'chevron-down': '<path d="m6 9 6 6 6-6" />',
    'x': '<path d="M18 6 6 18" /> <path d="m6 6 12 12" />',
    'pencil': '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" /> <path d="m15 5 4 4" />',
    'trash-2': '<path d="M10 11v6" /> <path d="M14 11v6" /> <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /> <path d="M3 6h18" /> <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />',
    'calendar-clock': '<path d="M16 14v2.2l1.6 1" /> <path d="M16 2v3" /> <path d="M21 7.338V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2h2.338" /> <path d="M3 9h5.859" /> <path d="M8 2v3" /> <circle cx="16" cy="16" r="6" />',
    'text-align-start': '<path d="M21 5H3" /> <path d="M15 12H3" /> <path d="M17 19H3" />',
    'repeat': '<path d="m17 2 4 4-4 4" /> <path d="M3 11v-1a4 4 0 0 1 4-4h14" /> <path d="m7 22-4-4 4-4" /> <path d="M21 13v1a4 4 0 0 1-4 4H3" />',
    'ellipsis-vertical': '<circle cx="12" cy="12" r="1" /> <circle cx="12" cy="5" r="1" /> <circle cx="12" cy="19" r="1" />',
    'check': '<path d="M20 6 9 17l-5-5" />',
};
const NcIcon = {
    props: { name: { type: String, required: true }, size: { type: [Number, String], default: 18 }, strokeWidth: { type: [Number, String], default: 2 } },
    computed: { body() { return NC_ICONS[this.name] || ''; } },
    template: `<svg class="nc-lucide" xmlns="http://www.w3.org/2000/svg" :width="size" :height="size" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" :stroke-width="strokeWidth" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" v-html="body"></svg>`,
};
if (typeof window !== 'undefined') { window.NcIcon = NcIcon; window.NC_ICONS = NC_ICONS; }
