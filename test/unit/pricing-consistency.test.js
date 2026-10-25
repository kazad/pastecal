// L3 pricing consistency: one set of prices and one branding story on every page that states them.
// Pro Single: $24 a year (yearly only), with a small "Made with pastecal" footer. Pro Unlimited (beta; buyable
// when billing is on, "Join the Pro beta" when it's off): $48 a year or $5 a month, also with the footer.
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

test('Teams is $290 a year or $29 a month on the pricing card, waitlist and FAQ', () => {
  const pricing = read('public/pricing.html');
  const teams = card(pricing, 'Teams');
  assert.match(teams, /<strong>\$290<\/strong>/);
  assert.match(teams, /\$29 a month/);
  assert.match(pricing, /<option value="teams">Teams, \$290 a year or \$29 a month<\/option>/);
  assert.match(pricing, /<summary>What is Teams\?<\/summary><p>[^<]*\$290 a year or \$29 a month/);
});

test('one price everywhere: no $2.99 and no $79 or $8 a month on any page people see', () => {
  for (const f of ['public/index.html', 'public/pricing.html', 'public/terms.html', 'public/components/Pro.js']) {
    const t = read(f);
    assert.ok(!/2\.99/.test(t), `${f} still mentions $2.99`);
    assert.ok(!/\$79\b|\$8 a month/.test(t), `${f} still has the old Pro Unlimited price`);
  }
});

test('four plans: Pro Single and Pro Unlimited are in beta, Teams is in development', () => {
  const pricing = read('public/pricing.html');
  const single = card(pricing, 'Pro Single');
  assert.match(single, /<strong>\$24<\/strong>/);
  assert.doesNotMatch(single, /\$2\.99/, 'Pro Single is yearly only');
  assert.match(single, /data-plan="pro">Get Pro<\/a>$/, 'Pro Single opens the Get Pro picker');
  const unlimited = card(pricing, 'Pro Unlimited');
  assert.match(unlimited, /<strong>\$48<\/strong>/);
  assert.match(unlimited, /\$5 month to month/);
  assert.match(pricing, /<option value="unlimited">Pro Unlimited, \$48 a year<\/option>/);
  assert.match(pricing, /<span class="badge">Beta<\/span>\s*<h3>Pro Unlimited<\/h3>/, 'Pro Unlimited carries the Beta badge');
  // Billing on: Get Pro Unlimited opens the Get Pro section on Unlimited. Billing off: the page renames it Join the Pro beta.
  assert.match(unlimited, /id="unlCta" class="cta primary" href="#get-pro" data-plan="unlimited">Get Pro Unlimited<\/a>$/);
  assert.match(pricing, /getElementById\('unlCta'\)\.textContent = 'Join the Pro beta'/);
  assert.match(pricing, /joinBeta\('unlimited'\)/);
  assert.match(pricing, /<label class="interval on"><input type="radio" name="interval" value="year" checked><span><b>\$48 a year<\/b>/);
  assert.match(pricing, /<label class="interval"><input type="radio" name="interval" value="month"><span><b>\$5 a month<\/b>/);
  assert.match(pricing, /body: JSON\.stringify\(\{ plan: 'unlimited', interval: interval\(\) \}\)/, 'Continue to payment checks out Pro Unlimited');
  const lockRow = /<tr><td>Lock editing to people you choose[\s\S]*?<\/tr>/.exec(pricing)[0];
  assert.match(lockRow, /<td class="pro">1 calendar<\/td><td>Every calendar you run<\/td><td>Every calendar <span class="soon">In development<\/span><\/td><\/tr>$/,
    'locking many calendars is on Pro Unlimited, still in development for Teams');
  for (const name of ['Teams']) {
    const block = new RegExp(`<span class="badge dev">In development</span>\\s*<h3>${name}</h3>[\\s\\S]*?</a>`).exec(pricing);
    assert.ok(block, `${name} card carries the In development badge`);
    assert.match(block[0], /href="#waitlist"[^>]*>Join the waitlist<\/a>$/);
  }
  assert.match(pricing, /<thead><tr><th>Feature<\/th><th>Free<\/th><th class="pro">Pro Single <span class="beta-tag">Beta<\/span><\/th><th>Pro Unlimited <span class="beta-tag">Beta<\/span><\/th><th>Teams<\/th><\/tr><\/thead>/);
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
