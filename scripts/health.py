#!/usr/bin/env python3
"""
pastecal health check -- read-only, about a minute, a fraction of a cent.

    ./scripts/stats.sh health            (or: python3 scripts/health.py)

Answers "is anything wrong right now?" from the three places the truth lives:
  1. the database (edit stamps, the history log, and the calendars edited recently) --
     read over REST with your gcloud login, admin read-only
  2. Google Analytics (errors by message, refused changes, blocked saves) -- via stats.sh
  3. Cloud Monitoring (database download volume -- the cost signal)

Anything that needs a person is printed first, under ATTENTION. deploy.sh runs this after
every hosting deploy, because a bad release shows up here within minutes (Sep 26: a series
edit that saved as a delete would have shown as an orphaned occurrence).

Cheap by design: history is fetched only for calendars edited in the last 24h and only
entries from the last 24h; calendars only if edited in the last 24h.
"""
import json, os, subprocess, sys, time, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor

DB = 'https://pastecal-web-default-rtdb.firebaseio.com'
PROJECT = 'pastecal-web'
HERE = os.path.dirname(os.path.abspath(__file__))
NOW = time.time() * 1000
H = 3600 * 1000

attention = []
def flag(msg): attention.append(msg)

def token():
    return subprocess.run(['gcloud', 'auth', 'print-access-token'], capture_output=True, text=True).stdout.strip().splitlines()[-1]

TOKEN = token()

def db_get(path, **params):
    q = urllib.parse.urlencode({**{k: json.dumps(v) if k in ('orderBy', 'startAt', 'endAt', 'equalTo') else v for k, v in params.items()}, 'access_token': TOKEN})
    with urllib.request.urlopen(f'{DB}{path}.json?{q}', timeout=60) as r:
        return json.loads(r.read() or b'null')

def ga(body):
    out = subprocess.run([os.path.join(HERE, 'stats.sh'), 'raw', json.dumps(body)], capture_output=True, text=True)
    try:
        d = json.loads(out.stdout)
    except Exception:
        return None
    return [([x['value'] for x in r.get('dimensionValues', [])], [x['value'] for x in r.get('metricValues', [])]) for r in d.get('rows', [])]

def is_test(cal_id): return cal_id.lower().startswith('test-')

# ---------------------------------------------------------------- 1. edits (database)
meta = db_get('/history_meta') or {}
stamps = {k: v.get('lastEditedAt') for k, v in meta.items() if isinstance(v, dict) and v.get('lastEditedAt') and not is_test(k)}
within = lambda hours: [k for k, t in stamps.items() if NOW - t < hours * H]
recent = within(24)
edits = {'1h': len(within(1)), '24h': len(recent), '7d': len(within(24 * 7))}
if edits['7d'] and edits['24h'] < 0.4 * edits['7d'] / 7:
    flag(f"edits are down: {edits['24h']} calendars edited in 24h vs ~{edits['7d'] / 7:.0f}/day this week")

# ---------------------------------------------------------------- 2. history + integrity (database)
def history_24h(cal_id):
    try:
        # Newest 10 by key (push keys are chronological) -- querying by savedAt would need
        # a database index; the last day is never more than a few entries anyway.
        rows = db_get(f'/history/{cal_id}', orderBy='$key', limitToLast=10) or {}
    except Exception:
        return cal_id, []
    return cal_id, [{k: v.get(k) for k in ('kind', 'removed', 'changed', 'added', 'savedAt', 'eventCount', 'title')} for v in rows.values()
                    if isinstance(v, dict) and NOW - (v.get('savedAt') or 0) < 24 * H]

def events_of(cal_id):
    try:
        v = db_get(f'/calendars/{cal_id}/events')
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

