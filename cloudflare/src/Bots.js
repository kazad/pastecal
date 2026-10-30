// Who is not a person, for first-party counts: calendar visits and follows (Insight.hitHeaders ->
// RoomInsight.countHit, read by scripts/ux.sh usage) and page events (Collector.js, /api/collect).
// Its own module, with no imports, so Collector.js stays loadable under plain node for its tests.
//
// Crawlers, link previews, monitors, scripts. Calendar apps (Google-Calendar-Importer, Outlook,
// iOS dataaccessd) don't match. The uptime check and GitHub Actions use curl.
// "pastecal-": our own scripts and audits that hit the live site put it in their User-Agent
// (health.py: pastecal-health; launch-smoke.mjs; a Playwright audit that emulates a phone:
// devices[...].userAgent + ' pastecal-audit'). Oct 28 2026: health.py's sweep of every calendar
// edited in 24h, before this marker counted, added ~375 visits to `ux.sh usage`.
const BOT_UA = /bot\b|bot\/|crawler|spider|preview|monitor|uptime|headless|lighthouse|curl\/|wget|python-requests|go-http-client|github|pastecal-/i;
export function isBot(request) {
    const bm = request.cf && request.cf.botManagement;
    if (bm && (bm.verifiedBot === true || (typeof bm.score === 'number' && bm.score > 0 && bm.score < 30))) return true;
    const ua = request.headers.get('User-Agent') || '';
    return !ua || BOT_UA.test(ua);
}

// Script runtimes (Node's fetch sends "node", Python's urllib "Python-urllib/3.x"). Never a person
// viewing a page or sending page events, so not a view and not an event. But a calendar app can be
// one (Home Assistant fetches feeds with aiohttp/httpx; self-hosted syncers with node or urllib), so
// a follow from one still counts.
const SCRIPT_UA = /^node\b|undici|node-fetch|axios\/|python-urllib|httpx|aiohttp|playwright/i;
export function isScript(request) {
    return SCRIPT_UA.test(request.headers.get('User-Agent') || '');
}
