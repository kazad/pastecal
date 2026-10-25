#!/usr/bin/env bash
# pastecal Pro launch, step by step (docs/pro-launch.md, "Launch order"). Interactive: every step says
# what it will do and waits for y (run), s (skip) or q (quit). Run it from this worktree:
#
#   ~/worktrees/pc-launch/scripts/launch.sh            # all steps, in order
#   ~/worktrees/pc-launch/scripts/launch.sh --from 5   # resume at a step (1-7)
#
# Steps (billing stays OFF through the deploy, as the runbook says; the webhook secret goes last):
#   1. Pre-checks: tools, git (launch-prep, clean, code == the tested commit), live version, secrets
#   2. Stripe LIVE catalog: product + prices pro_yearly ($24/yr) / pro_monthly ($2.99/mo), reused if
#      they exist; the Dashboard checklists (activation, customer portal) for the owner
#   3. Dry run: bundle, list the bindings, check them
#   4. Deploy launch-prep to pastecal-sync, then scripts/pro-smoke.sh --expect-deployed (billing off)
#   5. Secrets: STRIPE_SECRET_KEY, the two price ids, CONTACT_NOTIFY_TO, then the live webhook
#      endpoint and STRIPE_WEBHOOK_SECRET LAST (billing turns on), then pro-smoke --expect-billing
#   6. Post-checks: read-only curls, secrets list, the live webhook endpoint
#   7. Rollback notes and what to do after launch
#
# Secrets: never echoed, never written to disk, never in a command line. STRIPE_SECRET_KEY and
# CONTACT_NOTIFY_TO are typed into wrangler's own hidden prompt. Price ids are not secret. The
# webhook signing secret goes from `stripe` output straight into `wrangler secret put` through a pipe.
# A live Stripe key for the CLI (only if you have no `stripe login` live session) is read with a
# hidden prompt and handed to `stripe` in its environment (STRIPE_API_KEY), never as an argument.
# There is no `set -x` here, and there must never be.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CF="$ROOT/cloudflare"
WORKER="pastecal-sync"
SITE="https://pastecal.com"
WEBHOOK_URL="$SITE/api/stripe/webhook"
EXPECTED_LIVE="71aaca32"          # prod-counting-live 30001ea, live before the launch
# The commit whose code (cloudflare/src, wrangler.jsonc, public/) passed the full test run.
TESTED_CODE="71f5532"
LIVE_ACCOUNT="acct_1CN6CpEBwAK7H2Dz"
EVENTS="checkout.session.completed customer.subscription.created customer.subscription.updated customer.subscription.deleted customer.subscription.trial_will_end invoice.payment_failed charge.refunded charge.dispute.created"
NODE="${NODE:-$HOME/.nvm/versions/node/v22.18.0/bin/node}"
WRANGLER="$CF/node_modules/.bin/wrangler"
[ -e "$WRANGLER" ] || WRANGLER="$HOME/worktrees/pastecal-pro/cloudflare/node_modules/.bin/wrangler"
LOG="$HOME/pastecal-launch-$(date +%Y%m%d-%H%M%S).log"   # non-secret notes only (version ids, results)
FROM=1
[ "${1:-}" = "--from" ] && FROM="${2:-1}"

LIVE_CLI_KEY=""
trap 'unset LIVE_CLI_KEY WH' EXIT

