/**
 * pcKeys -- one place for what a key press means and how a shortcut is written.
 *
 * 1. Typing in Japanese, Chinese, Korean (an IME): the Enter that confirms a conversion and the Escape that cancels it
 *    arrive as ordinary keydowns, marked isComposing (keyCode 229). A handler that saves on Enter or closes on Escape
 *    saved a new event mid-word and threw it away on a cancel (S06). So:
 *      - pcKeys.is(e, 'Enter') is the only way app code asks which key it was: false while composing.
 *      - Vue's key modifiers (@keydown.enter, .esc, .tab, ...) go through Vue.withKeys, wrapped below to skip a key
 *        pressed mid-composition, before any .prevent/.stop. (Load this right after Vue, before any app is mounted.)
 *      - keyup.enter cannot tell (Chrome's keyup after a confirming Enter is not marked composing): use keydown.
 *    test/unit/ime-keys.test.js fails on any key handler that skips this.
 * 2. Shortcut labels: ⌘ and ⌥ on a Mac, Ctrl and Alt elsewhere (S14: the shortcuts sheet said ⌘D on Windows).
 *    pcKeys.mod('D') -> "⌘D" / "Ctrl+D"; pcKeys.alt -> "⌥" / "Alt". test/unit/shortcut-labels.test.js keeps
 *    literal ⌘/⌥ out of the app.
 */
(function (root) {
    'use strict';
    /** A key pressed while an IME is composing text: not a command. */
    const composing = (e) => !!e && (e.isComposing === true || e.keyCode === 229);
    const NAMES = { Esc: 'Escape' };
    /** Is this keydown `name` ('Enter', 'Escape', 'Tab'), pressed as a command (not mid-composition)? */
    const is = (e, name) => !composing(e) && !!e && (e.key === name || e.key === NAMES[name] || NAMES[e.key] === name);
    const nav = root.navigator || {};
    const isMac = /mac|iphone|ipad|ipod/i.test((nav.userAgentData && nav.userAgentData.platform) || nav.platform || '');
    const pcKeys = {
        composing, is, isMac,
        /** The command modifier with a key: "⌘D" on a Mac, "Ctrl+D" elsewhere; "⌘" / "Ctrl" alone. */
        mod: (k = '') => (isMac ? `⌘${k}` : `Ctrl${k ? '+' + k : ''}`),
        /** The option key: "⌥" on a Mac, "Alt" elsewhere. */
        alt: isMac ? '⌥' : 'Alt',
        /** The key that deletes: "⌫" on a Mac, "Delete" elsewhere (Delete and Backspace both do). */
        del: isMac ? '⌫' : 'Delete',
    };
    const Vue = root.Vue;
    if (Vue && typeof Vue.withKeys === 'function' && !Vue.withKeys.__pcIme) {
        const withKeys = Vue.withKeys;
        const wrapped = (fn, modifiers) => {
            const h = withKeys(fn, modifiers);   // (Vue caches h per handler and modifiers; so is the wrapper)
            return h.__pcIme || (h.__pcIme = (e, ...rest) => (composing(e) ? undefined : h(e, ...rest)));
        };
        wrapped.__pcIme = true;
        Vue.withKeys = wrapped;
    }
    if (typeof module !== 'undefined' && module.exports) module.exports = pcKeys;
    root.pcKeys = pcKeys;
})(typeof window !== 'undefined' ? window : globalThis);
