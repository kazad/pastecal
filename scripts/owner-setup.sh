#!/bin/bash
# One-time owner setup for pastecal. Each step asks first; press Enter to skip.
# Nothing here deploys code. Secrets are typed into the tool's own prompt and never printed.
set -u
export PATH="$HOME/.nvm/versions/node/v22.18.0/bin:$PATH"
PRO="$HOME/worktrees/pastecal-pro"
CF="$PRO/cloudflare"
W="$CF/node_modules/.bin/wrangler"

ask() { read -r -p "$1 [y/N] " a; [ "$a" = "y" ] || [ "$a" = "Y" ]; }
step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

step "1. Contact form emails you (preview)"
echo "Each message sent through /contact is emailed to this address. Stored as a secret, never in the repo."
if ask "Set it now?"; then
  read -r -p "Email address to receive contact messages: " to
  if [ -n "$to" ]; then
    (cd "$CF" && printf '%s' "$to" | "$W" secret put CONTACT_NOTIFY_TO --env staging --config wrangler.jsonc) && echo "Done."
  fi
fi

step "2. Google Analytics: allow creating the add_via dimension"
echo "Opens a browser to sign in to Google with the analytics edit scope, then registers add_via in GA4."
if ask "Do it now?"; then
  gcloud auth application-default login \
    --scopes=https://www.googleapis.com/auth/analytics.edit,https://www.googleapis.com/auth/analytics.readonly,https://www.googleapis.com/auth/cloud-platform \
    && (cd "$PRO" && ./scripts/stats.sh setup --create)
fi

step "3. backup.sh reads the new secret from your Keychain"
echo "Your untracked scripts/backup.sh still has the old (now dead) secret hardcoded."
BK="$HOME/Dropbox/computer/Projects/pastecal/scripts/backup.sh"
if [ -f "$BK" ] && grep -q 'IMPORT_SECRET:-[0-9a-f]\{16,\}' "$BK"; then
  if ask "Replace the hardcoded value with a Keychain lookup?"; then
    cp "$BK" "$BK.bak"
    sed -i '' -E 's/IMPORT_SECRET="\$\{IMPORT_SECRET:-[0-9a-f]+\}"/IMPORT_SECRET="${IMPORT_SECRET:-$(security find-generic-password -s pastecal-import-secret -w)}"/' "$BK"
    grep -q 'security find-generic-password' "$BK" && echo "Done (backup at backup.sh.bak)." || echo "Didn't match; left unchanged."
  fi
else
  echo "Nothing to do."
fi

step "4. Check the Firebase sync function uses the new secret"
echo "Shows the secret versions; the sync function was redeployed after version 3 was created."
if ask "Show it?"; then
  (cd "$HOME/Dropbox/computer/Projects/pastecal" && firebase functions:secrets:get CLOUDFLARE_IMPORT_SECRET --project pastecal-web)
fi

printf '\n\033[1mAll set.\033[0m Live Stripe setup waits for launch day (the live webhook needs the Pro code in production first).\n'
