#!/usr/bin/env node
/**
 * Backfills Cloudflare CalendarDirectory Durable Object from Firebase RTDB.
 *
 * Reads:
 * 1. /slug_mappings (normalized -> { actualSlug, isReadOnly })
 * 2. /calendars.json?shallow=true (all editable calendars)
 * 3. /calendars_readonly.json?shallow=true + /calendars_readonly/<k>/id.json (read-only views -> targetId)
 *
 * Posts batches to /api/directory/backfill on Cloudflare Worker.
 *
 * Usage:
 *   node cloudflare/scripts/backfill-directory.mjs [BASE=https://new.pastecal.com]
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEY_PATH = path.join(__dirname, '../../internal/keys/pastecal-web-firebase-adminsdk-scf60-24fc54f2df.json');
const BASE = process.argv[2] || 'https://new.pastecal.com';
const SECRET = process.env.IMPORT_SECRET || '1489ba81d8ddde0675e1f1af99012cf3cfbef60fd43fe8c8dd26bef4f362b9c8';
const DB = 'https://pastecal-web-default-rtdb.firebaseio.com';

// Generate Google OAuth2 access token from service account key
async function getAccessToken(sa) {
    const b64 = (x) => Buffer.from(typeof x === 'string' ? x : x).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const head = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claim = b64(JSON.stringify({
        iss: sa.client_email,
        scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600
    }));

    const crypto = await import('node:crypto');
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(`${head}.${claim}`);
    const sig = sign.sign(sa.private_key, 'base64url');

    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${head}.${claim}.${sig}`
    });
    const out = await res.json();
    if (!out.access_token) throw new Error(`Token exchange failed: ${JSON.stringify(out)}`);
    return out.access_token;
}

async function run() {
    console.log(`Starting CalendarDirectory backfill to ${BASE}...`);
    const sa = JSON.parse(readFileSync(KEY_PATH, 'utf8'));
    const token = await getAccessToken(sa);
    console.log('Firebase authenticated successfully.');

    // 1. Fetch slug_mappings
    console.log('Fetching /slug_mappings...');
    const smRes = await fetch(`${DB}/slug_mappings.json`, {
        headers: { Authorization: `Bearer ${token}` }
    });
    if (!smRes.ok) throw new Error(`Failed to fetch slug_mappings: HTTP ${smRes.status}`);
    const slugMappings = (await smRes.json()) || {};
    console.log(`Received ${Object.keys(slugMappings).length} slug_mappings.`);

    // 2. Fetch shallow calendars
    console.log('Fetching /calendars shallow keys...');
    const calRes = await fetch(`${DB}/calendars.json?shallow=true`, {
        headers: { Authorization: `Bearer ${token}` }
    });
    if (!calRes.ok) throw new Error(`Failed to fetch calendars: HTTP ${calRes.status}`);
    const calKeys = Object.keys((await calRes.json()) || {});
    console.log(`Received ${calKeys.length} calendar keys.`);

    // 3. Fetch shallow calendars_readonly
    console.log('Fetching /calendars_readonly shallow keys...');
    const roRes = await fetch(`${DB}/calendars_readonly.json?shallow=true`, {
        headers: { Authorization: `Bearer ${token}` }
    });
    if (!roRes.ok) throw new Error(`Failed to fetch calendars_readonly: HTTP ${roRes.status}`);
    const roKeys = Object.keys((await roRes.json()) || {});
    console.log(`Received ${roKeys.length} read-only view keys.`);

    // Build the master map of normalized -> entry
    const entries = new Map();

    // First: editable calendars from shallow keys
    for (const k of calKeys) {
        if (!k || typeof k !== 'string') continue;
        entries.set(k.toLowerCase(), {
            actualSlug: k,
            isReadOnly: false,
            targetId: k
        });
    }

    // Overlay slug_mappings for editable calendars (preserves case resolution)
    for (const [norm, data] of Object.entries(slugMappings)) {
        if (!data || data.notFound) continue;
        if (!data.isReadOnly && data.actualSlug) {
            entries.set(norm.toLowerCase(), {
                actualSlug: data.actualSlug,
                isReadOnly: false,
                targetId: data.actualSlug
            });
        }
    }

    console.log(`Mapped ${entries.size} editable calendars.`);

    // Next: fetch target IDs for read-only views in concurrent pools
    console.log(`Fetching target IDs for ${roKeys.length} read-only views...`);
    const CONCURRENCY = 60;
    let fetched = 0;
    const t0 = Date.now();

    for (let i = 0; i < roKeys.length; i += CONCURRENCY) {
        const batch = roKeys.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(async (key) => {
            try {
                const res = await fetch(`${DB}/calendars_readonly/${encodeURIComponent(key)}/id.json`, {
                    headers: { Authorization: `Bearer ${token}` }
                });
                if (res.ok) {
                    const targetId = await res.json();
                    if (targetId && typeof targetId === 'string') {
                        entries.set(key.toLowerCase(), {
                            actualSlug: key,
                            isReadOnly: true,
                            targetId: targetId.trim()
                        });
                    }
                }
            } catch (err) {
                console.warn(`Failed to fetch targetId for view ${key}:`, err.message);
            }
        }));
        fetched += batch.length;
        if (fetched % 1000 === 0 || fetched === roKeys.length) {
            const elapsed = Math.round((Date.now() - t0) / 1000);
            console.log(`Fetched ${fetched}/${roKeys.length} view IDs (${elapsed}s)...`);
        }
    }

    console.log(`Total directory items to upload: ${entries.size}`);

    // Post to Cloudflare /api/directory/backfill in batches of 500
    const allItems = Array.from(entries.values());
    const BATCH_SIZE = 500;
    let uploaded = 0;

    for (let i = 0; i < allItems.length; i += BATCH_SIZE) {
        const chunk = allItems.slice(i, i + BATCH_SIZE);
        const res = await fetch(`${BASE}/api/directory/backfill`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${SECRET}`
            },
            body: JSON.stringify(chunk)
        });
        if (!res.ok) {
            const txt = await res.text();
            throw new Error(`Upload batch failed HTTP ${res.status}: ${txt}`);
        }
        uploaded += chunk.length;
        process.stdout.write(`Uploaded ${uploaded}/${allItems.length}\r`);
    }

    console.log(`\nUpload complete! Verifying directory stats...`);
    const statsRes = await fetch(`${BASE}/api/directory/stats`);
    const stats = await statsRes.json();
    console.log('Live CalendarDirectory stats:', stats);
}

run().catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
});
