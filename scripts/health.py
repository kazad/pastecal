#!/usr/bin/env python3
"""
pastecal health check -- read-only, about a minute, a fraction of a cent.

    ./scripts/stats.sh health            (or: python3 scripts/health.py)

Answers "is anything wrong right now?" from the places the truth lives:
  1. the calendars on Cloudflare: when each was last edited (its daily R2 backup, rewritten on every change,
     listed with the `cf` CLI), and for the ones edited in the last 24h their history and events (GET /cal/<id>,
     read-only; its User-Agent pastecal-health keeps these reads out of visit counts, cloudflare/src/Bots.js)
  2. Google Analytics (errors by message, refused changes, blocked saves) -- via stats.sh
  3. the daily full archive (R2 archive/daily/<date>.json.gz, cloudflare/src/BackupArchive.js): GET
     /api/admin/backup/health (Bearer IMPORT_SECRET, from the env or the Keychain item pastecal-import-secret,
     never printed) -- missing, over 26h old, or under 95% of the directory's calendars is ATTENTION. Without
     the secret, only the newest file's age is checked (from the R2 listing).
  4. name collisions: GET /api/admin/directory/collisions?scope=self (same secret) -- a view link named after its own
     calendar, whose edit link then forwards to the view, is ATTENTION (repair: scripts/fix-name-collisions.mjs).

Anything that needs a person is printed first, under ATTENTION. deploy.sh runs this after
every hosting deploy, because a bad release shows up here within minutes (Sep 26: a series
edit that saved as a delete would have shown as an orphaned occurrence).

Cheap by design: history is fetched only for calendars edited in the last 24h and only
entries from the last 24h; calendars only if edited in the last 24h.
"""
import json, os, subprocess, sys, time, urllib.error, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor

SITE = 'https://pastecal.com'
BUCKET = 'pastecal-backups'
HERE = os.path.dirname(os.path.abspath(__file__))
NOW = time.time() * 1000
H = 3600 * 1000

attention = []
def flag(msg): attention.append(msg)

def ga(body):
    out = subprocess.run([os.path.join(HERE, 'stats.sh'), 'raw', json.dumps(body)], capture_output=True, text=True)
    try:
        d = json.loads(out.stdout)
    except Exception:
        return None
    return [([x['value'] for x in r.get('dimensionValues', [])], [x['value'] for x in r.get('metricValues', [])]) for r in d.get('rows', [])]

def is_test(cal_id): return cal_id.lower().startswith('test-')

# ---------------------------------------------------------------- 1. edits (Cloudflare)
# Each calendar's daily backup (snapshots/<id>/<day>.json) is rewritten after every change, so the newest
# one's last_modified is when the calendar was last edited (backups began Oct 22 2026).
def r2_list(prefix):
    out, after = [], None
    while True:
        cmd = ['cf', 'r2', 'objects', 'list', '--bucket-name', BUCKET, '--prefix', prefix, '--per-page', '1000']
        if after: cmd += ['--start-after', after]
        page = json.loads(subprocess.run(cmd, capture_output=True, text=True, check=True).stdout or '[]')
        out += page
        if len(page) < 1000: return out
        after = page[-1]['key']

def ms(iso): return time.mktime(time.strptime(iso[:19], '%Y-%m-%dT%H:%M:%S')) * 1000 - time.timezone * 1000

def site_get(path):
    with urllib.request.urlopen(urllib.request.Request(f'{SITE}{path}', headers={'User-Agent': 'pastecal-health'}), timeout=60) as r:
        return json.loads(r.read())

stamps = {}
for o in r2_list('snapshots/'):
    parts = o['key'].split('/')
    cal_id = urllib.parse.unquote(parts[1]) if len(parts) == 3 else None
    if not cal_id or is_test(cal_id) or len(parts[2]) != len('YYYY-MM-DD.json'): continue   # restore points are not edits
    stamps[cal_id] = max(stamps.get(cal_id, 0), ms(o['last_modified']))
within = lambda hours: [k for k, t in stamps.items() if NOW - t < hours * H]
recent = within(24)
edits = {'1h': len(within(1)), '24h': len(recent), '7d': len(within(24 * 7))}
if edits['7d'] and edits['24h'] < 0.4 * edits['7d'] / 7:
    flag(f"edits are down: {edits['24h']} calendars edited in 24h vs ~{edits['7d'] / 7:.0f}/day this week")

