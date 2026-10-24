// L3 pricing consistency: one set of prices and one branding story on every page that states them.
// Pro: $24 a year or $2.99 a month, with a small "Made with pastecal" footer. Teams: $100 a year or
// $10 a month, and removing pastecal branding is a Teams feature.
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

test('Teams is $100 a year or $10 a month on the pricing card, waitlist, FAQ and terms', () => {
  const pricing = read('public/pricing.html');
  const card = /<h3>Teams<\/h3>[\s\S]*?<\/div>\s*<\/div>/.exec(pricing)[0];
  assert.match(card, /<strong>\$100<\/strong>/);
  assert.match(card, /\$10 a month/);
  assert.match(pricing, /<option value="teams">Teams, \$100 a year or \$10 a month<\/option>/);
  assert.match(pricing, /<summary>What is Teams\?<\/summary><p>[^<]*\$100 a year or \$10 a month/);
  assert.match(read('public/terms.html'), /Teams[^<]*\$100 a year or \$10 a month/);
});

test('branding removal is a Teams feature; Pro keeps a small footer', () => {
  const pricing = read('public/pricing.html');
  const pro = /<h3>Pro<\/h3>[\s\S]*?<\/ul>/.exec(pricing)[0];
  assert.ok(!/No pastecal branding/.test(pro), 'the Pro card must not promise no branding');
  const teams = /<h3>Teams<\/h3>[\s\S]*?<\/ul>/.exec(pricing)[0];
  assert.match(teams, /No pastecal branding/);
  const row = /<tr><td>No pastecal branding[\s\S]*?<\/tr>/.exec(pricing)[0];
  assert.match(row, /<td class="pro n">—<\/td><td class="y">✓<\/td><\/tr>$/, 'compare table: Pro no, Teams yes');
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
