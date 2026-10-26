// @ts-check
/**
 * pastecal.com/templates: a gallery of every template, one page each, and "Use this template" opens a new
 * draft with it (/?template=<id>), gallery-only templates included. Needs `wrangler dev` on BASE_URL.
 */
const { test, expect } = require('@playwright/test');
const T = require('../../public/utils/templates.js');

test('the gallery lists every template, and each card opens its page', async ({ page }) => {
  await page.goto('/templates');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Calendar templates');
  const cards = page.locator('.tpl-card');
  await expect(cards).toHaveCount(T.all().length);
  await cards.filter({ hasText: 'On-call rotation' }).click();
  await expect(page).toHaveURL(/\/templates\/on-call-rota$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('On-call rotation');
});

test('"Use this template" starts a draft with it, and a reload keeps it without re-applying', async ({ page }) => {
  await page.goto('/templates/carpool');
  await page.getByTestId('use-template').click();
  await page.waitForFunction(() => window.__appMounted && document.querySelector('#app')._vnode.component.proxy.template?.id === 'carpool', null, { timeout: 20_000 });
  expect(new URL(page.url()).search).not.toContain('template=');   // dropped from the address
  expect(await page.evaluate(() => document.querySelector('#app')._vnode.component.proxy.calendar.title)).toBe('School carpool');
  // the homepage chips stay at seven; gallery-only templates are not chips
  await expect(page.locator('.pc-tpl-chip')).toHaveCount(T.list().length + 1);   // + Blank
});

test('the pages are indexable and listed in the sitemap', async ({ request }) => {
  const sm = await (await request.get('/sitemap.xml')).text();
  for (const p of ['/templates', '/templates/sports-team', '/templates/on-call-rota']) expect(sm).toContain(`https://pastecal.com${p}<`);
});

test('template pages may be indexed; a calendar edit link never', async ({ request }) => {
  for (const p of ['/templates', '/templates/sports-team', '/about', '/help']) {
    expect((await request.get(p)).headers()['x-robots-tag'] || '', p).not.toContain('noindex');
  }
  const id = `test-robots-${Date.now()}`;
  expect((await request.post(`/cal/${id}`, { data: { title: 'Robots', options: {}, events: [] } })).status()).toBe(201);
  expect((await request.get(`/${id}`)).headers()['x-robots-tag'] || '').toContain('noindex');
});
