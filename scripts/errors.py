#!/usr/bin/env python3
"""Browser errors, grouped so each one reads as a bug report.

    ./scripts/stats.sh errors          # last 7 days
    ./scripts/stats.sh errors -d 30    # last 30 days
    python3 scripts/errors.py --days 1 --all   # every group, not just the top 15

For each distinct error (message + file:line): how often, on how many days, when it was last seen, which
browsers, layouts, UIs and countries, and the line of code it points at, read from the live checkout
(launch-prep, ~/worktrees/pc-launch; PASTECAL_LIVE overrides). Errors from browser extensions or other
sites' scripts are marked "not our code". Data: js_error in Analytics Engine (cloudflare/src/Collector.js):
blob6 kind, blob9 message, blob10 where (both kept since Nov 11 2026), blob2 ui, blob3 browser, blob4 device,
blob5 country. Nothing here reads calendar contents; the page and the collector mask ids, URLs and quoted text.
"""
import argparse
import collections
import datetime as dt
import json
import os
import re
import subprocess
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
LIVE = os.environ.get('PASTECAL_LIVE') or (os.path.expanduser('~/worktrees/pc-launch')
                                           if os.path.isdir(os.path.expanduser('~/worktrees/pc-launch')) else os.path.dirname(HERE))
DS = os.environ.get('UX_DATASET', 'pastecal_events')


def query(sql):
    with tempfile.NamedTemporaryFile('w', suffix='.sql', delete=False) as f:
        f.write(sql + ' FORMAT JSON')
    try:
        out = subprocess.run(['cf', 'analytics_engine', 'sql', 'query', '--file', f.name],
                             capture_output=True, text=True, check=False)
    finally:
        os.unlink(f.name)
    try:
        d = json.loads(out.stdout)
        d = json.loads(d) if isinstance(d, str) else d
        return d['data']
    except Exception:
        raise SystemExit('Analytics Engine query failed (is the cf CLI logged in?):\n' + (out.stdout + out.stderr)[:800])


def live_build():
    try:
        m = re.search(r'app\.js\?v=(\d+)', open(os.path.join(LIVE, 'public/index.html')).read())
        return m.group(1) if m else None
    except OSError:
        return None


def parse_where(where):
    """'app.js?v=123:401' -> ('app.js', 401, '123'); 'promise' / 'unknown' / 'sync' -> (where, None, None)."""
    m = re.match(r'^([\w.-]+\.js)(?:\?v=(\w+))?:(\d+)$', where or '')
    return (m.group(1), int(m.group(3)), m.group(2)) if m else (where or '', None, None)


def source_line(file, line, ui):
    """The code at file:line in the live checkout, or None when it is not one of our files."""
    hits = []
    for root, dirs, files in os.walk(os.path.join(LIVE, 'public')):
        dirs[:] = [d for d in dirs if d not in ('vendor', 'node_modules')]
        if file in files:
            hits.append(os.path.join(root, file))
    if not hits:
        return None
    hits.sort(key=lambda p: (('nativecal' in p) != (ui == 'native'), len(p)))
    try:
        lines = open(hits[0], encoding='utf-8', errors='replace').read().split('\n')
    except OSError:
        return None
    if not 0 < line <= len(lines):
        return (os.path.relpath(hits[0], LIVE), '(that line no longer exists: the file is shorter now)')
    return (os.path.relpath(hits[0], LIVE), lines[line - 1].strip()[:150])


def ago(ts, now):
    s = (now - ts).total_seconds()
    return f'{int(s // 60)} min ago' if s < 3600 else f'{int(s // 3600)} h ago' if s < 86400 else f'{int(s // 86400)} days ago'


def top(counter, n=3):
    return ', '.join(f'{k or "?"} {v}' for k, v in counter.most_common(n))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--days', type=int, default=7)
    ap.add_argument('--all', action='store_true', help='every group, not just the top 15')
    a = ap.parse_args()
    rows = query(f"""SELECT blob6 AS kind, blob9 AS message, blob10 AS loc, blob2 AS ui, blob3 AS browser, blob4 AS device,
  blob5 AS country, toDate(timestamp) AS day, MAX(timestamp) AS last, MIN(timestamp) AS first, SUM(_sample_interval) AS n
FROM {DS} WHERE blob1 = 'js_error' AND timestamp > NOW() - INTERVAL '{a.days}' DAY
GROUP BY kind, message, loc, ui, browser, device, country, day""")
    now = dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)
    ts = lambda s: dt.datetime.strptime(s[:19], '%Y-%m-%d %H:%M:%S')
    build = live_build()

    groups, by_day, untexted = {}, collections.Counter(), collections.Counter()
    for r in rows:
        n = int(float(r['n']))
        by_day[r['day']] += n
        if not r['message'] and not r['loc']:
            untexted[r['kind'] or '?'] += n
            continue
        file, line, ver = parse_where(r['loc'])
        key = (r['message'], file, line)
        g = groups.setdefault(key, dict(n=0, kind=r['kind'], days=set(), first=ts(r['first']), last=ts(r['last']), vers=set(),
                                        browser=collections.Counter(), device=collections.Counter(),
                                        ui=collections.Counter(), country=collections.Counter()))
        g['n'] += n
        g['days'].add(r['day'])
        g['first'] = min(g['first'], ts(r['first']))
        g['last'] = max(g['last'], ts(r['last']))
        if ver:
            g['vers'].add(ver)
        for k in ('browser', 'device', 'ui', 'country'):
            g[k][r[k]] += n

    total = sum(by_day.values())
    print(f'Browser errors, last {a.days} days: {total} in all, {len(groups)} distinct'
          + (f', plus {sum(untexted.values())} recorded without text' if untexted else ''))
    if by_day:
        print('  by day: ' + ' · '.join(f'{d[5:]} {by_day[d]}' for d in sorted(by_day)))
    print()
    order = sorted(groups.items(), key=lambda kv: -kv[1]['n'])
    for i, ((msg, file, line), g) in enumerate(order if a.all else order[:15], 1):
        new = '  NEW' if (now - g['first']).total_seconds() < 2 * 86400 and g['first'] > now - dt.timedelta(days=a.days - 1) else ''
        print(f'{i:2}. {msg or "(no message)"}{new}')
        print(f'    {g["n"]}× on {len(g["days"])} day{"s" * (len(g["days"]) != 1)} · last {ago(g["last"], now)} · {g["kind"]}'
              f' · {top(g["browser"])} · {top(g["device"], 2)} · {top(g["ui"], 2)} · {top(g["country"])}')
        if line is None:
            print(f'    where: {file or "?"} (no file:line)')
        else:
            src = source_line(file, line, g['ui'].most_common(1)[0][0])
            if src is None:
                print(f'    where: {file}:{line}  · not our code (a browser extension or another site\'s script)')
            else:
                stale = build and g['vers'] and build not in g['vers']
                print(f'    where: {src[0]}:{line}' + ('  · from an older build, so the line may have moved' if stale else ''))
                print(f'      | {src[1]}')
        print()
    if not a.all and len(order) > 15:
        print(f'({len(order) - 15} more; --all lists them)\n')
    if untexted:
        print('Recorded before error text was kept (Nov 11 2026): ' + ', '.join(f'{k} {v}' for k, v in untexted.most_common()))
    if not total:
        print('No browser errors recorded.')


if __name__ == '__main__':
    main()
