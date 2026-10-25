/**
 * BackupService -- Grandfather-Father-Son automated backups to Cloudflare R2:
 *
 *   - Hourly:  Snapshot of calendars edited in the last hour -> hourly/YYYY-MM-DD-HH.json.gz (retained 24h)
 *   - Daily:   Nightly full snapshot at 00:00 UTC            -> daily/YYYY-MM-DD.json.gz (retained 30d)
 *   - Monthly: 1st of month at 00:00 UTC                     -> monthly/YYYY-MM.json.gz (retained 12mo)
 *
 * Runs via Cloudflare Cron Trigger (crons = ["0 * * * *"]) and can also be triggered manually
 * via POST /api/backup/run (with Bearer IMPORT_SECRET).
 */

export class BackupService {
    static async gzipCompress(text) {
        const stream = new Response(text).body.pipeThrough(new CompressionStream('gzip'));
        return await new Response(stream).arrayBuffer();
    }

    static async getRecentCalendars(env, sinceMs) {
        if (!env.DIRECTORY) return [];
        const dir = env.DIRECTORY.get(env.DIRECTORY.idFromName('global'));
        const res = await dir.fetch(`http://internal/recent-edited?since=${sinceMs}&limit=1000`);
        if (!res.ok) return [];
        return await res.json();
    }

    static async getAllCalendars(env) {
        if (!env.DIRECTORY) return [];
        const dir = env.DIRECTORY.get(env.DIRECTORY.idFromName('global'));
        let all = [];
        let offset = 0;
        const limit = 1000;
        while (true) {
            const res = await dir.fetch(`http://internal/list-all?limit=${limit}&offset=${offset}`);
            if (!res.ok) break;
            const batch = await res.json();
            if (!batch.length) break;
            all.push(...batch);
            offset += limit;
            if (batch.length < limit) break;
        }
        return all;
    }

    static async fetchCalendarData(env, targetId) {
        try {
            const room = env.CALENDARS.get(env.CALENDARS.idFromName(targetId));
            const res = await room.fetch(`http://internal/cal/${encodeURIComponent(targetId)}`);
            if (!res.ok) return null;
            const data = await res.json();
            return data?.calendar || null;
        } catch {
            return null;
        }
    }

