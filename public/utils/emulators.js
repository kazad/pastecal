/**
 * Point the Firebase client at the local emulators instead of production -- for e2e tests,
 * and for anyone developing on localhost who asks for it.
 *
 * Why: the e2e suite used to drive the app at localhost against the PRODUCTION database.
 * `firebase serve` serves the static files only, and the page's config hard-codes the
 * production databaseURL, so every test calendar, every edit and every anonymous sign-in
 * landed in real data. `?local` only ever moved Cloud Functions (to a port nothing
 * listened on).
 *
 * Loaded right after firebase-compat.js and BEFORE the page's inline config script. It
 * wraps firebase.initializeApp so the switch happens inside the same call that creates
 * the app -- before signInAnonymously() or the first database read can reach production.
 *
 * Emulator mode is on only on localhost/127.0.0.1, and only when one of:
 *   - the page is served by the hosting emulator (its port, below);
 *   - window.__PASTECAL_EMULATOR__ is set (the Playwright fixture sets it on every page);
 *   - the URL carries ?emulator (remembered for the tab, since the app rewrites the URL).
 * Plain `firebase serve` on another port keeps talking to production, as before.
 *
 * The ports must match firebase.json's "emulators" block; test/unit/emulator-switch.test.js
 * checks that they do.
 */
(function () {
    var EMULATORS = {
        projectId: 'demo-pastecal',   // a demo- project can never reach a real Firebase project
        hosting: 5103,
        database: 9000,
        functions: 5101,
        auth: 9099,
    };
    var HOST = '127.0.0.1';
    window.PASTECAL_EMULATORS = EMULATORS;

    if (typeof firebase === 'undefined' || !firebase.initializeApp) return;
    if (!/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return;

    var wanted = !!window.__PASTECAL_EMULATOR__ || String(location.port) === String(EMULATORS.hosting);
    try {
        if (/[?&]emulator(=|&|$)/.test(location.search)) sessionStorage.setItem('pastecal:emulator', '1');
        if (sessionStorage.getItem('pastecal:emulator') === '1') wanted = true;
    } catch (err) { /* storage blocked: the query param alone still works on this load */ }
    if (!wanted) return;

    var initializeApp = firebase.initializeApp;
    firebase.initializeApp = function (config) {
        var projectId = EMULATORS.projectId;
        var local = Object.assign({}, config, {
            projectId: projectId,
            authDomain: projectId + '.firebaseapp.com',
            databaseURL: 'http://' + HOST + ':' + EMULATORS.database + '?ns=' + projectId + '-default-rtdb',
        });
        var app = initializeApp.apply(this, [local].concat([].slice.call(arguments, 1)));
        firebase.database().useEmulator(HOST, EMULATORS.database);
        if (firebase.functions) firebase.functions().useEmulator(HOST, EMULATORS.functions);
        if (firebase.auth) firebase.auth().useEmulator('http://' + HOST + ':' + EMULATORS.auth, { disableWarnings: true });
        window.__PASTECAL_USING_EMULATOR__ = true;
        console.info('[emulators] Firebase is pointed at the local emulators (' + projectId + ')');
        return app;
    };
})();
