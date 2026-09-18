/**
 * pastecal.com/pro -- interest capture, magic-link sign-in, and Stripe checkout.
 *
 * The page has two modes, switched by PRO_CHECKOUT_LIVE:
 *
 *   waitlist (now)  "Get Pro" records an email as interest and says thank you.
 *                   Nothing is charged, no account is made. This exists to find
 *                   out whether anyone raises a hand at $99 BEFORE accounts and
 *                   billing get built, because that is the cheap question and
 *                   building first is the expensive way to ask it.
 *
 *   checkout (later) "Get Pro" sends a magic link; following it signs you in and
 *                   hands off to Stripe Checkout. Same button, same page.
 *
 * Both paths start from an email address, which is why the waitlist is not a
 * throwaway: the capture form IS the first step of the real flow, so switching
 * modes changes what happens after the submit, not the page around it.
 */
(function () {
    'use strict';

    // Flip to true once billing is real. Until then the button captures interest.
    const PRO_CHECKOUT_LIVE = false;

    const firebaseConfig = {
        apiKey: 'AIzaSyCZ9U1FflAFcdDLgxJscs2BwV_PrXqmzKw',
        authDomain: 'pastecal-web.firebaseapp.com',
        databaseURL: 'https://pastecal-web-default-rtdb.firebaseio.com',
        projectId: 'pastecal-web',
        storageBucket: 'pastecal-web.appspot.com',
        messagingSenderId: '912998627577',
        appId: '1:912998627577:web:aa652846c2618a986d8a28',
        measurementId: 'G-4J99GY9KE6',
    };
    firebase.initializeApp(firebaseConfig);

    const form = document.getElementById('waitlist');
    const input = document.getElementById('email');
    const button = document.getElementById('submit');
    const sub = document.getElementById('sub');
    const cta = document.getElementById('cta');

    /** Replace the form with a message. The form is the page's only action, so
     *  once it is done there is nothing to go back to. */
    function done(html) {
        cta.innerHTML = '<div class="ok">' + html + '</div>';
    }

    function fail(message) {
        sub.textContent = message;
        sub.style.color = '#dc2626';
        button.disabled = false;
        button.textContent = 'Get Pro';
    }

    // Deliberately loose. A regex cannot tell a real mailbox from a typo, and a
    // strict one mostly rejects valid addresses -- the only thing worth catching
    // here is an empty box or a missing @.
    const looksLikeEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

    form.addEventListener('submit', async function (e) {
        e.preventDefault();
        const email = (input.value || '').trim().toLowerCase();

        if (!looksLikeEmail(email)) {
            fail('That address looks incomplete — check it and try again.');
            input.focus();
            return;
        }

        button.disabled = true;
        button.textContent = 'One moment…';

        try {
            if (PRO_CHECKOUT_LIVE) {
                await startCheckout(email);
            } else {
                await recordInterest(email);
            }
        } catch (err) {
            console.warn('[pro] submit failed:', err);
            fail('Something went wrong on our end. Try again in a moment?');
        }
    });

    /**
     * Waitlist mode. Writes the address under a push id and nothing else.
     *
     * Stored server-side rather than in a form service so the list lives with the
     * product and can be read by the same scripts as everything else. The node is
     * write-only to the public (see database.rules.json): anyone may add an
     * address, nobody may read the list back, so this cannot become an email
     * scrape of people who were interested in paying.
     */
    async function recordInterest(email) {
        const payload = {
            email: email,
            at: firebase.database.ServerValue.TIMESTAMP,
            ua: (navigator.userAgent || '').slice(0, 120),
        };
        // Which calendar sent them, when the link carried it. Answers "is the
        // interest coming from the groups we think it is" without asking. Omitted
        // rather than sent as null, which the rules reject as a non-string.
        const from = new URLSearchParams(location.search).get('from');
        if (from) payload.from = from.slice(0, 60);

        await firebase.database().ref('pro_interest').push(payload);

        if (window.gtag) {
            window.gtag('event', 'pro_interest', { surface: 'web' });
        }

        done(
            '<strong>Thank you — you\'re on the list.</strong><br>' +
            'We\'ll email you the day Pro opens. If you need to pay by invoice ' +
            'or have a question, just reply to that email.'
        );
    }

    /**
     * Checkout mode. Sends a sign-in link; the click comes back to this page with
     * the Firebase params attached, and completeSignIn() picks it up below.
     *
     * A magic link rather than a password: there is no password to store, reset or
     * leak, and the address has to work anyway for receipts and renewal notices.
     */
    async function startCheckout(email) {
        await firebase.auth().sendSignInLinkToEmail(email, {
            url: location.origin + '/pro',
            handleCodeInApp: true,
        });
        // The link opens in whatever browser handles mail, which may not be this
        // one. Remembering the address here lets the common case (same browser)
        // skip re-typing it; the other case asks, which is why completeSignIn
        // can prompt.
        try { localStorage.setItem('pro_email', email); } catch (_) { }

        done(
            '<strong>Check your email.</strong><br>' +
            'We sent a sign-in link to <b>' + email.replace(/[<>&]/g, '') + '</b>. ' +
            'Open it and you\'ll come straight back here to finish.'
        );
    }

    /**
     * Returning from the emailed link: finish sign-in, then hand off to Stripe.
     *
     * Runs on every load because that is how Firebase's email-link flow reports
     * itself -- the same URL either does or does not carry the sign-in params.
     */
    async function completeSignIn() {
        if (!firebase.auth().isSignInWithEmailLink(location.href)) return;

        let email = null;
        try { email = localStorage.getItem('pro_email'); } catch (_) { }
        // Opened in a different browser than it was requested from, so the address
        // is not on this device. Asking is the only honest option.
        if (!email) email = window.prompt('Confirm the email this link was sent to:');
        if (!email) return;

        try {
            await firebase.auth().signInWithEmailLink(email, location.href);
            try { localStorage.removeItem('pro_email'); } catch (_) { }
            // Drop the sign-in params so a refresh is not a second attempt.
            history.replaceState({}, '', '/pro');

            const go = firebase.functions().httpsCallable('createProCheckout');
            const res = await go({ email: email });
            if (res && res.data && res.data.url) {
                location.assign(res.data.url);
                return;
            }
            done('Signed in, but checkout could not start. Email us and we\'ll sort it out.');
        } catch (err) {
            console.warn('[pro] sign-in failed:', err);
            done('That sign-in link has expired. Request a fresh one above.');
        }
    }

    completeSignIn();
})();
