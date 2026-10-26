/**
 * GUARD (root 6, Oct 26 2026): no key handler acts on Enter, Escape or Tab pressed while an IME is composing.
 *
 * Typing Japanese, Chinese or Korean, the Enter that confirms a conversion and the Escape that cancels it are ordinary
 * keydowns marked isComposing (keyCode 229). The card's title saved and closed a new event mid-word on that Enter and
 * threw it away on that Escape (editor-stress-2 S06); before that, the Oct 18 IME bug. Each handler checked e.key
 * itself, so each had to remember composition. Now public/utils/keys.js is the one place:
 *   - app code asks pcKeys.is(e, 'Enter') (false mid-composition), never e.key === 'Enter' / keyCode 13;
 *   - Vue's key modifiers (@keydown.enter, .esc, .tab) are wrapped in keys.js to skip a composing key;
 *   - no @keyup.enter / .esc / .tab: a keyup cannot tell (Chrome's keyup after a confirming Enter is not marked).
 * This scans the app's code for the other ways, and checks the Vue wrapper on the real Vue build.
 * Run: node --test test/unit/ime-keys.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PUB = path.join(__dirname, '..', '..', 'public');
function files(dir, re) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return d.name === 'vendor' || d.name === 'js-old-components' ? [] : files(p, re);
    return re.test(d.name) ? [p] : [];
  });
}
// The app: the page, its scripts, its components, the native calendar (and its /beta page).
const SOURCES = [path.join(PUB, 'index.html'), path.join(PUB, 'app.js'), path.join(PUB, 'nativecal', 'index.html'),
  ...['components', 'nativecal', 'directives', 'services', 'utils', 'models'].flatMap((d) => files(path.join(PUB, d), /\.js$/))]
  .filter((p, i, a) => a.indexOf(p) === i && !p.endsWith(path.join('utils', 'keys.js')));
const KEYS = '(Enter|Escape|Esc|Tab)';
const BANNED = [
  [new RegExp(`\\.key\\s*[!=]==?\\s*['"]${KEYS}['"]|['"]${KEYS}['"]\\s*[!=]==?\\s*\\w+\\.key\\b`), 'e.key compared to Enter/Escape/Tab: use pcKeys.is(e, ...)'],
  [new RegExp(`case\\s+['"]${KEYS}['"]`), 'switch on e.key with Enter/Escape/Tab: use pcKeys.is(e, ...)'],
  [/\b(keyCode|which)\s*[!=]==?\s*(13|27|9)\b/, 'keyCode 13/27/9: use pcKeys.is(e, ...)'],
  [new RegExp(`\\.code\\s*[!=]==?\\s*['"]${KEYS}['"]`), 'e.code compared to Enter/Escape/Tab: use pcKeys.is(e, ...)'],
  [/@keyup\.(enter|esc|escape|tab)\b|v-on:keyup\.(enter|esc|escape|tab)\b/i, '@keyup.enter/esc/tab cannot see a composition: use @keydown'],
];

test('no key handler in the app reads Enter, Escape or Tab without pcKeys (which skips a key pressed mid-composition)', () => {
  const found = [];
  for (const f of SOURCES) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');   // (comments may name keys)
      for (const [re, why] of BANNED) if (re.test(code)) found.push(`${path.relative(PUB, f)}:${i + 1}: ${why}`);
    });
  }
  assert.deepEqual(found, []);
  assert.ok(SOURCES.length > 20, `scanned ${SOURCES.length} files`);
});

test('keys.js loads right after Vue on every page that mounts the app, before any component', () => {
  for (const page of ['index.html', path.join('nativecal', 'index.html')]) {
    const html = fs.readFileSync(path.join(PUB, page), 'utf8');
    const vue = html.indexOf('vue.global.prod.js'), keys = html.indexOf('/utils/keys.js');
    const first = Math.min(...['/components/', '/nativecal/components/', '/app.js', 'createApp('].map((s) => { const i = html.indexOf(s, vue + 1); return i < 0 ? Infinity : i; }));
    assert.ok(vue > 0 && keys > vue && keys < first, `${page}: Vue ${vue}, keys.js ${keys}, first app script ${first}`);
  }
});

test('on the real Vue build, a key modifier (@keydown.enter.prevent, .esc) skips a composing key and still sees a plain one', () => {
  const ctx = { navigator: { platform: 'Win32' }, console };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(PUB, 'vendor', 'vue-3.5.44', 'vue.global.prod.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(PUB, 'utils', 'keys.js'), 'utf8'), ctx);
  const ran = [];
  const key = (k, composing) => ({ key: k, keyCode: composing ? 229 : 13, isComposing: composing, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {} });
  // What a compiled template calls: withKeys(withModifiers(handler, ['prevent']), ['enter']).
  const enter = ctx.Vue.withKeys(ctx.Vue.withModifiers(() => ran.push('enter'), ['prevent']), ['enter']);
  const esc = ctx.Vue.withKeys(() => ran.push('esc'), ['esc']);
  const mid = key('Enter', true); enter(mid);
  enter(key('Enter', false));
  esc(key('Escape', true)); esc(key('Escape', false));
  assert.deepEqual({ ran, preventedMidComposition: mid.prevented }, { ran: ['enter', 'esc'], preventedMidComposition: false });
  // And a template compiled at run time takes the wrapped withKeys.
  const render = ctx.Vue.compile('<input @keydown.enter.prevent="go">');
  const calls = [];
  const vnode = render.call({ go: () => calls.push('go') }, { go: () => calls.push('go') }, []);
  vnode.props.onKeydown(key('Enter', true));
  vnode.props.onKeydown(key('Enter', false));
  assert.deepEqual(calls, ['go']);
  // pcKeys.is: the one question app code asks.
  assert.deepEqual([ctx.pcKeys.is(key('Enter', true), 'Enter'), ctx.pcKeys.is(key('Enter', false), 'Enter'), ctx.pcKeys.is({ key: 'Esc' }, 'Escape')], [false, true, true]);
});
