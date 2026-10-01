"""The numbers behind render_report.py, kept free of HTML so they can be tested.

Everything here is a pure function of the GA4 payload plus "today". render_report
turns the results into words and colors; it must not decide anything itself. Every
conclusion the report prints -- a verdict, a green or red tile, a "too young" cell
-- is chosen here from the data, because the report once shipped a hardcoded,
always-green "returning growth is tracking total growth" box that said the same
thing whatever the numbers were.

Run the tests with:  python3 -m unittest discover -s test/report
"""

import datetime
import re

# GA4's daily tables run 24-48 hours behind. A week (or month) whose last day is
# fewer than this many days ago is still filling in, and reads as a dip.
LAG_DAYS = 2

# Below this many items a percentage or a delta is mostly noise: 1 of 3 vs 2 of 3
# is a "100% jump". Show the count, not the rate.
MIN_N = 10


def rows(block):
    """GA4 rows -> [(dims tuple, metrics tuple)] with metrics as floats."""
    out = []
    for r in (block or {}).get("rows", []) or []:
        dims = tuple(d.get("value", "") for d in r.get("dimensionValues", []) or [])
        mets = []
        for m in r.get("metricValues", []) or []:
            try:
                mets.append(float(m.get("value", 0) or 0))
            except (TypeError, ValueError):
                mets.append(0.0)
        out.append((dims, tuple(mets)))
    return out


def truncation(block):
    """(rows returned, rows that exist) when GA4 capped the report, else None.

    GA4 silently stops at the request's limit; rowCount is the true total. Any
    metric summed over a capped report reads low without saying so."""
    if not block:
        return None
    got = len(block.get("rows") or [])
    try:
        total = int(block.get("rowCount") or 0)
    except (TypeError, ValueError):
        return None
    return (got, total) if total > got else None


def num(x, places=0):
    """Format a number. None means "no value", never zero."""
    if x is None:
        return "n/a"
    if places == 0:
        return f"{int(round(x)):,}"
    return f"{x:,.{places}f}"


def times(x, places=1):
    """A multiple, or n/a. Never "0x" for a missing baseline."""
    return "n/a" if x is None else f"{num(x, places)}&times;"


def pct(part, whole):
    return 0.0 if not whole else part * 100.0 / whole


def direction(ratio, band=0.03):
    """'up', 'down' or 'flat' for a ratio (1.0 = unchanged); None stays None."""
    if ratio is None:
        return None
    if ratio >= 1 + band:
        return "up"
    if ratio <= 1 - band:
        return "down"
    return "flat"


# Tile/note class per direction: good news green, bad news red, flat neutral.
TONE = {"up": "good", "down": "warn", "flat": "", None: ""}


def as_date(v, default=None):
    if isinstance(v, datetime.date):
        return v
    try:
        return datetime.date.fromisoformat(str(v))
    except (TypeError, ValueError):
        return default


# ---------------------------------------------------------------- calendars

# Not calendars: app pages, static files, and the test/probe paths that once
# put 314 phantom "users" into a single week. App prefixes end at a segment
# boundary so real slugs like /demolition-crew or /imgur-fans still count;
# zz- and test- are deliberately bare prefixes. /view/ is the read-only mirror
# of a calendar already counted under its slug, and its id cannot be mapped
# back to that slug, so it is dropped everywhere rather than counted twice.
# Keep in sync with NOT_CAL_RE in stats.sh.
_NOT_CAL = re.compile(
    r"^/((nativecal|view|demo|components|directives|img|js-old-components"
    r"|models|services|utils)(/|$)|zz-|test-)")


def norm_cal(path):
    """A calendar's identity, or None for non-calendar paths. /edit/slug folds
    into /slug (same calendar, different door). Requires a leading slash so
    GA4's "(other)" overflow row is never read as a calendar."""
    if not path or not path.startswith("/") or "." in path:
        return None
    p = path.lower()
    if p == "/" or _NOT_CAL.match(p):
        return None
    if p.startswith("/edit/"):
        p = "/" + p[len("/edit/"):]
    p = p.rstrip("/")
    return p or None


