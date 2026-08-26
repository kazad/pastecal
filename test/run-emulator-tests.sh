#!/usr/bin/env bash
# Runs the Database-emulator-backed unit tests and reports pass/fail from node's own
# per-test TAP lines, not from `firebase emulators:exec`'s exit code or its final summary.
#
# Why not the exit code: emulators:exec has been observed (4/4 runs while writing this
# script) to exit non-zero AND hang for 3+ minutes in Database-emulator teardown, on runs
# where every wrapped test reported "ok". The hang required a manual `kill -9` every time.
# Trusting that exit code makes `npm run test:unit` cry wolf on green runs, which defeats
# the point of a smoke test meant to be trusted in a pre-deploy check.
#
# Why not the "# fail N" summary line either: the same teardown hang happens WHILE node's
# test runner is flushing output, so the run gets killed (see `timeout` below) before the
# final TAP summary block is ever written — even though every individual test already
# printed its "ok"/"not ok" result. Depending on the summary means every run reads as
# "crashed before producing a summary", indistinguishable from a real crash.
#
# So: count "ok N" / "not ok N" lines directly against the known number of test files'
# worth of tests, and treat "every test that reported a result reported ok, and at least
# one did" as pass — independent of whether the process was later killed by the timeout.
set -uo pipefail

cd "$(dirname "$0")/.."

# --- Java ------------------------------------------------------------------------------
# The Database emulator is a Java program, and firebase-tools requires JDK 21+. When the
# default `java` is older it refuses to start, and every test in this file silently never
# runs -- which is exactly how the 2026-08-25 lookupCalendar OOM outage reached production
# with a green-looking local suite: this machine's default java was 19, and the only signal
# was a JDK message buried above a "no test results" line.
#
# So: find a new-enough JDK ourselves (Homebrew installs one but does not put it on PATH),
# and if there genuinely isn't one, say so in those words rather than reporting it as a
# test failure.
java_major() {
    "$1" -version 2>&1 | head -1 | sed -E 's/.*version "([0-9]+).*/\1/'
}

JAVA_OK=""
default_java="none"
command -v java >/dev/null 2>&1 && default_java="$(java_major java)"

if [ "$default_java" != "none" ] && [ "$default_java" -ge 21 ] 2>/dev/null; then
    JAVA_OK="system"
else
    for candidate in /opt/homebrew/opt/openjdk/bin/java /usr/local/opt/openjdk/bin/java \
                     /Library/Java/JavaVirtualMachines/*/Contents/Home/bin/java; do
        if [ -x "$candidate" ] && [ "$(java_major "$candidate")" -ge 21 ] 2>/dev/null; then
            export JAVA_HOME="$(dirname "$(dirname "$candidate")")"
            export PATH="$JAVA_HOME/bin:$PATH"
            JAVA_OK="$JAVA_HOME"
            echo "Using JDK $(java_major "$candidate") from $JAVA_HOME (default java is $default_java, too old)."
            break
        fi
    done
fi

if [ -z "$JAVA_OK" ]; then
    echo "ERROR: the Database emulator needs a JDK 21+ and none was found."
    echo
    echo "  These tests cover the Cloud Functions that talk to the database. Skipping them"
    echo "  is how an OOM in lookupCalendar reached production once already, so this is a"
    echo "  hard failure rather than a skip."
    echo
    echo "  Fix:  brew install openjdk"
    exit 1
fi

LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT

# The timeout covers emulator STARTUP (~30-60s, JVM boot) plus the tests plus the teardown
# hang, not just the tests -- so a budget sized for the tests alone silently truncates the
# run. Scale it with the number of files and leave generous room for startup.
# Each file holds the RTDB connection open after its tests finish, so node's runner waits
# out a per-file drain before moving on -- the wall time is dominated by that, not by the
# assertions. 90s per file plus emulator startup is comfortable; anything tighter starts
# truncating the run, which this script then (correctly) reports as a failure.
FILE_COUNT="$(ls test/unit/*.emulator.test.js 2>/dev/null | wc -l | tr -d ' ')"
TIMEOUT=$((120 + FILE_COUNT * 90))

# One `node --test` for ALL files, not a loop over them: the Admin SDK holds an open RTDB
# connection, so a per-file invocation never exits and the loop hangs on the first file.
timeout "$TIMEOUT" firebase emulators:exec --only database "node --test test/unit/*.emulator.test.js" \
    > "$LOG" 2>&1
emulators_exit=$?

cat "$LOG"

ok_count="$(grep -cE '^ok [0-9]+ ' "$LOG")"
not_ok_count="$(grep -cE '^not ok [0-9]+ ' "$LOG")"

# Reporting PASSED on a partial run is how a silently-skipped suite lets a regression
# through -- the lookupCalendar OOM shipped that way. Neither the exit code nor node's
# "1..N" plan survives the teardown hang, so instead assert that at least one test from
# EVERY file reported. Each file contributes a distinct, stable test name.
MARKERS=(
    "SlugService.lookupCalendar"      # lookup-calendar.emulator.test.js
    "deviceBucket:"                   # ics-device-buckets.emulator.test.js
)
missing=()
for m in "${MARKERS[@]}"; do
    grep -qE "^(ok|not ok) [0-9]+ - .*${m}" "$LOG" || missing+=("$m")
done

if [ "${#missing[@]}" -gt 0 ]; then
    echo
    echo "ERROR: no results from ${#missing[@]} of ${#MARKERS[@]} emulator test group(s): ${missing[*]}"
    echo "       (exit $emulators_exit, timeout ${TIMEOUT}s, $FILE_COUNT file(s) on disk)."
    echo "       $ok_count test(s) passed before the run was cut short — treating as a"
    echo "       failure, not a pass."
    [ "$emulators_exit" = "124" ] && echo "       Exit 124 is the timeout: raise TIMEOUT in this script."
    echo "       If you added a test file, add a marker for it to MARKERS above."
    exit 1
fi

if [ "$not_ok_count" -gt 0 ]; then
    echo
    echo "FAILED: $not_ok_count emulator test(s) reported 'not ok'."
    exit 1
fi

if [ "$ok_count" -eq 0 ]; then
    echo
    echo "ERROR: no test results (no 'ok N' lines) found in the output above."
    echo "       Nothing ran, or the process was killed before any test reported —" \
         "treating as a failure (emulators:exec exit code / timeout status: $emulators_exit)."
    exit 1
fi

echo
echo "PASSED: all $ok_count emulator-backed test(s) reported ok."
if [ "$emulators_exit" -ne 0 ]; then
    echo "(note: emulators:exec itself exited non-zero [$emulators_exit] during teardown —" \
         "known-flaky, ignored; see comment at the top of this script.)"
fi
exit 0
