// Pro: the lock badge next to a locked calendar's title, and the share dialog's
// "Lock this calendar" / owner section.
//
// Talks only to this site's own JSON API (cookie session, see cloudflare/src/Accounts.js):
//   GET  /api/pro/status?calendar=<id> -> {locked, pro, isOwner}
//   GET  /api/me                       -> {email, calendars:[...]} | 401
//   POST /api/auth/start {email, next} -> {ok}   (a sign-in link by email)
//   POST /api/pro/checkout {calendarId, interval} -> {url}   503 / 409 handled
//   POST /api/pro/editor-key {calendarId} -> {editorKey}     ROTATES the key
//   POST /api/pro/portal {calendarId}  -> {url}
//   POST /api/auth/signout
// Analytics get the step and the reason only: never the email, the calendar name or a key.

const PRO_LOCK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';

const PRO_MESSAGES = {
    lockedVisitor: 'Only the owner and invited editors can change this calendar.',
    lockedEditor: 'Locked · you can edit',
    keyReset: 'This editor link was reset by the owner. Ask them for the new one.',
};

// Set when someone asks for a sign-in link from the share dialog, so the calendar reopens
// the dialog when the link brings them back. Holds the calendar id and a time, nothing personal.
const PRO_INTENT_KEY = 'pastecal_pro_intent';
const ProIntent = {
    set(id, interval) { try { localStorage.setItem(PRO_INTENT_KEY, JSON.stringify({ id, interval, t: Date.now() })); } catch (e) { /* storage blocked */ } },
    get(id) {
        try {
            const v = JSON.parse(localStorage.getItem(PRO_INTENT_KEY) || 'null');
            return v && v.id === id && Date.now() - v.t < 2 * 3600 * 1000 ? v : null;
        } catch (e) { return null; }
    },
    clear() { try { localStorage.removeItem(PRO_INTENT_KEY); } catch (e) { /* storage blocked */ } },
};

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

