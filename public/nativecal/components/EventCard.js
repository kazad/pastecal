/**
 * EventCard -- the native calendar's event editor on the main app's edit links (docs/native-switch.md, Decisions:
 * the editing prototype). One card that opens beside the event: a quick view (title, type, one clickable time
 * line, the details, "Edited 5m ago") that grows in place into every field (Starts / Ends with dates, times,
 * All day, the length, the time zone, repeat, details). Each part of a time opens its own picker, and pickers
 * take typing ("5p", "fri", "oct 20"). On a phone the card is a sheet along the bottom.
 *
 * The card only edits a value; the app saves it. Every change goes out as 'change' (patch, message) the moment it
 * is made, and the app writes it through its one write path (app.js nativeCardChange -> commitScheduleAction),
 * with a toast and Undo. A new event is not saved until Done (or Enter, or a click outside with a title).
 *
 *   props.card   { key, value, isNew, full, canRepeat, anchor: { testid, rect }, edited, place }
 *                value: { title, type, description, isAllDay, start: Date, end: Date, rule }
 *                (all day: start = local midnight of the first day, end = local midnight of the LAST day)
 *   emits        'change' (patch, message)   'done' ({ title, smart })   'cancel'   'delete'   'duplicate'
 *                'labels' (names)            'expand'
 */