# ---------------------------------------------------------------- 2. history + integrity (Cloudflare)
def history_24h(cal_id):
    try:
        # The newest 20 entries; the last day is never more than a few.
        rows = site_get(f'/cal/{urllib.parse.quote(cal_id, safe="")}/history') or []
    except Exception:
        return cal_id, []
    return cal_id, [{k: v.get(k) for k in ('kind', 'removed', 'changed', 'added', 'savedAt', 'eventCount', 'title')} for v in rows
                    if isinstance(v, dict) and NOW - (v.get('savedAt') or 0) < 24 * H]

def events_of(cal_id):
    try:
        v = (site_get(f'/cal/{urllib.parse.quote(cal_id, safe="")}') or {}).get('calendar', {}).get('events')
    except Exception:
        return cal_id, None
    return cal_id, [e for e in (v if isinstance(v, list) else list((v or {}).values())) if e]

with ThreadPoolExecutor(12) as pool:
    histories = dict(pool.map(history_24h, recent))
    calendars = dict(pool.map(events_of, recent))

kinds, removed_by_cal = {}, {}
for cal_id, rows in histories.items():
    for r in rows:
        kinds[r.get('kind') or '?'] = kinds.get(r.get('kind') or '?', 0) + 1
        removed_by_cal[cal_id] = removed_by_cal.get(cal_id, 0) + (r.get('removed') or 0)
# A whole calendar emptied, or its title cleared. A new calendar deleting its one sample
# event also counts as "wiped", so only calendars that held real data are flagged.
for cal_id, rows in histories.items():
    for r in rows:
        if r.get('kind') == 'wiped' and (r.get('eventCount') or 0) >= 3:
            flag(f"/{cal_id}: every event removed ({r.get('eventCount')} before) -- check it was deliberate")
        if r.get('kind') == 'title-cleared' and (r.get('title') or '') not in ('', 'New Calendar'):
            flag(f"/{cal_id}: title \"{r.get('title')}\" was cleared")
big_removals = sorted([(n, c) for c, n in removed_by_cal.items() if n >= 10], reverse=True)
for n, c in big_removals:
    flag(f'/{c}: {n} events removed in 24h -- check it was deliberate (Recent changes can restore)')

problems = []
for cal_id, evs in calendars.items():
    if evs is None:
        continue
    series = {str(e.get('id')) for e in evs if e.get('recurrenceID') in (None, '')}
    keys = [f"{e.get('id')}|{e.get('recurrenceID') or ''}" for e in evs]
    for e in evs:
        rid = e.get('recurrenceID')
        if rid not in (None, '') and str(rid) not in series:
            problems.append(f'/{cal_id}: "{e.get("title")}" points at a repeating series that is not there')
        if not e.get('start') or not e.get('end'):
            problems.append(f'/{cal_id}: "{e.get("title")}" has no start or end')
    dups = len(keys) - len(set(keys))
    if dups:
        problems.append(f'/{cal_id}: {dups} duplicate event rows')
for p in problems:
    flag('data: ' + p)

# ---------------------------------------------------------------- 3. analytics (GA4, via stats.sh)
two_days = {'dateRanges': [{'startDate': 'yesterday', 'endDate': 'today'}]}
counts = ga({**two_days, 'dimensions': [{'name': 'eventName'}], 'metrics': [{'name': 'eventCount'}, {'name': 'totalUsers'}],
             'dimensionFilter': {'filter': {'fieldName': 'eventName', 'inListFilter': {'values': [
                 'event_added', 'calendar_created', 'sync_refused', 'sync_failed', 'js_error']}}}}) or []
ga_counts = {d[0]: (int(m[0]), int(m[1])) for d, m in counts}
errors = ga({**two_days, 'dimensions': [{'name': 'customEvent:kind'}, {'name': 'customEvent:message'}, {'name': 'customEvent:where'}],
             'metrics': [{'name': 'eventCount'}, {'name': 'totalUsers'}],
             'dimensionFilter': {'filter': {'fieldName': 'eventName', 'stringFilter': {'value': 'js_error'}}},
             'orderBys': [{'metric': {'metricName': 'eventCount'}, 'desc': True}], 'limit': 15}) or []