# ---------------------------------------------------------------- helpers
B=$'\033[1m'; R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; N=$'\033[0m'
say()  { printf '%s\n' "$*"; }
ok()   { printf '%s  ok%s  %s\n' "$G" "$N" "$*"; }
warn() { printf '%s  !!%s  %s\n' "$Y" "$N" "$*"; }
bad()  { printf '%s  XX%s  %s\n' "$R" "$N" "$*"; }
note() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*" >> "$LOG"; }
die()  { bad "$*"; note "STOPPED: $*"; exit 1; }
wr()   { (cd "$CF" && "$NODE" "$WRANGLER" "$@"); }
yes_no() { local a; read -r -p "$1 [y/N] " a </dev/tty; [ "$a" = y ] || [ "$a" = Y ]; }
# step N "title" "what it does": returns 0 to run, 1 to skip; q quits.
step() {
    local n="$1" a
    [ "$n" -lt "$FROM" ] && return 1
    printf '\n%s== Step %s. %s%s\n%s\n' "$B" "$n" "$2" "$N" "$3"
    while true; do
        read -r -p "Run step $n? [y]es / [s]kip / [q]uit: " a </dev/tty
        case "$a" in y|Y) note "step $n: run"; return 0 ;; s|S) note "step $n: skipped"; return 1 ;; q|Q) note "quit at step $n"; exit 0 ;; esac
    done
}
# stripe in LIVE mode. stderr (the CLI's banner, errors) goes to $SERR so JSON stays clean.
SERR="$(mktemp)"; trap 'rm -f "$SERR"; unset LIVE_CLI_KEY WH' EXIT
st() {
    if [ -n "$LIVE_CLI_KEY" ]; then STRIPE_API_KEY="$LIVE_CLI_KEY" stripe "$@" 2>"$SERR"
    else stripe "$@" --live 2>"$SERR"; fi
}
st_err() { sed -e 's/sk_live_[A-Za-z0-9]*/sk_live_***/g; s/rk_live_[A-Za-z0-9]*/rk_live_***/g; s/whsec_[A-Za-z0-9]*/whsec_***/g' "$SERR" | tail -5; }
event_flags() { local e; for e in $EVENTS; do printf -- '--enabled-events=%s\n' "$e"; done; }

stripe_auth() {   # once per run: a live `stripe login` session, or a live key at a hidden prompt
    [ -n "${STRIPE_AUTH_DONE:-}" ] && return 0
    say "Stripe LIVE access. Either:"
    say "  l) the stripe CLI's own live session (you ran: stripe login, then stripe switch $LIVE_ACCOUNT --live)"
    say "  k) type a live secret key now (hidden; kept only in this process, passed via STRIPE_API_KEY)"
    local a; read -r -p "l or k: " a </dev/tty
    if [ "$a" = k ]; then
        read -rs -p "Live secret key (sk_live_... or rk_live_..., hidden): " LIVE_CLI_KEY </dev/tty; echo
        case "$LIVE_CLI_KEY" in sk_live_*|rk_live_*) ;; *) LIVE_CLI_KEY=""; die "not a live key (must start sk_live_ or rk_live_)";; esac
    else
        stripe whoami 2>/dev/null | sed -n '1,12p'
        say "It must show the live account $LIVE_ACCOUNT ('New business' / pastecal) in LIVE mode."
        yes_no "Is that the live pastecal account?" || die "switch first: stripe switch $LIVE_ACCOUNT --live"
    fi
    local probe lm; probe="$(st prices list --limit=1)" || probe=""
    lm="$(jq -r '.data[0].livemode | tostring' <<<"$probe" 2>/dev/null)"   # "true" | "false" | "null" (no prices)
    [ "$lm" = false ] && die "stripe answered in TEST mode; this script only works live"
    if [ -z "$probe" ]; then st_err; yes_no "The live probe call failed. Continue anyway (each later call still checks)?" || die "no live Stripe access"
    elif [ "$lm" = true ]; then ok "stripe answers in live mode"
    else ok "stripe reachable (no prices yet, so live mode is not provable from them; you confirmed the account)"; fi
    STRIPE_AUTH_DONE=1
}

price_id() { st prices list --lookup-keys="$1" --active=true | jq -er '.data[0].id // empty'; }

say "${B}pastecal Pro launch${N}   worktree: $ROOT   log (no secrets): $LOG"
note "launch.sh started in $ROOT at $(git -C "$ROOT" rev-parse --short HEAD)"