const EventCard = (() => {
    const K = (typeof cardKit !== 'undefined' && cardKit) || (typeof window !== 'undefined' && window.cardKit);
    const MAX = 20000;   // the server's per-field limit (cloudflare/src/CalendarRoom.js LIMITS.maxField)
    const M = 12;        // the gap kept from every edge of the screen
    const PHONE = 760;
    const clone = (v) => ({ ...v, start: new Date(v.start), end: new Date(v.end) });
    const sameDate = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    const at = (day, minutes) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minutes);
    const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), textarea, select, a[href], [tabindex]:not([tabindex="-1"])';

    return {
        props: {
            card: { type: Object, required: true },
            colors: { type: Array, default: () => [] },
            labels: { type: Array, default: () => [] },
            timeFormat: { type: String, default: '12' },
            firstDayOfWeek: { type: [Number, String], default: 0 },
            blocked: { type: Boolean, default: false },   // a question is open over the card: keys are its
        },
        emits: ['change', 'done', 'cancel', 'delete', 'duplicate', 'labels', 'expand'],
        data() {
            return {
                v: clone(this.card.value), full: !!this.card.full,
                titleText: this.card.value.title || '', detText: this.card.value.description || '',
                titleFocus: false, detFocus: false,
                picker: null, pickStyle: {}, menu: false, menuStyle: {},
                month: null, focusDay: null, custom: null, customError: '', labelNames: null, typed: '', typedBad: false,
                smart: null, smartSaid: '', showAll: false, clamped: false, pasteNote: '',
                pos: {}, entering: false, expanding: false, phone: typeof window !== 'undefined' && window.innerWidth <= PHONE,
                sheetDy: 0, keep: null, closing: false,
            };
        },
        computed: {
            color() { const p = this.colors.length ? this.colors : ['#3f51b5']; return p[((Number(this.v.type) || 1) - 1) % p.length] || p[0]; },
            typeName() { return this.labels[(Number(this.v.type) || 1) - 1] || `Type ${Number(this.v.type) || 1}`; },
            isNew() { return !!this.card.isNew; },
            sameDay() { return !this.v.isAllDay && sameDate(this.v.start, this.v.end); },
            fmt() { return this.timeFormat === '24' ? '24' : '12'; },
            minutes() { return Math.round((this.v.end - this.v.start) / 60000); },
            lengthText() { return this.v.isAllDay ? K.fmtDays(K.dayDiff(this.v.start, this.v.end) + 1) : K.fmtLen(this.minutes); },
            repText() { return K.describeRule(this.v.rule, this.v.start); },
            zone() {
                try {
                    const id = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
                    const name = new Intl.DateTimeFormat('en-US', { timeZoneName: 'longGeneric' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName');
                    return (name && name.value) || id.replace(/_/g, ' ');
                } catch (e) { return 'Your time zone'; }
            },
            linked() { return typeof Utils !== 'undefined' && Utils.linkify ? Utils.linkify(this.detText || '', { style: false }) : ''; },
            detCount() { return this.detText.length >= MAX * 0.9 ? `${this.detText.length.toLocaleString('en-US')} / ${MAX.toLocaleString('en-US')}` : ''; },
            max() { return MAX; },
            cls() {
                return { quick: !this.full, new: this.isNew, entering: this.entering, expanding: this.expanding, sheet: this.phone };
            },
            cardStyle() {
                const s = { '--evc': this.color };
                if (this.phone) { if (this.sheetDy) { s.transform = `translateY(${this.sheetDy}px)`; s.transition = 'none'; } return s; }
                return { ...s, ...this.pos };
            },
            presets() { return K.presets(this.v.start).map((p) => ({ ...p, text: K.describeRule(p.rule, this.v.start) })); },
            presetNow() { return K.presetOf(this.v.rule, this.v.start); },
            timeList() {
                const kind = this.picker && this.picker.kind;
                if (kind !== 's' && kind !== 'e') return [];
                const out = [];
                for (let m = 0; m < 1440; m += 15) out.push(m);
                if (kind === 'e') out.push(1440);
                const startMin = K.minutesOf(this.v.start);
                const endMin = K.minutesOf(this.v.end);
                return out.filter((m) => kind === 's' || !this.sameDay || m > startMin).map((m) => {
                    const cur = kind === 's' ? m === startMin : m === endMin && m !== 1440;
                    // The end on its own date (midnight at the end of a same-day event is the next day's 0:00).
                    const len = kind === 'e' ? Math.round((at(this.v.end, m) - this.v.start) / 60000) : 0;
                    return { m, cur, label: m === 1440 ? `${K.fmtMinutes(0, this.fmt)} (midnight)` : K.fmtMinutes(m, this.fmt), len: len > 0 ? K.fmtLen(len) : '' };
                });
            },
            lengths() {
                if (this.v.isAllDay) return [1, 2, 3, 7].map((n) => ({ n, label: K.fmtDays(n), sub: '', cur: n === K.dayDiff(this.v.start, this.v.end) + 1 }));
                return [15, 30, 45, 60, 90, 120, 180, 240].map((n) => ({ n, label: K.fmtLen(n), sub: `until ${K.fmtTime(new Date(this.v.start.getTime() + n * 60000), this.fmt, true)}`, cur: n === this.minutes }));
            },
            cells() { return this.month ? K.monthCells(this.month.y, this.month.m, Number(this.firstDayOfWeek) || 0) : []; },
            weekHeads() { const f = Number(this.firstDayOfWeek) || 0; return [0, 1, 2, 3, 4, 5, 6].map((i) => K.DAY_NAMES[(i + f) % 7]); },
            monthTitle() { return this.month ? `${K.MONTH_NAMES[this.month.m]} ${this.month.y}` : ''; },
        },
        watch: {
            'card.key'() { this.reset(true); },
            'card.value'(val, old) {
                const was = old || {};
                this.v = clone(val);
                // What is being typed stays, unless the value itself changed underneath it (an undo, another save).
                if (!this.titleFocus || val.title !== was.title) this.titleText = val.title || '';
                if (!this.detFocus || val.description !== was.description) this.detText = val.description || '';
                this.$nextTick(() => { this.grow(); this.fit(); this.measureClamp(); });
            },
            'card.place'() { this.$nextTick(() => this.place(false)); },
            'card.full'(f) { if (f && !this.full) this.expand(); },
        },
        mounted() {
            this._onKey = (e) => this.onKey(e);
            window.addEventListener('keydown', this._onKey, true);
            this._onResize = () => { this.phone = window.innerWidth <= PHONE; this.closePicker(); this.$nextTick(() => this.place(false)); };
            window.addEventListener('resize', this._onResize);
            // Pickers close when the page (or the card) scrolls under them; their own list scrolling is fine.
            // (Only a scroll that moved the field it belongs to: a re-render of the grid may scroll something else.)
            this._onScroll = (e) => {
                if (!(this.picker || this.menu) || (e.target && e.target.closest && e.target.closest('.nk-pick, .nk-menu'))) return;
                const pk = this.picker, at = pk && pk.el && pk.el.isConnected ? pk.el.getBoundingClientRect() : null;
                if (pk && at && pk.at && Math.abs(at.top - pk.at.top) < 2 && Math.abs(at.left - pk.at.left) < 2) return;
                this.closePicker(); this.menu = false;
            };
            window.addEventListener('scroll', this._onScroll, true);
            this.reset(true);
        },
        beforeUnmount() {
            window.removeEventListener('keydown', this._onKey, true);
            window.removeEventListener('resize', this._onResize);
            window.removeEventListener('scroll', this._onScroll, true);
            const el = this.$refs.card;
            if (el && el.contains(document.activeElement)) document.activeElement.blur();
        },
        methods: {
            reset(open) {
                this.v = clone(this.card.value); this.full = !!this.card.full;
                this.titleText = this.card.value.title || ''; this.detText = this.card.value.description || '';
                this.picker = null; this.menu = false; this.smart = null; this.showAll = false; this.pasteNote = ''; this.keep = null; this.closing = false;
                this.$nextTick(() => {
                    this.place(open);
                    this.grow(); this.measureClamp();
                    // A new event: type the title right away. An existing one: the title too, but not on a phone,
                    // where a keyboard sliding up over the sheet is not what a tap on an event asks for.
                    if (this.isNew || !this.phone) { const t = this.$refs.title; if (t) t.focus({ preventScroll: true }); }
                });
            },
            // ---- placement: beside the event, never past an edge -----------------------------------
            anchorRect() {
                const a = this.card.anchor || {};
                const els = a.testid ? [...document.querySelectorAll(`.nc [data-testid="${a.testid}"]`)].filter((e) => e.getClientRects().length) : [];
                const want = a.rect;
                if (els.length) {
                    if (!want || els.length === 1) return els[0].getBoundingClientRect();
                    const cx = want.left + want.width / 2, cy = want.top + want.height / 2;
                    return els.map((e) => e.getBoundingClientRect()).sort((p, q) => Math.hypot(p.left + p.width / 2 - cx, p.top + p.height / 2 - cy) - Math.hypot(q.left + q.width / 2 - cx, q.top + q.height / 2 - cy))[0];
                }
                return want || null;
            },
            place(animate) {
                const c = this.$refs.card;
                if (!c) return;
                if (this.phone) { this.pos = {}; this.fit(); if (animate) this.pop(); return; }
                const w = c.offsetWidth, r = this.anchorRect(), sx = window.scrollX, sy = window.scrollY;
                this.pos = { maxHeight: '', overflowY: '' };
                c.style.maxHeight = ''; c.style.overflowY = '';
                const h = c.offsetHeight;
                let vx, vy;
                if (!r) { vx = (window.innerWidth - w) / 2; vy = 120; }
                else {
                    vx = r.right + 10;
                    if (vx + w > window.innerWidth - M) vx = r.left - w - 10;
                    if (vx < M) vx = Math.max(M, Math.min(r.left, window.innerWidth - w - M));
                    vy = Math.max(M, Math.min(r.top - 24, Math.max(M, window.innerHeight - h - M - 8)));
                }
                const fromX = r ? (vx >= r.left ? 0 : w) : w / 2, fromY = r ? Math.max(0, r.top - vy + 12) : 0;
                this.pos = { left: `${vx + sx}px`, top: `${vy + sy}px`, '--from-x': `${fromX}px`, '--from-y': `${fromY}px` };
                this.$nextTick(() => { this.fit(); if (animate) this.pop(); });
            },
            pop() {
                if (reduced()) return;
                this.entering = false;
                requestAnimationFrame(() => { this.entering = true; setTimeout(() => { this.entering = false; }, 220); });
            },
            // Too little room below: up just enough (the only time the card moves), then its contents scroll inside.
            fit() {
                const c = this.$refs.card;
                if (!c || this.phone) return;
                c.style.maxHeight = ''; c.style.overflowY = '';
                // Layout sizes, not the box on screen: the card may be mid-animation (scaled).
                const h = c.offsetHeight, top = parseFloat(this.pos.top || 0) - window.scrollY;
                let room = window.innerHeight - top - M;
                if (h > room && room < 320) {
                    const need = Math.min(h, window.innerHeight - 2 * M), up = Math.max(0, Math.min(top - M, need - room));
                    this.pos = { ...this.pos, top: `${parseFloat(this.pos.top || 0) - up}px` };
                    c.style.top = this.pos.top;
                    room += up;
                }
                if (h > room) { c.style.maxHeight = `${room}px`; c.style.overflowY = 'auto'; }
            },
            expand(focus) {
                if (this.full) return;
                this.full = true;
                this.$emit('expand');
                if (!reduced()) { this.expanding = true; setTimeout(() => { this.expanding = false; }, 260); }
                this.$nextTick(() => { this.grow(); this.fit(); if (focus && this.$refs[focus]) this.$refs[focus].focus(); });
            },
            measureClamp() {
                const d = this.$refs.qdet;
                this.clamped = !!d && !this.showAll && d.scrollHeight > d.clientHeight + 2;
            },
            // ---- words ---------------------------------------------------------------------------------
            t(d, short = true) { return K.fmtTime(d, this.fmt, short); },
            d(d, o) { return K.fmtDate(d, o); },
            summary(v = this.v) {
                if (v.isAllDay) return sameDate(v.start, v.end) ? `${K.fmtDate(v.start)} · All day` : `${K.fmtDate(v.start)} – ${K.fmtDate(v.end)} · All day`;
                if (sameDate(v.start, v.end)) return `${K.fmtDate(v.start)} · ${this.t(v.start)} – ${this.t(v.end)}`;
                return `${K.fmtDate(v.start)}, ${this.t(v.start)} – ${K.fmtDate(v.end)}, ${this.t(v.end)}`;
            },
            // ---- changes -----------------------------------------------------------------------------
            change(patch, msg) {
                Object.assign(this.v, patch);
                this.$emit('change', { ...patch }, msg || this.summary());
                this.$nextTick(() => { this.grow(); this.fit(); });
            },
            onTitleInput() {
                if (this.isNew) this.smartApply();
                if (this.isNew) this.$emit('change', { title: this.titleText }, '');
            },
            commitTitle() {
                if (this.closing || this.isNew || this.titleText === (this.card.value.title || '')) return;
                this.change({ title: this.titleText }, `Renamed ${this.titleText.trim() || '(No title)'}`);
            },
            titleEnter() {
                if (this.isNew) { this.done(); return; }
                this.commitTitle();
                if (this.$refs.title) this.$refs.title.blur();
            },
            onDetInput() {
                this.grow();
                if (this.isNew) this.$emit('change', { description: this.detText }, '');
            },
            commitDetails() {
                if (this.closing || this.isNew || this.detText === (this.card.value.description || '')) return;
                this.change({ description: this.detText }, 'Details saved');
            },
            onPaste(e) {
                const text = e.clipboardData && e.clipboardData.getData('text');
                const ta = e.target;
                if (text == null || !ta) return;
                const before = ta.value.slice(0, ta.selectionStart), after = ta.value.slice(ta.selectionEnd);
                if (before.length + text.length + after.length <= MAX) { this.pasteNote = ''; return; }
                e.preventDefault();
                const fit = text.slice(0, Math.max(0, MAX - before.length - after.length));
                this.detText = before + fit + after;
                this.pasteNote = `Details are limited to ${MAX.toLocaleString('en-US')} characters; the end of the paste was left out.`;
                this.$nextTick(() => { ta.selectionStart = ta.selectionEnd = before.length + fit.length; this.onDetInput(); });
            },
            grow() {
                const ta = this.$refs.det;
                if (!ta) return;
                const top = this.$refs.card ? this.$refs.card.scrollTop : 0;
                ta.style.height = 'auto';
                const cap = Math.round(window.innerHeight * 0.4);
                ta.style.height = `${Math.max(72, Math.min(cap, ta.scrollHeight + 2))}px`;
                ta.style.overflowY = ta.scrollHeight + 2 > cap ? 'auto' : 'hidden';
                if (this.$refs.card) this.$refs.card.scrollTop = top;
            },
            // A time typed into a new event's title ("Practice Thu 5-6") moves it as you type; deleting the words
            // puts it back; Done keeps the time and drops the words.
            smartApply() {
                if (this.v.isAllDay) { this.smart = null; return; }
                if (!this.smart) this.smart = { base: { start: new Date(this.v.start), end: new Date(this.v.end) }, hit: null, key: '' };
                const hit = K.smartParse(this.titleText, new Date(), this.fmt);
                const b = this.smart.base, L = b.end - b.start;
                let start = new Date(b.start), end = new Date(b.end);
                if (hit) {
                    const day = hit.day || b.start;
                    if (hit.start != null) {
                        start = at(day, hit.start);
                        end = hit.end != null ? at(day, hit.end) : new Date(start.getTime() + L);
                    } else { start = at(day, K.minutesOf(b.start)); end = new Date(start.getTime() + L); }
                }
                this.smart.hit = hit;
                const key = hit ? `${start.getTime()}/${end.getTime()}` : '';
                Object.assign(this.v, { start, end });
                this.$emit('change', { start, end }, '');
                if (key && key !== this.smart.key) {
                    this.smartSaid = `Time set: ${this.summary()}`;
                    const q = this.$refs.qline;
                    if (q && !reduced()) { q.classList.remove('nk-pulse'); void q.offsetWidth; q.classList.add('nk-pulse'); }
                }
                this.smart.key = key;
            },
            done() {
                if (this.picker) this.closePicker(false);
                this.commitTitle();
                this.commitDetails();
                const hit = this.isNew && this.smart && this.smart.hit;
                const title = hit ? this.titleText.slice(0, hit.at).trim() : this.titleText;
                this.closing = true;   // the blur as it closes saves nothing more
                this.$emit('done', { title, description: this.detText, smart: hit ? { raw: this.titleText, base: this.smart.base } : null });
            },
            cancel() { this.closing = true; this.$emit('cancel'); },
            // Focus moving to Done, Cancel, Delete or the menu saves when that button acts: a question opening on
            // the blur would cover the button mid-click.
            blurSave(e, save) { const to = e.relatedTarget; if (to && this.$refs.card && this.$refs.card.contains(to) && to.matches('.nk-done, .nk-cancel, .nk-del, .nk-ovf')) return; save(); },
            blurInside() { const el = this.$refs.card; if (el && el.contains(document.activeElement)) document.activeElement.blur(); },
            toggleAllDay() {
                const v = this.v;
                if (!v.isAllDay) {
                    this.keep = { s: K.minutesOf(v.start), e: K.minutesOf(v.end) };
                    const end = K.minutesOf(v.end) === 0 && !sameDate(v.start, v.end) ? K.addDays(K.startOfDay(v.end), -1) : K.startOfDay(v.end);
                    this.change({ isAllDay: true, start: K.startOfDay(v.start), end: end < K.startOfDay(v.start) ? K.startOfDay(v.start) : end });
                } else {
                    const s = this.keep ? this.keep.s : 9 * 60, e = this.keep ? this.keep.e : 10 * 60;
                    let start = at(v.start, s), end = at(v.end, e);
                    if (end <= start) end = new Date(start.getTime() + 60 * 60000);
                    this.change({ isAllDay: false, start, end });
                }
            },
            // ---- pickers -----------------------------------------------------------------------------
            openPicker(kind, ev) {
                const el = ev.currentTarget;
                if (this.picker && this.picker.kind === kind && this.picker.el === el) { this.closePicker(); return; }
                this.closePicker(false);
                this.menu = false;
                this.typed = ''; this.typedBad = false; this.customError = ''; this.labelNames = null; this.custom = null;
                if (kind === 'sd' || kind === 'ed') {
                    const d = kind === 'sd' ? this.v.start : this.v.end;
                    this.month = { y: d.getFullYear(), m: d.getMonth() }; this.focusDay = K.startOfDay(d);
                }
                this.picker = { kind, el, at: el.getBoundingClientRect(), align: kind === 'dur' || kind === 'cat' ? 'right' : 'left' };
                el.setAttribute('aria-expanded', 'true');
                this.$nextTick(() => {
                    this.mountPicker();
                    const p = this.$refs.pick;
                    if (!p) return;
                    const cur = p.querySelector('.nk-plist .cur');
                    const list = p.querySelector('.nk-plist');
                    if (cur && list) list.scrollTop = cur.offsetTop - list.offsetTop - list.clientHeight / 2 + cur.offsetHeight / 2;
                    const first = p.querySelector('input.nk-typed') || p.querySelector('.nk-month [tabindex="0"]') || cur || p.querySelector('button');
                    if (first) first.focus({ preventScroll: true });
                });
            },
            mountPicker() {
                const p = this.$refs.pick, pk = this.picker;
                if (!p || !pk) return;
                const ar = pk.el.getBoundingClientRect();
                p.style.maxHeight = '';
                const w = p.offsetWidth, h = p.offsetHeight;
                const left = pk.align === 'right' ? ar.right - w : ar.left;
                const below = window.innerHeight - ar.bottom - M, above = ar.top - M;
                const s = { left: `${Math.max(M, Math.min(left, window.innerWidth - w - M))}px` };
                if (h <= below || below >= above) Object.assign(s, { top: `${ar.bottom + 6}px`, maxHeight: `${below - 6}px` });
                else Object.assign(s, { top: `${Math.max(M, ar.top - 6 - Math.min(h, above))}px`, maxHeight: `${above - 6}px` });
                this.pickStyle = s;
            },
            closePicker(refocus = true) {
                const pk = this.picker;
                if (!pk) return;
                this.picker = null;
                if (pk.el) { pk.el.setAttribute('aria-expanded', 'false'); if (refocus && pk.el.isConnected) pk.el.focus({ preventScroll: true }); }
            },
            pickKey(e) {
                // Inside a picker: Tab stays in it; Escape is handled by onKey.
                if (e.key !== 'Tab') return;
                const items = [...this.$refs.pick.querySelectorAll(FOCUSABLE)].filter((x) => x.offsetParent !== null);
                if (!items.length) return;
                const i = items.indexOf(document.activeElement);
                e.preventDefault();
                items[(i + (e.shiftKey ? -1 : 1) + items.length) % items.length].focus();
            },
            setAndClose(patch, msg) { this.closePicker(); this.change(patch, msg); },
            pickTime(m) {
                const v = this.v, kind = this.picker && this.picker.kind;
                if (kind === 's') {
                    const L = v.end - v.start, start = at(v.start, m);
                    this.setAndClose({ start, end: new Date(start.getTime() + L) }, `Starts ${this.t(start)}`);
                } else {
                    const end = at(v.end, m);
                    if (end <= v.start) { this.typedBad = true; return; }
                    this.setAndClose({ end }, `Ends ${this.t(end)}`);
                }
            },
            typedTime() {
                const m = K.parseTime(this.typed, this.fmt);
                if (m == null) { this.typedBad = true; return; }
                const kind = this.picker.kind;
                if (kind === 'e' && this.sameDay && m <= K.minutesOf(this.v.start)) { this.typedBad = true; return; }
                this.pickTime(m);
            },
            listKey(e) {
                const items = [...e.currentTarget.querySelectorAll('button')];
                const i = items.indexOf(document.activeElement);
                const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
                if (step && i >= 0) { e.preventDefault(); const n = items[Math.max(0, Math.min(items.length - 1, i + step))]; n.focus(); }
                if (step && i < 0 && step > 0) { e.preventDefault(); (e.currentTarget.querySelector('.cur') || items[0]).focus(); }
            },
            // Dates: a new start date moves the whole event (its length kept); a new end date moves only the end.
            pickDate(day) {
                const v = this.v, kind = this.picker.kind;
                if (kind === 'sd') {
                    const shift = K.dayDiff(v.start, day);
                    const start = K.addDays(v.start, shift), end = K.addDays(v.end, shift);
                    this.say(`Starts ${K.fmtDate(start, { weekday: 'long', month: 'long', day: 'numeric' })}`);
                    this.setAndClose({ start, end });
                } else {
                    if (day < K.startOfDay(v.start)) { this.typedBad = true; return; }
                    let end = v.isAllDay ? K.startOfDay(day) : at(day, K.minutesOf(v.end));
                    if (!v.isAllDay && end <= v.start) end = new Date(v.start.getTime() + 60 * 60000);
                    this.say(`Ends ${K.fmtDate(end, { weekday: 'long', month: 'long', day: 'numeric' })}`);
                    this.setAndClose({ end });
                }
            },
            sameDayEnd() {
                const v = this.v;
                let end = at(v.start, K.minutesOf(v.end));
                if (end <= v.start) end = new Date(Math.min(at(K.addDays(K.startOfDay(v.start), 1), 0), v.start.getTime() + 60 * 60000));
                this.setAndClose({ end });
            },
            typedDate() {
                const ref = this.month ? new Date(this.month.y, this.month.m, 1) : new Date();
                const d = K.parseDate(this.typed, new Date(), ref);
                if (!d) { this.typedBad = true; return; }
                this.pickDate(d);
            },
            stepMonth(n) { const d = new Date(this.month.y, this.month.m + n, 1); this.month = { y: d.getFullYear(), m: d.getMonth() }; this.$nextTick(() => this.mountPicker()); },
            dayClass(d) {
                const v = this.v, k = this.picker && this.picker.kind;
                const sel = k === 'sd' ? v.start : v.end;
                return { cur: sameDate(d, sel), in: d >= K.startOfDay(v.start) && d <= K.startOfDay(v.end) && !sameDate(d, sel), today: sameDate(d, new Date()),
                    off: k === 'ed' && d < K.startOfDay(v.start) };
            },
            dayKey(e) {
                const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
                if (!step || !this.focusDay) return;
                e.preventDefault();
                const n = K.addDays(this.focusDay, step);
                this.focusDay = n;
                if (n.getMonth() !== this.month.m || n.getFullYear() !== this.month.y) this.month = { y: n.getFullYear(), m: n.getMonth() };
                this.$nextTick(() => { const b = this.$refs.pick && this.$refs.pick.querySelector('.nk-month [tabindex="0"]'); if (b) b.focus(); });
            },
            dayLabel(d) { return `${K.fmtDate(d, { weekday: 'long', month: 'long', day: 'numeric' })}${sameDate(d, new Date()) ? ', today' : ''}`; },
            pickLength(n) {
                const v = this.v;
                if (v.isAllDay) this.setAndClose({ end: K.addDays(K.startOfDay(v.start), n - 1) }, K.fmtDays(n));
                else { const end = new Date(v.start.getTime() + n * 60000); this.setAndClose({ end }, `${K.fmtLen(n)}, until ${this.t(end)}`); }
            },
            pickType(i) { this.setAndClose({ type: i + 1 }, this.labels[i] || `Type ${i + 1}`); },
            editTypes() { this.labelNames = this.colors.map((_, i) => this.labels[i] || `Type ${i + 1}`); this.$nextTick(() => { this.mountPicker(); const i = this.$refs.pick && this.$refs.pick.querySelector('input'); if (i) i.focus(); }); },
            saveTypes() { const names = this.labelNames; this.labelNames = null; this.closePicker(); this.$emit('labels', names); },
            pickRepeat(rule) { this.setAndClose({ rule }, K.describeRule(rule, this.v.start)); },
            openCustom() {
                const s = K.parseRule(this.v.rule || 'FREQ=WEEKLY;INTERVAL=1;', this.v.start);
                if (!s.freq) s.freq = 'WEEKLY';
                if (s.endMode === 'until' && !s.until) s.until = K.dateStr(K.addDays(this.v.start, 14));
                this.custom = s; this.customError = '';
                this.$nextTick(() => this.mountPicker());
            },
            customDay(d) { const s = this.custom; const i = s.byDay.indexOf(d); if (i >= 0) { if (s.byDay.length > 1) s.byDay.splice(i, 1); } else s.byDay.push(d); },
            applyCustom() {
                const s = this.custom;
                if (s.endMode === 'until' && !s.until) s.until = K.dateStr(K.addDays(this.v.start, 14));
                const problem = K.ruleProblem(s, this.v.start, this.v.isAllDay ? K.addDays(this.v.end, 1) : this.v.end, this.v.isAllDay);
                if (problem) { this.customError = problem; return; }
                const untilStamp = typeof Event !== 'undefined' && typeof Event.ruleUntilStamp === 'function' ? Event.ruleUntilStamp : null;
                this.pickRepeat(K.buildRule(s, { isAllDay: this.v.isAllDay, untilStamp }));
            },
            // ---- the ⋯ menu ----------------------------------------------------------------------------
            toggleMenu(e) {
                if (this.menu) { this.menu = false; return; }
                this.closePicker(false);
                const r = e.currentTarget.getBoundingClientRect();
                const top = r.bottom + 6 + 100 > window.innerHeight - M ? r.top - 6 - 96 : r.bottom + 6;
                this.menuStyle = { left: `${Math.max(M, Math.min(r.left, window.innerWidth - 210 - M))}px`, top: `${Math.max(M, top)}px` };
                this.menu = true;
                this.$nextTick(() => { const b = this.$refs.menu && this.$refs.menu.querySelector('button'); if (b) b.focus(); });
            },
            menuAct(what) { this.menu = false; if (what === 'delete') this.closing = true; this.$emit(what); },
            say(t) { this.smartSaid = t; },
            // ---- keys: Escape closes one layer, Tab stays inside -------------------------------------------
            onKey(e) {
                if (this.blocked) return;
                if (e.key === 'Escape') {
                    if (this.menu) { this.menu = false; e.stopImmediatePropagation(); e.preventDefault(); return; }
                    if (this.picker) { this.closePicker(); e.stopImmediatePropagation(); e.preventDefault(); return; }
                    e.stopImmediatePropagation(); e.preventDefault();
                    this.cancel();
                    return;
                }
                if (e.key === 'Tab' && !this.picker && !this.menu) {
                    const c = this.$refs.card;
                    if (!c) return;
                    const items = [...c.querySelectorAll(FOCUSABLE)].filter((x) => x.offsetParent !== null || x === document.activeElement);
                    if (!items.length) return;
                    const i = items.indexOf(document.activeElement);
                    if (i === -1 && !c.contains(document.activeElement)) { e.preventDefault(); items[0].focus(); return; }
                    if (e.shiftKey && i === 0) { e.preventDefault(); items[items.length - 1].focus(); }
                    else if (!e.shiftKey && i === items.length - 1) { e.preventDefault(); items[0].focus(); }
                }
            },
            // ---- phone: drag the sheet down from its top to close it (keeps the changes) --------------------
            sheetStart(e) {
                const c = this.$refs.card;
                if (!this.phone || !c || c.scrollTop > 0 || !e.touches || e.touches.length !== 1 || e.target.closest('input, textarea, button, select, a')) return;
                this._sheet = { y0: e.touches[0].clientY };
            },
            sheetMove(e) {
                const s = this._sheet;
                if (!s) return;
                const dy = Math.max(0, e.touches[0].clientY - s.y0);
                if (dy > 0 && e.cancelable) e.preventDefault();   // the browser would scroll the page instead
                this.sheetDy = dy;
            },
            sheetEnd() {
                const s = this._sheet;
                if (!s) return;
                this._sheet = null;
                const dy = this.sheetDy;
                this.sheetDy = 0;
                if (dy > 90) this.done();
            },
        },
        template: /* html */ `
<teleport to="body">
<div v-if="phone" class="nk-scrim" data-testid="card-scrim" aria-hidden="true"></div>
<div ref="card" class="nk-card" :class="cls" :style="cardStyle" role="dialog" :aria-label="isNew ? 'New event' : 'Event'" data-testid="event-card"
  @touchstart="sheetStart" @touchmove="sheetMove" @touchend="sheetEnd" @touchcancel="sheetEnd">
  <div class="nk-h">
    <input ref="title" v-model="titleText" class="nk-title" placeholder="Add a title" aria-label="Title" autocomplete="off" maxlength="500" data-testid="card-title"
      aria-describedby="nk-said" @input="onTitleInput" @focus="titleFocus = true" @blur="titleFocus = false; blurSave($event, commitTitle)" @keydown.enter.prevent="titleEnter">
    <button type="button" class="nk-cat" aria-haspopup="listbox" :aria-expanded="String(!!picker && picker.kind === 'cat')" :aria-label="'Type: ' + typeName"
      data-testid="card-type" @click="openPicker('cat', $event)"><i></i><span>{{ typeName }}</span><nc-icon name="chevron-down" :size="13" :stroke-width="2.2"></nc-icon></button>
  </div>
  <div id="nk-said" class="nk-sr" aria-live="polite">{{ smartSaid }}</div>
  <div class="nk-b">
    <div v-if="!full" ref="qline" class="nk-qline" :class="{ hit: smart && smart.hit }" data-testid="card-time-line">
      <template v-if="v.isAllDay">
        <button type="button" class="nk-qs" data-testid="card-q-sd" aria-expanded="false" :aria-label="'Start date: ' + d(v.start)" @click="openPicker('sd', $event)">{{ d(v.start) }}</button>
        <template v-if="!sameDayAllDay"> – <button type="button" class="nk-qs" data-testid="card-q-ed" aria-expanded="false" :aria-label="'End date: ' + d(v.end)" @click="openPicker('ed', $event)">{{ d(v.end) }}</button></template>
        <span> · All day</span>
      </template>
      <template v-else>
        <button type="button" class="nk-qs" data-testid="card-q-sd" aria-expanded="false" :aria-label="'Start date: ' + d(v.start)" @click="openPicker('sd', $event)">{{ d(v.start) }}</button><span> · </span>
        <button type="button" class="nk-qs" data-testid="card-q-s" aria-expanded="false" :aria-label="'Start time: ' + t(v.start)" @click="openPicker('s', $event)">{{ t(v.start) }}</button><span> – </span>
        <button v-if="!sameDay" type="button" class="nk-qs" data-testid="card-q-ed" aria-expanded="false" :aria-label="'End date: ' + d(v.end)" @click="openPicker('ed', $event)">{{ d(v.end, { weekday: 'short' }) }}</button>
        <button type="button" class="nk-qs" data-testid="card-q-e" aria-expanded="false" :aria-label="'End time: ' + t(v.end)" @click="openPicker('e', $event)">{{ t(v.end) }}</button>
      </template>
      <span v-if="v.rule" class="nk-qrep"> · {{ repText }}</span>
    </div>
    <div v-if="!full && detText.trim()" class="nk-qdet-wrap">
      <div ref="qdet" class="nk-qdet" :class="{ all: showAll, fade: clamped }" data-testid="card-details-preview" v-html="linked"
        @click="!$event.target.closest('a') && expand('det')"></div>
      <button v-if="clamped || showAll" type="button" class="nk-showall" data-testid="card-show-all" @click="showAll = !showAll; $nextTick(() => { measureClamp(); fit(); })">{{ showAll ? 'Show less' : 'Show all' }}</button>
    </div>
    <div v-if="!full && !isNew" class="nk-meta" data-testid="card-edited">{{ card.edited || '\u00a0' }}</div>

    <div v-if="full" class="nk-when" :class="{ hit: smart && smart.hit }">
      <span class="nk-gi" title="Time"><nc-icon name="clock" :size="18"></nc-icon></span>
      <button type="button" class="nk-tp nk-dp" data-testid="card-start-date" aria-expanded="false" :aria-label="'Start date: ' + d(v.start)" @click="openPicker('sd', $event)">{{ d(v.start) }}</button>
      <span v-if="v.isAllDay" class="nk-tp off" aria-hidden="true">–</span>
      <button v-else type="button" class="nk-tp" data-testid="card-start-time" aria-expanded="false" :aria-label="'Start time: ' + t(v.start)" @click="openPicker('s', $event)">{{ t(v.start, false) }}</button>
      <button type="button" class="nk-switch" role="switch" :aria-checked="String(!!v.isAllDay)" data-testid="card-allday" @click="toggleAllDay"><i></i>All day</button>
      <span></span>
      <button type="button" class="nk-tp nk-dp" :class="{ same: sameDay }" data-testid="card-end-date" aria-expanded="false"
        :aria-label="'End date: ' + (sameDay ? 'same day, ' : '') + d(v.end)" @click="openPicker('ed', $event)">{{ d(v.end) }}</button>
      <span v-if="v.isAllDay" class="nk-tp off" aria-hidden="true">–</span>
      <button v-else type="button" class="nk-tp" data-testid="card-end-time" aria-expanded="false" :aria-label="'End time: ' + t(v.end)" @click="openPicker('e', $event)">{{ t(v.end, false) }}</button>
      <button type="button" class="nk-durb" data-testid="card-length" aria-expanded="false" :aria-label="'Length: ' + lengthText" @click="openPicker('dur', $event)">{{ lengthText }}<nc-icon name="chevron-down" :size="13" :stroke-width="2.2"></nc-icon></button>
    </div>
    <div v-if="full" class="nk-tz" :style="{ visibility: v.isAllDay ? 'hidden' : 'visible' }" data-testid="card-tz" :aria-label="'Time zone: ' + zone" title="Times are shown in your time zone">
      <span class="nk-gi"><nc-icon name="globe" :size="18"></nc-icon></span><span>{{ zone }}</span></div>
    <div v-if="full && card.canRepeat" class="nk-row">
      <span class="nk-gi" title="Repeats"><nc-icon name="repeat" :size="18"></nc-icon></span>
      <button type="button" class="nk-sel" data-testid="card-repeat" aria-expanded="false" :aria-label="'Repeats: ' + repText" @click="openPicker('rep', $event)">{{ repText }}<nc-icon name="chevron-down" :size="14" :stroke-width="2.2"></nc-icon></button>
    </div>
    <div v-if="full" class="nk-row">
      <span class="nk-gi" title="Details"><nc-icon name="text-align-start" :size="18"></nc-icon></span>
      <div class="nk-detwrap">
        <textarea ref="det" v-model="detText" class="nk-det" rows="3" placeholder="Place, notes, links" aria-label="Details" :maxlength="max" data-testid="card-details"
          @input="onDetInput" @paste="onPaste" @focus="detFocus = true" @blur="detFocus = false; blurSave($event, commitDetails)"></textarea>
        <div v-if="detCount || pasteNote" class="nk-count" data-testid="card-details-count" aria-live="polite">{{ pasteNote ? pasteNote + ' ' : '' }}{{ detCount }}</div>
      </div>
    </div>
    <div class="nk-foot">
      <button v-if="!isNew" type="button" class="nk-icon nk-del" aria-label="Delete" title="Delete" data-testid="card-delete" @click="closing = true; $emit('delete')"><nc-icon name="trash-2" :size="18"></nc-icon></button>
      <button v-if="full && !isNew" type="button" class="nk-icon nk-ovf" aria-label="More actions" title="More actions" aria-haspopup="menu" :aria-expanded="String(menu)" data-testid="card-more-actions" @click="toggleMenu"><nc-icon name="ellipsis" :size="18"></nc-icon></button>
      <button v-if="!full" type="button" class="nk-more" data-testid="card-more" @click="expand()">More details</button>
      <span class="nk-sp"></span>
      <button v-if="full || isNew" type="button" class="nk-cancel" data-testid="card-cancel" @click="cancel">Cancel</button>
      <button type="button" class="nk-done" data-testid="card-done" @click="done">Done</button>
    </div>
  </div>
</div>

<div v-if="menu" ref="menu" class="nk-menu" role="menu" :style="menuStyle" data-testid="card-menu" @keydown="pickKey">
  <button type="button" role="menuitem" data-testid="card-duplicate" @click="menuAct('duplicate')">Duplicate <kbd>⌘D</kbd></button>
  <button type="button" role="menuitem" class="red" data-testid="card-menu-delete" @click="menuAct('delete')">Delete <kbd>⌫</kbd></button>
</div>

<div v-if="picker" ref="pick" class="nk-pick" :class="'nk-pick-' + picker.kind" role="dialog" :aria-label="{ s: 'Start time', e: 'End time', sd: 'Start date', ed: 'End date', dur: 'Length', cat: 'Type', rep: 'Repeats' }[picker.kind]"
  :style="pickStyle" :data-kind="picker.kind" data-testid="card-picker" @keydown="pickKey">
  <template v-if="picker.kind === 's' || picker.kind === 'e'">
    <input v-model="typed" class="nk-typed" :class="{ bad: typedBad }" aria-label="Type a time" :placeholder="fmt === '24' ? 'Type a time: 17:30' : 'Type a time: 5p, 5:30pm'" data-testid="picker-input"
      @input="typedBad = false" @keydown.enter.prevent="typedTime" @keydown.down.prevent="$refs.tlist && ($refs.tlist.querySelector('.cur') || $refs.tlist.querySelector('button')).focus()">
    <div ref="tlist" class="nk-plist" @keydown="listKey">
      <button v-for="o in timeList" :key="o.m" type="button" :class="{ cur: o.cur }" :data-m="o.m" @click="pickTime(o.m)">{{ o.label }}<small v-if="o.len">{{ o.len }}</small></button>
    </div>
  </template>
  <template v-else-if="picker.kind === 'sd' || picker.kind === 'ed'">
    <div v-if="picker.kind === 'ed' && !v.isAllDay" class="nk-plist nk-plist-top">
      <button type="button" :class="{ cur: sameDay }" data-testid="picker-same-day" @click="sameDayEnd">Same day</button>
      <button type="button" data-testid="picker-next-day" @click="pickDate(addDays(v.start, 1))">Next day <small>{{ d(addDays(v.start, 1)) }}</small></button>
    </div>
    <input v-model="typed" class="nk-typed" :class="{ bad: typedBad }" aria-label="Type a date" placeholder="Type a date: Oct 20, Fri, tomorrow" data-testid="picker-input"
      @input="typedBad = false" @keydown.enter.prevent="typedDate">
    <div class="nk-mhead"><span>{{ monthTitle }}</span>
      <span><button type="button" class="nk-icon nk-sm" aria-label="Previous month" data-testid="picker-prev" @click="stepMonth(-1)"><nc-icon name="chevron-left" :size="16"></nc-icon></button><button type="button" class="nk-icon nk-sm" aria-label="Next month" data-testid="picker-next" @click="stepMonth(1)"><nc-icon name="chevron-right" :size="16"></nc-icon></button></span></div>
    <div class="nk-month" role="grid" :aria-label="monthTitle" @keydown="dayKey">
      <b v-for="h in weekHeads" :key="h" aria-hidden="true">{{ h.charAt(0) }}</b>
      <template v-for="(c, i) in cells" :key="i">
        <span v-if="!c"></span>
        <button v-else type="button" role="gridcell" :class="dayClass(c)" :disabled="dayClass(c).off" :data-d="dateStr(c)" :aria-label="dayLabel(c)"
          :aria-selected="String(dayClass(c).cur)" :tabindex="focusDay && sameDateFn(c, focusDay) ? 0 : -1" @click="pickDate(c)">{{ c.getDate() }}</button>
      </template>
    </div>
  </template>
  <div v-else-if="picker.kind === 'dur'" class="nk-plist" @keydown="listKey">
    <button v-for="o in lengths" :key="o.n" type="button" :class="{ cur: o.cur }" :data-len="o.n" @click="pickLength(o.n)">{{ o.label }}<small v-if="o.sub">{{ o.sub }}</small></button>
  </div>
  <template v-else-if="picker.kind === 'cat'">
    <template v-if="!labelNames">
      <div class="nk-plist" role="listbox" @keydown="listKey">
        <button v-for="(c, i) in colors" :key="i" type="button" class="nk-catopt" :class="{ cur: Number(v.type) === i + 1 }" role="option" :aria-selected="String(Number(v.type) === i + 1)"
          :data-t="i + 1" @click="pickType(i)"><i :style="{ background: c }"></i>{{ labels[i] || ('Type ' + (i + 1)) }}</button>
      </div>
      <div class="nk-pfoot"><button type="button" data-testid="picker-edit-types" @click="editTypes">Edit types…</button></div>
    </template>
    <template v-else>
      <div class="nk-labels">
        <label v-for="(c, i) in colors" :key="i"><i :style="{ background: c }"></i><input v-model="labelNames[i]" maxlength="40" :aria-label="'Name for type ' + (i + 1)" :data-testid="'picker-type-name-' + (i + 1)"></label>
      </div>
      <div class="nk-pfoot end"><button type="button" data-testid="picker-types-done" @click="saveTypes">Done</button></div>
    </template>
  </template>
  <template v-else-if="picker.kind === 'rep'">
    <div v-if="!custom" class="nk-plist" @keydown="listKey">
      <button v-for="p in presets" :key="p.id" type="button" :class="{ cur: presetNow === p.id }" :data-r="p.id" @click="pickRepeat(p.rule)">{{ p.text }}</button>
      <button v-if="presetNow === 'custom'" type="button" class="cur" data-r="current" @click="closePicker()">{{ repText }}</button>
      <button type="button" data-testid="picker-custom" @click="openCustom">Custom…</button>
    </div>
    <div v-else class="nk-cust">
      <label>Every <input type="number" min="1" max="99" v-model.number="custom.interval" aria-label="How often" data-testid="custom-interval">
        <select v-model="custom.freq" aria-label="Unit" data-testid="custom-unit">
          <option value="DAILY">{{ custom.interval > 1 ? 'days' : 'day' }}</option><option value="WEEKLY">{{ custom.interval > 1 ? 'weeks' : 'week' }}</option>
          <option value="MONTHLY">{{ custom.interval > 1 ? 'months' : 'month' }}</option><option value="YEARLY">{{ custom.interval > 1 ? 'years' : 'year' }}</option></select></label>
      <div v-if="custom.freq === 'WEEKLY'" class="nk-wd">
        <button v-for="(n, i) in ['S','M','T','W','T','F','S']" :key="i" type="button" :aria-pressed="String(custom.byDay.includes(i))" :aria-label="dayNames[i]" :data-testid="'custom-day-' + i" @click="customDay(i)">{{ n }}</button>
      </div>
      <div v-if="custom.freq === 'MONTHLY' || custom.freq === 'YEARLY'" class="nk-ends">
        <label v-if="custom.freq === 'YEARLY'">In <select v-model.number="custom.month" aria-label="Month" data-testid="custom-month"><option v-for="(n, i) in monthNames" :key="i" :value="i + 1">{{ n }}</option></select></label>
        <label><input type="radio" value="day" v-model="custom.monthMode" data-testid="custom-by-day"> On day <input type="number" min="1" max="31" v-model.number="custom.monthDay" aria-label="Day of the month" data-testid="custom-month-day" @focus="custom.monthMode = 'day'"></label>
        <label><input type="radio" value="weekday" v-model="custom.monthMode" data-testid="custom-by-weekday"> On the
          <select v-model.number="custom.setPos" aria-label="Which week" data-testid="custom-setpos" @focus="custom.monthMode = 'weekday'"><option :value="1">first</option><option :value="2">second</option><option :value="3">third</option><option :value="4">fourth</option><option :value="-1">last</option></select>
          <select v-model.number="custom.posDay" aria-label="Weekday" data-testid="custom-posday" @focus="custom.monthMode = 'weekday'"><option v-for="(n, i) in dayNames" :key="i" :value="i">{{ n }}</option></select></label>
      </div>
      <div class="nk-ends"><span>Ends</span>
        <label><input type="radio" value="never" v-model="custom.endMode" data-testid="custom-end-never"> Never</label>
        <label><input type="radio" value="until" v-model="custom.endMode" data-testid="custom-end-until"> On <input type="date" v-model="custom.until" aria-label="Last date" data-testid="custom-until" @focus="custom.endMode = 'until'"></label>
        <label><input type="radio" value="count" v-model="custom.endMode" data-testid="custom-end-count"> After <input type="number" min="1" max="999" v-model.number="custom.count" aria-label="Times" data-testid="custom-count" @focus="custom.endMode = 'count'"> times</label>
      </div>
      <p v-if="customError" class="nk-err" role="alert" data-testid="custom-error">{{ customError }}</p>
      <div class="nk-pfoot end"><button type="button" data-testid="custom-apply" @click="applyCustom">Apply</button></div>
    </div>
  </template>
</div>
</teleport>`,
    };
})();
// Template helpers that read cardKit directly.
EventCard.computed.sameDayAllDay = function () { return this.v.isAllDay && this.v.start.toDateString() === this.v.end.toDateString(); };
EventCard.computed.dayNames = function () { return cardKit.DAY_NAMES; };
EventCard.computed.monthNames = function () { return cardKit.MONTH_NAMES; };
EventCard.methods.addDays = function (d, n) { return cardKit.addDays(cardKit.startOfDay(d), n); };
EventCard.methods.dateStr = function (d) { return cardKit.dateStr(d); };
EventCard.methods.sameDateFn = function (a, b) { return a.toDateString() === b.toDateString(); };
if (typeof window !== 'undefined') window.EventCard = EventCard;
