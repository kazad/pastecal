const { chromium } = require('playwright');
const path = require('path');

const ARTIFACT_DIR = '/Users/kazad/.gemini/antigravity-cli/brain/4c2fcad4-b95a-4060-8317-59b9a407b98b';

(async () => {
    const browser = await chromium.launch({ headless: true });
    // 1440x900 standard desktop
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    console.log('Navigating to edge-to-edge preview...');
    await page.goto('http://localhost:8000/preview/durango-dance', { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);

    // 1. Edge-to-Edge Desktop Default (Pro Studio, 🍂 Autumn Ember, 5 Subcalendars)
    console.log('Capturing edge-to-edge-1-studio-autumn.png...');
    await page.evaluate(() => {
        window.setProTier('studio');
        window.setThemePreset('autumn');
        window.setStudioIcon('🩰', 'Durango Dance Studio', 'dance academy · pro studio');
    });
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'edge-to-edge-1-studio-autumn.png') });

    // 2. Open Pricing Modal on Edge-to-Edge (Side-by-side 4-column SaaS comparison)
    console.log('Opening pricing modal on edge-to-edge...');
    await page.evaluate(() => {
        window.openPricingModal();
    });
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'edge-to-edge-2-pricing-modal.png') });

    // Close Pricing Modal
    await page.evaluate(() => {
        window.closePricingModal();
    });
    await page.waitForTimeout(400);

    // 3. Switch to Winter / ❄️ Frost & Midnight Theme Edge-to-Edge
    console.log('Switching to Frost & Midnight edge-to-edge...');
    await page.evaluate(() => {
        window.setThemePreset('frost');
        window.setStudioIcon('❄️', 'Arctic Winter Academy', 'ice & figure skating');
    });
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'edge-to-edge-3-frost-midnight.png') });

    // 4. Switch to Spring / 🌸 Sakura Spring Theme with Yoga Studio Branding
    console.log('Switching to Sakura Spring + Yoga branding...');
    await page.evaluate(() => {
        window.setThemePreset('sakura');
        window.setStudioIcon('🧘', 'Lotus Yoga Studio', 'mindful movement');
    });
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'edge-to-edge-4-sakura-yoga.png') });

    // 5. Switch to Summer / ☀️ Solar Sunset Theme with Music Conservatory Branding
    console.log('Switching to Solar Sunset + Music branding...');
    await page.evaluate(() => {
        window.setThemePreset('sunset');
        window.setStudioIcon('🎵', 'SoundWave Music Hall', 'conservatory');
    });
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'edge-to-edge-5-solar-sunset.png') });

    // 6. Switch to Pro Unlimited Tier ($99) with Glowing Pill Cards & 100% Whitelabeling
    console.log('Switching to Pro Unlimited Tier + Glow Cards edge-to-edge...');
    await page.evaluate(() => {
        window.setProTier('unlimited');
        window.setThemePreset('contrast');
        window.setCardStyle('glow');
        window.setStudioIcon('🩰', 'Durango Dance Academy', 'official schedule');
    });
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'edge-to-edge-6-unlimited-whitelabel.png') });

    // 7. Wide Monitor Viewport (1920x1080) Ultra-wide Edge-to-Edge
    console.log('Testing 1920x1080 ultra-wide viewport...');
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.evaluate(() => {
        window.setProTier('studio');
        window.setThemePreset('contrast');
        window.setStudioIcon('🩰', 'Durango Dance', 'dance academy · pro studio');
    });
    await page.waitForTimeout(600);
    console.log('Capturing edge-to-edge-7-widescreen-1920.png...');
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'edge-to-edge-7-widescreen-1920.png') });

    // 8. Design Lab Overlay open over Edge-to-Edge
    console.log('Opening Design Lab overlay...');
    await page.evaluate(() => {
        window.toggleLabDock(true);
    });
    await page.waitForTimeout(500);
    console.log('Capturing edge-to-edge-8-lab-controls.png...');
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'edge-to-edge-8-lab-controls.png') });

    await browser.close();
    console.log('All edge-to-edge screenshots captured successfully!');
})();
