#!/usr/bin/env python3
"""Stop Firebase view copies from publishing edit names (security fix, Oct 25 2026).

/calendars_readonly/<viewId> is world-readable. Copies written before the whitelist fix in
functions/index.js (PublicViewService.mirrorOf) still carry `id` = the calendar's EDIT name, so anyone
with a view link could read the edit name and get edit access. 9,330 of 9,365 copies did.

For each such copy this records who owns the view the way PublicViewService.claim does
(/public_views/<viewId> = calendarId, /public_views_by_calendar/<calendarId>/<viewId> = true), so
syncPublicView keeps updating it, then replaces `id` with the view's own id.

    python3 scripts/fix-view-mirrors.py backup.json            # dry run: counts only
    python3 scripts/fix-view-mirrors.py backup.json --apply    # writes, in batches

backup.json is a full download of /calendars_readonly (keep it: it is the undo). Admin access comes from
your gcloud login, as in scripts/health.py.
"""
import json, re, subprocess, sys, time, urllib.request

DB = 'https://pastecal-web-default-rtdb.firebaseio.com'
SAFE = re.compile(r'^[^.#$\[\]/\x00-\x1f\x7f]{1,200}$')   # a valid Firebase key


def token():
    return subprocess.run(['gcloud', 'auth', 'print-access-token'], capture_output=True, text=True).stdout.strip().splitlines()[-1]


def call(method, path, body=None, tries=5):
    for attempt in range(tries):   # a dropped connection or DNS blip: the writes are idempotent, so retry
        try:
            return _call(method, path, body)
        except Exception:
            if attempt == tries - 1:
                raise
            time.sleep(2 * (attempt + 1))


def _call(method, path, body=None):
    req = urllib.request.Request(f'{DB}{path}.json?access_token={token()}', method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read() or b'null')


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    apply = '--apply' in sys.argv
    copies = json.load(open(sys.argv[1]))
    bindings = call('GET', '/public_views') or {}
    todo, skipped = [], []
    for view, v in copies.items():
        if not isinstance(v, dict) or v.get('id') in (None, view):
            continue
        cal = v.get('id')
        if not (isinstance(cal, str) and SAFE.match(cal) and SAFE.match(view)):
            skipped.append(view)
            continue
        if bindings.get(view) not in (None, cal):
            skipped.append(view)   # bound to another calendar already: leave the binding, still hide the id below
        todo.append((view, cal))
    print(f'copies: {len(copies)}  publishing an edit name: {len(todo) + len(skipped)}  fixable: {len(todo)}  odd keys skipped: {len(skipped)}')
    if not apply:
        print('dry run: nothing written. Add --apply to fix.')
        return
    done = 0
    for i in range(0, len(todo), 300):
        patch = {}
        for view, cal in todo[i:i + 300]:
            if bindings.get(view) is None:
                patch[f'public_views/{view}'] = cal
                patch[f'public_views_by_calendar/{cal}/{view}'] = True
            patch[f'calendars_readonly/{view}/id'] = view
        call('PATCH', '/', patch)   # the root: '/.json', not '.json' on the hostname
        done += min(300, len(todo) - i)
        print(f'  fixed {done}/{len(todo)}')
    # Odd keys: still hide the edit name, without touching bindings.
    for view in skipped:
        if SAFE.match(view):
            call('PATCH', f'/calendars_readonly/{view}', {'id': view})
    print('done')


if __name__ == '__main__':
    main()
