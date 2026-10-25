// Screenshots for pastecal.com/templates: each template opened the way a visitor does (/?template=<id>),
// the month grid only, 1x JPEG. Run against `wrangler dev`:  BASE=http://localhost:8787 node scripts/shoot-templates.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/Users/kazad/Dropbox/computer/Projects/pastecal/node_modules/playwright');
const T = require('../public/utils/templates.js');
const BASE = process.env.BASE || 'http://localhost:8787';
const b = await chromium.launch();
for (const { id } of T.all()) {
  const ctx = await b.newContext({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1, colorScheme: 'light' });
  await ctx.route(/googletagmanager|google-analytics|clarity|hotjar|\/api\/collect/, (r) => r.abort());
  const p = await ctx.newPage();
  await p.goto(`${BASE}/?backend=cf&template=${id}`);
  await p.waitForFunction((t) => window.__appMounted && document.querySelector('#app')._vnode.component.proxy.template?.id === t, id, { timeout: 20000 });
  await p.waitForTimeout(900);
  await p.addStyleTag({ content: '.pc-grid-tip,.pc-home-aside,.pc-tpl-nudge{display:none!important}' });
  const box = await p.locator('#cal2_wrap').boundingBox();
  await p.screenshot({ path: `public/img/templates/${id}.jpg`, type: 'jpeg', quality: 78, clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 640) } });
  console.log('shot', id);
  await ctx.close();
}
await b.close();
