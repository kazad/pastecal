
## free-harden merged into pro (2026-10-23, merge dc28f04)

Conflicts resolved by combining both sides: WS connect/save records an author only if the tab can
write (lock) AND the room exists; /import and /from-firebase answer r.status (423 locked) else 413
for a size refusal; create-view does rate limit -> source exists (404) -> lock check (403) -> custom
slug not a calendar name (409); one linkify (free-harden's single-pass, rel "noopener noreferrer
nofollow ugc"), used by read-only notes in both apps and the popover; index.html keeps the editor-key
script first, then the analytics scrub, then GTM. CSP already has 'unsafe-inline' (signin/done inline
scripts OK); Stripe is a location.href redirect, so no CSP change was needed.

Verified on fresh local wrangler instances (all pass, no test changes needed): lock 11, permissions 16,
stats 11, restore 14, accounts 16, billing 22, welcome 6, pro-health 5, hardening 11, ics-safety,
collector, headers, sync 13, phase3 15, cloud-service 13, backup 3, archive 5, copyback 8.

Left: unit tests (node --test test/unit-files.js) and the browser pass on ?backend=cf (draft -> save,
edit/undo, read-only link, .ics, /view embed allowed vs edit page blocked, /beta, Pro lock badge and
copy, Pro share panel, CSP console check) were not run before shutdown.
