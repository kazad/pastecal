// @ts-check
// Regression test for user-controllable date format in the event editor.
//
// User report: "Seeing 1/1/26 isn't the format I'm used to and causes problems."
// The Syncfusion editor's Start/End date pickers default to en-US (M/d/yy).
// This makes 6/7/26 ambiguous — June 7 in the US, July 6 in most of the world.
//
// Fix: globalSettings.dateFormat with values 'auto' | 'us' | 'iso' | 'eu',
// applied to Syncfusion's DateTimePicker in the popupOpen hook.

const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:8000';

async function waitForApp(page) {
  await page.waitForFunction(
    () => !!window.scheduleObj && !!document.getElementById('app')?._vnode?.component?.proxy,
    { timeout: 15_000 },
  );
  await page.waitForTimeout(1500);
}

async function openEventEditor(page) {
  await page.evaluate(() => {
    const proxy = document.getElementById('app')._vnode.component.proxy;
    const start = new Date(2026, 0, 7, 10, 0, 0); // Jan 7 — unambiguous test date
    const end = new Date(2026, 0, 7, 11, 0, 0);
    const ev = new Event({ title: 'Test', start: start.toISOString(), end: end.toISOString(), type: 1 });
    proxy.calendar.events = [ev];
    proxy.syncFusionEvents = proxy.calendar.getSyncFusionEvents();
    window.scheduleObj.eventSettings.dataSource = proxy.syncFusionEvents;
  });
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const proxy = document.getElementById('app')._vnode.component.proxy;
    window.scheduleObj.openEditor(proxy.syncFusionEvents[0], 'Save');
  });
  await page.waitForTimeout(600);
}

async function readEditorStartValue(page) {
  return await page.evaluate(() => {
    return document.querySelector('input[name="StartTime"]')?.value || null;
  });
}

test.describe('Date format setting', () => {
  test('iso format renders dates as yyyy-MM-dd', async ({ page }) => {
    await page.goto(BASE + '/');
    await page.evaluate(() => {
      localStorage.setItem('pastecal_global_settings', JSON.stringify({
        firstDayOfWeek: '0', timeFormat: '12', defaultView: 'Month',
        customViewDuration: 3, customViewUnit: 'Months', startHour: '05:00',
        darkMode: 'auto', dateFormat: 'iso',
      }));
    });
    await page.goto(BASE + '/dformat-iso-' + Date.now().toString().slice(-6));
    await waitForApp(page);
    await openEventEditor(page);

    const startValue = await readEditorStartValue(page);
    // ISO: 2026-01-07 — the year must come first, four digits.
    expect(startValue).toMatch(/^2026-01-07/);
  });

  test('eu format renders dates as dd/MM/yyyy', async ({ page }) => {
    await page.goto(BASE + '/');
    await page.evaluate(() => {
      localStorage.setItem('pastecal_global_settings', JSON.stringify({
        firstDayOfWeek: '0', timeFormat: '12', defaultView: 'Month',
        customViewDuration: 3, customViewUnit: 'Months', startHour: '05:00',
        darkMode: 'auto', dateFormat: 'eu',
      }));
    });
    await page.goto(BASE + '/dformat-eu-' + Date.now().toString().slice(-6));
    await waitForApp(page);
    await openEventEditor(page);

    const startValue = await readEditorStartValue(page);
    // EU: 07/01/2026 — day before month, four-digit year.
    expect(startValue).toMatch(/^07\/01\/2026/);
  });

  test('us format renders dates as M/d/yy (existing default)', async ({ page }) => {
    await page.goto(BASE + '/');
    await page.evaluate(() => {
      localStorage.setItem('pastecal_global_settings', JSON.stringify({
        firstDayOfWeek: '0', timeFormat: '12', defaultView: 'Month',
        customViewDuration: 3, customViewUnit: 'Months', startHour: '05:00',
        darkMode: 'auto', dateFormat: 'us',
      }));
    });
    await page.goto(BASE + '/dformat-us-' + Date.now().toString().slice(-6));
    await waitForApp(page);
    await openEventEditor(page);

    const startValue = await readEditorStartValue(page);
    // US: 1/7/26 — month before day, two-digit year.
    expect(startValue).toMatch(/^1\/7\/26/);
  });
});
