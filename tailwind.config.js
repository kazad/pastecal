/**
 * Tailwind, prebuilt (scripts/build-css.sh -> public/tailwind.css).
 *
 * The page used to load cdn.tailwindcss.com: a 124 KB compiler that rebuilt the CSS
 * in every visitor's browser, on every page load, before anything could be drawn --
 * worst on exactly the cheap phones where pastecal is used most. This is the same
 * version (3.4.17) and the same config, compiled once at deploy time.
 *
 * `content` must list every file that writes class names, or those classes are left
 * out of the build and silently render unstyled. Vue templates live inside the JS
 * files as strings, so the JS is scanned too.
 */
module.exports = {
  content: [
    './public/index.html',
    './public/*.js',
    './public/components/**/*.js',
    './public/directives/**/*.js',
    './public/services/**/*.js',
    './public/utils/**/*.js',
    './public/models/**/*.js',
  ],
  // Dark mode is driven by data-theme="dark" on <html> (see applyTheme in app.js),
  // not the OS preference. Without this, every `dark:` utility silently never applies.
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      // Theme tokens from style.css, exposed so they work with variants
      // (disabled:, hover:, focus:); the plain .bg-1/.text-color-1 classes do not.
      colors: {
        theme: {
          bg: 'var(--bg)',
          panel: 'var(--panel-bg)',
          disabled: 'var(--bg-disabled)',
          border: 'var(--border-color)',
          muted: 'var(--text-color-1)',
          strong: 'var(--text-color-2)',
          hover: 'var(--bg-interactive-hover)',
        },
      },
    },
  },
};