# ---------------------------------------------------------------- 1. pre-checks
if step 1 "Pre-checks" "Tools, git state, the live version (must be $EXPECTED_LIVE or a later secret-only change), and the Worker's secret names. Read-only."; then
    for t in git jq curl stripe python3; do command -v "$t" >/dev/null || die "$t is required"; done
    [ -x "$NODE" ] || die "node not found at $NODE (set NODE=)"
    [ -e "$WRANGLER" ] || die "wrangler not found (symlink cloudflare/node_modules from ~/worktrees/pastecal-pro/cloudflare/node_modules)"
    ok "tools: $(stripe version 2>/dev/null | head -1), wrangler $(wr --version 2>/dev/null | tail -1)"

    br="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"
    [ "$br" = launch-prep ] || die "on branch '$br', not launch-prep"
    [ -z "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ] || { git -C "$ROOT" status --short; die "uncommitted changes"; }
    git -C "$ROOT" merge-base --is-ancestor "$TESTED_CODE" HEAD || die "HEAD does not contain the tested commit $TESTED_CODE"
    git -C "$ROOT" diff --quiet "$TESTED_CODE" HEAD -- cloudflare/src cloudflare/wrangler.jsonc public \
        || { git -C "$ROOT" diff --stat "$TESTED_CODE" HEAD -- cloudflare/src cloudflare/wrangler.jsonc public; die "shipped code differs from the tested commit $TESTED_CODE: re-run the tests (docs/pro-launch.md) and update TESTED_CODE"; }
    ok "git: launch-prep at $(git -C "$ROOT" rev-parse --short HEAD), clean, code identical to tested $TESTED_CODE"
    note "git HEAD $(git -C "$ROOT" rev-parse HEAD)"

    wr whoami 2>/dev/null | grep -iE "logged in|account" | head -3
    deps="$(wr deployments status --name "$WORKER" --json 2>/dev/null)"
    live="$(jq -r '(if type=="array" then (sort_by(.created_on) | last) else . end) | .versions | max_by(.percentage) | .version_id // empty' <<<"$deps" 2>/dev/null)"
    if [ -z "$live" ]; then
        warn "could not read the live version as JSON; here is the list:"
        wr deployments list --name "$WORKER" | tail -20
        yes_no "Is the 100% version $EXPECTED_LIVE (or a later 'Secret Change' on top of it)?" || die "live version is not the expected one"
    elif [[ "$live" == "$EXPECTED_LIVE"* ]]; then
        ok "live version $live"
    else
        trig="$(wr versions view "$live" --name "$WORKER" --json 2>/dev/null | jq -r '.annotations["workers/triggered_by"] // empty' 2>/dev/null)"
        warn "live version is $live (triggered by: ${trig:-unknown}), not $EXPECTED_LIVE"
        wr versions list --name "$WORKER" 2>/dev/null | tail -24
        if [ "$trig" = secret ] || [ -z "$trig" ]; then
            # Empty: the annotation could not be read. A secret-only version (e.g. owner-setup.sh) is the likely case.
            yes_no "Is $live a 'Secret Change' on top of $EXPECTED_LIVE's code (see the Source column above)?" || die "live code moved: rebase launch-prep onto what is live, re-test"
        else
            die "a newer CODE upload is live (triggered by $trig): rebase launch-prep onto it and re-test before launching"
        fi
    fi
    note "live version before launch: ${live:-confirmed by hand}"

    secrets="$(wr secret list --name "$WORKER" 2>/dev/null | jq -r '.[].name' 2>/dev/null | sort | tr '\n' ' ')"
    say "  secret names on $WORKER: ${secrets:-<could not read>}"
    # Fail closed: production already holds these two, so a list without them was not read properly.
    case " $secrets " in *" IMPORT_SECRET "*) ;; *) wr secret list --name "$WORKER" --format pretty 2>&1 | tail -15
        yes_no "Could not confirm the secret list (no IMPORT_SECRET in it). Checked by eye: no ACCOUNTS_DEV_MODE, STRIPE_API_BASE, LOCK_API_BASE, UNSAFE_DEV_SESSION_HEADER?" || die "secret list unreadable";; esac
    for s in ACCOUNTS_DEV_MODE STRIPE_API_BASE LOCK_API_BASE UNSAFE_DEV_SESSION_HEADER BETA_REAL_DATA BILLING_TEST_MODE SITE_URL; do
        case " $secrets " in *" $s "*) die "$s is set on production: delete it first (wr secret delete $s --name $WORKER)";; esac
    done
    case " $secrets " in *" STRIPE_SECRET_KEY "*|*" STRIPE_WEBHOOK_SECRET "*) warn "Stripe secrets already exist: billing will be ON the moment step 4 deploys";; esac
    ok "no dev-only or staging-only setting on production"
