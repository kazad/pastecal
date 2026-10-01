/**
 * Unit tests for WelcomeDock's lifecycle (public/components/WelcomeDock.js).
 *
 * The dock waits 600ms before appearing so the calendar paints first, and gets out of
 * the way on the first click or keypress. close() used to key off `visible`, which is
 * false during that delay, so an interaction in the first 600ms was ignored and the dock
 * appeared anyway over someone already using the calendar. The reveal timer was also
 * never cleared on unmount. A `done` flag now answers "should this still appear?".
 *
 * Run: npm run test:unit:fast
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '../../public/components/WelcomeDock.js'), 'utf8');

function mount(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const listeners = new Set();
  const document = {
    addEventListener: (type, fn) => listeners.add(fn),
    removeEventListener: (type, fn) => listeners.delete(fn),
  };
  const def = new Function('document', `${src}; return WelcomeDock;`)(document);
  const vm = { emitted: [] };
  Object.assign(vm, def.data.call(vm));
  for (const [name, fn] of Object.entries(def.methods)) vm[name] = fn.bind(vm);
  vm.$el = { contains: () => false };
  vm.$emit = (name) => vm.emitted.push(name);
  def.mounted.call(vm);
  const interact = () => [...listeners].forEach((fn) => fn({ target: {} }));
  return { vm, def, listeners, interact };
}

test('appears after the reveal delay when nobody interacts', (t) => {
  const { vm } = mount(t);
  assert.equal(vm.visible, false);
  t.mock.timers.tick(600);
  assert.equal(vm.visible, true);
});

test('an interaction during the reveal delay keeps it from ever appearing', (t) => {
  const { vm, listeners, interact } = mount(t);
  t.mock.timers.tick(200);
  interact();
  t.mock.timers.tick(5000);
  assert.equal(vm.visible, false, 'must not pop up over someone already using the calendar');
  assert.deepEqual(vm.emitted, ['dismissed']);
  assert.equal(listeners.size, 0, 'listeners removed');
});

test('unmounting before the reveal cancels it', (t) => {
  const { vm, def, listeners } = mount(t);
  def.beforeUnmount.call(vm);
  t.mock.timers.tick(5000);
  assert.equal(vm.visible, false);
  assert.equal(vm.timer, null, 'no fade timer started on a dead component');
  assert.equal(listeners.size, 0);
});

test('an interaction after it appears fades it once', (t) => {
  const { vm, interact } = mount(t);
  t.mock.timers.tick(600);
  interact();
  vm.dismiss();
  t.mock.timers.tick(300);
  assert.equal(vm.visible, false);
  assert.deepEqual(vm.emitted, ['dismissed']);
});
