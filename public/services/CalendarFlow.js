/*
 * CalendarFlow -- what kind of page this is, and how a calendar gets created, named and
 * shared. Shared by the Syncfusion app (public/app.js) and nativecal (public/nativecal/),
 * which used to carry two drifting copies of all of it.
 *
 * Why one derived page mode: every header control used to pick its own boolean. The
 * mobile claim bar tested !isExisting, the share button tested isExisting, and the
 * read-only /view/ path never set isExisting -- so a phone viewing someone's calendar
 * got a "Claim" bar (which created an editable copy of that calendar) and no share
 * button. Asking "which page am I on" once, here, and having every control read the
 * answer makes that class of bug unrepresentable:
 *
 *   'loading'  a calendar URL whose data has not answered yet (nothing to claim yet)
 *   'new'      an unsaved draft: the homepage, or a free name at /<slug>
 *   'editable' a saved calendar opened by its edit link
 *   'view'     a read-only /view/<slug> link -- never claimable, never editable
 *
 * The pure helpers are exported for node tests (test/unit/calendar-flow.test.js); the Vue
 * mixin needs a browser (SlugRules, CalendarDataService, SlugManager as globals).
 */
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    else root.CalendarFlow = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';

    const MODES = Object.freeze(['loading', 'new', 'editable', 'view']);

    function pageMode({ isReadOnly = false, isExisting = false, isLoading = false } = {}) {
        if (isReadOnly) return 'view';
        if (isExisting) return 'editable';
        if (isLoading) return 'loading';
        return 'new';
    }

    // ---- Sample event -------------------------------------------------------------------
    // A first-time draft gets one example event so the grid is not empty. It used to be
    // saved into the claimed calendar like any other event, so every new calendar --
    // and every subscriber's phone, through the ICS feed -- carried a "Sample event" nobody
    // made. It is now recognisable by its id, and dropped on create unless the person
    // made it theirs (renamed it): an edited sample is their event.
    const SAMPLE_TITLE = 'Sample event';
    const SAMPLE_ID_PREFIX = 'sample-';

    function markSample(event) {
        if (event && !String(event.id || '').startsWith(SAMPLE_ID_PREFIX)) {
            event.id = SAMPLE_ID_PREFIX + (event.id || Math.random().toString(36).slice(2));
        }
        return event;
    }

    function isUntouchedSample(event) {
        return !!event && String(event.id || '').startsWith(SAMPLE_ID_PREFIX)
            && (event.title || '') === SAMPLE_TITLE;
    }

    function withoutSamples(events) {
        return (Array.isArray(events) ? events : []).filter(e => !isUntouchedSample(e));
    }

    // ---- Names ----------------------------------------------------------------------------
    const DEFAULT_TITLE = 'New Calendar';

    /** "soccer-team_2026" -> "Soccer team 2026": a title for someone who only chose a link. */
    function titleFromSlug(slug) {
        const words = String(slug || '').split(/[-_]+/).filter(Boolean);
        if (!words.length) return '';
        const s = words.join(' ');
        return s.charAt(0).toUpperCase() + s.slice(1);
    }

    /** The title a claim should save: what they typed, else one made from a chosen name. */
    function titleForClaim({ typedTitle, currentTitle, slug, slugChosen }) {
        const typed = String(typedTitle || '').trim();
        if (typed) return typed.slice(0, 120);
        const current = String(currentTitle || '').trim();
        if (current && current !== DEFAULT_TITLE) return current;
        return slugChosen ? titleFromSlug(slug) || DEFAULT_TITLE : DEFAULT_TITLE;
    }

    // ---- Words shown to people ------------------------------------------------------------
    // Inline/toast copy, in one place, for both apps. These replaced native alert()s, which
    // block the page, cannot be styled or read by the app's own focus handling, and on a
    // phone read as the site crashing.
    const VIEW_PROBLEMS = {
        'not-shared': {
            title: 'This calendar is not shared for viewing',
            message: 'Ask whoever sent this link for its view-only link.',
        },
        'not-found': {
            title: 'Calendar not found',
            message: 'Check the link for typos. View-only links look like pastecal.com/view/name.',
        },
        failed: {
            title: 'Could not load this calendar',
            message: 'Check your connection and reload the page.',
        },
    };
    const viewProblem = (kind) => VIEW_PROBLEMS[kind] || VIEW_PROBLEMS.failed;

    const COPY_TOASTS = {
        view: 'View-only link copied',
        edit: 'Edit link copied. Anyone with it can change or delete events.',
        feed: 'Subscription link copied',
        current: 'Link to this view copied',
    };
    const copyToast = (kind) => COPY_TOASTS[kind] || 'Link copied';

    /** Why a create failed, in words a person can act on. */
    function claimErrorMessage(error, slug) {
        const code = String((error && (error.code || error.message)) || '').toLowerCase();
        if (code.includes('permission')) {
            return `pastecal.com/${slug} can't be used. Try another name.`;
        }
        if (code.includes('network') || code.includes('disconnect') || code.includes('unavailable')) {
            return 'Could not reach PasteCal. Check your connection and try again.';
        }
        return 'Could not create the calendar. Please try again.';
    }

    // ---- "Calendar created!" across the redirect -------------------------------------------
    // Creating navigates to the new URL, and a toast shown before that navigation died with
    // the page. The flag rides on the URL instead and is removed as soon as it is read, so
    // a reload or a copied link never repeats it.
    const CREATED_PARAM = 'created';
    function createdURL(path) { return `${path}?${CREATED_PARAM}=1`; }

    /** Where a calendar lives in THIS app: nativecal keeps its own base (/nativecal/<id>). */
    function calendarPath(slug, base) {
        const b = String(base || "/").replace(/\/+$/, "");
        return `${b}/${slug}`;
    }
    function takeCreatedFlag(loc, history) {
        try {
            const url = new URL(loc.href);
            if (url.searchParams.get(CREATED_PARAM) !== '1') return false;
            url.searchParams.delete(CREATED_PARAM);
            if (history && typeof history.replaceState === 'function') {
                history.replaceState(history.state, '', url.pathname + url.search + url.hash);
            }
            return true;
        } catch (e) {
            return false;
        }
    }

    // ---- Vue mixin --------------------------------------------------------------------------
    // Everything the header, claim dialog and load path need, for both apps. Expects the
    // host component to own: calendar, isReadOnly, isExisting, isLoading, recentManager,
    // recentCalendars, clearLocalStorage(), showToast(), and (Syncfusion) track().
    const safeTrack = (fn) => {
        try {
            const A = root && root.Analytics;
            if (A) fn(A);
        } catch (e) { /* observational only */ }
    };
    const Rules = () => root && root.SlugRules;

    const mixin = {
        data() {
            return {
                showClaimDialog: false,
                userHasEditedSlug: false,
                claimBusy: false,
                claimError: '',
                // A /view/ link that cannot be shown, as { title, message } (see viewProblem).
                viewLoadProblem: null,
                renameTarget: '',
                renameError: '',
                renameBusy: false,
                // Just arrived from creating this calendar: show "created, now share it".
                justCreated: false,
            };
        },

        computed: {
            pageMode() {
                return pageMode({ isReadOnly: this.isReadOnly, isExisting: this.isExisting,
                    isLoading: this.isLoading });
            },
            isViewMode() { return this.pageMode === 'view'; },
            isEditableMode() { return this.pageMode === 'editable'; },
            isNewMode() { return this.pageMode === 'new'; },
            /** SlugRules verdict on the name in the claim box. */
            slugCheck() {
                const R = Rules();
                return R ? R.check(this.calendar && this.calendar.id) : { ok: true, message: '' };
            },
            /** What to say under the claim box: the server's answer, else the rule's. */
            slugMessage() {
                if (this.claimError) return this.claimError;
                return this.userHasEditedSlug && !this.slugCheck.ok ? this.slugCheck.message : '';
            },
            /**
             * The header pill copies the view-only link whenever there is one, so it SHOWS
             * that link -- it used to display the edit URL while copying the view URL,
             * which taught people the wrong thing about what they had just sent.
             */
            headerLink() {
                const slug = this.calendar && this.calendar.options && this.calendar.options.publicViewId;
                if (slug) return { kind: 'view', prefix: 'pastecal.com/view/', name: slug };
                return { kind: 'edit', prefix: 'pastecal.com/', name: (this.calendar && this.calendar.id) || '' };
            },
        },

        methods: {
            /** Slugify as they type, so what the box shows is exactly what will be claimed. */
            onSlugInput(e) {
                const R = Rules();
                const raw = e && e.target ? e.target.value : String(e || '');
                const slug = R ? R.slugify(raw) : raw;
                this.calendar.id = slug;
                if (e && e.target && e.target.value !== slug) e.target.value = slug;
                this.userHasEditedSlug = true;
                this.claimError = '';
            },

            randomizeId() {
                this.calendar.id = Utils.randomID(8);
                this.userHasEditedSlug = false;
                this.claimError = '';
            },

            /**
             * The header's Claim button and Enter key. A name they typed is a decision, so it
             * is claimed directly; an untouched generated id gets the dialog, which offers a
             * name and a title first.
             */
            startClaim() {
                if (this.pageMode !== 'new' || this.claimBusy) return;
                const R = Rules();
                if (R) this.calendar.id = R.slugify(this.calendar.id, { final: true });
                if (!this.slugCheck.ok) {
                    this.userHasEditedSlug = true;   // show why
                    return;
                }
                if (!this.userHasEditedSlug) return this.openClaimDialog();
                return this.claim();
            },

            openClaimDialog() {
                if (this.pageMode !== 'new') return;
                this.claimError = '';
                this.showClaimDialog = true;
            },

            closeClaimDialog() {
                if (this.claimBusy) return;
                this.showClaimDialog = false;
            },

            /**
             * Create the calendar at calendar.id. Every failure ends in words next to the
             * field and the page usable again: a taken name, a name the rules refuse, a
             * network error. Success navigates to the new calendar, which shows "Calendar
             * created!" when it loads (see takeCreatedFlag).
             */
            claim({ title = '' } = {}) {
                if (this.pageMode !== 'new' || this.claimBusy) return;
                const R = Rules();
                const slug = R ? R.slugify(this.calendar.id, { final: true }) : String(this.calendar.id || '');
                this.calendar.id = slug;
                if (R && !R.check(slug).ok) {
                    this.userHasEditedSlug = true;
                    return;
                }

                // Whether the name was chosen or just accepted is the whole naming question:
                // a claim of an untouched generated id is not evidence anyone wanted it.
                const chosen = this.userHasEditedSlug;
                this.claimError = '';
                this.claimBusy = true;
                const failed = (message) => {
                    this.claimBusy = false;
                    this.isLoading = false;
                    this.claimError = message;
                };

                CalendarDataService.checkExists(slug, () => {
                    safeTrack(a => a.track('slug_claim_failed', { where: 'calendar_url', reason: 'taken' }));
                    failed(`pastecal.com/${slug} is taken. Try another name.`);
                }, () => {
                    this.calendar.title = titleForClaim({ typedTitle: title, currentTitle: this.calendar.title,
                        slug, slugChosen: chosen });
                    const toSave = { ...this.calendar, id: slug, events: withoutSamples(this.calendar.events) };
                    this.isLoading = true;
                    CalendarDataService.createWithId(slug, toSave, () => {
                        // Sent urgently by the module: the redirect below unloads this page.
                        safeTrack(a => a.calendarCreated(chosen, toSave));
                        // `where` matches SlugManager's tag on the view-link flow, so the two
                        // never get conflated in reporting.
                        safeTrack(a => chosen
                            ? a.track('slug_claimed', { where: 'calendar_url', slug_length: slug.length,
                                event_count_bucket: a.bucketEvents(toSave.events.length) }, { urgent: true })
                            : a.track('slug_autoassigned', { where: 'calendar_url',
                                event_count_bucket: a.bucketEvents(toSave.events.length) }, { urgent: true }));
                        // Recorded here rather than after the redirect, so a calendar you just
                        // made is always in the list -- flagged `mine`, never evicted. Written
                        // BEFORE the draft is cleared: if storage fails, the draft survives.
                        this.recentManager.add(slug, toSave.title, true);
                        this.recentCalendars = this.recentManager.getAll();
                        this.clearLocalStorage();
                        this.showClaimDialog = false;
                        window.location.href = createdURL(calendarPath(slug, window.CAL_BASE));
                    }, {
                        onError: (error) => {
                            safeTrack(a => a.track('slug_claim_failed', { where: 'calendar_url',
                                reason: (error && error.code) || 'write_failed' }));
                            failed(claimErrorMessage(error, slug));
                        },
                    });
                }, (error) => failed(claimErrorMessage(error, slug)));
            },

            /**
             * Confirm the create once, on the first load after it, with the next step
             * (share it) in the header notice. A toast before the redirect died with the page.
             */
            announceIfJustCreated() {
                if (takeCreatedFlag(window.location, window.history)) this.justCreated = true;
            },

            onRenameInput(e) {
                const R = Rules();
                const v = R ? R.slugify(e.target.value) : e.target.value;
                this.renameTarget = v;
                if (e.target.value !== v) e.target.value = v;
                this.renameError = '';
            },

            /** A /view/ link that cannot be shown: say so on the page, not in an alert(). */
            showViewProblem(kind) {
                this.viewLoadProblem = viewProblem(kind);
                this.isLoading = false;
            },

            /**
             * Copy this calendar to a new edit link and open it there. The old link keeps
             * the data as it was (a copy, never deleted); the view-only link FOLLOWS the
             * copy (PublicViewService.followRename), so subscribers are not stranded.
             */
            renameCalendar() {
                if (this.pageMode !== 'editable' || this.renameBusy) return;
                const R = Rules();
                const newId = R ? R.slugify(this.renameTarget, { final: true }) : String(this.renameTarget || '');
                this.renameTarget = newId;
                const verdict = R ? R.check(newId) : { ok: !!newId, message: 'Pick a name.' };
                if (!verdict.ok) { this.renameError = verdict.message; return; }
                if (newId === String(this.calendar.id).toLowerCase()) {
                    this.renameError = 'That is already this calendar\'s name.';
                    return;
                }
                this.renameError = '';
                this.renameBusy = true;
                const done = (message) => { this.renameBusy = false; this.renameError = message || ''; };
                CalendarDataService.checkExists(newId, () => done(`pastecal.com/${newId} is taken. Try another name.`), () => {
                    const oldId = this.calendar.id;
                    const copy = JSON.parse(JSON.stringify(this.calendar));
                    copy.id = newId;
                    copy.title = copy.title || DEFAULT_TITLE;
                    // Lets the server move the read-only view to the new id; without it the
                    // view stays bound to the old copy and its link and feed stop updating.
                    copy.options = { ...(copy.options || {}), renamedFrom: oldId };
                    CalendarDataService.createWithId(newId, copy, () => {
                        // The recents entry moves with it: both would list a stale copy
                        // alongside the live calendar with no way to tell them apart.
                        const previous = this.recentManager.getAll().find(item => item.id === oldId);
                        this.recentManager.remove(oldId);
                        this.recentManager.add(newId, copy.title, !!(previous && previous.mine));
                        if (previous && previous.pinned) this.recentManager.togglePin(newId);
                        this.recentCalendars = this.recentManager.getAll();
                        window.location.href = calendarPath(newId, window.CAL_BASE);
                    }, { asCreator: false, onError: (error) => done(claimErrorMessage(error, newId)) });
                }, (error) => done(claimErrorMessage(error, newId)));
            },
        },
    };

    return {
        MODES, pageMode,
        SAMPLE_TITLE, SAMPLE_ID_PREFIX, markSample, isUntouchedSample, withoutSamples,
        DEFAULT_TITLE, titleFromSlug, titleForClaim,
        viewProblem, copyToast, claimErrorMessage,
        CREATED_PARAM, createdURL, takeCreatedFlag, calendarPath,
        mixin,
    };
}));