# TODO(cal_key): the analytics layer is moving from page paths to a hashed
# `cal_key` event parameter (see stats.sh). When report.sh's weekly/reach queries
# switch dimension, this is the one place a dimension value becomes a calendar
# identity: a cal_key is already an identity, so it should pass through as-is
# (minus "(not set)"). Nothing else in this file looks at paths.
def cal_identity(dim_value):
    return norm_cal(dim_value)


# ---------------------------------------------------------------- weeks

def week_key(day):
    y, w, _ = day.isocalendar()
    return f"{y}{w:02d}"


def week_monday(wk):
    return datetime.date.fromisocalendar(int(wk[:4]), int(wk[4:]), 1)


def settled(last_day, today):
    """True once GA4 has had LAG_DAYS to process the period ending last_day."""
    return (today - last_day).days >= LAG_DAYS


def fold_weekly(block, today, weekly_from=None):
    """(weeks, wk_cal): the contiguous list of settled ISO weeks the payload
    covers, and (week, calendar) -> people.

    Weeks come from the calendar, not from the data: a week with no calendar
    traffic still exists, and indexing only the weeks that had rows would shift
    every "N weeks later" by the gaps.

    The first week is dropped when the query did not start on its Monday (it is
    partial and would open every series with a fake dip). Weeks still inside the
    GA4 processing lag are dropped as unsettled.

    Paths that fold together (/solo and /solo/) take the MAX, not the sum: GA4
    de-duplicates users per row, so one browser on both rows would otherwise read
    as two people and fake a "shared" calendar. Max keeps it a floor."""
    raw = {}
    for dims, mets in rows(block):
        if len(dims) < 2 or not re.fullmatch(r"\d{6}", dims[0] or ""):
            continue
        cal = cal_identity(dims[1])
        if cal is None:
            continue
        key = (dims[0], cal)
        raw[key] = max(raw.get(key, 0), mets[0] if mets else 0)

    start = as_date(weekly_from)
    if start is not None:
        first = start - datetime.timedelta(days=start.weekday())
        drop_first = start.weekday() != 0
    elif raw:
        first = week_monday(min(wk for wk, _ in raw))
        drop_first = True     # unknown query start: assume partial
    else:
        return [], {}

    weeks = []
    mon = first
    while settled(mon + datetime.timedelta(days=6), today):
        weeks.append(week_key(mon))
        mon += datetime.timedelta(days=7)
    if drop_first and weeks:
        weeks = weeks[1:]
    keep = set(weeks)
    return weeks, {k: u for k, u in raw.items() if k[0] in keep}


def weekly_series(weeks, wk_cal):
    by_week = {wk: [] for wk in weeks}
    for (wk, _), u in wk_cal.items():
        if wk in by_week:
            by_week[wk].append(u)
    return [{
        "week": wk,
        "active": sum(1 for u in by_week[wk] if u >= 1),
        "shared": sum(1 for u in by_week[wk] if u >= 2),
        "strong": sum(1 for u in by_week[wk] if u >= 3),
    } for wk in weeks]


def year_ago(wk, known):
    """The same ISO week number a year earlier. A 53rd week has no counterpart
    in a 52-week year; it compares against week 52 instead."""
    y, w = int(wk[:4]), int(wk[4:])
    cand = f"{y - 1}{w:02d}"
    if cand not in known and w == 53:
        cand = f"{y - 1}52"
    return cand


def yoy(series, last=4):
    """The last `last` weeks' shared calendars vs the same ISO weeks a year ago.

    Returns (multiple or None, reason). None when any year-ago week is outside
    the data (n/a, not 0) or the year-ago base is zero (no ratio exists)."""
    if len(series) < last:
        return None, "not enough weeks"
    by = {w["week"]: w["shared"] for w in series}
    recent = series[-last:]
    base_weeks = [year_ago(w["week"], by) for w in recent]
    if any(b not in by for b in base_weeks):
        return None, "no data a year ago"
    base = sum(by[b] for b in base_weeks)
    if not base:
        return None, "none a year ago"
    return sum(w["shared"] for w in recent) / base, ""


# Cohort horizons, in weeks after birth. Every cohort is judged over the SAME
# windows: an older cohort given more weeks to be shared or to show traffic
# would look healthier for no reason but age.
SHARE_WEEKS = 4          # reached a 2nd person within weeks birth..birth+3
ALIVE_FROM, ALIVE_TO = 4, 7  # any traffic in weeks birth+4..birth+7
LOOKBACK = 8             # births only count after this many weeks of history