const LockBadge = {
    template: /* html */ `
        <span class="pc-lock" :class="{ 'pc-lock--open': open }" data-testid="lock-badge"
            @pointerenter="$event.pointerType === 'mouse' && (open = true)" @pointerleave="$event.pointerType === 'mouse' && (open = false)">
            <button type="button" class="pc-lock-btn" :aria-label="label" :aria-expanded="open ? 'true' : 'false'"
                @click.stop="open = !open" @keydown.esc="open = false" @blur="open = false" v-html="svg"></button>
            <span v-if="open" class="pc-lock-pop" role="tooltip" data-testid="lock-tip">{{ label }}</span>
        </span>
    `,
    props: { canEdit: Boolean },
    data() { return { open: false, svg: PRO_LOCK_SVG }; },
    computed: {
        label() { return this.canEdit ? PRO_MESSAGES.lockedEditor : PRO_MESSAGES.lockedVisitor; },
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
                <span class="pc-pro-icon" v-html="svg"></span>
                <h4 v-if="mode === 'owner'">Locked with Pro</h4>
                <h4 v-else-if="mode === 'locked'">This calendar is locked</h4>
                <h4 v-else>Lock this calendar</h4>
            </div>

            <!-- Unlocked, editable: the offer -->
            <template v-if="mode === 'offer'">
                <p class="pc-pro-lead">Only you and people you invite can edit. Everyone else can still view.</p>
                <div class="pc-pro-plans" role="radiogroup" aria-label="Billing">
                    <label class="pc-pro-plan" :class="{ on: interval === 'year' }">
                        <input type="radio" value="year" v-model="interval" name="pc-pro-interval">
                        <span><b>$24/year</b> <em class="pc-pro-save">Save 33%</em></span>
                    </label>
                    <label class="pc-pro-plan" :class="{ on: interval === 'month' }">
                        <input type="radio" value="month" v-model="interval" name="pc-pro-interval">
                        <span><b>$2.99/month</b></span>
                    </label>
                </div>

                <form v-if="step === 'email'" class="pc-pro-email" @submit.prevent="sendLink" data-testid="pro-email-form">
                    <label for="pc-pro-email-input">Your email, so you can manage the lock later. No password.</label>
                    <div class="pc-pro-row">
                        <input id="pc-pro-email-input" ref="email" type="email" v-model.trim="email" required
                            autocomplete="email" placeholder="you@example.com">
                        <button type="submit" class="pc-pro-btn" :disabled="busy">{{ busy ? 'Sending…' : 'Send sign-in link' }}</button>
                    </div>
                </form>
                <p v-else-if="step === 'sent'" class="pc-pro-ok" data-testid="pro-sent">
                    Check your email for a sign-in link. It brings you back here to finish.
                </p>
                <div v-else class="pc-pro-row">
                    <button type="button" class="pc-pro-btn" @click="lockNow" :disabled="busy" data-testid="pro-lock-btn">
                        {{ busy ? 'One moment…' : 'Lock this calendar' }}
                    </button>
                    <span v-if="me" class="pc-pro-muted">Signed in as {{ me.email }} · <a href="#" @click.prevent="signOut">Sign out</a></span>
                </div>
            </template>

            <!-- Locked, and this browser is not signed in as the owner -->
            <template v-if="mode === 'locked'">
                <p class="pc-pro-lead">Only the owner and people with an editor link can change it. Everyone else can view.</p>
                <form v-if="step === 'email'" class="pc-pro-email" @submit.prevent="sendLink">
                    <label for="pc-pro-email-input2">Are you the owner? Sign in with the email you paid with.</label>
                    <div class="pc-pro-row">
                        <input id="pc-pro-email-input2" ref="email" type="email" v-model.trim="email" required autocomplete="email" placeholder="you@example.com">
                        <button type="submit" class="pc-pro-btn" :disabled="busy">{{ busy ? 'Sending…' : 'Send sign-in link' }}</button>
                    </div>
                </form>
                <p v-else-if="step === 'sent'" class="pc-pro-ok">Check your email for a sign-in link.</p>
                <p v-else-if="me" class="pc-pro-muted">Signed in as {{ me.email }}, which doesn't own this calendar · <a href="#" @click.prevent="signOut">Sign out</a></p>
                <a v-else href="#" class="pc-pro-link" @click.prevent="step = 'email'; focusEmail()">Owner? Sign in to manage it</a>
            </template>

            <!-- The owner -->
            <template v-if="mode === 'owner'">
                <p class="pc-pro-lead">Only you and people with your editor link can change it. Everyone else can view.
                    <span v-if="renewal" data-testid="pro-renewal">{{ renewal }}</span></p>

                <div class="pc-pro-sub">
                    <h5>Editor link</h5>
                    <p class="pc-pro-muted">Share it with people who should be able to edit.</p>
                    <div v-if="editorLink" class="pc-pro-row">
                        <input ref="link" class="pc-pro-field" type="text" readonly :value="editorLink" @focus="$event.target.select()"
                            aria-label="Editor link" data-testid="pro-editor-link">
                        <button type="button" class="pc-pro-btn" @click="copyLink">{{ copied ? 'Copied' : 'Copy' }}</button>
                    </div>
                    <div class="pc-pro-row">
                        <button type="button" class="pc-pro-btn" :class="{ 'pc-pro-btn--quiet': editorLink }" @click="makeKey" :disabled="busy" data-testid="pro-key-btn">
                            {{ editorLink ? 'Reset editor link' : 'Create editor link' }}
                        </button>
                    </div>
                    <p class="pc-pro-warn">Making a new link turns off the old one. Anyone still using it will see a read-only calendar.</p>
                </div>

                <div class="pc-pro-row pc-pro-foot">
                    <button type="button" class="pc-pro-btn pc-pro-btn--quiet" @click="portal" :disabled="busy">Manage billing</button>
                    <a href="#" class="pc-pro-link" @click.prevent="signOut">Sign out</a>
                    <span v-if="me" class="pc-pro-muted">{{ me.email }}</span>
                </div>
            </template>

            <p v-if="error" class="pc-pro-err" role="alert" data-testid="pro-error">{{ error }}</p>
        </section>
    `,
    props: {
        calendarId: String,
        locked: Boolean,      // from the live snapshot
        canEdit: Boolean,     // this tab may change the calendar
    },
    data() {
        return {
            svg: PRO_LOCK_SVG,
            status: null,         // /api/pro/status
            me: null,             // /api/me, or null when signed out
            interval: 'year',
            step: 'idle',         // idle | email | sent
            email: '',
            busy: false,
            error: '',
            editorLink: '',
            copied: false,
        };
    },
    computed: {
        mode() {
            if (this.status && this.status.isOwner) return 'owner';
            if (this.locked || (this.status && this.status.locked)) return 'locked';
            if (!this.canEdit) return 'hidden';
            return 'offer';
        },
        renewal() {
            const c = this.me && (this.me.calendars || []).find((x) => x.id === this.calendarId);
            if (!c || !c.currentPeriodEnd) return '';
            const ms = c.currentPeriodEnd < 1e12 ? c.currentPeriodEnd * 1000 : c.currentPeriodEnd;
            const d = new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
            return c.status === 'active' || c.status === 'trialing' ? `Renews ${d}.` : `Pro ends ${d}.`;
        },
    },
    watch: {
        locked() { this.refresh(); },
        mode: {
            handler(m, old) {
                if (m === old) return;
                if (m === 'offer') proTrack((a) => a.proLockShown('share_panel'));
                if (m === 'owner') this.editorLink = this.storedLink();
            },
            immediate: true,
        },
    },
    mounted() {
        const intent = ProIntent.get(this.calendarId);
        if (intent && intent.interval) this.interval = intent.interval;
        this.refresh();
    },
    methods: {
        async refresh() {
            if (!this.calendarId) return;
            const [st, me] = await Promise.all([
                proApi('GET', `/api/pro/status?calendar=${encodeURIComponent(this.calendarId)}`),
                proApi('GET', '/api/me'),
            ]);
            if (st.status === 200) this.status = st.data;
            this.me = me.status === 200 ? me.data : null;
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
                if (me.status === 401) { this.me = null; this.step = 'email'; this.focusEmail(); proTrack((a) => a.proSignInShown('share_panel')); return; }
                if (me.status !== 200) { this.error = me.status === 0 ? 'We couldn’t reach pastecal. Check your connection and try again.' : 'Something went wrong. Try again in a minute.'; return; }
                this.me = me.data;
                await this.checkout();
            } finally { this.busy = false; }
        },
        async checkout() {
            proTrack((a) => a.proCheckoutStarted(this.interval));
            const r = await proApi('POST', '/api/pro/checkout', { calendarId: this.calendarId, interval: this.interval });
            if (r.status === 200 && r.data.url) { ProIntent.clear(); location.href = r.data.url; return; }
            const reason = r.status === 0 ? 'network' : (r.data.error || String(r.status));
            proTrack((a) => a.proCheckoutFailed(reason));
            if (r.status === 401) { this.me = null; this.step = 'email'; this.focusEmail(); return; }
            if (r.status === 503) { this.error = 'Pro isn’t available yet. Nothing was charged.'; return; }
            if (r.status === 409 && r.data.error === 'already-pro') { this.error = 'This calendar already has Pro.'; this.refresh(); return; }
            if (r.status === 409) { this.error = 'Someone else has already locked this calendar.'; this.refresh(); return; }
            if (r.status === 0) { this.error = 'We couldn’t reach pastecal. Check your connection and try again.'; return; }
            this.error = 'Something went wrong. Nothing was charged. Try again in a minute.';
        },
        async sendLink() {
            this.error = '';
            if (!this.email) return;
            this.busy = true;
            try {
                const next = '/' + encodeURIComponent(this.calendarId);
                const r = await proApi('POST', '/api/auth/start', { email: this.email, next });
                if (r.status === 200 && r.data.ok) {
                    ProIntent.set(this.calendarId, this.interval);
                    this.step = 'sent';
                    proTrack((a) => a.proSignInSent(this.mode === 'locked' ? 'owner_signin' : 'share_panel'));
                    return;
                }
                this.error = r.status === 0 ? 'We couldn’t reach pastecal. Check your connection and try again.'
                    : (r.data.error && r.status < 500 ? r.data.error : 'Something went wrong. Try again in a minute.');
            } finally { this.busy = false; }
        },
        async makeKey() {
            if (this.editorLink && !window.confirm('Reset the editor link? The current link stops working right away.')) return;
            const kind = this.editorLink ? 'reset' : 'create';
            this.error = ''; this.busy = true; this.copied = false;
            try {
                const r = await proApi('POST', '/api/pro/editor-key', { calendarId: this.calendarId });
                if (r.status === 200 && r.data.editorKey) {
                    this.editorLink = `https://pastecal.com/${encodeURIComponent(this.calendarId)}#k=${r.data.editorKey}`;
                    this.rememberLink(this.editorLink);
                    proTrack((a) => a.proEditorLinkMade(kind));
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
        async portal() {
            this.error = ''; this.busy = true;
            try {
                const r = await proApi('POST', '/api/pro/portal', { calendarId: this.calendarId });
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
            this.refresh();
        },
    },
};