fi

# ---------------------------------------------------------------- 2. Stripe live catalog
if step 2 "Stripe LIVE: product, prices, Dashboard checklists" "Reuses the live prices with lookup keys pro_yearly / pro_monthly if they exist (checks amount and interval), creates whatever is missing. Then the Dashboard-only settings, which you do by hand."; then
    stripe_auth
    for spec in "pro_yearly 2400 year Pro yearly" "pro_monthly 299 month Pro monthly"; do
        set -- $spec; key="$1"; amount="$2"; interval="$3"; nick="$4 $5"
        cur="$(st prices list --lookup-keys="$key" --active=true)" || { st_err; die "listing prices failed"; }
        if [ "$(jq '.data | length' <<<"$cur")" -gt 0 ]; then
            got="$(jq -r '.data[0] | [.id, .unit_amount, .currency, .recurring.interval, .product] | @tsv' <<<"$cur")"
            read -r pid pamt pcur pint pprod <<<"$got"
            [ "$pamt" = "$amount" ] && [ "$pcur" = usd ] && [ "$pint" = "$interval" ] \
                || die "live price $key exists but is $pamt $pcur/$pint, not $amount usd/$interval. Fix it in the Dashboard (new price + move the lookup key)"
            ok "reusing $key = $pid ($amount usd / $interval, product $pprod)"; PRODUCT="${PRODUCT:-$pprod}"
        else
            if [ -z "${PRODUCT:-}" ]; then
                PRODUCT="$(st products list --active=true --limit=100 | jq -r '[.data[] | select(.name=="pastecal Pro")][0].id // empty')"
                if [ -z "$PRODUCT" ]; then
                    yes_no "Create the live product 'pastecal Pro'?" || die "no product"
                    PRODUCT="$(st products create --name="pastecal Pro" --description="Lock your calendar: only you and people with your editor key can edit." | jq -er .id)" || { st_err; die "product create failed"; }
                    ok "created product $PRODUCT"
                else ok "reusing product $PRODUCT"; fi
            fi
            yes_no "Create live price $key: $amount usd every $interval on $PRODUCT?" || die "price $key missing"
            pid="$(st prices create --product="$PRODUCT" --currency=usd --unit-amount="$amount" "--recurring[interval]=$interval" --lookup-key="$key" --nickname="$nick" | jq -er .id)" || { st_err; die "price create failed"; }
            ok "created $key = $pid"
        fi
        note "price $key $pid"
    done

    cat <<EOF

${B}Dashboard, LIVE mode (the CLI cannot do these).${N} Tick each one off:
  Account (Settings -> Business):
    [ ] public business name: pastecal   statement descriptor: PASTECAL   support email: support@pastecal.com
    [ ] website https://pastecal.com; bank account verified; no "action required" banner
    [ ] customer emails: receipts + refunds on; failed-payment + upcoming-renewal reminders on
    [ ] Stripe Tax OFF (launch without collecting tax; watch Tax -> Registrations thresholds)
  Payment methods (Settings -> Payment methods): ${B}card only${N} (turn the others off)
  Branding + public details: icon, color; ${B}privacy${N} https://pastecal.com/privacy  ${B}terms${N} https://pastecal.com/terms
  Customer portal (Settings -> Billing -> Customer portal) -> Save, so it becomes the default:
    [ ] customers can update payment methods
    [ ] cancellations allowed, at the END of the billing period, no prorations
    [ ] invoice history on;  switching plans OFF at launch
    [ ] business name pastecal; privacy + terms links as above; default redirect https://pastecal.com/
  Restricted API key for the Worker (Developers -> API keys -> Create restricted key "pastecal-sync Worker"):
    Checkout Sessions: Write, Customer portal: Write, Subscriptions: Write, Customers: Write (the
    30-day trial creates the customer + subscription directly), Invoices: Read, Charges: Read,
    Refunds: Write -- nothing else. Keep it ready for step 5; paste it nowhere else.
