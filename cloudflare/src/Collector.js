// First-party event collector -> Workers Analytics Engine.
//
// The browser batches events (public/utils/analytics.js, the `http` sink) and POSTs
// them to /api/collect. Each becomes one Analytics Engine data point, queryable with
// SQL (scripts/stats.sh ux). Same-origin, so ad blockers do not drop it.
//
// Privacy: the calendar path is the calendar's id, so it is never stored. Only the UI
// ("classic" vs "native") is derived from it.
//
// Column layout (keep in sync with scripts/stats.sh ux; Analytics Engine columns are positional):
//   index1 = event name
//   blob1 name | blob2 ui | blob3 browser | blob4 device | blob5 country | blob6 detail | blob7 cached | blob8 homepage variant
//   double1 ttfb_ms | double2 fcp_ms | double3 lcp_ms | double4 load_ms | double5 cls | double6 first_event_seconds | double7 count

export const MAX_BODY_BYTES = 16 * 1024;
export const MAX_EVENTS = 20;           // the page sends at most 12 at a time (analytics.js BATCH_SIZE)

const NAME = /^[a-z0-9_]{1,40}$/;
const str = (v, n = 60) => (v == null ? '' : String(v).slice(0, n));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Turn a request body into Analytics Engine data points (pure, so it is unit-testable). */
export function toDataPoints(body, country = '') {
    const events = Array.isArray(body?.events) ? body.events.slice(0, MAX_EVENTS) : [];
    const points = [];
    for (const e of events) {
        const name = e && e.name;
        if (typeof name !== 'string' || !NAME.test(name)) continue;
        const p = (e.params && typeof e.params === 'object') ? e.params : {};
        if (p.surface === 'test') continue;
        const path = typeof e.path === 'string' ? e.path : '';
        points.push({
            indexes: [name],
            blobs: [
                name,
                path.startsWith('/nativecal') ? 'native' : 'classic',
                str(p.browser, 12),
                str(p.device, 12),
                str(country, 4),
                // detail; the trial_* events' one value each (feature, interval, mode, trial_surface) too
                str(p.add_via ?? p.source ?? p.method ?? p.code ?? p.kind ?? p.reason ?? p.where ?? p.feature ?? p.interval ?? p.mode ?? p.trial_surface ?? p.type, 40),
                str(p.cached, 4),
                str(p.hv, 8),
            ],
            doubles: [num(p.ttfb_ms), num(p.fcp_ms), num(p.lcp_ms), num(p.load_ms), num(p.cls), num(p.first_event_seconds), 1],
        });
    }
    return points;
}

/** POST /api/collect. Always 204: telemetry must never produce an error the page could surface. */
export async function handleCollect(request, env) {
    const done = new Response(null, { status: 204 });
    try {
        if (!env.EVENTS) return done;
        // Per IP (COLLECT_LIMITER, wrangler.jsonc): a page sends one batch every ~10 s at most, so
        // anything faster is not a person. Over the limit, the batch is dropped -- still a 204.
        if (env.COLLECT_LIMITER) {
            const { success } = await env.COLLECT_LIMITER.limit({ key: 'collect:' + (request.headers.get('CF-Connecting-IP') || 'unknown') });
            if (!success) return done;
        }
        const text = await request.text();
        if (text.length > MAX_BODY_BYTES) return done;
        const points = toDataPoints(JSON.parse(text), request.cf?.country);
        for (const pt of points) env.EVENTS.writeDataPoint(pt);
    } catch (e) { /* malformed telemetry is dropped */ }
    return done;
}
