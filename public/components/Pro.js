// Pro: the lock badge next to a locked calendar's title, and the share dialog's
// "Lock this calendar" / owner section.
//
// Talks only to this site's own JSON API (cookie session, see cloudflare/src/Accounts.js):
//   GET  /api/pro/status?calendar=<id> -> {locked, pro, isOwner}
//   GET  /api/me                       -> {email, calendars:[...]} | 401
//   POST /api/auth/start {email, next} -> {ok}   (a sign-in link by email)
//   POST /api/pro/checkout {calendarId, interval} -> {url}   503 / 409 handled
//   POST /api/pro/editor-key {calendarId} -> {editorKey}     ROTATES the key
//   POST /api/pro/portal {calendarId, flow?} -> {url}         flow 'add-card': Keep Pro during a trial
//   POST /api/pro/trial {calendarId}   -> {ok, trialEnd}      30 days free, no card (409 trial-used-calendar/-account)
//   POST /api/pro/lapsed-mode {calendarId, mode} -> {ok, mode, paused}   'readonly' | 'open', after Pro ends
//   POST /api/auth/signout
//   GET  /api/pro/config               -> {billing}  false: every Pro offer is "Join the beta" (ProBetaJoin)
//   POST /api/waitlist {email, plan:'pro', use, page, website} -> {ok, returning}   the Pro beta list
// Analytics get the step and the reason only: never the email, the calendar name or a key.

const PRO_LOCK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';

// The name a person sees for a plan id (the lock's plan, /api/me's plan). Ids stay as they are:
// 'pro' is Plus, 'unlimited' is Pro, 'teams' is Teams; anything else reads as Plus.
// Twin of planName in cloudflare/src/Plans.js (test/unit/plan-name.test.js).
function planName(plan) {
    return plan === 'unlimited' ? 'Pro' : plan === 'teams' ? 'Teams' : 'Plus';
}

const PRO_MESSAGES = {
    lockedVisitor: 'Only the owner and invited editors can change this calendar.',
    lockedEditor: 'Locked · you can edit',
    keyReset: 'This editor link was reset by the owner. Ask them for the new one.',
    paused: 'Editing is paused by the owner.',
};

// Set when someone asks for a sign-in link from the share dialog, so the calendar reopens
// the dialog when the link brings them back. Holds the calendar id and a time, nothing personal.
const PRO_INTENT_KEY = 'pastecal_pro_intent';
const ProIntent = {
    // go: they already pressed Lock and only had to sign in, so continue to payment once they're back.
    // surface: where a trial was asked for ('share' | 'stats' | 'lock'), for trial_started.
    set(id, interval, go = false, surface) { try { localStorage.setItem(PRO_INTENT_KEY, JSON.stringify({ id, interval, go, surface, t: Date.now() })); } catch (e) { /* storage blocked */ } },
    get(id) {
        try {
            const v = JSON.parse(localStorage.getItem(PRO_INTENT_KEY) || 'null');
            return v && v.id === id && Date.now() - v.t < 2 * 3600 * 1000 ? v : null;
        } catch (e) { return null; }
    },
    clear() { try { localStorage.removeItem(PRO_INTENT_KEY); } catch (e) { /* storage blocked */ } },
};

