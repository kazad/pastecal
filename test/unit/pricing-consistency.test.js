// L3 pricing consistency: one set of prices and one branding story on every page that states them.
// Pro Single: $24 a year or $2.99 a month, with a small "Made with pastecal" footer. Pro Unlimited (in
// development): $79 a year or $8 a month, also with the footer. Teams (in development): $290 a year or
// $29 a month, and removing pastecal branding is a Teams-only feature.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const pages = ['public/pricing.html', 'public/terms.html', 'public/privacy.html', 'public/index.html', 'public/pro/done.html'];

test('no page states the old Teams price', () => {
  for (const f of pages) assert.ok(!/\$80\b|\$8 each/.test(read(f)), `${f} still says $80 / $8 each`);
});

// One plan card: from its <h3> to the end of its button.
const card = (html, name) => new RegExp(`<h3>${name}</h3>[\\s\\S]*?</a>`).exec(html)[0];

test('Teams is $290 a year or $29 a month on the pricing card, waitlist, FAQ and terms', () => {
  const pricing = read('public/pricing.html');
  const teams = card(pricing, 'Teams');
  assert.match(teams, /<strong>\$290<\/strong>/);
  assert.match(teams, /\$29 a month/);
  assert.match(pricing, /<option value="teams">Teams, \$290 a year or \$29 a month<\/option>/);
  assert.match(pricing, /<summary>What is Teams\?<\/summary><p>[^<]*\$290 a year or \$29 a month/);
  assert.match(read('public/terms.html'), /Teams[^<]*\$290 a year or \$29 a month/);
});

test('four plans: Pro Single is on sale, Pro Unlimited and Teams are in development', () => {
  const pricing = read('public/pricing.html');
  const single = card(pricing, 'Pro Single');
  assert.match(single, /<strong>\$24<\/strong>/);
  assert.match(single, /\$2\.99/);
  assert.match(single, /data-plan="pro">Get Pro<\/a>$/, 'Pro Single opens the Get Pro picker');
  const unlimited = card(pricing, 'Pro Unlimited');
  assert.match(unlimited, /<strong>\$79<\/strong>/);
  assert.match(unlimited, /\$8 a month/);
  assert.match(pricing, /<option value="unlimited">Pro Unlimited, \$79 a year<\/option>/);
  for (const name of ['Pro Unlimited', 'Teams']) {
    const block = new RegExp(`<span class="badge dev">In development</span>\\s*<h3>${name}</h3>[\\s\\S]*?</a>`).exec(pricing);
    assert.ok(block, `${name} card carries the In development badge`);
    assert.match(block[0], /href="#waitlist"[^>]*>Join the waitlist<\/a>$/);
  }
  assert.match(pricing, /<thead><tr><th>Feature<\/th><th>Free<\/th><th class="pro">Pro Single <span class="beta-tag">Beta<\/span><\/th><th>Pro Unlimited<\/th><th>Teams<\/th><\/tr><\/thead>/);
});

test('branding removal is a Teams feature; Pro keeps a small footer', () => {
  const pricing = read('public/pricing.html');
  for (const name of ['Free', 'Pro Single', 'Pro Unlimited']) assert.ok(!/No pastecal branding/.test(card(pricing, name)), `the ${name} card must not promise no branding`);
  assert.match(card(pricing, 'Pro Single'), /small “Made with pastecal” line/);
  assert.match(card(pricing, 'Teams'), /No pastecal branding/);
  const row = /<tr><td>No pastecal branding[\s\S]*?<\/tr>/.exec(pricing)[0];
  assert.match(row, /<td class="n">—<\/td><td class="pro n">—<\/td><td class="n">—<\/td><td class="y">✓<\/td><\/tr>$/, 'compare table: Free, Pro Single and Pro Unlimited no, Teams yes');
  assert.ok(!/removes pastecal branding|without our branding/.test(pricing));
  assert.ok(!/hides pastecal branding/.test(read('public/terms.html')));
  assert.match(read('public/index.html'), /data-testid="hosted-note"[^>]*>Made with <a [^>]*>pastecal<\/a> · <a [^>]*data-testid="report-link">Report<\/a>/);
});

test('privacy covers visit counting, the welcome email and deleting an account', () => {
  const p = read('public/privacy.html');
  assert.match(p, /Each calendar also counts its own visits/);
  assert.match(p, /never store IP addresses/i);
  assert.match(p, /one welcome email when you first lock a calendar/);
  assert.match(p, /Deleting it removes your email, your sign-in links and your sessions/);
});
