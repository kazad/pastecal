/**
 * Tailwind for the native renderer (/beta, /nativecal): scripts/build-css.sh -> public/nativecal/tailwind.css.
 *
 * nativecal/index.html used the Play CDN (cdn.tailwindcss.com), an in-browser compiler that is
 * not meant for production. Same version and config as the main app (tailwind.config.js), only
 * scanning the files the native page uses: its own HTML and components plus the shared ones.
 */
const base = require('./tailwind.config.js');
module.exports = {
  ...base,
  // Only the theme colors: the main app's token-mapped sizes, radii and shadows (tailwind.config.js)
  // are not applied to NativeCal, which keeps Tailwind's own scale (shadow-sm, text-2xl).
  theme: { extend: base.theme.extend },
  content: [
    './public/nativecal/**/*.{html,js}',
    './public/components/**/*.js',
    './public/directives/**/*.js',
    './public/services/**/*.js',
    './public/utils/**/*.js',
    './public/models/**/*.js',
  ],
};
