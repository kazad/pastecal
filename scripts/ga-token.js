#!/usr/bin/env node
// Print a Google OAuth access token for the Analytics APIs, minted from the
// service account key in internal/keys/.
//
//   node scripts/ga-token.js            # read-only scope (reporting)
//   node scripts/ga-token.js --edit     # edit scope (creating dimensions)
//   node scripts/ga-token.js --key=PATH # a specific key file
//
// Which key: --key=PATH, else $PASTECAL_GA_KEY, else the ONLY .json file in
// internal/keys/. More than one there is an error rather than a guess -- it used
// to take whichever readdir listed first, so adding a second key (a rotation, a
// different project) silently changed which identity the reports ran as.
//
// Why this exists: gcloud's Application Default Credentials can no longer be
// granted analytics.edit. Google blocks that scope on gcloud's built-in client
// ID -- "This app is blocked ... Google blocked this access" -- and points at
// service account impersonation instead. A service account mints its own token
// with whatever scope it asks for and needs no browser, now or ever.
//
// The service account must be an Editor on the GA4 property. That is granted in
// the Analytics UI (Admin > Property access management), NOT in Google Cloud
// IAM -- GA4 has its own permission system that Cloud IAM does not touch. The
// "Analytics Hub" roles in Cloud IAM are BigQuery data sharing and are unrelated.
//
// No dependencies: node:crypto can sign the JWT directly.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const KEY_DIR = path.join(__dirname, '..', 'internal', 'keys');

function findKey() {
  const flag = process.argv.find((a) => a.startsWith('--key='));
  const explicit = flag ? flag.slice('--key='.length) : process.env.PASTECAL_GA_KEY;
  if (explicit) return path.resolve(explicit);

  let names;
  try {
    names = fs.readdirSync(KEY_DIR);
  } catch {
    fail(`No ${KEY_DIR} directory. This needs the service account key, which is
gitignored -- see internal/keys/. Or pass --key=PATH / set PASTECAL_GA_KEY.`);
  }
  const keys = names.filter((n) => n.endsWith('.json')).sort();
  if (!keys.length) fail(`No .json service account key in ${KEY_DIR}.`);
  if (keys.length > 1) {
    fail(`${keys.length} .json files in ${KEY_DIR} (${keys.join(', ')}); refusing to guess
which service account to use. Remove the stale ones, or choose one with
--key=PATH or PASTECAL_GA_KEY=PATH.`);
  }
  return path.join(KEY_DIR, keys[0]);
}

// A private key readable by other local users is a credential leak in waiting.
// Warn rather than refuse: the fix (chmod 600) is the owner's call, and a hard
// failure here would only push them to the weaker gcloud fallback.
function checkPerms(keyPath) {
  if (process.platform === 'win32') return;
  let mode;
  try {
    mode = fs.statSync(keyPath).mode;
  } catch {
    return; // the read below reports a missing file properly
  }
  if (mode & 0o077) {
    process.stderr.write(`WARNING: ${keyPath} is readable by other users ` +
      `(mode ${(mode & 0o777).toString(8)}). Fix with: chmod 600 "${keyPath}"\n`);
  }
}

function fail(msg) {
  process.stderr.write(msg.trim() + '\n');
  process.exit(1);
}

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

async function main() {
  const scope = process.argv.includes('--edit')
    ? 'https://www.googleapis.com/auth/analytics.edit'
    : 'https://www.googleapis.com/auth/analytics.readonly';

  const keyPath = findKey();
  checkPerms(keyPath);
  let key;
  try {
    key = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
  } catch (err) {
    fail(`Could not read ${keyPath}: ${err.message}`);
  }
  if (!key.client_email || !key.private_key) {
    fail(`${keyPath} is not a service account key (no client_email/private_key).`);
  }

  const now = Math.floor(Date.now() / 1000);
  const unsigned = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64({
    iss: key.client_email,
    scope,
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  });

  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(key.private_key)
    .toString('base64url');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: unsigned + '.' + sig,
    }),
  });

  const json = await res.json().catch(() => ({}));
  if (!json.access_token) {
    fail(`Token request failed (HTTP ${res.status}): ${JSON.stringify(json).slice(0, 300)}`);
  }
  process.stdout.write(json.access_token);
}

main().catch((err) => fail(`Unexpected failure: ${err.message}`));