EOF
    yes_no "All done in the Dashboard?" || die "finish the Dashboard checklist, then re-run with --from 2"
    portal="$(st billing_portal configurations list)" || { st_err; warn "could not read portal configurations"; portal='{}'; }
    jq -r '.data[]? | "  portal \(.id): default=\(.is_default) cancel=\(.features.subscription_cancel.mode // "off") switch=\(.features.subscription_update.enabled) pm_update=\(.features.payment_method_update.enabled)"' <<<"$portal"
    jq -e '.data[]? | select(.is_default and .features.subscription_cancel.mode=="at_period_end")' <<<"$portal" >/dev/null \
        && ok "default portal cancels at period end" || warn "no default portal that cancels at period end: save the portal settings in the Dashboard"
fi

# ---------------------------------------------------------------- 3. dry run
if step 3 "Dry run" "Bundles launch-prep for $WORKER without uploading, and checks the binding list."; then
    out="$(mktemp -d)"
    dry="$(wr deploy --dry-run --env="" --outdir "$out" 2>&1)"; rc=$?
    rm -rf "$out"
    grep -E 'env\.|Total Upload' <<<"$dry"
    [ $rc -eq 0 ] || { tail -20 <<<"$dry"; die "dry run failed"; }
    for b in 'env.CALENDARS (CalendarRoom)' 'env.DIRECTORY (CalendarDirectory)' 'env.WAITLIST (Waitlist)' 'env.ACCOUNTS (Accounts)' \
             'env.EMAIL' 'env.BACKUPS (pastecal-backups)' 'env.EVENTS (pastecal_events)' 'env.CREATE_LIMITER' 'env.COLLECT_LIMITER' \
             'env.ASSETS' 'env.FIREBASE_DB_URL ("https://pastecal-web-default-rtdb' 'env.COPY_BACK ("*")'; do
        grep -qF "$b" <<<"$dry" || die "binding missing from the dry run: $b"
    done
    for b in BETA_REAL_DATA BILLING_TEST_MODE ACCOUNTS_DEV_MODE SITE_URL staging; do
        grep -q "$b" <<<"$(grep 'env\.' <<<"$dry")" && die "the production bundle carries $b"
    done
    ok "bindings: live's nine (CALENDARS DIRECTORY WAITLIST BACKUPS EVENTS CREATE_LIMITER ASSETS FIREBASE_DB_URL COPY_BACK) + ACCOUNTS, EMAIL, COLLECT_LIMITER; no staging/dev vars"
    say "  New on this deploy: Durable Object class Accounts (migration v4, ONE-WAY: no wrangler rollback across it)."
    yes_no "Bindings look right?" || die "stopped at the dry run"
fi

# ---------------------------------------------------------------- 4. deploy
if step 4 "Deploy launch-prep to $WORKER" "Uploads and deploys to pastecal.com (100%, all at once). Billing stays off until step 5. Then runs scripts/pro-smoke.sh --expect-deployed."; then
    say "  ${R}This changes production.${N} Migration v4 (Accounts) is one-way."
    yes_no "Deploy now?" || die "not deployed"
    dep="$(wr deploy --env="" --message "Pro launch: launch-prep $(git -C "$ROOT" rev-parse --short HEAD) (billing off until secrets)" 2>&1)"; rc=$?
    tail -15 <<<"$dep"
    [ $rc -eq 0 ] || die "deploy failed (production is unchanged unless the output says otherwise)"
    newv="$(grep -Eo 'Current Version ID: [0-9a-f-]+' <<<"$dep" | awk '{print $4}')"
    ok "deployed version ${newv:-<see output>}"; note "deployed version ${newv:-unknown}"
    say "  Waiting 15 s for the edge to pick it up..."; sleep 15
    (cd "$ROOT" && bash scripts/pro-smoke.sh --expect-deployed) && ok "smoke (billing off) passed" || warn "smoke test reported failures: read them before step 5 (rollback: step 7)"
