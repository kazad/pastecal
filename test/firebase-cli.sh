# Sourced by the test runners: sets FIREBASE to the firebase-tools command to run.
#
# The emulator suites used to need a globally installed `firebase`, at whatever version
# that machine happened to have -- so a fresh clone or a CI runner could not run them, and
# two machines could disagree about the emulator itself. The pinned version below is what
# CI runs (via npx, nothing global), and what any machine without `firebase` on PATH gets.
# Under CI the pinned version is used even if a global one exists.
FIREBASE_TOOLS_VERSION="15.32.1"

if [ -z "${CI:-}" ] && command -v firebase >/dev/null 2>&1; then
    FIREBASE=(firebase)
else
    FIREBASE=(npx --yes "firebase-tools@${FIREBASE_TOOLS_VERSION}")
fi
