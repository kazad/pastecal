/**
 * One display name per plan id, the same on the page (public/components/Pro.js) and in the Worker
 * (cloudflare/src/Plans.js): 'pro' is Plus, 'unlimited' is Pro, 'teams' is Teams, and a missing or
 * unknown id reads as Plus.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function pagePlanName() {
  const src = fs.readFileSync(path.join(__dirname, '../../public/components/Pro.js'), 'utf8');
  const m = /function planName\(plan\) \{[\s\S]*?\n\}/.exec(src);
  assert.ok(m, 'Pro.js defines planName');
  return new Function(`${m[0]}; return planName;`)();
}
async function workerPlanName() {
  return (await import(path.join(__dirname, '../../cloudflare/src/Plans.js'))).planName;
}

const CASES = [['pro', 'Plus'], ['unlimited', 'Pro'], ['teams', 'Teams'], [null, 'Plus'], [undefined, 'Plus'], ['', 'Plus'], ['other', 'Plus']];

test('page and Worker name every plan id the same way', async () => {
  const page = pagePlanName(), worker = await workerPlanName();
  for (const [id, name] of CASES) {
    assert.equal(page(id), name, `page: ${id}`);
    assert.equal(worker(id), name, `worker: ${id}`);
  }
});