def cohorts(weeks, wk_cal, lookback=LOOKBACK):
    """Per birth week index: {born, shared, alive, share_judged, alive_judged}.

    A cohort's share rate is only judged once all SHARE_WEEKS have happened, and
    its survival only once week birth+ALIVE_TO is settled. "Birth" is first
    traffic after `lookback` weeks of history, so an established calendar is
    not mistaken for a newborn (one dormant longer than that still is).

    NOTE: stats.sh `cohorts` still uses open-ended windows (shared ever, alive
    any time from birth+4) and will disagree with this table for young cohorts.
    It is owned elsewhere; align it to these horizons when it is next touched."""
    idx = {wk: i for i, wk in enumerate(weeks)}
    last = len(weeks) - 1
    per_cal = {}
    for (wk, cal), u in wk_cal.items():
        if wk in idx and u > 0:
            per_cal.setdefault(cal, {})[idx[wk]] = u
    out = {}
    for wks in per_cal.values():
        b = min(wks)
        if b < lookback:
            continue
        c = out.setdefault(b, {"born": 0, "shared": 0, "alive": 0,
                               "share_judged": b + SHARE_WEEKS - 1 <= last,
                               "alive_judged": b + ALIVE_TO <= last})
        c["born"] += 1
        if any(wks.get(i, 0) >= 2 for i in range(b, b + SHARE_WEEKS)):
            c["shared"] += 1
        if any(i in wks for i in range(b + ALIVE_FROM, b + ALIVE_TO + 1)):
            c["alive"] += 1
    return out


def leak(cohort_map):
    """Pooled rates over cohorts old enough for BOTH horizons, or None.

    The verdict names whichever step loses more of the same births -- the share
    step loses (born - shared), survival loses (born - alive) -- or "both" when
    they are within 5 points. Neither is assumed to be the leak in advance."""
    mature = [c for c in cohort_map.values() if c["alive_judged"] and c["born"]]
    if not mature:
        return None
    born = sum(c["born"] for c in mature)
    sh = sum(c["shared"] for c in mature)
    al = sum(c["alive"] for c in mature)
    return {
        "cohorts": len(mature), "born": born,
        "share_rate": pct(sh, born), "alive_rate": pct(al, born),
        "worse": ("both" if abs(sh - al) * 100 < 5 * born
                  else "retention" if al < sh else "sharing"),
        "enough": born >= MIN_N,
    }


def window_weeks(days):
    """How many whole weeks best approximate a `days`-day window."""
    return max(1, round(days / 7))


def share_rate(weeks, wk_cal, k, offset=0):
    """(calendars with a 2nd person in some week, calendars active) over the k
    weeks ending `offset` weeks before the last settled week; None when the data
    does not reach back that far.

    Per calendar, not per person: a person with three solo calendars is three
    unshared calendars, never "3 viewers". Whether a calendar reached anyone
    beyond its creator is only knowable inside a week, where GA4 de-duplicates
    people."""
    end = len(weeks) - offset
    start = end - k
    if start < 0 or k <= 0:
        return None
    span = set(weeks[start:end])
    active, shared = set(), set()
    for (wk, cal), u in wk_cal.items():
        if wk in span and u >= 1:
            active.add(cal)
            if u >= 2:
                shared.add(cal)
    return len(shared), len(active)


def active_weeks(weeks, wk_cal, k, offset=0):
    """calendar -> number of weeks with traffic among the same k weeks."""
    end = len(weeks) - offset
    span = set(weeks[max(end - k, 0):end])
    out = {}
    for (wk, cal), u in wk_cal.items():
        if wk in span and u >= 1:
            out[cal] = out.get(cal, 0) + 1
    return out


def reach_people(block):
    """calendar -> distinct people over the window, from the pagePath report.
    Folded rows take the max, for the same reason as fold_weekly."""
    out = {}
    for dims, mets in rows(block):
        cal = cal_identity(dims[0] if dims else "")
        users = mets[1] if len(mets) > 1 else 0
        if cal is None or users <= 0:
            continue
        out[cal] = max(out.get(cal, 0), users)
    return out


