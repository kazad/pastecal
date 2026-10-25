#!/usr/bin/env node
// Copies scripts/site-chrome/header.html and footer.html into every static page, between
//   <!-- site-header --> ... <!-- /site-header -->   and   <!-- site-footer --> ... <!-- /site-footer -->
// and makes sure the page links /tokens.css, /components.css and /site.css. Safe to run again: no change means no write.
// Run it after editing a partial:  node scripts/sync-site-chrome.mjs
// A page with no markers yet gets them: its old hand-written header/footer block is replaced
// (header right after <body>, footer just before </body>).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PAGES = ['pricing', 'help', 'about', 'privacy', 'terms', 'report', 'contact', 'signin', 'account', 'handle', 'templates', 'features'].map(n => `public/${n}.html`)
  // the template pages (scripts/build-templates.mjs)
  .concat(fs.existsSync(path.join(root, 'public/templates')) ? fs.readdirSync(path.join(root, 'public/templates')).filter((f) => f.endsWith('.html')).sort().map((f) => `public/templates/${f}`) : []);
// The homepage has the app's own header, and ends with the same site footer (inside its markers).
export const FOOTER_ONLY = ['public/index.html'];
export const syncFooter = (html, footer = partial('footer.html')) => html.replace(markerRe('site-footer'), () => block('site-footer', footer));
const partial = (n) => fs.readFileSync(path.join(root, 'scripts/site-chrome', n), 'utf8').trim();
export const block = (name, html) => `<!-- ${name} -->\n${html}\n<!-- /${name} -->`;
export const markerRe = (name) => new RegExp(`<!-- ${name} -->[\\s\\S]*?<!-- /${name} -->`);

// Old hand-written blocks, removed the first time a page gets markers.
const OLD = {
  'site-header': [/<header class="site">[\s\S]*?<\/header>\s*/, /<a class="top"[^>]*>[\s\S]*?<\/a>\s*/],
  'site-footer': [/<nav class="foot">[\s\S]*?<\/nav>\s*/, /<footer>[\s\S]*?<\/footer>\s*/],
};

export function sync(html, header = partial('header.html'), footer = partial('footer.html')) {
  let out = html;
  for (const [name, part] of [['site-header', header], ['site-footer', footer]]) {
    if (markerRe(name).test(out)) { out = out.replace(markerRe(name), () => block(name, part)); continue; }
    for (const re of OLD[name]) out = out.replace(re, '');
    if (name === 'site-header') out = out.replace(/<body>/, () => `<body>\n${block(name, part)}\n`);
    else out = out.replace(/<\/body>/, () => `${block(name, part)}\n</body>`);
  }
  for (const css of ['/tokens.css', '/components.css', '/site.css']) {
    if (!out.includes(`href="${css}"`)) {
      // components.css right after tokens.css: the building blocks, before any page's own styles
      if (css === '/components.css' && out.includes('href="/tokens.css">')) { out = out.replace('href="/tokens.css">', () => 'href="/tokens.css"><link rel="stylesheet" href="/components.css">'); continue; }
      // after the last stylesheet link in the head (site.css after tokens.css and legal.css), else before </head>
      const link = `<link rel="stylesheet" href="${css}">`;
      const m = [...out.slice(0, out.indexOf('</head>')).matchAll(/<link rel="stylesheet"[^>]*>/g)].pop();
      out = css === '/site.css' || !m ? out.replace('</head>', () => `${link}\n</head>`) : out.replace(m[0], () => `${m[0]}${link}`);
    }
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const rel of PAGES) {
    const file = path.join(root, rel);
    const before = fs.readFileSync(file, 'utf8');
    const after = sync(before);
    if (after !== before) { fs.writeFileSync(file, after); console.log('updated', rel); } else console.log('ok     ', rel);
  }
  for (const rel of FOOTER_ONLY) {
    const file = path.join(root, rel);
    const before = fs.readFileSync(file, 'utf8');
    if (!markerRe('site-footer').test(before)) throw new Error(`${rel} has no <!-- site-footer --> markers`);
    const after = syncFooter(before);
    if (after !== before) { fs.writeFileSync(file, after); console.log('updated', rel); } else console.log('ok     ', rel);
  }
}