fi

# ---------------------------------------------------------------- 5. secrets
if step 5 "Turn billing on: secrets, then the live webhook" "STRIPE_SECRET_KEY (wrangler's hidden prompt), STRIPE_PRICE_PRO_YEARLY/MONTHLY (looked up live), CONTACT_NOTIFY_TO (hidden prompt), then the live webhook endpoint $WEBHOOK_URL and STRIPE_WEBHOOK_SECRET LAST. Each takes effect immediately."; then
    stripe_auth
    say "5a. STRIPE_SECRET_KEY: paste the restricted live key at wrangler's hidden prompt."
    if yes_no "Set STRIPE_SECRET_KEY now?"; then
        wr secret put STRIPE_SECRET_KEY --name "$WORKER" </dev/tty || die "secret put failed"
        command -v pbcopy >/dev/null && pbcopy </dev/null   # in case it was on the clipboard
        note "secret STRIPE_SECRET_KEY set"
    fi
    say "5b. Price ids (not secret)."
    for pair in "STRIPE_PRICE_PRO_YEARLY pro_yearly" "STRIPE_PRICE_PRO_MONTHLY pro_monthly"; do
        set -- $pair
        p="$(price_id "$2")" || true
        [ -n "$p" ] || { st_err; die "no live price with lookup key $2 (step 2)"; }
        say "  $1 = $p"
        if yes_no "  Set $1?"; then printf '%s' "$p" | wr secret put "$1" --name "$WORKER" >/dev/null || die "secret put $1 failed"; ok "$1 set"; note "secret $1 = $p"; fi
    done
    say "5c. CONTACT_NOTIFY_TO: the address that gets one email per contact-form message (hidden prompt)."
    if yes_no "Set CONTACT_NOTIFY_TO now?"; then wr secret put CONTACT_NOTIFY_TO --name "$WORKER" </dev/tty || die "secret put failed"; note "secret CONTACT_NOTIFY_TO set"; fi

    say "5d. The live webhook endpoint (billing turns on when its secret is stored)."
    eps="$(st webhook_endpoints list --limit=100)" || { st_err; die "listing webhook endpoints failed"; }
    we="$(jq -r --arg u "$WEBHOOK_URL" '[.data[] | select(.url==$u)][0].id // empty' <<<"$eps")"
    # shellcheck disable=SC2046
    if [ -z "$we" ]; then
        yes_no "Create the live endpoint $WEBHOOK_URL with the 8 events and store its secret?" || die "no webhook: billing stays off"
        WH="$(st webhook_endpoints create --url="$WEBHOOK_URL" --description="pastecal Pro (Worker pastecal-sync)" $(event_flags) | jq -er '.secret // empty')" || true
        case "${WH:-}" in
            whsec_*) printf '%s' "$WH" | wr secret put STRIPE_WEBHOOK_SECRET --name "$WORKER" >/dev/null && ok "STRIPE_WEBHOOK_SECRET set: billing is ON" || die "secret put failed: roll the endpoint's secret in the Dashboard, then: pbpaste | wr secret put STRIPE_WEBHOOK_SECRET --name $WORKER" ;;
            *) st_err; die "no signing secret came back. The endpoint may exist without its secret: re-run --from 5 (it will find it)" ;;
        esac
        unset WH; note "webhook endpoint created; STRIPE_WEBHOOK_SECRET set"
    else
        say "  Found $we for $WEBHOOK_URL. Making sure it is enabled with exactly the 8 events..."
        st webhook_endpoints update "$we" -d disabled=false $(event_flags) | jq -r '"  \(.id) status=\(.status) events=\(.enabled_events | join(","))"' || { st_err; die "update failed"; }
        say "  Stripe shows a signing secret only when an endpoint is created. Choose:"
        say "    r) Dashboard -> Developers -> Webhooks -> this endpoint -> Roll secret, copy it, then I pipe the clipboard in"
        say "    d) delete this endpoint and create a new one (its secret is piped in directly)"
        say "    k) keep: STRIPE_WEBHOOK_SECRET on $WORKER already holds this endpoint's current secret"
        read -r -p "  r / d / k: " a </dev/tty
        case "$a" in
            r) read -r -p "  Rolled and copied? [enter] " _ </dev/tty
               pbpaste | wr secret put STRIPE_WEBHOOK_SECRET --name "$WORKER" >/dev/null && pbcopy </dev/null && ok "STRIPE_WEBHOOK_SECRET set: billing is ON" || die "secret put failed"
               note "webhook $we secret rolled; STRIPE_WEBHOOK_SECRET set" ;;
            d) yes_no "  Delete $we and recreate?" || die "stopped"
               st webhook_endpoints delete "$we" --confirm >/dev/null || { st_err; die "delete failed"; }
               WH="$(st webhook_endpoints create --url="$WEBHOOK_URL" --description="pastecal Pro (Worker pastecal-sync)" $(event_flags) | jq -er '.secret // empty')" || true
               case "${WH:-}" in whsec_*) printf '%s' "$WH" | wr secret put STRIPE_WEBHOOK_SECRET --name "$WORKER" >/dev/null && ok "STRIPE_WEBHOOK_SECRET set: billing is ON" || die "secret put failed";; *) st_err; die "no signing secret came back";; esac
               unset WH; note "webhook recreated; STRIPE_WEBHOOK_SECRET set" ;;
            *) ok "kept the existing webhook secret"; note "webhook $we kept" ;;
        esac
    fi
    say "  Waiting 10 s..."; sleep 10
    (cd "$ROOT" && bash scripts/pro-smoke.sh --expect-billing) && ok "smoke (billing on) passed" || warn "smoke test reported failures: see step 7 (g1/g2 kill switches)"