refused = [(d, m) for d, m in errors if d[0] == 'command_failed']
if refused:
    flag(f'{sum(int(m[0]) for _, m in refused)} change(s) refused by the event store (command_failed) -- see ERRORS')
if ga_counts.get('sync_refused', (0, 0))[0]:
    n, u = ga_counts['sync_refused']
    flag(f'{n} save(s) blocked by the write gate for {u} people (sync_refused)')
if ga_counts.get('sync_failed', (0, 0))[0]:
    flag(f"{ga_counts['sync_failed'][0]} save(s) failed to reach the server (sync_failed)")

# ---------------------------------------------------------------- 3b. active people and calendars
def active_people():
    rows = ga({'dateRanges': [{'startDate': 'yesterday', 'endDate': 'yesterday'}],
               'metrics': [{'name': 'active1DayUsers'}, {'name': 'active7DayUsers'}, {'name': 'active28DayUsers'}]})
    return [int(x) for x in rows[0][1]] if rows else None

NOT_CALENDAR = ('/', '/beta', '/beta/', '/nativecal/', '/dev/design', '/dev/pro.html')
def calendar_of(path):
    p = path.split('?')[0].rstrip('/')
    for pre in ('/beta/', '/nativecal/'):
        if p.startswith(pre): p = '/' + p[len(pre):]
    if not p or p in NOT_CALENDAR or p.startswith('/dev') or p.count('/') > 2 or is_test(p.strip('/').split('/')[-1]):
        return None
    return p.lower()

def active_calendars(days):
    rows = ga({'dateRanges': [{'startDate': f'{days}daysAgo' if days > 1 else 'yesterday', 'endDate': 'yesterday'}],
               'dimensions': [{'name': 'pagePath'}], 'metrics': [{'name': 'totalUsers'}], 'limit': 20000}) or []
    users = {}
    for d, m in rows:
        c = calendar_of(d[0])
        if c: users[c] = max(users.get(c, 0), int(m[0]))   # per-path users; a calendar's max across its paths
    return len(users), sum(1 for u in users.values() if u >= 2)

people = active_people()
viewed = {k: active_calendars(n) for k, n in (('day', 1), ('week', 7), ('month', 28))}
edited = {'day': len(within(24)), 'week': len(within(24 * 7)), 'month': len(within(24 * 28))}

# ---------------------------------------------------------------- 4. the daily full archive (Cloudflare)
def import_secret():
    if os.environ.get('IMPORT_SECRET'): return os.environ['IMPORT_SECRET']
    try:
        return subprocess.run(['security', 'find-generic-password', '-s', 'pastecal-import-secret', '-w'],
                              capture_output=True, text=True).stdout.strip()
    except Exception:
        return ''

def check_archive():
    secret = import_secret()
    if secret:
        req = urllib.request.Request(f'{SITE}/api/admin/backup/health', headers={'User-Agent': 'pastecal-health', 'Authorization': f'Bearer {secret}'})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                h = json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code != 503: return f'health route answered HTTP {e.code}', [f'backup: the archive health check answered HTTP {e.code}']
            h = json.loads(e.read() or b'{}')
        n = h.get('newest') or {}
        line = (f"newest {n.get('date')}: {n.get('count')} of {h.get('editable')} calendars ({n.get('absent')} names lead nowhere), {n.get('ageHours')}h old, "
                f"{(n.get('gzBytes') or 0) / 1e6:.1f} MB" if n else 'no archive for today or yesterday')
        return line, ['backup: ' + p for p in h.get('problems', [])]
    # No secret: the newest file's age from the listing (no count check).
    files = [o for o in r2_list('archive/daily/') if o['key'].endswith('.json.gz')]
    if not files: return 'no daily archive in R2', ['backup: no daily full archive in R2 (archive/daily/)']
    o = max(files, key=lambda o: o['key'])
    age = (NOW - ms(o['last_modified'])) / H
    return (f"newest {o['key']}: {age:.1f}h old (no IMPORT_SECRET: count not checked)",
            [f'backup: the newest full archive is {age:.1f} hours old, over 26'] if age > 26 else [])

try:
    backup, backup_flags = check_archive()
except Exception as e:
    backup, backup_flags = f'unavailable ({type(e).__name__})', [f'backup: the archive check failed ({type(e).__name__})']
for f in backup_flags: flag(f)

