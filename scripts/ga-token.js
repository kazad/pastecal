#!/usr/bin/env node
// Print a Google OAuth access token for the Analytics APIs, minted from the
// service account key in internal/keys/.
//
//   node scripts/ga-token.js            # read-only scope (reporting)
//   node scripts/ga-token.js --edit     # edit scope (creating dimensions)
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
  let names;
  try {
    names = fs.readdirSync(KEY_DIR);
  } catch {
    fail(`No ${KEY_DIR} directory. This needs the service account key, which is
gitignored -- see internal/keys/.`);
  }
  const hit = names.find((n) => n.endsWith('.json'));
  if (!hit) fail(`No .json service account key in ${KEY_DIR}.`);
  return path.join(KEY_DIR, hit);
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