    static async run(env, forcedTier = null) {
        if (!env.BACKUPS) {
            console.warn('[BackupService] R2 bucket BACKUPS not bound');
            return { ok: false, error: 'no R2 bucket' };
        }

        const now = new Date();
        const nowMs = now.getTime();
        const dateStr = now.toISOString().slice(0, 10);
        const hourStr = String(now.getUTCHours()).padStart(2, '0');
        const monthStr = now.toISOString().slice(0, 7);

        const isMonthly = forcedTier === 'monthly' || (!forcedTier && now.getUTCDate() === 1 && now.getUTCHours() === 0);
        const isDaily = forcedTier === 'daily' || (!forcedTier && now.getUTCHours() === 0);
        const isHourly = forcedTier === 'hourly' || !forcedTier;

        const results = [];

        // 1. Hourly backup: calendars edited in the last 70 minutes (buffer for cron skew)
        if (isHourly && !isDaily) {
            const since = nowMs - 70 * 60 * 1000;
            const targets = await this.getRecentCalendars(env, since);
            if (targets.length) {
                const cals = {};
                for (const t of targets) {
                    const id = t.target_id || t.actual_slug;
                    const cal = await this.fetchCalendarData(env, id);
                    if (cal) cals[id] = cal;
                }
                const key = `hourly/${dateStr}-${hourStr}.json.gz`;
                const payload = JSON.stringify({
                    tier: 'hourly',
                    createdAt: now.toISOString(),
                    calendarCount: Object.keys(cals).length,
                    calendars: cals
                });
                const compressed = await this.gzipCompress(payload);
                await env.BACKUPS.put(key, compressed, {
                    httpMetadata: { contentType: 'application/gzip' },
                    customMetadata: { tier: 'hourly', count: String(Object.keys(cals).length), date: dateStr }
                });
                results.push({ tier: 'hourly', key, count: Object.keys(cals).length, size: compressed.byteLength });
                console.log(`[BackupService:hourly] Saved ${key} with ${Object.keys(cals).length} calendars (${compressed.byteLength} bytes)`);
            } else {
                console.log('[BackupService:hourly] No calendars edited in the last hour, skipping');
            }
        }

        // 2. Daily full backup (midnight UTC or forced)
        if (isDaily) {
            const targets = await this.getAllCalendars(env);
            const cals = {};
            for (const t of targets) {
                const id = t.target_id || t.actual_slug;
                const cal = await this.fetchCalendarData(env, id);
                if (cal && (cal.events?.length || cal.title)) cals[id] = cal;
            }
            const key = `daily/${dateStr}.json.gz`;
            const payload = JSON.stringify({
                tier: 'daily',
                createdAt: now.toISOString(),
                calendarCount: Object.keys(cals).length,
                calendars: cals
            });
            const compressed = await this.gzipCompress(payload);
            await env.BACKUPS.put(key, compressed, {
                httpMetadata: { contentType: 'application/gzip' },
                customMetadata: { tier: 'daily', count: String(Object.keys(cals).length), date: dateStr }
            });
            results.push({ tier: 'daily', key, count: Object.keys(cals).length, size: compressed.byteLength });
            console.log(`[BackupService:daily] Saved ${key} with ${Object.keys(cals).length} calendars (${compressed.byteLength} bytes)`);
        }

        // 3. Monthly full backup (1st of month at 00:00 UTC or forced)
        if (isMonthly) {
            const targets = await this.getAllCalendars(env);
            const cals = {};
            for (const t of targets) {
                const id = t.target_id || t.actual_slug;
                const cal = await this.fetchCalendarData(env, id);
                if (cal && (cal.events?.length || cal.title)) cals[id] = cal;
            }
            const key = `monthly/${monthStr}.json.gz`;
            const payload = JSON.stringify({
                tier: 'monthly',
                createdAt: now.toISOString(),
                calendarCount: Object.keys(cals).length,
                calendars: cals
            });
            const compressed = await this.gzipCompress(payload);
            await env.BACKUPS.put(key, compressed, {
                httpMetadata: { contentType: 'application/gzip' },
                customMetadata: { tier: 'monthly', count: String(Object.keys(cals).length), month: monthStr }
            });
            results.push({ tier: 'monthly', key, count: Object.keys(cals).length, size: compressed.byteLength });
            console.log(`[BackupService:monthly] Saved ${key} with ${Object.keys(cals).length} calendars (${compressed.byteLength} bytes)`);
        }

        // 4. Lifecycle retention cleanup
        await this.pruneOldBackups(env, nowMs);

        return { ok: true, results };
    }

    static async pruneOldBackups(env, nowMs) {
        try {
            // Prune hourly older than 24 hours
            const hourlyList = await env.BACKUPS.list({ prefix: 'hourly/' });
            for (const obj of hourlyList.objects || []) {
                const ageMs = nowMs - obj.uploaded.getTime();
                if (ageMs > 24 * 3600 * 1000) {
                    await env.BACKUPS.delete(obj.key);
                    console.log(`[BackupService:cleanup] Pruned expired hourly backup: ${obj.key}`);
                }
            }

            // Prune daily older than 30 days
            const dailyList = await env.BACKUPS.list({ prefix: 'daily/' });
            for (const obj of dailyList.objects || []) {
                const ageMs = nowMs - obj.uploaded.getTime();
                if (ageMs > 30 * 86400 * 1000) {
                    await env.BACKUPS.delete(obj.key);
                    console.log(`[BackupService:cleanup] Pruned expired daily backup: ${obj.key}`);
                }
            }
        } catch (e) {
            console.warn('[BackupService:cleanup] Prune error:', e.message);
        }
    }
}