fi

# ---------------------------------------------------------------- 6. post-checks
if step 6 "Post-checks (read-only)" "GETs against pastecal.com (curl's user agent is a bot, so nothing is counted), the secret names, and the live webhook endpoint."; then
    code() { curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$@"; }
    title() { curl -s --max-time 20 "$1" | grep -o '<title>[^<]*' | head -1 | sed 's/<title>//'; }
    for p in / /pricing /contact; do
        c="$(code "$SITE$p")"; t="$(title "$SITE$p")"
        [ "$c" = 200 ] && ok "$p $c  '$t'" || bad "$p $c"
    done
    # demo is a view-only NAME: /cal/view/<name> resolves it through the directory (index.js, route 5).
    c="$(code "$SITE/cal/view/demo")"; [ "$c" = 200 ] && ok "/cal/view/demo $c" || warn "/cal/view/demo $c (was it 200 before the deploy? if so, investigate)"
    ics="$(curl -s -D - -o /dev/null --max-time 20 "$SITE/demo.ics" | tr -d '\r')"
    grep -q '^HTTP/[0-9.]* 200' <<<"$ics" && grep -qi '^content-type: text/calendar' <<<"$ics" && ok "/demo.ics 200 text/calendar" || bad "/demo.ics: $(head -1 <<<"$ics")"
    st_json="$(curl -s --max-time 20 "$SITE/api/pro/status?calendar=demo")"
    if jq -e 'has("locked") and has("pro")' <<<"$st_json" >/dev/null 2>&1; then ok "/api/pro/status?calendar=demo $(jq -c . <<<"$st_json")"
    elif jq -e . <<<"$st_json" >/dev/null 2>&1; then warn "/api/pro/status?calendar=demo answered JSON without locked/pro (a view name may not resolve): ${st_json:0:120}; pro-smoke's calendar=test check is the authoritative one"
    else bad "/api/pro/status did not answer JSON: ${st_json:0:120}"; fi
    c="$(code "$SITE/api/admin/cal/x/stats-dump")"; [ "$c" = 403 ] && ok "stats-dump $c (dev hooks off)" || bad "stats-dump answered $c, expected 403"
    c="$(code -X POST -H 'Content-Type: application/json' --data '{}' "$WEBHOOK_URL")"; ok "webhook with no signature: $c (400 = billing on, 503 = off)"
    secrets="$(wr secret list --name "$WORKER" 2>/dev/null | jq -r '.[].name' 2>/dev/null | sort | tr '\n' ' ')"
    say "  secrets: ${secrets:-<could not read>}"
    case " $secrets " in *" IMPORT_SECRET "*) ;; *) bad "secret list unreadable: check by eye with: wr secret list --name $WORKER --format pretty";; esac
    for s in STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET STRIPE_PRICE_PRO_YEARLY STRIPE_PRICE_PRO_MONTHLY CONTACT_NOTIFY_TO; do
        case " $secrets " in *" $s "*) ;; *) warn "$s is not set";; esac
    done
    for s in ACCOUNTS_DEV_MODE STRIPE_API_BASE LOCK_API_BASE UNSAFE_DEV_SESSION_HEADER; do
        case " $secrets " in *" $s "*) bad "$s is set on production";; esac
    done
    stripe_auth
    st webhook_endpoints list --limit=100 | jq -r --arg u "$WEBHOOK_URL" '.data[] | select(.url==$u) | "  live webhook \(.id): status=\(.status) events=\(.enabled_events|length) api_version=\(.api_version // "account default")"' || st_err
    say "  Also: wr tail $WORKER --format pretty --search accounts   (10 minutes, no [accounts] or [stats] errors)"
    say "  Then the one real purchase + refund in docs/pro-launch.md (f) 4-5."
