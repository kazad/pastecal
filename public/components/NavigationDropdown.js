// NavigationDropdown component
// "New calendar" (on the homepage draft: "Start over"), then your calendars and recently visited ones, with pin/remove controls,
// then the Pro account section at the bottom.
//
// Only Pro owners have accounts, so there is no sign-in button anywhere else: free users never
// need one. Signed in, the section lists the owner's Pro calendars with billing and sign-out;
// signed out, it is one quiet "Upgraded a calendar? Sign in" line. Talks to this site's JSON API (cookie
// session, cloudflare/src/Accounts.js): GET /api/me, POST /api/auth/start, /api/auth/signout,
// /api/pro/portal. Analytics get the state only: never the email or a calendar name.
// Each Pro calendar row has a "Stats" button beside it (open-stats, handled by app.js).

// Shared by both header instances and kept across opens: the menu is v-if'd, so it is destroyed
// on every close, and a "Check your email" must not vanish when the mouse drifts off it.
const ACCOUNT_ACTIVE = ['active', 'trialing', 'past_due'];
const AccountMenu = {
    state: (typeof Vue !== 'undefined' && Vue.reactive ? Vue.reactive : (x) => x)({
        status: 'idle',   // idle | loading | in | out
        me: null,         // /api/me while signed in
        step: 'idle',     // signed out: idle | email | sent
        email: '',
        busy: false,
        error: '',        // a short message for the section, never blocking the menu
        shown: false,     // accountMenuShown fires once per page
        retry: false,     // /api/me failed (not a 401): fetch again on the next open
        confirmDelete: false, // "Delete account" pressed: asking to confirm
    }),
    async api(method, path, body) {
        const init = { method, credentials: 'same-origin', headers: {} };
        if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
        let res;
        try { res = await fetch(path, init); } catch (e) { return { status: 0, data: {} }; }
        const data = await res.json().catch(() => ({}));
        return { status: res.status, data };
    },
    track(fn) {
        try {
            if (typeof track === 'function') track(fn);
            else if (typeof Analytics !== 'undefined' && Analytics) fn(Analytics);
        } catch (e) { /* observational only */ }
    },
    // GET /api/me once per page (the first time the menu opens); load(true) after a sign-out.
    async load(force) {
        const st = this.state;
        if (!force && st.status !== 'idle' && !(st.retry && st.status === 'out' && st.step === 'idle')) return;
        st.status = 'loading'; st.error = ''; st.retry = false;
        const r = await this.api('GET', '/api/me');
        if (r.status === 200) { st.me = r.data; st.status = 'in'; this.hint(true); }
        else if (r.status === 401) { st.me = null; st.status = 'out'; this.hint(false); }
        // Anything else (offline, a server error): most people opening this menu have no account,
        // so don't tell them one failed to load. Show the quiet line and try again next open.
        else { st.me = null; st.status = 'out'; st.retry = true; }
        if (!st.shown && !st.retry) {
            st.shown = true;
            const state = st.status === 'in' ? 'signed_in' : 'signed_out';
            this.track(a => a.accountMenuShown(state));
        }
    },
    // The site pages' header shows "Account" while this hint cookie is set (the session itself is HttpOnly).
    hint(on) {
        try { document.cookie = on ? 'pc_in=1; Path=/; Max-Age=34560000; SameSite=Lax' : 'pc_in=; Path=/; Max-Age=0; SameSite=Lax'; } catch (e) { /* no hint */ }
    },
    // Someone signed in or out elsewhere on the page (the share dialog): fetch again next open.
    reset() {
        Object.assign(this.state, { status: 'idle', me: null, step: 'idle', busy: false, error: '', retry: false, confirmDelete: false });
    },
};
if (typeof window !== 'undefined') window.AccountMenu = AccountMenu;

const NAV_NETWORK_ERROR = 'We couldn’t reach pastecal. Check your connection and try again.';

