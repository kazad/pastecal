// L3 pricing consistency: one set of prices and one branding story on every page that states them.
// Plus (plan id 'pro', in beta): $29 a year (yearly only), with a small "Made with pastecal" footer.
// Pro (plan id 'unlimited', in beta; buyable when billing and its price are on, "Join the beta" otherwise): $96 a year ($8 a month, billed yearly) or $10 month to month,
// also with the footer. Teams (in development): $490 a year or $49 a month, and removing pastecal
// branding is a Teams-only feature.
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

test('Teams is $490 a year or $49 a month on the pricing card, waitlist, FAQ and homepage', () => {
  const pricing = read('public/pricing.html');
  const teams = card(pricing, 'Teams');
  assert.match(teams, /<strong>\$490<\/strong>/);
  assert.match(teams, /\$49 a month/);
  assert.match(pricing, /<option value="teams">Teams, \$490 a year or \$49 a month<\/option>/);
  assert.match(pricing, /<summary>What is Teams\?<\/summary><p>[^<]*\$490 a year or \$49 a month/);
  assert.match(read('public/index.html'), /<h4>Teams<\/h4><p class="pc-plan-price"><b>\$490<\/b> a year <small>or \$49 a month<\/small>/);
});

test('one price everywhere: none of the old prices on any page people see', () => {
  for (const f of ['public/index.html', 'public/pricing.html', 'public/terms.html', 'public/components/Pro.js', 'public/components/NavigationDropdown.js', 'cloudflare/src/Accounts.js']) {
    const t = read(f);
    assert.ok(!/2\.99/.test(t), `${f} still mentions $2.99`);
    assert.ok(!/\$24\b|\$2 a month/.test(t), `${f} still has the old $24 price`);
    assert.ok(!/\$48\b|\$60\b|\$6 (a month|month to month)|\$5 a month/.test(t), `${f} still has an old price for the 10-calendar plan`);
    assert.ok(!/\$79\b/.test(t), `${f} still has $79`);
    assert.ok(!/\$290\b|\$29 a month/.test(t), `${f} still has the old Teams price`);
    assert.ok(!/Pro Plus|Join the Pro beta|Pro beta trial/.test(t), `${f} still uses the old plan names`);
  }
});

test('four plans: Plus and Pro are in beta, Teams is in development', () => {
  const pricing = read('public/pricing.html');
  const plus = card(pricing, 'Plus');
  assert.match(plus, /<strong>\$29<\/strong>/);
  assert.match(plus, /about \$2\.42 a month/);
  assert.doesNotMatch(plus, /month to month/, 'Plus is yearly only');
  assert.match(plus, /1 upgraded calendar/);
  assert.match(pricing, /<span class="badge">Beta<\/span>\s*<h3>Plus<\/h3>/, 'Plus carries the Beta badge');
  assert.match(plus, /data-plan="pro">Get Plus<\/a>$/, 'Plus opens the Get Plus picker (billing on)');
  assert.match(pricing, /<b>\$29 a year<\/b>, per calendar/);
  const pro = card(pricing, 'Pro');
  assert.match(pro, /<strong>\$96<\/strong>/);
  assert.match(pro, /\$8 a month, billed yearly/);
  assert.match(pro, /\$10 month to month/);
  assert.match(pro, /10 upgraded calendars/);
  assert.match(pricing, /<option value="unlimited">Pro, \$96 a year or \$10 a month<\/option>/);
  assert.match(pricing, /<span class="badge">Beta<\/span>\s*<h3>Pro<\/h3>/, 'Pro carries the Beta badge');
  // Billing on: Get Pro opens the Get Plus section on Pro. Billing off: the page renames it Join the beta.
  assert.match(pro, /id="unlCta" class="cta primary" href="#get-pro" data-plan="unlimited">Get Pro<\/a>$/);
  assert.match(pricing, /getElementById\('unlCta'\)\.textContent = 'Join the beta'/);
  assert.match(pricing, /joinBeta\('unlimited'\)/);
  assert.match(pricing, /<label class="interval on"><input type="radio" name="interval" value="year" checked><span><b>\$96 a year<\/b>/);
  assert.match(pricing, /<label class="interval"><input type="radio" name="interval" value="month"><span><b>\$10 a month<\/b>/);
  assert.match(pricing, /body: JSON\.stringify\(\{ plan: 'unlimited', interval: interval\(\) \}\)/, 'Continue to payment checks out Pro');
  const block = /<span class="badge dev">In development<\/span>\s*<h3>Teams<\/h3>[\s\S]*?<\/a>/.exec(pricing);
  assert.ok(block, 'Teams card carries the In development badge');
  assert.match(block[0], /href="#waitlist"[^>]*>Join the waitlist<\/a>$/);
  assert.match(pricing, /<thead><tr><th>Feature<\/th><th>Free<\/th><th class="pro">Plus <span class="beta-tag">Beta<\/span><\/th><th>Pro <span class="beta-tag">Beta<\/span><\/th><th>Teams<\/th><\/tr><\/thead>/);
  assert.match(pricing, /<span>Upgraded calendars<\/span>/);
  assert.match(pricing, /<tr><td>With a short name<small>[\s\S]*?<td class="n">—<\/td><td class="pro">1<\/td><td>10<\/td><td>10<\/td><\/tr>/);
  assert.match(pricing, /<tr><td>Under your own name<small>[\s\S]*?<td class="n">—<\/td><td class="pro n">—<\/td><td>Unlimited<\/td><td>Unlimited<\/td><\/tr>/);
  assert.ok(!/Pro calendar/.test(pricing), 'the concept word is "upgraded calendar"');
});

test('homepage plan cards match the pricing page', () => {
  const home = read('public/index.html');
  assert.match(home, /<h4>Plus<\/h4><p class="pc-plan-price"><b>\$29<\/b> a year<\/p>/);
  assert.match(home, /<h4>Pro<\/h4><p class="pc-plan-price"><b>\$96<\/b> a year <small>or \$10 a month<\/small><\/p>/);
  assert.match(home, /<span class="pc-gopro-price">Plus · \$29 a year<\/span>/);
});

test('branding removal is a Teams feature; Plus and Pro keep a small footer', () => {
  const pricing = read('public/pricing.html');
  for (const name of ['Free', 'Plus', 'Pro']) assert.ok(!/No pastecal branding/.test(card(pricing, name)), `the ${name} card must not promise no branding`);
  assert.match(card(pricing, 'Plus'), /small “Made with pastecal” line/);
  assert.match(card(pricing, 'Teams'), /No pastecal branding/);
  const row = /<tr><td>No pastecal branding[\s\S]*?<\/tr>/.exec(pricing)[0];
  assert.match(row, /<td class="n">—<\/td><td class="pro n">—<\/td><td class="n">—<\/td><td class="y">✓<\/td><\/tr>$/, 'compare table: Free, Plus and Pro no, Teams yes');
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