fi

# ---------------------------------------------------------------- 7. rollback + after
step 7 "Rollback notes and after launch" "Prints only." && cat <<EOF

${B}Rollback.${N} Start with the kill switches, which take seconds and keep the deploy:
  Stop new sales:     wr secret delete STRIPE_PRICE_PRO_YEARLY --name $WORKER; wr secret delete STRIPE_PRICE_PRO_MONTHLY --name $WORKER
  All billing off:    wr secret delete STRIPE_SECRET_KEY --name $WORKER   (Stripe retries webhooks for 3 days)

Code rollback to the pre-launch version $EXPECTED_LIVE:
  wrangler rollback --name $WORKER $EXPECTED_LIVE
  ${R}Cloudflare refuses that one${N}: this deploy added the Accounts Durable Object class (migration v4), and
  rollbacks cannot cross a Durable Object migration. Use instead the forward rollback build, which is
  production's code (prod-counting-live) with the Accounts class kept (branch rollback-prep, tested:
  dry run + a room written by launch-prep reads identically there):
    cd ~/worktrees/pc-rollback/cloudflare && $NODE $WRANGLER deploy --env="" --message "rollback: pre-Pro code, Accounts kept"
  Caveat: that code does not enforce Pro locks (paid calendars become editable by their edit name) and
  has no billing routes, so turn billing off first (above) and tell any paying owners.
  Between two versions AFTER this deploy, wrangler rollback works:  wr deployments list --name $WORKER; wr rollback <version-id> --name $WORKER

${B}After launch.${N}
  - Fast-forward master to launch-prep. origin/master is an ancestor, so this is a fast-forward on GitHub:
        git -C $ROOT push origin launch-prep:master
    Your LOCAL master has an unpushed commit 94ad206 ("Production as deployed: ...", a snapshot of the
    Dropbox checkout, not what is live). Keep it before moving master:
        git branch dropbox-snapshot-94ad206 94ad206 && git branch -f master launch-prep
  - prod-counting-live / DEPLOY-COUNTING.md are history now: production runs launch-prep.
  - ./scripts/stats.sh trials -d 7     (trial funnel, first-party)    ./scripts/stats.sh health
EOF
note "done"
say; ok "launch.sh finished. Notes (no secrets): $LOG"