def sticky(people, weeks_active, k, min_people=3):
    """Calendars a group keeps using: min_people+ people in the window AND
    traffic in 2+ different weeks of it (just 1 when the window is one week).

    Not "with a returning visitor": GA4 credits a person's first visit to the
    page their first_visit event fired on, so a group member who first landed on
    the homepage shows up on the calendar as already-returning, and per-page
    new/returning cannot be trusted."""
    need = 2 if k >= 2 else 1
    return sorted(c for c, n in people.items()
                  if n >= min_people and weeks_active.get(c, 0) >= need)


# ---------------------------------------------------------------- months

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
          "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def months(block, today, months_from=None):
    """(complete months, [months still filling in]).

    A month is partial only while it is the current month -- or the month that
    just ended, while its last day is inside the GA4 lag. On the 1st the
    previous month used to be flagged partial because the query ran
    365daysAgo..yesterday and assumed the last row was always "this month".

    The first month is dropped as a baseline when the query did not start on
    its 1st, since a growth multiple over a half-month baseline is fiction."""
    items = []
    for dims, mets in sorted(rows(block), key=lambda r: r[0][0] if r[0] else ""):
        ym = dims[0] if dims else ""
        if not re.fullmatch(r"\d{6}", ym):
            continue
        users = mets[0] if mets else 0
        new_users = mets[1] if len(mets) > 1 else 0
        items.append({
            "ym": ym,
            "label": f"{ym[:4]}-{ym[4:]}",
            "short": MONTHS[int(ym[4:]) - 1] + " " + ym[2:4],
            "users": users,
            "new": new_users,
            "returning": max(users - new_users, 0),
        })

    start = as_date(months_from)
    if items and (start is None or start.day != 1):
        items = items[1:]

    cur = today.strftime("%Y%m")
    first_of_month = today.replace(day=1)
    prev_end = first_of_month - datetime.timedelta(days=1)
    unsettled = {cur}
    if not settled(prev_end, today):
        unsettled.add(prev_end.strftime("%Y%m"))
    complete = [m for m in items if m["ym"] not in unsettled]
    partial = [m for m in items if m["ym"] in unsettled]
    return complete, partial


def growth_multiple(items, key):
    if len(items) < 2 or not items[0][key]:
        return None
    return items[-1][key] / items[0][key]


def avg_mom(items, key):
    if len(items) < 2 or not items[0][key]:
        return None
    n = len(items) - 1
    return ((items[-1][key] / items[0][key]) ** (1.0 / n) - 1) * 100


# Returning growth below this fraction of total growth is "lagging": the
# audience is being refilled by new arrivals rather than compounding.
LAGGING = 0.8
LEADING = 1.25


def growth_verdict(mult_u, mult_r):
    """(tone, title, explanation) for the growth section, from the data."""
    if mult_u is None or mult_r is None or mult_u <= 0:
        return ("", "Not enough history to judge retention",
                "There is no usable baseline month for one of the two series.")
    ratio = mult_r / mult_u
    if ratio < LAGGING:
        return ("warn" if mult_r < 1 else "amber",
                "Returning growth is lagging total growth",
                "Retention is not keeping pace with acquisition &mdash; new "
                "arrivals are refilling an audience that is churning through.")
    if ratio > LEADING:
        return ("good", "Returning growth is outpacing total growth",
                "A growing share of the audience comes back &mdash; retention "
                "is compounding faster than acquisition.")
    if mult_u < 1:
        return ("warn", "Shrinking, retention and acquisition alike",
                "Both series fell over the span; the mix held but the audience "
                "got smaller.")
    return ("good", "Returning growth is tracking total growth",
            "Retention is keeping pace with acquisition rather than lagging it.")


def delta(now, before, n=None):
    """(percent change or None, direction, reason).

    None when there is no baseline, or when n -- the smaller of the two sample
    sizes -- is under MIN_N, where a percentage is noise."""
    if n is not None and n < MIN_N:
        return None, "flat", f"too few to compare (n={int(n)})"
    if not before:
        return None, "flat", "no baseline"
    change = (now - before) * 100.0 / before
    if change >= 3:
        return change, "up", ""
    if change <= -3:
        return change, "down", ""
    return change, "flat", ""
