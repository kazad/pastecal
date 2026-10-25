// L3 pricing consistency: one set of prices and one branding story on every page that states them.
// Pro Single: $24 a year or $2.99 a month, with a small "Made with pastecal" footer. Pro Unlimited (on sale;
// its @name, short links and co-owners still in development): $79 a year or $8 a month, also with the footer.
// Teams (in development): $290 a year or $29 a month, and removing pastecal branding is a Teams-only feature.
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

test('four plans: Pro Single and Pro Unlimited are on sale, Teams is in development', () => {
  const pricing = read('public/pricing.html');
  const single = card(pricing, 'Pro Single');
  assert.match(single, /<strong>\$24<\/strong>/);
  assert.match(single, /\$2\.99/);
  assert.match(single, /data-plan="pro">Get Pro<\/a>$/, 'Pro Single opens the Get Pro picker');
  const unlimited = card(pricing, 'Pro Unlimited');
  assert.match(unlimited, /<strong>\$79<\/strong>/);
  assert.match(unlimited, /\$8 a month/);
  // Pro Unlimited: Available now, bought from the Get Pro section; its @name rows stay In development.
  assert.ok(/<span class="badge new">Available now<\/span>\s*<h3>Pro Unlimited<\/h3>/.test(pricing), 'Pro Unlimited carries the Available now badge');
  assert.match(unlimited, /href="#get-pro" data-plan="unlimited">Get Pro Unlimited<\/a>$/);
  assert.ok(!/Join the waitlist/.test(unlimited));
  assert.match(unlimited, /In development, included when ready<\/p>\s*<ul class="coming">\s*<li>Your own name: <code>pastecal\.com\/@name<\/code><\/li>/,
    '@name is listed under In development');
  assert.match(pricing, /<tr><td>Your own name: <code>pastecal\.com\/@name<\/code> <span class="soon">In development<\/span>/);
  const lockRow = /<tr><td>Lock editing to people you choose[\s\S]*?<\/tr>/.exec(pricing)[0];
  assert.match(lockRow, /<td class="pro">1 calendar<\/td><td>Unlimited<\/td><td>Unlimited <span class="soon">In development<\/span><\/td><\/tr>$/,
    'locking any number of calendars is available on Pro Unlimited, still in development for Teams');
  assert.match(pricing, /body: JSON\.stringify\(\{ plan: 'unlimited', interval: interval\(\) \}\)/, 'Continue to payment checks out Pro Unlimited');
  // Teams stays in development, with the waitlist.
  const teamsBlock = /<span class="badge dev">In development<\/span>\s*<h3>Teams<\/h3>[\s\S]*?<\/a>/.exec(pricing);
  assert.ok(teamsBlock, 'Teams card carries the In development badge');
  assert.match(teamsBlock[0], /href="#waitlist"[^>]*>Join the waitlist<\/a>$/);
  assert.match(pricing, /<meta name="description" content="[^"]*Pro Unlimited locks every calendar you run: \$79 a year or \$8 a month\. Teams \(\$290 a year or \$29 a month\) is in development\.">/);
  assert.match(read('public/terms.html'), /Pro Unlimited is Pro for any number of calendars[^<]*\$79 a year or \$8 a month/);
  assert.match(pricing, /<thead><tr><th>Feature<\/th><th>Free<\/th><th class="pro">Pro Single<\/th><th>Pro Unlimited<\/th><th>Teams<\/th><\/tr><\/thead>/);
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