# ---------------------------------------------------------------- 4. cost signal (Cloud Monitoring)
def db_bytes(hours_back_start, hours_back_end):
    end = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(time.time() - hours_back_end * 3600))
    start = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(time.time() - hours_back_start * 3600))
    q = urllib.parse.urlencode({
        'filter': 'metric.type="firebasedatabase.googleapis.com/network/sent_bytes_count"',
        'interval.startTime': start, 'interval.endTime': end,
        'aggregation.alignmentPeriod': f'{int((hours_back_start - hours_back_end) * 3600)}s',
        'aggregation.perSeriesAligner': 'ALIGN_SUM', 'aggregation.crossSeriesReducer': 'REDUCE_SUM'})
    req = urllib.request.Request(f'https://monitoring.googleapis.com/v3/projects/{PROJECT}/timeSeries?{q}',
                                 headers={'Authorization': f'Bearer {TOKEN}', 'x-goog-user-project': PROJECT})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            d = json.loads(r.read())
        return sum(int(p['value'].get('int64Value', 0)) for s in d.get('timeSeries', []) for p in s.get('points', []))
    except Exception:
        return None

gb_24h = db_bytes(24, 0)
gb_week = db_bytes(24 * 8, 24)
if gb_24h is not None:
    gb_24h /= 1e9
    # 10 GB/month free = ~0.33 GB/day
    if gb_24h > 0.33:
        flag(f'database downloads {gb_24h:.2f} GB in 24h -- over the free-tier pace (~0.33 GB/day)')

# ---------------------------------------------------------------- 5. Cloudflare health
cf_status = {}
try:
    req = urllib.request.Request('https://pastecal.com/api/directory/stats', headers={'User-Agent': 'pastecal-health/1.0'})
    with urllib.request.urlopen(req, timeout=10) as r:
        stats = json.loads(r.read())
        cf_status['directory_records'] = stats.get('total', 0)
        if stats.get('total', 0) < 10000:
            flag(f"Cloudflare directory count low: {stats.get('total')} records (expected ~17k)")
except Exception as e:
    flag(f"Cloudflare directory stats failed: {e}")

try:
    req = urllib.request.Request('https://pastecal.com/api/lookup?slug=25980', headers={'User-Agent': 'pastecal-health/1.0'})
    with urllib.request.urlopen(req, timeout=10) as r:
        lookup = json.loads(r.read())
        cf_status['lookup_ok'] = lookup.get('found', False)
        if not lookup.get('found'):
            flag("Cloudflare slug lookup for sample calendar '25980' returned not found")
except Exception as e:
    flag(f"Cloudflare slug lookup failed: {e}")

try:
    req = urllib.request.Request('https://pastecal.com/cal/25980/history', headers={'User-Agent': 'pastecal-health/1.0'})
    with urllib.request.urlopen(req, timeout=10) as r:
        hist = json.loads(r.read())
        cf_status['history_entries'] = len(hist) if isinstance(hist, list) else 0
except Exception as e:
    flag(f"Cloudflare DO history check failed: {e}")

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
print('ACTIVE         (complete days, through yesterday)')
if people:
    print(f'   people      DAU {people[0]:>5}   WAU {people[1]:>5}   MAU {people[2]:>5}   (stickiness DAU/MAU {people[0] / max(people[2], 1):.0%})')
print(f"   calendars   viewed:  DAC {viewed['day'][0]:>5}   WAC {viewed['week'][0]:>5}   MAC {viewed['month'][0]:>5}")
print(f"               shared (2+ people):  {viewed['day'][1]:>5}         {viewed['week'][1]:>5}         {viewed['month'][1]:>5}")
print(f"               edited:  {edited['day']:>9}   {edited['week']:>9}   {edited['month']:>9}   (edit stamps, since Sep 14)")
if gb_24h is not None:
    wk = f', {gb_week / 7e9:.2f} GB/day over the week before' if gb_week else ''
    print(f"COST           database downloads {gb_24h:.2f} GB in 24h{wk} (free tier ~0.33 GB/day)")
if cf_status:
    print(f"CLOUDFLARE     directory: {cf_status.get('directory_records', '?')} records, "
          f"lookup: {'ok' if cf_status.get('lookup_ok') else 'FAIL'}, "
          f"history query: {cf_status.get('history_entries', '?')} entries")
print()
print('Read-only. Sources: database (REST, gcloud login), GA4 (stats.sh), Cloud Monitoring.')
sys.exit(1 if attention else 0)
