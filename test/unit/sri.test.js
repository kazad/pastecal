/**
 * Subresource Integrity: every third-party <script> whose URL pins a version carries an
 * integrity hash and crossorigin, so a compromised CDN file is refused instead of run.
 * Versionless URLs (GTM, the Cloudflare beacon, unpkg's floating vue@3, the Tailwind CDN,
 * Google Fonts CSS) change under the same URL and cannot be pinned this way.
 *
 * Run: npm run test:unit
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

for (const file of ['public/index.html', 'public/nativecal/index.html']) {
  test(`${file}: version-pinned third-party scripts have integrity + crossorigin`, () => {
    const html = fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');
    const tags = [...html.matchAll(/<script\b[^>]*\bsrc="(https:\/\/[^"]+)"[^>]*>/g)];
    const pinned = tags.filter(([, src]) => /@\d+\.\d+\.\d+\/|\/\d+\.\d+\.\d+\//.test(src));
    assert.ok(pinned.length >= 4, `${file}: expected the pinned CDN scripts, found ${pinned.length}`);
    for (const [tag, src] of pinned) {
      assert.match(tag, /\bintegrity="sha384-[A-Za-z0-9+/=]{64}"/, `${src} has no integrity hash`);
      assert.match(tag, /\bcrossorigin="anonymous"/, `${src} has no crossorigin`);
    }
  });
}