// The quiet "Lock this calendar" line on your own calendar when someone else changed it since
// your last visit (app.js maybeShowProUpsell). Shown at most once per calendar per 30 days;
// storage holds calendar ids and times, nothing personal. Pure decisions, unit-tested in
// test/unit/pro-upsell.test.js.
const PRO_UPSELL_KEY = 'pastecal_pro_upsell';
const ProUpsell = {
    EVERY_MS: 30 * 24 * 3600 * 1000,
    MAX_IDS: 100,
    _all() {
        try { const v = JSON.parse(localStorage.getItem(PRO_UPSELL_KEY) || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch (e) { return {}; }
    },
    shownAt(id) { const t = this._all()[id]; return typeof t === 'number' ? t : null; },
    markShown(id, now = Date.now()) {
        try {
            const all = this._all(); all[id] = now;
            const keep = Object.entries(all).sort((a, b) => b[1] - a[1]).slice(0, this.MAX_IDS);
            localStorage.setItem(PRO_UPSELL_KEY, JSON.stringify(Object.fromEntries(keep)));
        } catch (e) { /* storage blocked: it may show again next visit */ }
    },
    // Everything that can be decided before reading the history. 'wait' = not known yet (the
    // lock state or the last-edit stamp hasn't arrived), so ask again later.
    precheck(c) {
        if (!c.id || !c.existing || c.homepage || c.readOnly || c.viewRoute || c.embedded || c.beta) return 'no';
        if (!c.mine) return 'no';                                   // never pitch to visitors of someone else's calendar
        if (c.shownAt != null && c.now - c.shownAt < this.EVERY_MS) return 'no';
        if (!c.lockKnown) return 'wait';
        if (c.locked) return 'no';
        if (!c.visitKnown) return 'wait';
        if (!c.lastSeenAt) return 'no';                             // first visit from this browser: nothing is "since"
        if (c.lastEditedAt == null) return 'wait';
        return c.lastEditedAt > c.lastSeenAt ? 'yes' : 'no';
    },
    // Did a browser other than this one change the calendar after `since`? History rows written
    // before writers were recorded (or by the server, like lock changes) have no writer and don't count.
    changedByOthers(entries, since, me) {
        return (entries || []).some((e) => (e.parts || [e]).some((p) => p.savedAt > since && p.writer && p.writer !== me));
    },
};

// Trial analytics state, in this browser only (calendar ids never leave it):
//   once(id, feature): true the first time a feature is used on this calendar today (trial_feature_used);
//   trialing/lapsedSeen: so trial_converted / trial_lapsed fire once when the owner next sees the outcome.
const TRIAL_USAGE_KEY = 'pastecal_trial_usage';
const TrialUsage = {
    _all() { try { const v = JSON.parse(localStorage.getItem(TRIAL_USAGE_KEY) || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch (e) { return {}; } },
    _save(all) {
        try {
            const keep = Object.entries(all).sort((a, b) => String(b[1]).localeCompare(String(a[1]))).slice(0, 300);
            localStorage.setItem(TRIAL_USAGE_KEY, JSON.stringify(Object.fromEntries(keep)));
        } catch (e) { /* storage blocked: may count again */ }
    },
    today() { return new Date().toISOString().slice(0, 10); },
    once(id, feature) {
        const all = this._all(), k = String(id).toLowerCase() + '|' + feature, d = this.today();
        if (all[k] === d) return false;
        all[k] = d; this._save(all);
        return true;
    },
    flag(id, name, on) {
        const all = this._all(), k = String(id).toLowerCase() + '#' + name;
        if (on === undefined) return !!all[k];
        if (on) all[k] = this.today(); else delete all[k];
        this._save(all);
        return on;
    },
};
// During a trial, the first use per feature per calendar per day.
function trialFeature(id, feature) {
    if (id && TrialUsage.once(id, feature)) proTrack((a) => a.trialFeatureUsed(feature));
}

// This browser's author uid (services/AuthorSignal.js): trial and checkout are for an editor of record (the
// browser that made the calendar, or one that edited it on 2+ days); the server checks it. Never shown anywhere.
function proAuthor() {
    try { return typeof AuthorSignal !== 'undefined' && AuthorSignal.uid ? AuthorSignal.uid() || '' : ''; } catch (e) { return ''; }
}

function proTrack(fn) {
    try { if (typeof Analytics !== 'undefined' && Analytics) fn(Analytics); } catch (e) { /* observational only */ }
}

async function proApi(method, path, body) {
    const init = { method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    let res;
    try { res = await fetch(path, init); } catch (e) { return { status: 0, data: {} }; }
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
}

// Can Pro be bought on this site? GET /api/pro/config, asked once per page. true | false; a failed or
// stalled (4s) request counts as true, so the offer works as before (checkout and the trial still answer 503 when off).
const ProBilling = {
    _p: null,
    load() {
        if (!this._p) {
            // A stalled request must not hold the offer back: after 4 seconds, behave as billing on.
            const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
            if (ctl) setTimeout(() => ctl.abort(), 4000);
            this._p = fetch('/api/pro/config', { credentials: 'same-origin', signal: ctl ? ctl.signal : undefined })
                .then((r) => (r.ok ? r.json() : null))
                .then((d) => (d && typeof d.billing === 'boolean' ? d.billing : true))
                .catch(() => true);
        }
        return this._p;
    },
};

// "Join the beta": while billing is off, this stands in for Try Pro free / Get Pro / Lock this calendar.
// The button opens an email field; the address goes on the Pro waitlist (plan 'pro'), with the calendar's
// path as the page it came from. Same honeypot and email check as the pricing page's waitlist form.
const PRO_BETA_DONE = 'You’re on the list. We’ll email you when your trial is ready.';
const ProBetaJoin = {
    template: /* html */ `
        <div class="pc-beta-join" data-testid="pro-beta-join">
            <button v-if="step === 'idle'" type="button" class="pc-btn" :class="btnClass" @click="open" data-testid="pro-beta-btn">Join the beta</button>
            <form v-else-if="step === 'email'" class="pc-pro-email" @submit.prevent="submit" novalidate data-testid="pro-beta-form">
                <label :for="inputId">Your email. We’ll write when your trial is ready.</label>
                <div class="pc-pro-row">
                    <input :id="inputId" class="pc-field" ref="email" type="email" v-model.trim="email" required autocomplete="email" placeholder="you@example.com"
                        data-hj-suppress data-clarity-mask="true" data-testid="pro-beta-email">
                    <button type="submit" class="pc-btn pc-btn--primary" :disabled="busy" data-testid="pro-beta-submit">{{ busy ? 'Sending…' : 'Join' }}</button>
                </div>
                <div class="pc-hp" aria-hidden="true"><label :for="inputId + '-w'">Website</label><input :id="inputId + '-w'" v-model="website" tabindex="-1" autocomplete="off"></div>
            </form>
            <p v-else class="pc-pro-ok" role="status" data-testid="pro-beta-done">{{ done }}</p>
            <p v-if="error" class="pc-pro-err" role="alert" data-testid="pro-beta-error">{{ error }}</p>
        </div>
    `,
    props: {
        surface: { type: String, default: 'share' },  // share | stats | lock (pro_beta_joined)
        calendarId: String,
        btnClass: { type: String, default: 'pc-btn--primary' },   // .pc-btn variants
        autoOpen: Boolean,                              // already asked for Pro: show the email field at once
    },
    data() {
        return { step: 'idle', email: '', website: '', busy: false, error: '', done: PRO_BETA_DONE,
            inputId: 'pc-beta-email-' + Math.random().toString(36).slice(2, 8) };
    },
    mounted() { if (this.autoOpen) this.open(false); },
    methods: {
        open(focus = true) {
            this.step = 'email'; this.error = '';
            if (focus) this.$nextTick(() => { this.$refs.email && this.$refs.email.focus(); });
        },
        async submit() {
            this.error = '';
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.email)) { this.error = 'Enter an email address, like you@example.com.'; this.$refs.email && this.$refs.email.focus(); return; }
            this.busy = true;
            try {
                const page = this.calendarId ? '/' + this.calendarId : location.pathname;
                const r = await proApi('POST', '/api/waitlist', { email: this.email, plan: 'pro', use: 'Pro beta', page, website: this.website });
                if (r.status === 200 && r.data.ok) {
                    this.done = r.data.returning ? 'You’re still on the list. We’ll email you when your trial is ready.' : PRO_BETA_DONE;
                    this.step = 'done';
                    proTrack((a) => a.proBetaJoined(this.surface));
                    return;
                }
                this.error = r.status === 0 ? 'We couldn’t reach pastecal. Check your connection and try again.'
                    : (r.data.error && r.status < 500 ? r.data.error : 'That didn’t save. Try again in a minute.');
            } finally { this.busy = false; }
        },
    },
};

const LockBadge = {
    template: /* html */ `
        <span class="pc-lock" :class="{ 'pc-lock--open': open }" data-testid="lock-badge"
            @pointerenter="$event.pointerType === 'mouse' && (open = true)" @pointerleave="$event.pointerType === 'mouse' && (open = false)">
            <button type="button" class="pc-btn pc-btn--ghost pc-btn--icon pc-btn--xs pc-lock-btn" :aria-label="label" :aria-expanded="open ? 'true' : 'false'"
                @click.stop="open = !open" @keydown.esc="open = false" @blur="open = false" v-html="svg"></button>
            <span v-if="open" class="pc-lock-pop" role="tooltip" data-testid="lock-tip">{{ label }}
                <!-- mousedown.prevent keeps the button's blur from closing the popover before the click lands -->
                <a v-if="!canEdit" href="/" class="pc-lock-copy" data-testid="lock-copy"
                    @mousedown.prevent @click.prevent.stop="open = false; $emit('copy')">Make your own copy</a>
            </span>
        </span>
    `,
    props: { canEdit: Boolean, paused: Boolean },
    emits: ['copy'],
    data() { return { open: false, svg: PRO_LOCK_SVG }; },
    computed: {
        label() { return this.paused ? PRO_MESSAGES.paused : this.canEdit ? PRO_MESSAGES.lockedEditor : PRO_MESSAGES.lockedVisitor; },
    },
    mounted() {
        this._close = () => { this.open = false; };
        document.addEventListener('click', this._close);
    },
    beforeUnmount() { document.removeEventListener('click', this._close); },
};

const ProPanel = {
    template: /* html */ `
        <section class="pc-pro" data-testid="pro-panel" v-if="mode !== 'hidden'">
            <div class="pc-pro-head">
                <h4 v-if="mode === 'owner'" data-testid="pro-owner-title">Upgraded with {{ plan }} <span class="pc-pill pc-pill--beta" data-testid="pro-beta-tag">Beta</span></h4>
                <h4 v-else-if="mode === 'lapsed'" data-testid="pro-lapsed-title">{{ status.lapsedTrial ? 'Trial ended' : plan + ' ended' }} — read-only</h4>
                <h4 v-else-if="mode === 'paused'">Editing is paused</h4>
                <h4 v-else-if="mode === 'locked'">This calendar is locked</h4>
                <h4 v-else>Upgrade this calendar <span class="pc-pill pc-pill--beta" data-testid="pro-beta-tag">Beta</span></h4>
            </div>

            <!-- Unlocked and editable: what Plus adds, then one way to get it -->
            <template v-if="mode === 'offer'">
                <ul class="pc-plus-list" data-testid="plus-features">
                    <li><b>Choose who edits.</b> You and people with your editor links. Everyone else can view.</li>
                    <li><b>Its name is reserved</b> for you.</li>
                    <li><b>Full stats:</b> views per day, followers, places.</li>
                    <li><b>History:</b> every saved version, and restore any of them.</li>
                </ul>
                <p class="pc-pro-muted">Coming: subcalendars.</p>

                <!-- Billing not on yet (/api/pro/config): the beta list instead of the trial and checkout -->
                <div v-if="billing === false" class="pc-plus-cta">
                    <p class="pc-pro-lead">Plus is in beta. Join, and we’ll email you when your trial is ready.</p>
                    <pro-beta-join :surface="surface" :calendar-id="calendarId" :auto-open="autoJoin"></pro-beta-join>
                </div>

                <!-- Never trialed: 30 days free, no card. Signing in starts it. -->
                <div v-else-if="billing === true && !trialUsed" class="pc-plus-cta" data-testid="pro-trial-box">
                    <form v-if="trialStep === 'email'" class="pc-pro-email" @submit.prevent="sendTrialLink" data-testid="pro-trial-email-form">
                        <label for="pc-pro-trial-email">Your email. The link we send starts your trial. No password.</label>
                        <div class="pc-pro-row">
                            <input id="pc-pro-trial-email" class="pc-field" ref="trialEmail" type="email" v-model.trim="email" required autocomplete="email" placeholder="you@example.com">
                            <button type="submit" class="pc-btn pc-btn--primary" :disabled="busy">{{ busy ? 'Sending…' : 'Send link' }}</button>
                        </div>
                    </form>
                    <p v-else-if="trialStep === 'sent'" class="pc-pro-ok" data-testid="pro-trial-sent">Check your email. The link starts your trial and brings you back here.</p>
                    <template v-else>
                        <button type="button" class="pc-btn pc-btn--primary pc-plus-main" @click="startTrial" :disabled="busy" data-testid="pro-trial-btn">{{ busy ? 'One moment…' : 'Start 30-day free trial' }}</button>
                        <p class="pc-pro-muted pc-pro-note">No card needed.<template v-if="me"> As <span data-hj-suppress data-clarity-mask="true">{{ me.email }}</span>.</template></p>
                    </template>
                    <p class="pc-pro-muted pc-pro-note">When the trial ends, nothing is charged and it’s a free calendar again, unless you keep Plus.</p>
                    <p v-if="step === 'idle'" class="pc-pro-muted pc-plus-or">or <button type="button" class="pc-link" @click="lockNow" :disabled="busy" data-testid="pro-lock-btn">{{ going ? 'taking you to payment…' : 'upgrade now: $29/year' }}</button></p>
                </div>

                <!-- Already had its trial: pay -->
                <div v-else-if="billing === true" class="pc-plus-cta">
                    <p class="pc-pro-price" data-testid="pro-price"><b>$29 a year</b> <span class="pc-pro-muted">That's about $2.42 a month.</span></p>
                    <div v-if="step === 'idle'" class="pc-pro-row">
                        <button type="button" class="pc-btn pc-btn--primary pc-plus-main" @click="lockNow" :disabled="busy" data-testid="pro-lock-btn">
                            {{ going ? 'Taking you to payment…' : busy ? 'One moment…' : 'Upgrade this calendar' }}
                        </button>
                    </div>
                    <p v-if="step === 'idle' && me" class="pc-pro-muted pc-pro-note">Signed in as <span data-hj-suppress data-clarity-mask="true">{{ me.email }}</span> · <a href="#" @click.prevent="signOut">Sign out</a></p>
                    <p v-else-if="step === 'idle'" class="pc-pro-muted pc-pro-note" data-testid="pro-next">Next: pay on Stripe's secure page. No account to set up.</p>
                </div>

                <!-- Pressed "upgrade now" while signed out and checkout asked for an email -->
                <template v-if="billing === true">
                    <form v-if="step === 'email'" class="pc-pro-email" @submit.prevent="sendLink" data-testid="pro-email-form">
                        <label for="pc-pro-email-input">Your email, so you can manage your plan later. No password.</label>
                        <div class="pc-pro-row">
                            <input id="pc-pro-email-input" class="pc-field" ref="email" type="email" v-model.trim="email" required
                                autocomplete="email" placeholder="you@example.com">
                            <button type="submit" class="pc-btn pc-btn--primary" :disabled="busy">{{ busy ? 'Sending…' : 'Send sign-in link' }}</button>
                        </div>
                    </form>
                    <p v-else-if="step === 'sent'" class="pc-pro-ok" data-testid="pro-sent">Check your email for a sign-in link. It brings you back here to finish.</p>
                    <p v-if="testCardHint" class="pc-pro-muted pc-pro-note" data-testid="pro-test-card">{{ testCardHint }}</p>
                </template>
            </template>

            <!-- Locked, and this browser is not signed in as the owner -->
            <template v-if="mode === 'locked' || mode === 'paused'">
                <p v-if="mode === 'paused'" class="pc-pro-lead" data-testid="pro-paused">Editing is paused by the owner. You can still view it and follow it in your calendar app.</p>
                <p v-else class="pc-pro-lead">Only the owner and people with an editor link can change it. Everyone else can view.</p>
                <form v-if="step === 'email'" class="pc-pro-email" @submit.prevent="sendLink">
                    <label for="pc-pro-email-input2">Are you the owner? Sign in with the email you paid with.</label>
                    <div class="pc-pro-row">
                        <input id="pc-pro-email-input2" class="pc-field" ref="email" type="email" v-model.trim="email" required autocomplete="email" placeholder="you@example.com">
                        <button type="submit" class="pc-btn pc-btn--primary" :disabled="busy">{{ busy ? 'Sending…' : 'Send sign-in link' }}</button>
                    </div>
                </form>
                <p v-else-if="step === 'sent'" class="pc-pro-ok">Check your email for a sign-in link.</p>
                <p v-else-if="me" class="pc-pro-muted">Signed in as <span data-hj-suppress data-clarity-mask="true">{{ me.email }}</span>, which doesn't own this calendar · <a href="#" @click.prevent="signOut">Sign out</a></p>
                <a v-else href="#" class="pc-link" @click.prevent="step = 'email'; focusEmail()" data-testid="pro-owner-signin">Owner? Sign in to manage it</a>
            </template>

            <!-- The plan ended (trial or paid) and the calendar is paused: its owner chooses -->
            <template v-if="mode === 'lapsed'">
                <p class="pc-pro-lead">Everyone can still view it and follow it in their calendar app. Nobody can edit it, you included.</p>
                <div class="pc-pro-row">
                    <button type="button" class="pc-btn" @click="openToEveryone" :disabled="busy" data-testid="pro-open-btn">Open to everyone</button>
                    <button v-if="!keepOpen && billing !== false" type="button" class="pc-btn pc-btn--primary" @click="keepProAfter" :disabled="busy" data-testid="pro-keep-btn">Keep {{ plan }}</button>
                </div>
                <div v-if="keepOpen" class="pc-pro-keep" data-testid="pro-keep-plans">
                    <p class="pc-pro-price"><b>$29 a year</b> <span class="pc-pro-muted">That's about $2.42 a month.</span></p>
                    <div class="pc-pro-row"><button type="button" class="pc-btn pc-btn--primary" @click="keepCheckout" :disabled="busy" data-testid="pro-keep-checkout">{{ going ? 'Taking you to payment…' : 'Keep ' + plan }}</button></div>
                </div>
                <p class="pc-pro-muted pc-pro-note">Open to everyone: a free calendar anyone with the edit link can change.<template v-if="billing !== false"> Keep {{ plan }}: only you and your editors again, $29 a year.</template></p>
                <p v-if="testCardHint" class="pc-pro-muted pc-pro-note">{{ testCardHint }}</p>
            </template>

            <!-- The owner -->
            <template v-if="mode === 'owner'">
                <p class="pc-pro-trial-line" data-testid="plus-plan-line">
                    <template v-if="status.trial"><span data-testid="pro-trial-line">{{ plan }} trial · {{ trialLeft }}</span> ·
                        <a v-if="!status.trial.hasCard && billing !== false" href="#" class="pc-link" @click.prevent="keepPro" data-testid="pro-keep-trial">Keep {{ plan }}</a>
                        <span v-else-if="status.trial.hasCard" class="pc-pro-muted">card on file, {{ plan }} continues</span></template>
                    <template v-else>{{ plan }}<span v-if="renewal" class="pc-pro-muted" data-testid="pro-renewal"> · {{ renewal }}</span></template>
                </p>
                <div v-if="status.trial && keepOpen" class="pc-pro-keep" data-testid="pro-keep-plans">
                    <p class="pc-pro-price"><b>$29 a year</b> <span class="pc-pro-muted">That's about $2.42 a month.</span></p>
                    <div class="pc-pro-row"><button type="button" class="pc-btn pc-btn--primary" @click="keepCheckout" :disabled="busy" data-testid="pro-keep-checkout">{{ going ? 'Taking you to payment…' : 'Keep ' + plan }}</button>
                        <span class="pc-pro-muted">{{ keepNote }}</span></div>
                </div>

                <div class="pc-pro-sub" data-testid="plus-editors">
                    <h5>Who can edit</h5>
                    <p class="pc-pro-muted">You, and people with your editor link. Everyone else can view.</p>
                    <div v-if="editorLink" class="pc-pro-row">
                        <input ref="link" class="pc-field pc-pro-field" type="text" readonly :value="editorLink" @focus="$event.target.select()"
                            aria-label="Editor link" data-testid="pro-editor-link" data-hj-suppress data-clarity-mask="true">
                        <button type="button" class="pc-btn pc-btn--primary" @click="copyLink">{{ copied ? 'Copied' : 'Copy' }}</button>
                    </div>
                    <div class="pc-pro-row">
                        <button type="button" class="pc-btn" :class="{ 'pc-btn--primary': !editorLink }" @click="makeKey" :disabled="busy" data-testid="pro-key-btn">
                            {{ editorLink ? 'Reset editor link' : 'Get a new editor link' }}
                        </button>
                    </div>
                    <p v-if="editorLink" class="pc-pro-muted pc-pro-note">The last link made in this browser. If you reset it somewhere else, get a new one here.</p>
                    <p class="pc-pro-warn">A new link turns off the old one. Anyone still using it will see a view-only calendar.</p>
                </div>

                <div class="pc-pro-sub" data-testid="pro-lapse-choice">
                    <h5>If your plan ends</h5>
                    <label class="pc-pro-choice"><input type="radio" value="readonly" v-model="lapsedMode" @change="saveLapsedMode" name="pc-pro-lapse">
                        <span><b>Read-only.</b> Everyone can view; nobody edits until you decide.</span></label>
                    <label class="pc-pro-choice"><input type="radio" value="open" v-model="lapsedMode" @change="saveLapsedMode" name="pc-pro-lapse">
                        <span><b>Open to everyone.</b> A free calendar anyone with the edit link can change.</span></label>
                </div>

                <div class="pc-pro-row pc-pro-foot">
                    <button type="button" class="pc-btn" @click="portal" :disabled="busy" data-testid="pro-billing-btn">Manage billing</button>
                    <a href="#" class="pc-link" @click.prevent="signOut">Sign out</a>
                    <span v-if="me" class="pc-pro-muted" data-hj-suppress data-clarity-mask="true">{{ me.email }}</span>
                </div>
                <p class="pc-pro-muted pc-pro-note" data-testid="plus-any-device">It’s yours, not this browser’s: sign in with your email on any device to manage it.</p>
            </template>

            <p v-if="error" class="pc-pro-err" role="alert" data-testid="pro-error">{{ error }}</p>
        </section>
    `,
    props: {
        calendarId: String,
        locked: Boolean,      // from the live snapshot
        paused: Boolean,      // from the live snapshot: Pro ended and the owner left it read-only
        surface: { type: String, default: 'share' },   // where the Pro offer was opened from (trial_started)
        canEdit: Boolean,     // this tab may change the calendar
        calendarTitle: String, // named on Stripe's page, so the payer sees which calendar it's for
        autoJoin: Boolean,    // billing off and they pressed "Join the beta" somewhere: the email field opens at once
    },
    components: { 'pro-beta-join': ProBetaJoin },
    // open-insight: 'stats' | 'history' (owner only). owner: whether this browser owns the calendar,
    // so the app can offer History from Recent changes.
    emits: ['open-insight', 'owner'],
    data() {
        return {
            svg: PRO_LOCK_SVG,
            status: null,         // /api/pro/status
            me: null,             // /api/me, or null when signed out
            interval: 'year',
            step: 'idle',         // idle | email | sent
            email: '',
            busy: false,
            going: false,         // signed in from a Lock press: on the way to Stripe
            autoGo: false,
            error: '',
            editorLink: '',
            copied: false,
            trialStep: 'idle',    // idle | email | sent ("Try Pro free")
            keepOpen: false,      // Keep Pro pressed: the plan choice and the checkout button show
            trialSurface: '',
            wantTrial: false,     // opened from "Try Pro free" (ProIntent 'trial')
            lapsedMode: 'readonly',
            billing: null,        // /api/pro/config: false = Pro can't be bought yet, so the offer is the Pro beta list
            // The staging copy only (utils/preview.js): which test card to pay with.
            testCardHint: typeof PreviewSite !== 'undefined' && PreviewSite.is() ? PreviewSite.CHECKOUT_HINT : '',
        };
    },
    computed: {
        mode() {
            if (this.status && this.status.isOwner) return 'owner';
            if (this.status && this.status.lapsedOwner && !this.locked) return 'lapsed';
            if (this.paused || (this.status && this.status.paused && !this.locked)) return 'paused';
            if (this.locked || (this.status && this.status.locked)) return 'locked';
            if (!this.canEdit) return 'hidden';
            return 'offer';
        },
        trialUsed() { return !!(this.status && this.status.trialUsed); },
        // The plan's display name: the lock's plan, or the ended plan for a paused calendar's owner.
        plan() { return planName(this.status && this.status.plan); },
        // Matches the server (checkout carries the trial's end when it is over 49 hours away).
        keepNote() {
            const end = this.status && this.status.trial && this.status.trial.endsAt;
            return end && end * 1000 - Date.now() > 49 * 3600 * 1000
                ? 'Pay on Stripe’s secure page. Your free days still count: the first charge is when the trial ends.'
                : 'Pay on Stripe’s secure page. Billing starts today.';
        },
        trialLeft() {
            const end = this.status && this.status.trial && this.status.trial.endsAt;
            if (!end) return '';
            // Whole days, rounded down, the way Stripe's Checkout counts them ("29 days free").
            const days = Math.max(0, Math.floor((end * 1000 - Date.now()) / 86400000));
            return days === 0 ? 'Ends today' : days === 1 ? '1 day left' : `${days} days left`;
        },
        renewal() {
            const c = this.me && (this.me.calendars || []).find((x) => x.id === this.calendarId);
            if (!c || !c.currentPeriodEnd || c.status === 'trialing') return '';     // a trial shows its own line
            const ms = c.currentPeriodEnd < 1e12 ? c.currentPeriodEnd * 1000 : c.currentPeriodEnd;
            const d = new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
            return c.status === 'active' || c.status === 'trialing' ? `Renews ${d}` : `Ends ${d}`;
        },
    },
    watch: {
        locked() { this.refresh(); },
        paused() { this.refresh(); },
        mode: {
            handler(m, old) {
                if (m === old) return;
                if (m === 'offer') proTrack((a) => a.proLockShown('share_panel'));
                if (m === 'owner') this.editorLink = this.storedLink();
                this.$emit('owner', m === 'owner');
            },
            immediate: true,
        },
    },
    mounted() {
        const intent = ProIntent.get(this.calendarId);
        // Pro is yearly only; an old 'month' intent becomes yearly.
        this.autoGo = !!(intent && intent.go);
        this.wantTrial = !!(intent && intent.interval === 'trial');
        this.trialSurface = (intent && intent.surface) || this.surface;
        this.refresh();
        // Waiting on the email: they may sign in and pay in another tab or browser. Coming back here
        // shows where things stand instead of "Check your email".
        this._onFocus = () => { if (this.step === 'sent') this.refresh(); };
        window.addEventListener('focus', this._onFocus);
    },
    beforeUnmount() { window.removeEventListener('focus', this._onFocus); },
    methods: {
        async refresh() {
            if (!this.calendarId) return;
            const [st, me, billing] = await Promise.all([
                proApi('GET', `/api/pro/status?calendar=${encodeURIComponent(this.calendarId)}`),
                proApi('GET', '/api/me'),
                ProBilling.load(),
            ]);
            this.billing = billing;
            // Billing off: no trial or checkout to continue to. The panel shows the Pro beta list instead.
            if (!billing) { this.wantTrial = false; this.autoGo = false; }
            if (st.status === 200) this.status = st.data;
            if (this.status && this.status.lapsedMode) this.lapsedMode = this.status.lapsedMode;
            this.me = me.status === 200 ? me.data : null;
            this.trackTrialOutcome();
            // "Try Pro free": back from its sign-in link (verify already started it; this explains a refusal),
            // or from the Go Pro card (signed out: straight to the email box).
            // Back from the trial sign-in link, and verify started it: that is the trial starting.
            if (this.wantTrial && this.mode === 'owner' && this.status.trial) {
                this.wantTrial = false; ProIntent.clear();
                proTrack((a) => a.trialStarted(this.trialSurface));
                TrialUsage.flag(this.calendarId, 'trialing', true);
                return;
            }
            if (this.wantTrial && this.mode === 'offer') {
                const go = this.autoGo; this.wantTrial = false; this.autoGo = false;
                if (go && this.me) { await this.startTrial(); return; }
                if (!this.me && !this.trialUsed) { this.trialStep = 'email'; this.$nextTick(() => { this.$refs.trialEmail && this.$refs.trialEmail.focus(); }); }
                return;
            }
            this.wantTrial = false;
            // Back from the sign-in link they asked for when they pressed Lock: no second press.
            if (this.autoGo && this.me && this.mode === 'offer') {
                this.autoGo = false; this.busy = true; this.going = true;
                try { await this.checkout(); } finally { this.busy = false; this.going = false; }
            }
            this.autoGo = false;
            if (this.trialStep === 'sent' && (this.me || this.mode === 'owner')) this.trialStep = 'idle';
            if (this.step === 'sent' && (this.me || this.mode === 'owner')) this.step = 'idle';
        },
        focusEmail() { this.$nextTick(() => { this.$refs.email && this.$refs.email.focus(); }); },
        // The owner's own copy of the last link they made here, so it can be copied again later.
        storedLink() {
            try { return localStorage.getItem('pastecal_editor_link:' + String(this.calendarId).toLowerCase()) || ''; } catch (e) { return ''; }
        },
        rememberLink(link) {
            try { localStorage.setItem('pastecal_editor_link:' + String(this.calendarId).toLowerCase(), link); } catch (e) { /* storage blocked: shown for now */ }
        },
        async lockNow() {
            this.error = ''; this.busy = true;
            try {
                const me = await proApi('GET', '/api/me');
                if (me.status !== 200 && me.status !== 401) { this.error = me.status === 0 ? 'We couldn’t reach pastecal. Check your connection and try again.' : 'Something went wrong. Try again in a minute.'; return; }
                // Signed out: pay first. Stripe asks for the email, and "Pro is on" signs them in.
                this.me = me.status === 200 ? me.data : null;
                await this.checkout();
            } finally { this.busy = false; }
        },
        async checkout() {
            proTrack((a) => a.proCheckoutStarted(this.interval));
            const r = await proApi('POST', '/api/pro/checkout', { calendarId: this.calendarId, interval: this.interval, title: this.calendarTitle || '', author: proAuthor() });
            if (r.status === 200 && r.data.url) { ProIntent.clear(); location.href = r.data.url; return; }
            const reason = r.status === 0 ? 'network' : (r.data.error || String(r.status));
            proTrack((a) => a.proCheckoutFailed(reason));
            if (r.status === 401) { this.me = null; this.step = 'email'; this.focusEmail(); return; }
            if (r.status === 403 && r.data.error === 'not-an-editor') { this.error = r.data.message; return; }
            if (r.status === 503) { this.error = 'Upgrades aren’t available yet. Nothing was charged.'; return; }
            if (r.status === 409 && r.data.error === 'already-pro') { this.error = 'This calendar is already upgraded.'; this.refresh(); return; }
            if (r.status === 409) { this.error = 'Someone else has already locked this calendar.'; this.refresh(); return; }
            if (r.status === 0) { this.error = 'We couldn’t reach pastecal. Check your connection and try again.'; return; }
            this.error = 'Something went wrong. Nothing was charged. Try again in a minute.';
        },
        // ---- the 30-day trial and after Pro ----
        async startTrial() {
            this.error = '';
            if (!this.me) { this.trialStep = 'email'; this.$nextTick(() => { this.$refs.trialEmail && this.$refs.trialEmail.focus(); }); return; }
            this.busy = true;
            try {
                const r = await proApi('POST', '/api/pro/trial', { calendarId: this.calendarId, author: proAuthor() });
                if (r.status === 200 && r.data.ok) {
                    ProIntent.clear();
                    if (!r.data.already) { proTrack((a) => a.trialStarted(this.trialSurface || this.surface)); TrialUsage.flag(this.calendarId, 'trialing', true); }
                    await this.refresh(); return;
                }
                if (r.status === 401) { this.me = null; this.trialStep = 'email'; return; }
                const e = r.data.error;
                if (e === 'trial-used-calendar' || e === 'trial-used-account') { this.error = r.data.message; this.refresh(); return; }
                if (e === 'locked-by-other') { this.error = 'Someone else has already locked this calendar.'; this.refresh(); return; }
                if (e === 'already-pro') { this.refresh(); return; }
                if (e === 'buy-on-live' || e === 'not-an-editor') { this.error = r.data.message; return; }
                if (r.status === 404) { this.error = 'Save this calendar first. Then you can try Plus on it.'; return; }
                if (r.status === 503) { this.error = 'Upgrades aren’t available yet.'; return; }
                this.error = r.status === 0 ? 'We couldn’t reach pastecal. Check your connection and try again.' : 'Something went wrong. Try again in a minute.';
            } finally { this.busy = false; }
        },
        async sendTrialLink() {
            this.error = '';
            if (!this.email) return;
            this.busy = true;
            try {
                const r = await proApi('POST', '/api/auth/start', { email: this.email, next: '/' + encodeURIComponent(this.calendarId) + '?pro=trial' });
                if (r.status === 200 && r.data.ok) { ProIntent.set(this.calendarId, 'trial', true, this.trialSurface || this.surface); this.trialStep = 'sent'; return; }
                this.error = r.status === 0 ? 'We couldn’t reach pastecal. Check your connection and try again.'
                    : (r.data.error && r.status < 500 ? r.data.error : 'Something went wrong. Try again in a minute.');
            } finally { this.busy = false; }
        },
        // Keep Pro, during the trial or after it ended: the ordinary checkout for this calendar, at the
        // plan here ($29/year). The paid subscription replaces the trial.
        keepPro() { this.keepOpen = true; },
        keepProAfter() { this.keepOpen = true; },
        async keepCheckout() {
            this.busy = true; this.going = true;
            try { await this.checkout(); } finally { this.busy = false; this.going = false; }
        },
        // Once per outcome, when the owner next sees it: a trial that became paid Pro, or one that ended.
        trackTrialOutcome() {
            const id = this.calendarId, st = this.status;
            if (!id || !st || !TrialUsage.flag(id, 'trialing')) return;
            if (st.isOwner && !st.trial) {
                const c = this.me && (this.me.calendars || []).find((x) => x.id === id);
                proTrack((a) => a.trialConverted(c && c.interval));
                TrialUsage.flag(id, 'trialing', false);
            } else if (st.lapsedOwner) {
                proTrack((a) => a.trialLapsed('readonly'));
                TrialUsage.flag(id, 'trialing', false);
            } else if (!st.locked && !st.paused && st.trialUsed) {
                proTrack((a) => a.trialLapsed('open'));          // the owner had chosen "open" ahead of time
                TrialUsage.flag(id, 'trialing', false);
            }
        },
        async openToEveryone() {
            if (!window.confirm('Open this calendar to everyone? Anyone with the edit link will be able to change it.')) return;
            this.error = ''; this.busy = true;
            try {
                const r = await proApi('POST', '/api/pro/lapsed-mode', { calendarId: this.calendarId, mode: 'open' });
                if (r.status === 200) { await this.refresh(); return; }
                if (r.status === 401 || r.status === 403) { this.error = 'Sign in as the owner to change this.'; this.refresh(); return; }
                this.error = r.status === 0 ? 'We couldn’t reach pastecal. Check your connection and try again.' : 'Something went wrong. Try again in a minute.';
            } finally { this.busy = false; }
        },
        async saveLapsedMode() {
            this.error = '';
            const r = await proApi('POST', '/api/pro/lapsed-mode', { calendarId: this.calendarId, mode: this.lapsedMode });
            if (r.status === 200 && this.status && this.status.trial) trialFeature(this.calendarId, 'settings');
            if (r.status !== 200) { this.error = r.status === 0 ? 'We couldn’t reach pastecal. Check your connection and try again.' : 'That didn’t save. Try again in a minute.'; this.refresh(); }
        },
        async sendLink() {
            this.error = '';
            if (!this.email) return;
            this.busy = true;
            try {
                // Buying: the link brings the choice along, so it finishes even in another browser.
                const next = '/' + encodeURIComponent(this.calendarId) + (this.mode === 'offer' ? `?pro=${this.interval}` : '');
                const r = await proApi('POST', '/api/auth/start', { email: this.email, next });
                if (r.status === 200 && r.data.ok) {
                    ProIntent.set(this.calendarId, this.interval, this.mode === 'offer');
                    this.step = 'sent';
                    proTrack((a) => a.proSignInSent(this.mode === 'locked' ? 'owner_signin' : 'share_panel'));
                    return;
                }
                this.error = r.status === 0 ? 'We couldn’t reach pastecal. Check your connection and try again.'
                    : (r.data.error && r.status < 500 ? r.data.error : 'Something went wrong. Try again in a minute.');
            } finally { this.busy = false; }
        },
        async makeKey() {
            // A key always exists once the calendar is locked (maybe made on another device), so always ask.
            if (!window.confirm('Make a new editor link? Any editor link you already shared stops working right away.')) return;
            const kind = this.editorLink ? 'reset' : 'create';
            this.error = ''; this.busy = true; this.copied = false;
            try {
                const r = await proApi('POST', '/api/pro/editor-key', { calendarId: this.calendarId });
                if (r.status === 200 && r.data.editorKey) {
                    this.editorLink = `${location.origin}/${encodeURIComponent(this.calendarId)}#k=${r.data.editorKey}`;
                    this.rememberLink(this.editorLink);
                    proTrack((a) => a.proEditorLinkMade(kind));
                    if (this.status && this.status.trial) trialFeature(this.calendarId, 'editor_link');
                    return;
                }
                if (r.status === 401 || r.status === 403) { this.error = 'Sign in as the owner to make an editor link.'; this.refresh(); return; }
                this.error = r.status === 0 ? 'We couldn’t reach pastecal. Check your connection and try again.' : 'Something went wrong. Try again in a minute.';
            } finally { this.busy = false; }
        },
        copyLink() {
            const done = () => { this.copied = true; setTimeout(() => { this.copied = false; }, 2000); };
            try {
                navigator.clipboard.writeText(this.editorLink).then(done, () => this.selectLink());
            } catch (e) { this.selectLink(); }
        },
        selectLink() {
            const el = this.$refs.link;
            if (el) { el.focus(); el.select(); }
            this.error = 'Press Ctrl+C (or ⌘C) to copy the link.';
        },
        async portal(flow) {
            this.error = ''; this.busy = true;
            try {
                const r = await proApi('POST', '/api/pro/portal', { calendarId: this.calendarId, ...(flow === 'add-card' ? { flow } : {}) });
                if (r.status === 200 && r.data.url) { proTrack((a) => a.proPortalOpened()); location.href = r.data.url; return; }
                if (r.status === 503) this.error = 'Billing isn’t available right now. Try again later.';
                else if (r.status === 404) this.error = 'We couldn’t find a billing account for this email.';
                else if (r.status === 401) { this.error = 'Sign in again to manage billing.'; this.refresh(); }
                else this.error = r.status === 0 ? 'We couldn’t reach pastecal. Check your connection and try again.' : 'Something went wrong. Try again in a minute.';
            } finally { this.busy = false; }
        },
        async signOut() {
            await proApi('POST', '/api/auth/signout', {});
            this.me = null; this.step = 'idle'; this.editorLink = '';
            if (typeof AccountMenu !== 'undefined') AccountMenu.reset();   // the logo menu fetches again
            this.refresh();
        },
    },
};
