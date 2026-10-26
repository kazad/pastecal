// LOCAL_NO_LIMITS turns off the per-address rate limits for local test servers (cloudflare/src/index.js fetch).
// It must never reach a deployed Worker: no environment in wrangler.jsonc may define it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('wrangler.jsonc never sets LOCAL_NO_LIMITS (production or staging)', () => {
  const cfg = fs.readFileSync(path.join(__dirname, '../../cloudflare/wrangler.jsonc'), 'utf8');
  assert.ok(!/LOCAL_NO_LIMITS/.test(cfg), 'LOCAL_NO_LIMITS is for wrangler dev --var only');
});
