// @ts-check
/**
 * Firebase is retired in the browser (Oct 25 2026). Driven like a visitor:
 *   1. Opening a calendar and adding an event makes no request to Firebase (gstatic firebasejs, firebaseio,
 *      identitytoolkit, securetoken, apis.google.com) and the event is saved on Cloudflare.
 *   2. A browser that signed in to Firebase before (its user kept in IndexedDB) still adopts that uid as its
 *      pastecal id, so calendars it created stay its own.
 * Needs `wrangler dev` on BASE_URL (default http://localhost:8787).
 */
const { test, expect } = require('@playwright/test');

const FIREBASE = /gstatic\.com\/firebasejs|firebaseio\.com|identitytoolkit|securetoken|apis\.google\.com/;

test('no Firebase request, and an edit is saved on Cloudflare', async ({ browser, request }) => {
  const id = `test-nofb-${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
  expect((await request.post(`/cal/${id}`, { data: { title: 'No Firebase', options: {}, events: [] } })).status()).toBe(201);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => { window.__TEST__ = true; });
  const firebaseHits = [];
  ctx.on('request', (r) => { if (FIREBASE.test(r.url())) firebaseHits.push(r.url()); });
  await ctx.route(/googletagmanager|google-analytics|clarity|hotjar/, (r) => r.abort());
  const page = await ctx.newPage();
  await page.goto(`/${id}`);
  await page.waitForFunction(() => window.__appMounted && window.scheduleObj && document.querySelector('.e-work-cells'), null, { timeout: 20_000 });
  expect(await page.evaluate(() => typeof window.firebase)).toBe('undefined');
  await page.getByTestId('desktop-add-event-button').click();
  await page.keyboard.type('Saved without Firebase tomorrow at 10am', { delay: 15 });
  await page.keyboard.press('Enter');
  await expect.poll(async () => ((await (await request.get(`/cal/${id}`)).json()).calendar.events || []).map((e) => e.title)).toContain('Saved without Firebase');
  await page.waitForTimeout(1500);
  expect(firebaseHits, firebaseHits.join('\n')).toEqual([]);
  await ctx.close();
});

test('a browser with an old Firebase user adopts its uid as its pastecal id', async ({ browser }) => {
  const ctx = await browser.newContext();
  await ctx.route(/googletagmanager|google-analytics|clarity|hotjar/, (r) => r.abort());
  const page = await ctx.newPage();
  await page.goto('/help');   // same origin, no app: plant the old Firebase store first
  await page.evaluate(() => new Promise((ok, fail) => {
    const req = indexedDB.open('firebaseLocalStorageDb', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('firebaseLocalStorage', { keyPath: 'fbase_key' });
    req.onerror = () => fail(req.error);
    req.onsuccess = () => {
      const tx = req.result.transaction('firebaseLocalStorage', 'readwrite');
      tx.objectStore('firebaseLocalStorage').put({ fbase_key: 'firebase:authUser:KEY:[DEFAULT]', value: { uid: 'old-firebase-uid-123' } });
      tx.oncomplete = () => { req.result.close(); ok(); };
    };
  }));
  await page.goto('/?backend=cf');
  await page.waitForFunction(() => window.__appMounted, null, { timeout: 20_000 });
  expect(await page.evaluate(() => AuthorSignal.ready())).toBe('old-firebase-uid-123');
  expect(await page.evaluate(() => localStorage.getItem('pastecal_browser_id'))).toBe('old-firebase-uid-123');
  await ctx.close();
});
