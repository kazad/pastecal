// @ts-check
// Regression tests for settings application after page load.
//
// Bug history: globalSettings (e.g. timeFormat=24) saved to localStorage but
// Syncfusion's scheduleObj.timeFormat stayed at the default 12-hour after reload.
// applyGlobalSettings only ran when remote calendar load succeeded AND scheduleObj
// was already constructed at callback time — every other code path silently
// skipped Syncfusion application, leaving the calendar grid rendering 12-hour
// even though localStorage and the settings dropdown both said 24-hour.

const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:8000';

async function waitForApp(page) {
  await page.waitForFunction(() => !!window.scheduleObj && !!document.getElementById('app')?._vnode?.component?.proxy, { timeout: 15000 });
  // Give Firebase callback a chance to fire
  await page.waitForTimeout(2500);
}

async function readState(page) {
  // Switch to Week view so time cells render — assert against actual DOM, not just
  // the Syncfusion property. We learned the hard way that scheduleObj.timeFormat can
  // be set while the rendered cells stay stale.
  await page.evaluate(() => { if (window.scheduleObj) window.scheduleObj.currentView = 'Week'; });
  await page.waitForTimeout(500);
  return await page.evaluate(() => {
    const proxy = document.getElementById('app')._vnode.component.proxy;
    return {
      stored: JSON.parse(localStorage.getItem('pastecal_global_settings') || '{}'),
      vueTimeFormat: proxy.globalSettings.timeFormat,
      scheduleObjTimeFormat: window.scheduleObj?.timeFormat,
      firstTimeCellText: document.querySelector('.e-time-cells-wrap .e-time-slots span')?.textContent || null,
    };
  });
}

test.describe('Settings application on page load', () => {
  test('24-hour format persists across reload on a calendar URL', async ({ page }) => {
    // Seed localStorage with 24-hour preference before any app code runs.
    await page.goto(BASE + '/');
    await page.evaluate(() => {
      localStorage.setItem('pastecal_global_settings', JSON.stringify({
        firstDayOfWeek: '0',
        timeFormat: '24',
        defaultView: 'Month',
        customViewDuration: 3,
        customViewUnit: 'Months',
        startHour: '05:00',
        darkMode: 'auto',
      }));
    });

    // Navigate to a calendar URL (existing or new — either path must apply settings).
    const slug = 'tf-test-' + Date.now().toString().slice(-8);
    await page.goto(BASE + '/' + slug);
    await waitForApp(page);

    const state = await readState(page);
    expect(state.stored.timeFormat).toBe('24');
    expect(state.vueTimeFormat).toBe('24');
    // The bug: scheduleObjTimeFormat was null or 'hh:mm a' (12-hour) here.
    expect(state.scheduleObjTimeFormat).toBe('HH:mm');
    // The visible symptom: rendered time cells showed AM/PM despite saved 24-hour.
    expect(state.firstTimeCellText).not.toMatch(/AM|PM/);
    expect(state.firstTimeCellText).toMatch(/^\d{2}:\d{2}$/);
  });

  test('12-hour format persists across reload on a calendar URL', async ({ page }) => {
    await page.goto(BASE + '/');
    await page.evaluate(() => {
      localStorage.setItem('pastecal_global_settings', JSON.stringify({
        firstDayOfWeek: '0',
        timeFormat: '12',
        defaultView: 'Month',
        customViewDuration: 3,
        customViewUnit: 'Months',
        startHour: '05:00',
        darkMode: 'auto',
      }));
    });

    const slug = 'tf-test-' + Date.now().toString().slice(-8);
    await page.goto(BASE + '/' + slug);
    await waitForApp(page);

    const state = await readState(page);
    expect(state.stored.timeFormat).toBe('12');
    expect(state.vueTimeFormat).toBe('12');
    expect(state.scheduleObjTimeFormat).toBe('hh:mm a');
    expect(state.firstTimeCellText).toMatch(/AM|PM/);
  });
});