# ---------------------------------------------------------------- 5. name collisions (Cloudflare directory)
# A view row named after its own calendar takes that calendar's edit link (it forwards to /view/<name>; 45 calendars,
# Oct 28 2026). GET /api/admin/directory/collisions?scope=self: SQL, then one HEAD per candidate. The full scan (a view
# named after ANOTHER calendar) reads every row: scripts/fix-name-collisions.mjs, not here.
def check_collisions():
    secret = import_secret()
    if not secret: return 'not checked (no IMPORT_SECRET)', []
    req = urllib.request.Request(f'{SITE}/api/admin/directory/collisions?scope=self', headers={'User-Agent': 'pastecal-health', 'Authorization': f'Bearer {secret}'})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            found = json.loads(r.read()).get('collisions', [])
    except ValueError:
        return 'not checked (this deploy has no collision route)', []    # a page, not JSON
    except urllib.error.HTTPError as e:
        if e.code == 404: return 'not checked (this deploy has no collision route)', []
        return f'route answered HTTP {e.code}', [f'names: the collision check answered HTTP {e.code}']
    if not found: return 'none (no view link holds its own calendar\'s name)', []
    names = ', '.join(c['name'] for c in found[:5]) + (' ...' if len(found) > 5 else '')
    return (f'{len(found)} edit link(s) forward to their view: {names}',
            [f'names: {len(found)} calendar(s) whose edit link opens the view (run: node scripts/fix-name-collisions.mjs --base {SITE})'])

try:
    names, names_flags = check_collisions()
except Exception as e:
    names, names_flags = f'unavailable ({type(e).__name__})', [f'names: the collision check failed ({type(e).__name__})']
for f in names_flags: flag(f)

# ---------------------------------------------------------------- report
print('pastecal health --', time.strftime('%Y-%m-%d %H:%M %Z'))
print()
if attention:
    print('ATTENTION')
    for a in attention:
        print('  !', a)
else:
    print('ATTENTION  none -- nothing needs a person right now')
print()
print(f"EDITS          calendars edited: {edits['1h']} in the last hour, {edits['24h']} in 24h, {edits['7d']} in 7 days")
print(f"HISTORY 24h    {', '.join(f'{k} {v}' for k, v in sorted(kinds.items())) or 'no entries'}"
      f"   (events removed: {sum(removed_by_cal.values())})")
print(f"DATA           {len([c for c in calendars.values() if c is not None])} recently edited calendars scanned, "
      f"{len(problems)} problem(s)")
if ga_counts:
    g = lambda k: ga_counts.get(k, (0, 0))
    print(f"ANALYTICS      today+yesterday: {g('event_added')[0]} events added by {g('event_added')[1]} people, "
          f"{g('calendar_created')[0]} calendars created, {g('js_error')[0]} browser errors, "
          f"{g('sync_refused')[0]} blocked saves")
else:
    print('ANALYTICS      unavailable (stats.sh raw failed -- run ./scripts/stats.sh setup)')
if errors:
    print('ERRORS         (today+yesterday, by message)')
    for d, m in errors[:10]:
        kind, msg, where = d
        print(f"   {m[0]:>4}x {m[1]:>3} people  {kind or '-':<16} {(msg or '(no message)')[:70]:<70}  {where[:40]}")
print(f"BACKUP         {backup}")
print(f"NAMES          {names}")
print('ACTIVE         (complete days, through yesterday)')
if people:
    print(f'   people      DAU {people[0]:>5}   WAU {people[1]:>5}   MAU {people[2]:>5}   (stickiness DAU/MAU {people[0] / max(people[2], 1):.0%})')
print(f"   calendars   viewed:  DAC {viewed['day'][0]:>5}   WAC {viewed['week'][0]:>5}   MAC {viewed['month'][0]:>5}")
print(f"               shared (2+ people):  {viewed['day'][1]:>5}         {viewed['week'][1]:>5}         {viewed['month'][1]:>5}")
print(f"               edited:  {edited['day']:>9}   {edited['week']:>9}   {edited['month']:>9}   (R2 backups, since Oct 22)")
print()
print('Read-only. Sources: Cloudflare (R2 backup listing via cf, GET /cal, /api/admin/backup/health, /api/admin/directory/collisions), GA4 (stats.sh).')
sys.exit(1 if attention else 0)
