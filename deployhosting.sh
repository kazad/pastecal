#!/usr/bin/env bash
# Hosting-only deploy. Goes through deploy.sh so it is gated on the tests like every other
# deploy (this used to call `firebase deploy` directly and skip them).
exec "$(dirname "$0")/deploy.sh" "$@" hosting
