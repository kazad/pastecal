import { chromium } from '@playwright/test';

async function run() {
    console.log('🚀 Starting Playwright live Cloudflare E2E test...');
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    const calId = `test-e2e-${Date.now()}`;
    const url = `https://pastecal.com/${calId}`;
    console.log(`🔨 Creating initial calendar room for ${calId}...`);
    const createRes = await fetch(`https://pastecal.com/cal/${encodeURIComponent(calId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: calId, title: 'Live Test Calendar', events: [] })
    });
    console.log(`   Create room response status: ${createRes.status}`);

    console.log(`📍 Navigating to live calendar: ${url}`);

    const wsFrames = [];
    page.on('websocket', (ws) => {
        console.log(`🔌 WebSocket opened: ${ws.url()}`);
        ws.on('framesent', (frame) => {
            try {
                const parsed = JSON.parse(frame.payload);
                wsFrames.push({ dir: 'sent', data: parsed });
                console.log(`📤 WS Sent: [t=${parsed.t}]`, frame.payload.slice(0, 120));
            } catch {}
        });
        ws.on('framereceived', (frame) => {
            try {
                const parsed = JSON.parse(frame.payload);
                wsFrames.push({ dir: 'recv', data: parsed });
                console.log(`📥 WS Recv: [t=${parsed.t}]`, frame.payload.slice(0, 120));
            } catch {}
        });
    });

    page.on('console', (msg) => console.log(`🖥️  PAGE LOG [${msg.type()}]:`, msg.text()));
    page.on('pageerror', (err) => console.log(`💥 PAGE ERROR:`, err.message));

    // Capture Analytics.track calls
    const analyticsEvents = [];
    await page.addInitScript(() => {
        window.__analyticsEvents = [];
        const interval = setInterval(() => {
            if (window.Analytics && !window.__analyticsHooked) {
                window.__analyticsHooked = true;
                const origTrack = window.Analytics.track.bind(window.Analytics);
                window.Analytics.track = function (name, params) {
                    window.__analyticsEvents.push({ name, params });
                    return origTrack(name, params);
                };
            }
        }, 50);
    });

    await page.goto(url, { waitUntil: 'networkidle' });

    // 1. Verify calendar initialized and connected to Cloudflare
    await page.waitForFunction(() => typeof CalendarDataService !== 'undefined' && !!window.scheduleObj);
    const isCloudflare = await page.evaluate(() => {
        return typeof CloudCalendarService !== 'undefined' ? CloudCalendarService.enabled() : false;
    });
    console.log(`✅ CloudCalendarService active: ${isCloudflare}`);

    // Wait for room snapshot connection
    await page.waitForFunction(() => {
        return typeof CalendarDataService !== 'undefined' && Object.keys(CalendarDataService._rooms || {}).length > 0;
    }, { timeout: 10000 });
    console.log('✅ Connected to Cloudflare Durable Object room');

    // 2. Manipulate the calendar as a user: Add an event via quick-add input or store
    console.log('✍️  Adding an event to the calendar...');
    await page.evaluate(() => {
        const testEvent = {
            id: 'evt-' + Date.now(),
            title: 'Cloudflare Live Test Event',
            start: new Date(Date.now() + 3600000).toISOString(),
            end: new Date(Date.now() + 7200000).toISOString(),
            type: 1
        };
        const current = CalendarDataService._rooms[Object.keys(CalendarDataService._rooms)[0]];
        const events = [...(current?.server?.events || []), testEvent];
        CalendarDataService.sync({ id: current.id, events });
    });

    await page.waitForTimeout(2500);

    // Verify WebSocket sent a delta command
    const saveFrame = wsFrames.find((f) => f.dir === 'sent' && f.data.t === 'save');
    if (!saveFrame) {
        throw new Error('❌ No save frame sent over WebSocket!');
    }
    console.log(`✅ Delta save frame sent: commands count = ${saveFrame.data.commands?.length}`);
    console.log(`   Command detail:`, JSON.stringify(saveFrame.data.commands[0]));

    // 3. Reload the page to verify persistence from Cloudflare DO
    console.log('🔄 Reloading page to verify persistence from Durable Object...');
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);

    const persistedEvents = await page.evaluate(() => {
        const room = CalendarDataService._rooms[Object.keys(CalendarDataService._rooms)[0]];
        return room?.server?.events || [];
    });
    console.log(`✅ Persisted events count after reload: ${persistedEvents.length}`);
    const foundEvent = persistedEvents.find((e) => e.title === 'Cloudflare Live Test Event');
    if (!foundEvent) {
        throw new Error('❌ Test event was NOT found in persisted events after reload!');
    }
    console.log(`✅ Successfully loaded persisted event: "${foundEvent.title}" (id: ${foundEvent.id})`);

    // 4. Modify the event to test delta update
    console.log('✏️  Updating event title to verify update delta...');
    await page.evaluate((evtId) => {
        const current = CalendarDataService._rooms[Object.keys(CalendarDataService._rooms)[0]];
        const events = (current?.server?.events || []).map((e) => (e.id === evtId ? { ...e, title: 'Updated Cloudflare Event' } : e));
        CalendarDataService.sync({ id: current.id, events });
    }, foundEvent.id);

    await page.waitForTimeout(2000);

    const updateFrame = wsFrames.find((f) => f.dir === 'sent' && f.data.t === 'save' && f.data.commands?.some((c) => c.type === 'update'));
    if (!updateFrame) {
        throw new Error('❌ Expected update delta command not sent over WebSocket!');
    }
    console.log(`✅ Delta update command verified:`, JSON.stringify(updateFrame.data.commands));

    // 5. Simulate an uncaught JS error and verify analytics captures it
    console.log('⚡ Simulating uncaught JS error in browser...');
    await page.evaluate(() => {
        window.dispatchEvent(new ErrorEvent('error', {
            message: 'Uncaught TypeError: cannot read properties of test',
            filename: 'https://pastecal.com/app.js',
            lineno: 999
        }));
    });

    await page.waitForTimeout(1000);

    const capturedEvents = await page.evaluate(() => window.__analyticsEvents || []);
    console.log(`📊 Captured Analytics events count: ${capturedEvents.length}`);
    const jsErrorEvent = capturedEvents.find((e) => e.name === 'js_error');
    if (!jsErrorEvent) {
        throw new Error('❌ Simulated JS error was not captured by Analytics!');
    }
    console.log(`✅ Analytics caught js_error:`, JSON.stringify(jsErrorEvent.params));

    await browser.close();
    console.log('\n🎉 ALL LIVE CLOUDFLARE E2E CHECKS PASSED SUCCESSFULLY!');
}

run().catch((err) => {
    console.error('💥 Test failed:', err);
    process.exit(1);
});