const NavigationDropdown = {
    template: /* html */ `
        <div class="pc-nav absolute top-full left-0 mt-2 bg-1 shadow-xl border border-color-default overflow-hidden z-50">
            <!-- Starts a fresh draft on the homepage. On the homepage draft itself, "Start over" (below) takes its place. -->
            <a v-if="!onDraft" href="/" @click.prevent="$emit('go-homepage')" data-testid="nav-new"
                class="pc-nav-row pc-nav-new flex items-center text-color-2 hover:bg-theme-hover transition-colors cursor-pointer group">
                <span class="pc-nav-plus">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" width="16" height="16"><path d="M12 5v14M5 12h14"/></svg>
                </span>
                <span class="min-w-0">
                    <span class="block font-semibold transition-colors">New calendar</span>
                    <span class="block text-xs text-color-1">No sign-up. Share it when it's ready.</span>
                </span>
            </a>
            <!-- On the draft itself: wipe it back to a fresh blank draft (events, title, notes, colors).
                 One Cmd+Z, or the toast's Undo, brings it all back (app.js startOver). -->
            <button v-else type="button" @click="$emit('start-over')" data-testid="nav-start-over"
                class="pc-nav-row pc-nav-new flex items-center w-full text-left text-color-2 hover:bg-theme-hover transition-colors cursor-pointer group">
                <span class="pc-nav-plus" aria-hidden="true">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>
                </span>
                <span class="min-w-0">
                    <span class="block font-semibold transition-colors">Start over</span>
                    <span class="block text-xs text-color-1">Clear this draft and begin again. Undo brings it back.</span>
                </span>
            </button>
            <!-- Help lives here, not as a header icon: the header keeps the calendar's own actions -->
            <a href="/help" target="_blank" rel="noopener" data-testid="nav-help"
                class="pc-nav-row flex items-center w-full text-left text-color-2 hover:bg-theme-hover transition-colors cursor-pointer group">
                <span class="pc-nav-plus" aria-hidden="true">?</span>
                <span class="min-w-0">
                    <span class="block font-semibold transition-colors">Help</span>
                    <span class="block text-xs text-color-1">Sharing, privacy, undo, shortcuts</span>
                </span>
            </a>

            <!-- Calendars grouped by ownership: yours first, then ones you visited -->
            <div v-if="recentCalendars.length > 0" class="pc-nav-list">
                <template v-for="group in groups" :key="group.label">
                <div v-if="group.items.length > 0">
                <div class="pc-nav-label text-xs font-semibold text-color-1 border-t border-color-default">
                    {{ group.label }}
                </div>
                <div>
                    <div v-for="item in group.items" :key="item.id"
                        class="pc-nav-row flex justify-between items-center hover:bg-theme-hover transition-colors group">
                        <a :href="item.path" class="flex-1 min-w-0 mr-3">
                            <div class="pc-nav-title text-color-2 font-medium transition-colors">
                                <span class="truncate">{{ item.title }}</span>
                                <span v-if="item.pro" class="pc-pill pc-pill--pro pc-nav-pro" data-testid="nav-pro-pill">{{ item.planName }}</span>
                            </div>
                            <div class="text-xs text-color-1 truncate">
                                {{ item.address }}<template v-if="item.view"> · view only</template>
                            </div>
                        </a>
                        <div class="flex items-center gap-1 transition-opacity"
                            :class="{ 'opacity-100': item.pinned, 'opacity-0 group-hover:opacity-100': !item.pinned }">
                            <button @click.stop="$emit('toggle-pin', item.id)"
                                class="pc-btn pc-btn--ghost pc-btn--icon pc-btn--sm"
                                :class="{ 'text-color-2': item.pinned }"
                                :title="item.pinned ? 'Unpin calendar' : 'Pin calendar'">
                                <!-- Filled star when pinned -->
                                <svg v-if="item.pinned" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="w-5 h-5">
                                    <path fill-rule="evenodd" d="M10.788 3.21c.448-1.077 1.976-1.077 2.424 0l2.082 5.006 5.404.434c1.164.093 1.636 1.545.749 2.305l-4.117 3.527 1.257 5.273c.271 1.136-.964 2.033-1.96 1.425L12 18.354 7.373 21.18c-.996.608-2.231-.29-1.96-1.425l1.257-5.273-4.117-3.527c-.887-.76-.415-2.212.749-2.305l5.404-.434 2.082-5.005Z" clip-rule="evenodd" />
                                </svg>
                                <!-- Outline star when not pinned -->
                                <svg v-else xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5">
                                    <path stroke-linecap="round" stroke-linejoin="round" d="M11.48 3.499a.562.562 0 0 1 1.04 0l2.125 5.111a.563.563 0 0 0 .475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 0 0-.182.557l1.285 5.385a.562.562 0 0 1-.84.61l-4.725-2.885a.562.562 0 0 0-.586 0L6.982 20.54a.562.562 0 0 1-.84-.61l1.285-5.386a.562.562 0 0 0-.182-.557l-4.204-3.602a.562.562 0 0 1 .321-.988l5.518-.442a.563.563 0 0 0 .475-.345L11.48 3.5Z" />
                                </svg>
                            </button>
                            <!-- Calendars you made stay; only ones you opened can be removed from the list. -->
                            <button v-if="!item.mine" @click.stop="$emit('remove-recent', item.id)"
                                class="pc-btn pc-btn--ghost pc-btn--icon pc-btn--sm"
                                title="Remove from recent">
                                <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" fill="none"
                                    viewBox="0 0 24 24" stroke="currentColor">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                                        d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </button>
                        </div>
                    </div>
                </div>
                </div>
                </template>
            </div>

            <p v-if="recentCalendars.length === 0" class="pc-nav-empty border-t border-color-default text-sm text-color-1">
                Calendars you open or save show up here, so you can find them again.
            </p>

            <!-- Pro account: only owners have one, so signed out it is a single quiet line -->
            <!-- click.stop like the pin buttons: both headers' v-click-outside would close the menu -->
            <div class="pc-acct border-t border-color-default" data-testid="account-section" @click.stop>
                <p v-if="acct.status === 'idle' || acct.status === 'loading'" class="pc-acct-muted pc-acct-line" aria-live="polite">Loading…</p>

                <template v-else-if="acct.status === 'in'">
                    <div class="pc-acct-head">
                        <span class="pc-acct-label" data-testid="account-plan">{{ planLabel }}</span>
                        <span class="pc-acct-muted pc-acct-email" data-testid="account-email" data-hj-suppress data-clarity-mask="true">{{ acct.me.email }}</span>
                    </div>
                    <div v-for="c in proCalendars" :key="c.id" class="pc-acct-cal-row">
                        <a :href="c.path" class="pc-acct-cal" data-testid="account-calendar">
                            <span class="pc-acct-cal-title">{{ c.title }}</span>
                            <span class="pc-acct-cal-status" :class="{ 'pc-acct-cal-status--warn': c.problem }">{{ c.label }}</span>
                        </a>
                        <!-- Beside the row, not inside it: the row is a link to the calendar -->
                        <button type="button" class="pc-btn pc-btn--xs pc-acct-stats" @click="$emit('open-stats', c.id)"
                            :aria-label="'Stats for ' + c.title" data-testid="account-stats">Stats</button>
                    </div>
                    <p v-if="proCalendars.length === 0" class="pc-acct-muted pc-acct-line">No upgraded calendars right now.</p>
                    <p v-if="acct.me.plan === 'unlimited'" class="pc-acct-muted pc-acct-line" data-testid="account-unlimited-hint">To upgrade another calendar, open it and choose its Plus tab.</p>
                    <a v-else href="/pricing#get-pro" data-from="account-menu" class="pc-link pc-acct-link pc-acct-line" data-testid="account-get-pro">{{ billing === false ? 'Join the beta' : proCalendars.length ? 'Upgrade another calendar' : 'Upgrade a calendar' }}</a>
                    <div class="pc-acct-actions">
                        <a href="/account" class="pc-btn pc-btn--sm" data-from="account-menu" data-testid="account-page-link">Account</a>
                        <button type="button" class="pc-btn pc-btn--sm" @click="portal" :disabled="acct.busy" data-testid="account-billing">Manage billing</button>
                        <button type="button" class="pc-link pc-acct-link" @click="signOut" :disabled="acct.busy" data-testid="account-signout">Sign out</button>
                    </div>
                    <!-- Asked in place, not with confirm(): a browser dialog would also close the menu -->
                    <div v-if="acct.confirmDelete" class="pc-acct-delete" data-testid="account-delete-confirm">
                        <p class="pc-acct-line">Delete your account? This signs you out on every device and erases your email. Your calendars stay at their links, but paused ones stay read-only for good, and @links and short links end after 90 days. <a href="/account" class="pc-acct-link">See what happens to each</a>.</p>
                        <div class="pc-acct-actions">
                            <button type="button" class="pc-btn pc-btn--sm pc-btn--danger" @click="deleteAccount" :disabled="acct.busy" data-testid="account-delete-yes">{{ acct.busy ? 'Deleting…' : 'Delete account' }}</button>
                            <button type="button" class="pc-link pc-acct-link" @click="acct.confirmDelete = false" :disabled="acct.busy" data-testid="account-delete-no">Cancel</button>
                        </div>
                    </div>
                    <button v-else type="button" class="pc-link pc-acct-link pc-acct-line pc-acct-delete-link" @click="acct.confirmDelete = true; acct.error = ''" :disabled="acct.busy" data-testid="account-delete">Delete account</button>
                </template>

                <template v-else-if="acct.status === 'out'">
                    <p v-if="acct.step === 'deleted'" class="pc-acct-ok pc-acct-line" data-testid="account-deleted">Your account is deleted.</p>
                    <p v-else-if="acct.step === 'sent'" class="pc-acct-ok pc-acct-line" data-testid="account-sent">Check your email for a sign-in link.</p>
                    <form v-else-if="acct.step === 'email'" class="pc-acct-form" @submit.prevent="sendLink" data-testid="account-email-form">
                        <label for="pc-acct-email" class="pc-acct-muted">Use the email you paid with. No password.</label>
                        <div class="pc-acct-row">
                            <input id="pc-acct-email" class="pc-field pc-field--sm" ref="email" type="email" v-model.trim="acct.email" required
                                autocomplete="email" placeholder="you@example.com" @keydown.esc.stop="acct.step = 'idle'">
                            <button type="submit" class="pc-btn pc-btn--sm pc-btn--primary" :disabled="acct.busy">{{ acct.busy ? 'Sending…' : 'Send link' }}</button>
                        </div>
                    </form>
                    <button v-else type="button" class="pc-link pc-acct-link pc-acct-line" @click="startSignIn" data-testid="account-signin">Have Plus or Pro? Sign in</button>
                </template>

                <p v-if="acct.error" class="pc-acct-err" role="alert" data-testid="account-error">{{ acct.error }}</p>
            </div>
        </div>
    `,
    props: ['recentCalendars', 'onDraft'],
    emits: ['go-homepage', 'start-over', 'toggle-pin', 'remove-recent', 'open-stats', 'open-help'],
    data() { return { acct: AccountMenu.state, billing: null }; },   // billing: /api/pro/config (Pro.js ProBilling)
    mounted() {
        AccountMenu.load();
        if (typeof ProBilling !== 'undefined') ProBilling.load().then((b) => { this.billing = b; });
    },     // never blocks opening: the section shows its own loading line
    computed: {
        // The plan, at the top of the section: "Pro · renews October 24, 2027", "Plus", or just the account.
        planLabel() {
            const me = this.acct.me || {};
            if (me.plan === 'unlimited') {
                const u = me.unlimited || {}, end = u.currentPeriodEnd ? (u.currentPeriodEnd < 1e12 ? u.currentPeriodEnd * 1000 : u.currentPeriodEnd) : 0;
                const date = end ? new Date(end).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }) : '';
                const P = planName('unlimited');
                return u.status === 'past_due' ? `${P} · payment problem` : date ? `${P} · renews ${date}` : P;
            }
            return me.plan ? planName(me.plan) : 'Your account';
        },
        // Calendars this account pays for, lowercased id -> /api/me row.
        proById() {
            const map = new Map();
            const cals = (this.acct.status === 'in' && this.acct.me && this.acct.me.calendars) || [];
            for (const c of cals) if (c && c.id) map.set(String(c.id).toLowerCase(), c);
            return map;
        },
        proCalendars() {
            const titles = new Map((this.recentCalendars || []).filter(r => !r.view && !/ \(View Only\)$/.test(r.title || ''))
                .map(r => [String(r.id).toLowerCase(), RecentCalendars.display(r).title]));
            const now = Date.now();
            const out = [];
            for (const c of this.proById.values()) {
                const end = c.currentPeriodEnd ? (c.currentPeriodEnd < 1e12 ? c.currentPeriodEnd * 1000 : c.currentPeriodEnd) : 0;
                const date = end ? new Date(end).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }) : '';
                const name = planName(c.plan);
                let label;
                if (c.status === 'past_due') label = 'Payment problem';
                else if (c.status === 'active' || c.status === 'trialing') label = date ? `${c.status === 'trialing' ? name + ' trial · ends' : c.cancelAtPeriodEnd ? name + ' · ends' : name + ' · renews'} ${date}` : name;
                else if (end > now) label = `${name} · ends ${date}`;
                else continue;     // ended: no longer upgraded
                out.push({ id: c.id, title: titles.get(String(c.id).toLowerCase()) || c.id,
                    path: '/' + encodeURIComponent(c.id), label, problem: c.status === 'past_due' });
            }
            return out;
        },
        // Calendars you created are listed separately from ones you merely visited:
        // in a no-login product this list is the only route back to your own work.
        groups() {
            const all = (this.recentCalendars || []).map(item => {
                const shown = { ...item, ...RecentCalendars.display(item) };
                const sub = !shown.view && this.proById.get(String(item.id).toLowerCase());
                return { ...shown, pro: !!(sub && ACCOUNT_ACTIVE.includes(sub.status)), planName: planName(sub && sub.plan) };
            });
            return [
                { label: 'Your calendars', items: all.filter(item => item.mine) },
                { label: 'Recently visited', items: all.filter(item => !item.mine) },
            ];
        }
    },
    methods: {
        startSignIn() {
            this.acct.step = 'email'; this.acct.error = '';
            this.$nextTick(() => { this.$refs.email && this.$refs.email.focus(); });
        },
        async sendLink() {
            const st = this.acct;
            st.error = '';
            if (!st.email) return;
            st.busy = true;
            try {
                // Back to this page after signing in. A path only: the server refuses anything else.
                const r = await AccountMenu.api('POST', '/api/auth/start', { email: st.email, next: location.pathname });
                if (r.status === 200 && r.data.ok) {
                    st.step = 'sent';
                    AccountMenu.track(a => a.accountSignInSent());
                    return;
                }
                st.error = r.status === 0 ? NAV_NETWORK_ERROR
                    : (r.data.error && r.status < 500 ? r.data.error : 'Something went wrong. Try again in a minute.');
            } finally { st.busy = false; }
        },
        async portal() {
            const st = this.acct;
            st.error = ''; st.busy = true;
            try {
                const first = this.proCalendars[0];
                const r = await AccountMenu.api('POST', '/api/pro/portal', first ? { calendarId: first.id } : {});
                if (r.status === 200 && r.data.url) { AccountMenu.track(a => a.accountPortalOpened()); location.href = r.data.url; return; }
                if (r.status === 503) st.error = 'Billing isn’t available right now. Try again later.';
                else if (r.status === 404) st.error = 'We couldn’t find a billing account for this email.';
                else if (r.status === 401) { st.error = ''; await AccountMenu.load(true); }
                else st.error = r.status === 0 ? NAV_NETWORK_ERROR : 'Something went wrong. Try again in a minute.';
            } finally { st.busy = false; }
        },
        async signOut() {
            const st = this.acct;
            st.error = ''; st.busy = true;
            try {
                const r = await AccountMenu.api('POST', '/api/auth/signout', {});
                if (r.status === 0) { st.error = NAV_NETWORK_ERROR; return; }
                AccountMenu.track(a => a.accountSignedOut());
                st.step = 'idle';
                await AccountMenu.load(true);
            } finally { st.busy = false; }
        },
        // POST /api/account/delete. Refused (409) while a subscription is still running, including one
        // canceled but paid up to the end of its period: Stripe could charge someone who can't sign in.
        async deleteAccount() {
            const st = this.acct;
            st.error = ''; st.busy = true;
            try {
                const r = await AccountMenu.api('POST', '/api/account/delete', {});
                if (r.status === 200) {
                    st.confirmDelete = false;
                    AccountMenu.track(a => a.accountSignedOut());
                    await AccountMenu.load(true);
                    st.step = 'deleted';
                    return;
                }
                st.confirmDelete = false;
                if (r.status === 409) st.error = 'You still have an active plan. Cancel it in Manage billing; you can delete your account once it has ended.';
                else if (r.status === 401) await AccountMenu.load(true);
                else st.error = r.status === 0 ? NAV_NETWORK_ERROR : 'Something went wrong. Try again in a minute.';
            } finally { st.busy = false; }
        },
    }
};
