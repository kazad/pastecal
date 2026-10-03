/**
 * CalendarFlow: page mode, the claim path and its failures, sample events, the created
 * notice, and the header/share components that read them. Runs the SHIPPED mixin methods
 * bound to a minimal instance, with CalendarDataService stubbed at its boundary.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
globalThis.SlugRules = require('../../functions/slug-rules.js');
const F = require('../../public/services/CalendarFlow.js');

test('page mode: one answer, and /view/ is never claimable', () => {
    assert.equal(F.pageMode({ isReadOnly: true, isExisting: false, isLoading: true }), 'view');
    assert.equal(F.pageMode({ isReadOnly: true, isExisting: true }), 'view');
    assert.equal(F.pageMode({ isExisting: true }), 'editable');
    assert.equal(F.pageMode({ isLoading: true }), 'loading');
    assert.equal(F.pageMode({}), 'new');
});

test('sample event: dropped on create unless the person made it theirs', () => {
    const sample = F.markSample({ id: 'u1', title: F.SAMPLE_TITLE });
    assert.ok(sample.id.startsWith(F.SAMPLE_ID_PREFIX));
    const renamed = F.markSample({ id: 'u2', title: F.SAMPLE_TITLE });
    renamed.title = 'Dentist';
    const real = { id: 'u3', title: 'Sample event' };   // a user's own event with that title
    assert.deepEqual(F.withoutSamples([sample, renamed, real]).map(e => e.id), [renamed.id, 'u3']);
});

test('titles: typed wins, a chosen link becomes a readable title, a random one does not', () => {
    assert.equal(F.titleForClaim({ typedTitle: ' Soccer ', currentTitle: 'New Calendar', slug: 'x1y', slugChosen: true }), 'Soccer');
    assert.equal(F.titleForClaim({ typedTitle: '', currentTitle: 'New Calendar', slug: 'soccer-team_2026', slugChosen: true }), 'Soccer team 2026');
    assert.equal(F.titleForClaim({ typedTitle: '', currentTitle: 'New Calendar', slug: 'k3j9x2pq', slugChosen: false }), 'New Calendar');
    assert.equal(F.titleForClaim({ typedTitle: '', currentTitle: 'Trip', slug: 'abc', slugChosen: true }), 'Trip');
});

test('created flag: read once from the URL, then removed', () => {
    let replaced = null;
    const history = { state: null, replaceState: (s, t, url) => { replaced = url; } };
    assert.equal(F.takeCreatedFlag({ href: 'https://pastecal.com/abc?created=1&d=2026-01-01' }, history), true);
    assert.equal(replaced, '/abc?d=2026-01-01');
    assert.equal(F.takeCreatedFlag({ href: 'https://pastecal.com/abc' }, history), false);
    assert.equal(F.createdURL(F.calendarPath('abc', '/nativecal')), '/nativecal/abc?created=1');
});

test('copy toasts say which link was copied', () => {
    assert.equal(F.copyToast('view'), 'View-only link copied');
    assert.match(F.copyToast('edit'), /^Edit link copied.*change or delete events/);
});

// ---- the claim path, through the real mixin ----------------------------------------------

function makeVm({ id = 'my-cal', edited = true, mode = {}, exists = false, writeError = null, checkError = null } = {}) {
    const calls = { created: null, recents: [], cleared: 0, href: null };
    globalThis.window = { location: { set href(v) { calls.href = v; }, get href() { return 'https://x/'; } }, CAL_BASE: undefined };
    globalThis.CalendarDataService = {
        checkExists(slug, yes, no, err) {
            calls.checked = slug;
            if (checkError) return err(checkError);
            return exists ? yes() : no();
        },
        createWithId(key, value, success, opts) {
            calls.created = { key, value };
            if (writeError) return opts.onError(writeError);
            success();
        },
    };
    const vm = {
        ...F.mixin.data(),
        calendar: { id, title: 'New Calendar', events: [F.markSample({ id: 's', title: F.SAMPLE_TITLE }), { id: 'e1', title: 'Real' }] },
        isReadOnly: false, isExisting: false, isLoading: false, ...mode,
        recentManager: { add: (...a) => calls.recents.push(a), getAll: () => [] },
        recentCalendars: [],
        clearLocalStorage: () => { calls.cleared++; },
        showToast() {},
    };
    vm.userHasEditedSlug = edited;
    for (const [k, fn] of Object.entries(F.mixin.computed)) {
        Object.defineProperty(vm, k, { get: () => fn.call(vm), configurable: true });
    }
    for (const [k, fn] of Object.entries(F.mixin.methods)) vm[k] = fn.bind(vm);
    return { vm, calls };
}

test('claim: success strips the sample, sets a title, records recents, redirects with ?created=1', () => {
    const { vm, calls } = makeVm({ id: 'soccer-team' });
    vm.claim({ title: '' });
    assert.equal(calls.created.key, 'soccer-team');
    assert.deepEqual(calls.created.value.events.map(e => e.id), ['e1']);
    assert.equal(calls.created.value.title, 'Soccer team');
    assert.deepEqual(calls.recents[0], ['soccer-team', 'Soccer team', true]);
    assert.equal(calls.cleared, 1);
    assert.equal(calls.href, '/soccer-team?created=1');
});

test('claim: "My Carpool 1" is slugified, never sent raw', () => {
    const { vm, calls } = makeVm({ id: 'My Carpool 1' });
    vm.claim();
    assert.equal(calls.checked, 'my-carpool-1');
    assert.equal(calls.created.key, 'my-carpool-1');
});

test('claim: invalid or reserved names never reach the database, and say why', () => {
    for (const bad of ['ab', 'nativecal', 'view']) {
        const { vm, calls } = makeVm({ id: bad });
        vm.claim();
        assert.equal(calls.checked, undefined, `${bad} must not be checked or written`);
        assert.ok(vm.slugMessage, `${bad} must explain itself`);
    }
});

test('claim: a taken name and a refused write both end with words and a usable page', () => {
    const taken = makeVm({ exists: true });
    taken.vm.claim();
    assert.match(taken.vm.slugMessage, /is taken/);
    assert.equal(taken.vm.claimBusy, false);
    assert.equal(taken.calls.created, null);

    const refused = makeVm({ writeError: { code: 'PERMISSION_DENIED' } });
    refused.vm.claim();
    assert.equal(refused.vm.isLoading, false, 'Loading... must not stick after a refused write');
    assert.equal(refused.vm.claimBusy, false);
    assert.match(refused.vm.slugMessage, /can't be used/);
    assert.equal(refused.calls.href, null);

    const thrown = makeVm({ checkError: new Error('Invalid key') });
    thrown.vm.claim();
    assert.equal(thrown.vm.claimBusy, false);
    assert.ok(thrown.vm.slugMessage);
});

test('claim: does nothing on a /view/ page or a saved calendar (B1)', () => {
    for (const mode of [{ isReadOnly: true }, { isExisting: true }]) {
        const { vm, calls } = makeVm({ mode });
        vm.startClaim();
        vm.claim();
        vm.openClaimDialog();
        assert.equal(calls.checked, undefined);
        assert.equal(vm.showClaimDialog, false);
    }
});

test('startClaim: an untouched generated id opens the dialog; a typed name claims', () => {
    const fresh = makeVm({ id: 'k3j9x2pq', edited: false });
    fresh.vm.startClaim();
    assert.equal(fresh.vm.showClaimDialog, true);
    assert.equal(fresh.calls.checked, undefined);
    const typed = makeVm({ id: 'trip-2026', edited: true });
    typed.vm.startClaim();
    assert.equal(typed.calls.created.key, 'trip-2026');
});

test('onSlugInput: slugifies as typed', () => {
    const { vm } = makeVm({ edited: false });
    const target = { value: 'Team Cal' };
    vm.onSlugInput({ target });
    assert.equal(vm.calendar.id, 'team-cal');
    assert.equal(target.value, 'team-cal');
    assert.equal(vm.userHasEditedSlug, true);
});

test('header link: shows the link the pill copies', () => {
    const { vm } = makeVm({ mode: { isExisting: true } });
    vm.calendar.options = {};
    assert.equal(vm.headerLink.kind, 'edit');
    vm.calendar.options.publicViewId = 'abc123';
    assert.deepEqual(vm.headerLink, { kind: 'view', prefix: 'pastecal.com/view/', name: 'abc123' });
});

// ---- markup: every control reads the page mode, in both apps -----------------------------

test('both apps use the one header, claim dialog and share panel', () => {
    for (const p of ['public/index.html', 'public/nativecal/index.html']) {
        const html = read(p);
        assert.match(html, /<app-header/, p);
        assert.match(html, /<claim-dialog/, p);
        assert.match(html, /<share-panel/, p);
        assert.doesNotMatch(html, /data-testid="mobile-header"/, `${p}: the second header tree is gone`);
        assert.doesNotMatch(html, /<topbar/, p);
        assert.doesNotMatch(html, /Feed URL \(full access\)/, `${p}: no edit feed`);
        assert.doesNotMatch(html, /Hover over the <strong>PasteCal logo/, p);
    }
    for (const p of ['public/app.js', 'public/nativecal/app.js']) {
        const src = read(p);
        assert.match(src, /mixins: \[CalendarFlow\.mixin\]/, p);
        assert.doesNotMatch(src, /\balert\(/, `${p}: no native alerts`);
        // A method of the same name on the app would silently override the mixin's --
        // exactly how the second create() hid the claim dialog.
        for (const m of Object.keys(F.mixin.methods)) {
            assert.doesNotMatch(src, new RegExp(`\\n\\s{8}${m}\\(`), `${p} redefines ${m}()`);
        }
    }
});

test('header: the claim bar exists only in "new" mode; the view chip only in "view"', () => {
    const src = read('public/components/AppHeader.js').split('template:')[1];
    assert.match(src, /v-if="mode === 'new'"[^>]*data-testid="claim-bar"/);
    assert.match(src, /v-if="mode === 'view'"[^>]*data-testid="share-pill-readonly"|v-if="mode === 'view'" type="button" @click="app.toggleShare\(\)"/);
    assert.doesNotMatch(src, /isExisting|isReadOnly/, 'the header reads pageMode, not ad-hoc booleans');
});

test('share panel: view link first and primary, edit link last with a warning', () => {
    const src = read('public/components/SharePanel.js').split('template:')[1];
    const view = src.indexOf('data-testid="share-view-card"');
    const edit = src.indexOf('data-testid="share-edit-card"');
    assert.ok(view > 0 && edit > view);
    assert.match(src, /Anyone with this link can change or delete events/);
    assert.doesNotMatch(src, /Sharing &amp; Security|Sharing & Security/);
    assert.doesNotMatch(src, /\.ics`[^]*calendar\.id/, 'no edit-link feed');
});
