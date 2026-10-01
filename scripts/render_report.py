#!/usr/bin/env python3
"""Render the GA4 payload from report.sh into a standalone HTML report.

Reads one JSON object on stdin, writes HTML on stdout. No dependencies, no
network: everything needed is already in the payload, so the output file works
offline and can be mailed around.

Kept separate from report.sh because building HTML in bash is how you get
unescaped user data in an attribute. Every value here goes through esc().
"""

import datetime
import html
import json
import sys

from report_metrics import (
    LAG_DAYS, MIN_N, SHARE_WEEKS, ALIVE_FROM, ALIVE_TO, TONE,
    rows, truncation, num, times, pct, direction, as_date,
    fold_weekly, weekly_series, yoy, cohorts as build_cohorts, leak,
    window_weeks, share_rate, active_weeks, reach_people, sticky,
    months, growth_multiple, avg_mom, growth_verdict, delta,
)


def esc(v):
    return html.escape(str(v), quote=True)


def secs(x):
    x = int(round(x or 0))
    return f"{x // 60}m {x % 60:02d}s" if x >= 60 else f"{x}s"


# ---------------------------------------------------------------- charts


def sparkline(series, width=760, height=128, label="Daily people over the reporting window"):
    """Area+line over time. One series, so no legend: the heading names it."""
    if len(series) < 2:
        return '<p class="empty">Not enough days in range to plot.</p>'

    vals = [v for _, v in series]
    hi = max(vals) or 1
    n = len(series)
    dx = width / (n - 1)

    pts = [(i * dx, height - (v / hi) * (height - 12) - 6) for i, (_, v) in enumerate(series)]
    line = " ".join(f"{x:.1f},{y:.1f}" for x, y in pts)
    area = f"0,{height} " + line + f" {width},{height}"

    # Label only the ends and the peak: a number on every point is noise.
    peak = max(range(n), key=lambda i: series[i][1])
    marks = []
    for i in {0, n - 1, peak}:
        x, y = pts[i]
        # First point: anchor the label to the RIGHT of its dot, not at the plot
        # edge. Anchored at the edge it overlaps the steep opening descent and
        # the leading digit is lost against the area fill.
        anchor = "start" if i == 0 else ("end" if i == n - 1 else "middle")
        # Nudge the end labels inward so they clear the plot edge, and push a
        # label below its point when the point sits too near the top to fit above.
        px = (x + 8) if i == 0 else (width - 6 if i == n - 1 else x)
        py = (y + 16) if y < 20 else (y - 9)
        # A first or last point that is ALSO the peak sits hard against the top
        # corner, where an above-the-point label is clipped by the viewBox.
        if i == 0:
            py = y + 4          # vertically centred on the dot, offset right
        elif i == n - 1 and i == peak:
            py = y + 17
        marks.append(
            f'<circle cx="{x:.1f}" cy="{y:.1f}" r="3.5" class="pt"/>'
            f'<text x="{px:.1f}" y="{py:.1f}" text-anchor="{anchor}" '
            f'class="ptl">{esc(num(series[i][1]))}</text>'
        )

    # The viewBox is padded on all sides: end labels are anchored at the plot
    # edge, and a peak label sits above its point, so both overflow a viewBox
    # that stops at the data. Padding is cheaper than clamping every label.
    pad = 26
    return f'''<svg viewBox="{-pad} {-14} {width + pad * 2} {height + 14 + 6}" class="spark" role="img"
     aria-label="{esc(label)}">
  <polygon points="{area}" class="area"/>
  <polyline points="{line}" class="line"/>
  {''.join(marks)}
</svg>
<div class="axis"><span>{esc(series[0][0])}</span><span>{esc(series[-1][0])}</span></div>'''


def monthly_chart(items, partial_items=()):
    """Monthly users, returning vs new, as stacked columns.

    Stacked rather than two lines because the QUESTION is the mix -- how much of
    the growth is people coming back -- and a stack answers that directly. A 2px
    surface gap separates the segments so the boundary is never ambiguous.
    Months still filling in are drawn faded after the complete ones.
    """
    if len(items) < 2:
        return '<p class="empty">Not enough months yet.</p>'
    show = items[-12:]
    hi = max(r["users"] for r in list(show) + list(partial_items)) or 1
    cols = []
    for r in show:
        ret_h = r["returning"] / hi * 100
        new_h = r["new"] / hi * 100
        cols.append(
            f'<div class="mcol" title="{esc(r["label"])}: {esc(num(r["users"]))} people">'
            f'<span class="mplot"><span class="mstack">'
            f'<span class="mnew" style="height:{new_h:.1f}%"></span>'
            f'<span class="mret" style="height:{ret_h:.1f}%"></span>'
            f'</span></span>'
            f'<span class="mlab">{esc(r["short"])}</span></div>')
    for r in partial_items:
        ret_h = r["returning"] / hi * 100
        new_h = r["new"] / hi * 100
        cols.append(
            f'<div class="mcol partial" title="{esc(r["label"])}: still filling in">'
            f'<span class="mplot"><span class="mstack">'
            f'<span class="mnew" style="height:{new_h:.1f}%"></span>'
            f'<span class="mret" style="height:{ret_h:.1f}%"></span>'
            f'</span></span>'
            f'<span class="mlab">{esc(r["short"])}</span></div>')
    return (
        '<div class="mlegend">'
        '<span><i class="sw ret"></i>Returning</span>'
        '<span><i class="sw new"></i>New</span></div>'
        '<div class="months">' + "".join(cols) + "</div>"
        + ('<p class="mnote">Faded columns are still filling in (the current '
           'month, or one that ended inside GA4&rsquo;s 24&ndash;48 hour '
           'processing lag) &mdash; they are not a decline.</p>' if partial_items else ""))


def bars(items, unit=""):
    """Ranked horizontal bars. Magnitude by length; value direct-labeled."""
    if not items:
        return '<p class="empty">No data in this window.</p>'
    hi = max(v for _, v in items) or 1
    out = []
    for label, v in items:
        out.append(
            f'<div class="bar"><span class="bl">{esc(label)}</span>'
            f'<span class="btrack"><span class="bfill" style="width:{pct(v, hi):.1f}%"></span></span>'
            f'<span class="bv">{esc(num(v))}{esc(unit)}</span></div>'
        )
    return '<div class="bars">' + "".join(out) + "</div>"


def table(headers, body_rows, aligns=None):
    if not body_rows:
        return '<p class="empty">No data in this window.</p>'
    aligns = aligns or []
    th = "".join(f"<th>{esc(h)}</th>" for h in headers)
    tr = []
    for r in body_rows:
        cells = []
        for i, c in enumerate(r):
            cls = ' class="num"' if i < len(aligns) and aligns[i] == "r" else ""
            cells.append(f"<td{cls}>{c}</td>")
        tr.append("<tr>" + "".join(cells) + "</tr>")
    return (
        '<div class="tw"><table><thead><tr>' + th + "</tr></thead><tbody>"
        + "".join(tr) + "</tbody></table></div>"
    )


# ---------------------------------------------------------------- build

d = json.load(sys.stdin)
days = d.get("days", 30)

# Visitors
ov = {dims[0]: mets for dims, mets in rows(d.get("overview"))}
new_u = ov.get("new", (0, 0, 0))
ret_u = ov.get("returning", (0, 0, 0))
total_sessions = sum(m[0] for m in ov.values())
total_users = sum(m[1] for m in ov.values())

ret_per_user = (ret_u[0] / ret_u[1]) if ret_u[1] else 0
new_per_user = (new_u[0] / new_u[1]) if new_u[1] else 0

# Daily series
daily = sorted(rows(d.get("daily")), key=lambda r: r[0][0])
series = [
    (f"{x[0][0][4:6]}/{x[0][0][6:8]}" if len(x[0][0]) == 8 else x[0][0], x[1][0])
    for x in daily
]

# Product events
ev = {dims[0]: mets for dims, mets in rows(d.get("events"))}
rt = {dims[0]: mets for dims, mets in rows(d.get("realtime"))}
CUSTOM = [
    "calendar_created", "slug_prompt_shown", "slug_claimed", "slug_autoassigned",
    "slug_claim_failed", "event_added", "calendar_shared", "calendar_returned",
    "feature_used",
]
rt_custom = {k: v for k, v in rt.items() if k in CUSTOM}
has_events = bool(ev)

shown = ev.get("slug_prompt_shown", (0, 0))[0]
claimed = ev.get("slug_claimed", (0, 0))[0]
auto = ev.get("slug_autoassigned", (0, 0))[0]
failed = ev.get("slug_claim_failed", (0, 0))[0]

# Calendars, with visits-per-user as the return-depth proxy
cal_rows = []
for dims, mets in rows(d.get("pages"))[:15]:
    path = dims[0] or "(not set)"
    s, u = mets[0], mets[1]
    cal_rows.append((path, s, u, (s / u) if u else 0))
cal_rows.sort(key=lambda r: r[3], reverse=True)

# Custom dimension coverage
dims_list = d.get("dims")
NEEDED = ["where", "source", "method", "feature", "named", "visit_bucket",
          "slug_length", "event_count_bucket", "has_custom_slug", "reason", "surface"]
missing = [p for p in NEEDED if not dims_list or p not in dims_list] if dims_list is not None else NEEDED

# Reach: how many DIFFERENT people saw a calendar, vs the same few reloading.
# pagePath, not landingPage -- landingPage only counts sessions that started on
# the page, undercounting anything reached from the homepage. No per-calendar
# new/returning split: GA4 credits newUsers to the page the first_visit event
# fired on, so a person who first landed on the homepage reads as "returning"
# on every calendar they then open.
reach_rows = []
for dims, mets in rows(d.get("reach")):
    path = dims[0] or "(not set)"
    views, users = mets[0], mets[1]
    if users <= 0:
        continue
    reach_rows.append({"path": path, "views": views, "users": users,
                       "per": views / users})

# "Today" decides which weeks and months are settled. report.sh passes it so a
# run near midnight cannot disagree with the dates it queried.
today = as_date(d.get("today"), datetime.date.today())

# ---------------------------------------------------------------- north star
#
# Weekly active shared calendars: calendars that reached 2+ distinct browsers
# inside one week. This is the number the product exists to grow -- a calendar
# a GROUP is using -- and the base every Pro-tier projection stands on. Weekly,
# because GA4 can only de-duplicate people within one bucket; "2+ people ever,
# summed across weeks" would double-count the same person returning.
#
# Alongside it, cohort survival: of the calendars first seen each week, how
# many reached a second person within SHARE_WEEKS, and how many still had
# traffic in weeks ALIVE_FROM..ALIVE_TO. When the north star is flat while new
# users keep arriving, these two rates say WHERE the loop leaks.
weeks_all, wk_cal = fold_weekly(d.get("weekly"), today, d.get("weeklyFrom"))
wasc_all = weekly_series(weeks_all, wk_cal)
# The payload reaches back past a year (for the year-ago comparison and the
# cohort lookback); the chart and the peak cover the last 52 weeks.
wasc = wasc_all[-52:]
cohorts = build_cohorts(weeks_all, wk_cal)
leak_stats = leak(cohorts)

# ---------------------------------------------------------------- KPIs
#
# Three diagnostic numbers under the north star, chosen against the business
# model in internal/specs/pro.md:
# MAU -> conversion -> MRR, with the free tier as the growth engine. Each answers
# a question that would change what gets built next.
#
#   1. Returning people     -- the population that could ever convert. Total users
#                              flatters: most are one-visit arrivals.
#   2. Calendars shared     -- share of active calendars that reached anyone
#                              beyond their creator inside a week. The free tier
#                              exists to be shared; this is whether that works.
#   3. Calendars that stick -- 3+ people in the window and traffic in 2+ of its
#                              weeks. The unit of real value, the Pro upsell target.


def split_users(block):
    """(returning people, new people). Index 1 is totalUsers: the overview query
    asks for sessions,totalUsers,averageSessionDuration in that order, and both
    windows must use the same order or this compares sessions against people."""
    o = {dims[0]: mets for dims, mets in rows(block)}
    ret = o.get("returning", (0, 0, 0))
    new_ = o.get("new", (0, 0, 0))
    return (ret[1] if len(ret) > 1 else 0, new_[1] if len(new_) > 1 else 0)


# ---- monthly history --------------------------------------------------------
# The single most important context in the report. A two-window delta on a noisy
# site says almost nothing; twelve months of direction says a lot.
complete, partial = months(d.get("monthly"), today, d.get("monthsFrom"))

cur_ret, cur_new = split_users(d.get("overview"))
prev_ret, prev_new = split_users(d.get("prevOverview"))

# The KPI windows in whole settled weeks, so the weekly data can answer them.
k_weeks = window_weeks(days)
cur_share = share_rate(weeks_all, wk_cal, k_weeks)
prev_share = share_rate(weeks_all, wk_cal, k_weeks, offset=k_weeks)

cur_sticky = sticky(reach_people(d.get("reach")),
                    active_weeks(weeks_all, wk_cal, k_weeks), k_weeks)
prev_sticky = sticky(reach_people(d.get("prevReach")),
                     active_weeks(weeks_all, wk_cal, k_weeks, offset=k_weeks), k_weeks)

# Every query the numbers depend on, checked for GA4's silent row cap. Top-N
# display lists (channels, countries, landing pages) are capped on purpose and
# change no metric, so they are not listed.
METRIC_BLOCKS = {
    "overview": "visitor totals", "prevOverview": "previous-window totals",
    "daily": "daily people", "reach": "reach and sticky calendars",
    "prevReach": "previous-window sticky calendars", "monthly": "monthly growth",
    "weekly": "north star, cohorts and sharing", "events": "product events",
}
capped = [(label, t) for key, label in METRIC_BLOCKS.items()
          for t in [truncation(d.get(key))] if t]

bd = d.get("breakdowns") or {}

# ---------------------------------------------------------------- html

parts = []
A = parts.append

A(f'''<meta charset="utf-8">
<title>Pastecal Usage Report</title>
<style>
:root {{
  color-scheme: light;
  --ground:#fbfcfd; --panel:#ffffff; --sunk:#f2f5f8;
  --ink:#16202b; --muted:#5b6b7c; --faint:#8a99a8; --rule:#e3e9ef;
  --accent:#2a78d6; --accent-soft:#e8f1fc;
  --warn:#d81b60; --warn-soft:#fdeaf1;
  --good:#1baf7a; --good-soft:#e4f4ee;
  --amber:#a86407; --amber-soft:#fdf1de;
  --s1:#2a78d6; --s2:#eb6834; --s3:#1baf7a;
  --shadow:0 1px 2px rgba(22,32,43,.06),0 8px 24px -12px rgba(22,32,43,.18);
  --ui: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
        Roboto, sans-serif, "Apple Color Emoji";
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}}
@media (prefers-color-scheme: dark) {{
  :root:not([data-theme="light"]) {{
    color-scheme: dark;
    --ground:#12171c; --panel:#1b222a; --sunk:#232c35;
    --ink:#e6edf3; --muted:#9aa9b8; --faint:#6b7b8a; --rule:#2c3742;
    --accent:#3987e5; --accent-soft:#17293a;
    --warn:#f0658f; --warn-soft:#351a25;
    --good:#199e70; --good-soft:#14312a;
    --amber:#e0a44a; --amber-soft:#33260f;
    --s1:#3987e5; --s2:#d95926; --s3:#199e70;
    --shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px -12px rgba(0,0,0,.7);
  }}
}}
:root[data-theme="dark"] {{
  color-scheme: dark;
  --ground:#12171c; --panel:#1b222a; --sunk:#232c35;
  --ink:#e6edf3; --muted:#9aa9b8; --faint:#6b7b8a; --rule:#2c3742;
  --accent:#3987e5; --accent-soft:#17293a;
  --warn:#f0658f; --warn-soft:#351a25;
  --good:#199e70; --good-soft:#14312a;
  --amber:#e0a44a; --amber-soft:#33260f;
  --s1:#3987e5; --s2:#d95926; --s3:#199e70;
  --shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px -12px rgba(0,0,0,.7);
}}
*{{box-sizing:border-box}}
body{{margin:0;background:var(--ground);color:var(--ink);font-family:var(--ui);
     font-size:16px;line-height:1.6;-webkit-font-smoothing:antialiased}}
.wrap{{max-width:920px;margin:0 auto;padding:0 24px 80px}}
header{{padding:48px 0 26px;border-bottom:1px solid var(--rule);margin-bottom:36px}}
.eyebrow{{font-size:12px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;
         color:var(--accent);margin:0 0 12px}}
h1{{font-weight:700;font-size:clamp(27px,4vw,36px);line-height:1.12;
    letter-spacing:-.02em;margin:0 0 12px}}
.sub{{font-size:16px;color:var(--muted);margin:0}}
section{{margin-bottom:44px}}
h2{{font-weight:700;font-size:21px;letter-spacing:-.015em;margin:0 0 8px}}
h3{{font-size:15px;font-weight:650;margin:0 0 6px}}
p{{margin:0 0 13px;max-width:68ch}} p:last-child{{margin-bottom:0}}
.lede{{font-size:15.5px;color:var(--muted);max-width:66ch}}
code{{font-family:var(--mono);font-size:.87em;background:var(--sunk);
      padding:.1em .4em;border-radius:4px;border:1px solid var(--rule)}}
.kpis{{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));
       gap:12px;margin-top:20px}}
.kpi{{border:1px solid var(--rule);border-radius:12px;background:var(--panel);
      box-shadow:var(--shadow);padding:18px 20px;display:flex;flex-direction:column}}
.kpi .kn{{font-size:11.5px;font-weight:650;letter-spacing:.08em;
          text-transform:uppercase;color:var(--faint);margin-bottom:9px}}
.kpi .kv{{font-size:34px;font-weight:700;letter-spacing:-.03em;line-height:1;
          font-variant-numeric:tabular-nums}}
.kpi .kd{{display:inline-flex;align-items:center;gap:5px;font-size:12.5px;
          font-weight:650;margin-top:8px;padding:3px 9px;border-radius:100px;
          align-self:flex-start}}
.kd.up{{background:var(--good-soft);color:var(--good)}}
.kd.down{{background:var(--warn-soft);color:var(--warn)}}
.kd.flat{{background:var(--sunk);color:var(--muted)}}
.kpi .kw{{font-size:13px;color:var(--muted);margin-top:10px;line-height:1.45}}
.mlegend{{display:flex;gap:16px;font-size:12.5px;color:var(--muted);margin-bottom:10px}}
.mlegend .sw{{display:inline-block;width:10px;height:10px;border-radius:2px;
              margin-right:5px;vertical-align:-1px}}
.sw.ret{{background:var(--s1)}} .sw.new{{background:var(--s3)}}
.months{{display:flex;gap:6px;align-items:flex-end}}
.mcol{{flex:1;display:flex;flex-direction:column;align-items:center;min-width:0}}
/* The stack needs a RESOLVED height for its percentage segments to size against;
   flex:1 inside an auto-height parent gives them nothing to resolve to, and every
   bar collapses to min-height. */
.mplot{{height:170px;width:100%;display:flex;align-items:flex-end}}
/* Columns grow UP from a shared baseline: the stack is bottom-aligned inside a
   full-height cell, with the returning segment written last so column-reverse
   puts it at the bottom. The duplicate justify-content here previously made the
   bars hang from the top instead. */
.mstack{{width:100%;display:flex;flex-direction:column-reverse;
         justify-content:flex-start;gap:2px;height:100%}}
.mret{{background:var(--s1);border-radius:0 0 3px 3px;min-height:2px}}
.mnew{{background:var(--s3);border-radius:3px 3px 0 0;min-height:2px}}
.mcol.partial .mstack{{opacity:.42}}
.mlab{{font-size:10.5px;color:var(--faint);margin-top:6px;white-space:nowrap}}
.mnote{{font-size:12.5px;color:var(--faint);margin-top:10px;font-style:italic}}
.tiles{{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));
        gap:10px;margin-top:18px}}
.tile{{border:1px solid var(--rule);border-radius:10px;background:var(--panel);
       padding:14px 16px}}
.tile .v{{font-size:26px;font-weight:700;letter-spacing:-.025em;line-height:1.05;
         font-variant-numeric:tabular-nums}}
.tile .k{{font-size:12.5px;color:var(--muted);margin-top:3px;line-height:1.35}}
.tile.hi .v{{color:var(--accent)}}
.tile.good .v{{color:var(--good)}}
.tile.warn .v{{color:var(--warn)}}
.card{{border:1px solid var(--rule);border-radius:11px;background:var(--panel);
       box-shadow:var(--shadow);padding:18px 20px;margin-top:18px}}
.spark{{width:100%;height:auto;display:block;overflow:visible}}
.area{{fill:var(--s1);opacity:.13}}
.line{{fill:none;stroke:var(--s1);stroke-width:2;stroke-linejoin:round;stroke-linecap:round}}
.pt{{fill:var(--s1);stroke:var(--panel);stroke-width:2}}
.ptl{{fill:var(--muted);font-size:11px;font-family:var(--ui);font-variant-numeric:tabular-nums}}
.axis{{display:flex;justify-content:space-between;font-size:11.5px;
       color:var(--faint);margin-top:5px}}
.bars{{display:flex;flex-direction:column;gap:7px}}
.bar{{display:grid;grid-template-columns:minmax(90px,190px) 1fr auto;
      gap:10px;align-items:center;font-size:13.5px}}
.bl{{color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}}
.btrack{{background:var(--sunk);border-radius:4px;height:11px;overflow:hidden}}
.bfill{{display:block;height:100%;background:var(--s1);border-radius:0 4px 4px 0}}
.bv{{color:var(--muted);font-variant-numeric:tabular-nums;font-size:13px;min-width:52px;
     text-align:right}}
.tw{{overflow-x:auto;margin-top:14px}}
table{{border-collapse:collapse;width:100%;min-width:460px;font-size:14px}}
th,td{{text-align:left;padding:9px 13px;border-bottom:1px solid var(--rule);vertical-align:top}}
th{{font-size:11.5px;font-weight:650;letter-spacing:.08em;text-transform:uppercase;
    color:var(--faint)}}
td.num{{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}}
.note{{border-left:3px solid var(--accent);background:var(--accent-soft);
       border-radius:0 8px 8px 0;padding:14px 17px;margin-top:18px}}
.note.warn{{border-left-color:var(--warn);background:var(--warn-soft)}}
.note.amber{{border-left-color:var(--amber);background:var(--amber-soft)}}
.note.good{{border-left-color:var(--good);background:var(--good-soft)}}
.note h3{{margin:0 0 5px}}
.note p{{font-size:14px;color:var(--muted);margin:0 0 8px}} .note p:last-child{{margin:0}}
.note b{{color:var(--ink);font-weight:650}}
.empty{{font-size:14px;color:var(--faint);font-style:italic}}
.funnel{{display:flex;flex-direction:column;gap:9px;margin-top:16px}}
.fr{{display:grid;grid-template-columns:minmax(120px,200px) 1fr auto;gap:12px;
     align-items:center;font-size:14px}}
.ftrack{{background:var(--sunk);border-radius:4px;height:14px;overflow:hidden}}
.ffill{{display:block;height:100%;border-radius:0 4px 4px 0}}
.fv{{font-variant-numeric:tabular-nums;color:var(--muted);min-width:86px;text-align:right}}
footer{{border-top:1px solid var(--rule);padding-top:20px;margin-top:14px;
        font-size:13px;color:var(--faint)}}
@media print{{body{{background:#fff}} .card{{box-shadow:none}}}}
</style>

<div class="wrap">
<header>
  <p class="eyebrow">Pastecal &middot; Local usage report</p>
  <h1>Last {days} days</h1>
  <p class="sub">Generated {esc(d.get("generated", ""))} from GA4 property
     <code>pastecal-web</code>. This file is local; nothing is published.</p>
</header>''')

# ---- capped queries: any metric built on a truncated report reads low
if capped:
    items = "".join(
        f"<li><b>{esc(label)}</b> &mdash; {esc(num(got))} of {esc(num(total))} rows</li>"
        for label, (got, total) in capped)
    A(f'''<div class="note warn">
<h3>Some numbers below are truncated</h3>
<p>GA4 returned fewer rows than exist for these queries, so the figures built on
them read <b>low</b>. Raise the query's limit in <code>scripts/report.sh</code>.</p>
<ul style="font-size:14px;color:var(--muted);margin:0;padding-left:20px">{items}</ul>
</div>''')


def rate_cell(part, whole):
    """count (pct%) -- the percentage only once the base is big enough to mean
    something; under MIN_N the cell says so instead."""
    if whole < MIN_N:
        return f'{num(part)} <span class="empty">(n&lt;{MIN_N})</span>'
    return f'{num(part)} ({pct(part, whole):.0f}%)'


# ---- north star (leads the report: the one number, then the diagnostics)
if len(wasc) >= 6:
    def wlab(wk):
        return f"W{int(wk[4:])} '{wk[2:4]}"

    shared_series = [(wlab(w["week"]), w["shared"]) for w in wasc]
    latest = wasc[-1]
    cur4 = sum(w["shared"] for w in wasc[-4:]) / 4
    # Same ISO weeks a year earlier -- not the first weeks of the chart, which
    # sit ~47 weeks back and change with the window.
    yoy_x, yoy_why = yoy(wasc_all)
    yoy_tone = TONE[direction(yoy_x)]
    roll = [sum(w["shared"] for w in wasc[i:i + 4]) / 4 for i in range(len(wasc) - 3)]
    peak4 = max(roll)
    peak_wk = wlab(wasc[roll.index(peak4) + 3]["week"])

    # Trend, judged against the best 4-week stretch rather than last window:
    # this series plateaued for 14 weeks in summer 2026 while every short delta
    # read "flat, fine". Distance from peak is the honest question.
    off = (cur4 / peak4) if peak4 else None
    if off is None:
        trend_note = '''<div class="note amber">
<h3>No shared calendars yet</h3>
<p>No calendar reached a second person in any week of the last year, so there
is no peak to measure against.</p></div>'''
    elif off >= 0.97:
        trend_note = f'''<div class="note good">
<h3>At the high-water mark</h3>
<p>The current 4-week average (<b>{num(cur4, 1)}</b>) is at or above the best
4-week stretch of the last year (<b>{num(peak4, 1)}</b>). Keep feeding it.</p></div>'''
    elif off >= 0.88:
        trend_note = f'''<div class="note amber">
<h3>Plateaued below the peak</h3>
<p>The current 4-week average (<b>{num(cur4, 1)}</b>) sits {num((1 - off) * 100, 0)}%
under the best stretch (<b>{num(peak4, 1)}</b>, ending {esc(peak_wk)}). A few
weeks of this is noise or season; a quarter of it means the growth loop has
found its ceiling and needs a new input &mdash; check the cohort table below
for which stage is leaking.</p></div>'''
    else:
        trend_note = f'''<div class="note warn">
<h3>Well off the peak</h3>
<p>The current 4-week average (<b>{num(cur4, 1)}</b>) is {num((1 - off) * 100, 0)}%
below the best stretch (<b>{num(peak4, 1)}</b>, ending {esc(peak_wk)}). That is
past plateau territory &mdash; something changed. Compare the cohort table's
birth counts (acquisition) against its survival rates (retention) to see which
side fell.</p></div>'''

    too_young = '<span class="empty">too young</span>'
    coh_rows = []
    for b in sorted(cohorts)[-12:]:
        c = cohorts[b]
        coh_rows.append([
            esc(wlab(weeks_all[b])),
            num(c["born"]),
            rate_cell(c["shared"], c["born"]) if c["share_judged"] else too_young,
            rate_cell(c["alive"], c["born"]) if c["alive_judged"] else too_young,
        ])

    coh_headers = ["Born week", "Calendars", f"2nd person by wk {SHARE_WEEKS}",
                   f"Alive wk {ALIVE_FROM}–{ALIVE_TO}"]

    leak_note = ""
    if leak_stats:
        L = leak_stats
        basis = (f'{num(L["born"])} calendars from {num(L["cohorts"])} '
                 f'cohort{"s" if L["cohorts"] != 1 else ""}')
        if not L["enough"]:
            verdict = (f'<p>Only {basis} are old enough to judge &mdash; too few '
                       f'for the rates to mean anything yet.</p>')
            tone = ""
        elif L["worse"] == "retention":
            verdict = (f'<p>Across {basis} old enough to judge, <b>{L["share_rate"]:.0f}%</b> '
                       f'reached a second person within {SHARE_WEEKS} weeks and '
                       f'<b>{L["alive_rate"]:.0f}%</b> still had traffic in weeks '
                       f'{ALIVE_FROM}&ndash;{ALIVE_TO}. Fewer survive than get shared, '
                       f'so the bigger leak is <b>retention</b>: groups try it, share '
                       f'it, then drift.</p>')
            tone = " amber"
        else:
            rates = (f'<p>Across {basis} old enough to judge, <b>{L["share_rate"]:.0f}%</b> '
                     f'reached a second person within {SHARE_WEEKS} weeks and '
                     f'<b>{L["alive_rate"]:.0f}%</b> still had traffic in weeks '
                     f'{ALIVE_FROM}&ndash;{ALIVE_TO}. ')
            if L["worse"] == "sharing":
                verdict = rates + ('More calendars fail to reach a second person '
                                   'than fail to survive, so the bigger leak is the '
                                   '<b>share step</b>.</p>')
            else:
                verdict = rates + ('The two steps lose about as many calendars '
                                   'each; neither is clearly the bigger leak.</p>')
            tone = " amber"
        leak_note = f'''<div class="note{tone}">
<h3>Where the loop leaks</h3>
{verdict}
<p>Floors, not ceilings: "2nd person" means 2+ browsers in a single week (GA4
cannot de-duplicate people across weeks), <code>/view/</code>-link visitors
cannot be attributed to their calendar, and ICS subscribers never hit GA4 at
all. A calendar dormant 8+ weeks reads as newborn when it wakes.</p></div>'''

    A(f'''<section>
<h2>North star: weekly active shared calendars</h2>
<p class="lede">Calendars that reached <b>2+ people inside one week</b> &mdash;
a group actually coordinating through pastecal, not a link opened once. This is
the number the product exists to grow: it is the unit of word-of-mouth (every
shared calendar advertises to its viewers) and the base under every Pro-tier
projection. "People" means distinct browsers, so one person on two devices
counts &mdash; the 3+ tile is the conservative floor.</p>
<div class="tiles">
  <div class="tile hi"><div class="v">{num(latest["shared"])}</div>
    <div class="k">Shared calendars, {esc(wlab(latest["week"]))} (last settled week;
    weeks under {LAG_DAYS} days old are left out while GA4 catches up)</div></div>
  <div class="tile"><div class="v">{num(cur4, 1)}</div>
    <div class="k">4-week average</div></div>
  <div class="tile {yoy_tone}"><div class="v">{times(yoy_x)}</div>
    <div class="k">Last 4 weeks vs the same ISO weeks a year ago{
        " (" + esc(yoy_why) + ")" if yoy_why else ""}</div></div>
  <div class="tile"><div class="v">{num(latest["strong"])}</div>
    <div class="k">With 3+ people, same week</div></div>
</div>
<div class="card">
  <h3>Weekly active shared calendars, last 12 months</h3>
  {sparkline(shared_series, label="Weekly active shared calendars, last 12 months")}
</div>
{trend_note}
<div class="card">
  <h3>Cohort survival &mdash; the input that moves the number</h3>
  <p class="lede">Of calendars first seen each week: how many reached a second
  person within {SHARE_WEEKS} weeks of birth, and how many had any traffic in
  weeks {ALIVE_FROM}&ndash;{ALIVE_TO}. Every cohort gets the same windows, so a
  cohort is "too young" until its window has fully passed. Terminal version:
  <code>./scripts/stats.sh cohorts</code> (open-ended windows; may differ).</p>
  {table(coh_headers, coh_rows, ["l", "r", "r", "r"])}
</div>
{leak_note}
</section>''')

# ---- growth (direction before detail)
if len(complete) >= 3:
    mult_u = growth_multiple(complete, "users")
    mult_r = growth_multiple(complete, "returning")
    mom = avg_mom(complete, "users")
    span = f"{complete[0]['short']} to {complete[-1]['short']}"
    g_tone, g_title, g_body = growth_verdict(mult_u, mult_r)

    def mult_tile(x, label):
        return (f'<div class="tile {TONE[direction(x)]}"><div class="v">{times(x)}</div>'
                f'<div class="k">{label}</div></div>')

    mom_dir = None if mom is None else direction(1 + mom / 100.0, band=0.005)
    A(f'''<section>
<h2>Growth</h2>
<p class="lede">Twelve months of direction. A two-window comparison on a site
this noisy can say the opposite of the trend, so direction comes before the
short-window numbers below.</p>

<div class="tiles">
  {mult_tile(mult_u, "People, " + esc(span))}
  {mult_tile(mult_r, "Returning people, same span")}
  <div class="tile {TONE[mom_dir]}"><div class="v">{"n/a" if mom is None else num(mom, 1) + "%"}</div>
    <div class="k">Average month over month</div></div>
</div>

<div class="card">
  <h3>People per month</h3>
  {monthly_chart(complete, partial)}
</div>

<div class="note {g_tone}">
<h3>{g_title}</h3>
<p>People: <b>{times(mult_u)}</b>; returning people: <b>{times(mult_r)}</b>,
{esc(span)}. {g_body}</p>
</div>
</section>''')


# ---- KPIs
def kpi(name, value, now, before, note, n=None):
    change, direction_, why = delta(now, before, n)
    if change is None:
        chip = f'<span class="kd flat">{esc(why)}</span>'
    else:
        arrow = {"up": "&uarr;", "down": "&darr;", "flat": "&rarr;"}[direction_]
        chip = (f'<span class="kd {direction_}">{arrow} {abs(change):.0f}% '
                f'vs previous {days}d</span>')
    return (f'<div class="kpi"><div class="kn">{esc(name)}</div>'
            f'<div class="kv">{value}</div>{chip}'
            f'<div class="kw">{note}</div></div>')


if cur_share:
    share_val = (f"{pct(*cur_share):.0f}%" if cur_share[1] >= MIN_N
                 else f"{num(cur_share[0])}/{num(cur_share[1])}")
    share_kpi = kpi(
        "Calendars shared", share_val,
        pct(*cur_share), pct(*prev_share) if prev_share else None,
        f"Of {num(cur_share[1])} calendars active in the last {k_weeks} settled "
        f"week{'s' if k_weeks != 1 else ''}, {num(cur_share[0])} reached a second "
        "person inside a week. Per calendar, not per person: someone with three "
        "solo calendars is three unshared calendars.",
        n=min(cur_share[1], prev_share[1]) if prev_share else None)
else:
    share_kpi = kpi("Calendars shared", "n/a", 0, None,
                    "No settled weeks of calendar data in the payload.")

A(f'''<section>
<h2>The three numbers</h2>
<p class="lede">Chosen against the growth model: people who come back, whether
calendars actually get shared, and how many calendars have a real audience.</p>
<p class="lede"><b>Read the deltas against the trend above, not on their own.</b>
A {days}-day window is short enough that a busy fortnight can invert the sign
&mdash; these say what changed recently, not which way the product is going.
Deltas are hidden when either window has fewer than {MIN_N} to compare.</p>
<div class="kpis">
{kpi("Returning people", num(cur_ret), cur_ret, prev_ret,
     "People who came back at least once. Total visitors flatters &mdash; most arrive once "
     "and never return, so this is the population that could ever matter commercially.",
     n=min(cur_ret, prev_ret))}
{share_kpi}
{kpi("Calendars that stick", num(len(cur_sticky)), len(cur_sticky), len(prev_sticky),
     f"Calendars with 3+ people in the window and traffic in "
     f"{'2+ of its weeks' if k_weeks >= 2 else 'its week'}. A calendar a group "
     "keeps coming back to, not a link opened once.",
     n=min(len(cur_sticky), len(prev_sticky)))}
</div>
</section>''')

# ---- headline
A(f'''<section>
<h2>Visitors</h2>
<p class="lede">Returning visitors are the ones doing real work &mdash; compare
the two rows below rather than reading the totals alone.</p>
<div class="tiles">
  <div class="tile"><div class="v">{num(total_users)}</div><div class="k">People</div></div>
  <div class="tile"><div class="v">{num(total_sessions)}</div><div class="k">Sessions</div></div>
  <div class="tile hi"><div class="v">{num(ret_per_user, 1)}&times;</div>
    <div class="k">Sessions per returning person</div></div>
  <div class="tile hi"><div class="v">{secs(ret_u[2])}</div>
    <div class="k">Returning session length</div></div>
</div>
<div class="card">
  <h3>Daily people</h3>
  {sparkline(series)}
</div>
{table(["Type", "Sessions", "People", "Per person", "Avg length"],
       [[esc(k),
         f'<span>{num(v[0])}</span>', num(v[1]),
         num((v[0] / v[1]) if v[1] else 0, 1),
         secs(v[2])]
        for k, v in sorted(ov.items(), key=lambda kv: -kv[1][0])
        if k in ("new", "returning")],
       ["l", "r", "r", "r", "r"])}
</section>''')

# ---- product events
A('<section><h2>Product events</h2>')

if has_events:
    A('<p class="lede">What people actually do, from the instrumentation in '
      '<code>utils/analytics.js</code>.</p>')
    A(table(["Event", "Count", "People"],
            [[f"<code>{esc(k)}</code>", num(v[0]), num(v[1])]
             for k, v in sorted(ev.items(), key=lambda kv: -kv[1][0])],
            ["l", "r", "r"]))
else:
    live = "".join(
        f'<div class="bar"><span class="bl"><code>{esc(k)}</code></span>'
        f'<span class="btrack"><span class="bfill" style="width:100%"></span></span>'
        f'<span class="bv">{num(v[0])}</span></div>'
        for k, v in sorted(rt_custom.items(), key=lambda kv: -kv[1][0]))
    if rt_custom:
        A(f'''<div class="note good">
<h3>Firing now, not yet in the daily tables</h3>
<p>No custom events appear in the {days}-day window, but GA4's realtime view is
already recording them. Realtime has no processing delay; the daily tables run
<b>24 to 48 hours behind</b>. Check again tomorrow.</p>
<div class="bars" style="margin-top:12px">{live}</div>
<p style="margin-top:10px">Counts above are the last 30 minutes.</p>
</div>''')
    else:
        A('''<div class="note amber">
<h3>No product events recorded</h3>
<p>Neither the daily tables nor realtime show any custom events. Either the
instrumentation has not been deployed, or it is not reaching GA4. Verify with
<code>npx playwright test test/e2e/analytics-delivery.spec.js</code>, which
asserts on the actual network request.</p>
</div>''')
A("</section>")

# ---- funnel
if shown or claimed or auto:
    kept_w = pct(auto, shown) if shown else 0
    chose_w = pct(claimed, shown) if shown else 0
    A(f'''<section>
<h2>Naming a calendar</h2>
<p class="lede">Everyone is offered a generated name they can change. This is the
rate at which they do.</p>
<div class="funnel">
  <div class="fr"><span>Offered a name</span>
    <span class="ftrack"><span class="ffill" style="width:100%;background:var(--s1)"></span></span>
    <span class="fv">{num(shown)}</span></div>
  <div class="fr"><span>Chose their own</span>
    <span class="ftrack"><span class="ffill" style="width:{chose_w:.1f}%;background:var(--s3)"></span></span>
    <span class="fv">{num(claimed)} &middot; {pct(claimed, shown):.0f}%</span></div>
  <div class="fr"><span>Kept the random one</span>
    <span class="ftrack"><span class="ffill" style="width:{kept_w:.1f}%;background:var(--s2)"></span></span>
    <span class="fv">{num(auto)} &middot; {pct(auto, shown):.0f}%</span></div>
</div>
<div class="note">
<p><b>How to read it.</b> A high "kept the random one" share says the naming step
is not discoverable, not that people are happy with a random name.
{"A <b>" + num(failed) + "</b> name-taken count argues for suggesting alternatives." if failed else ""}</p>
</div>
</section>''')

# ---- breakdowns
if bd:
    A('<section><h2>Breakdowns</h2>'
      '<p class="lede">Available because the matching custom dimensions are registered.</p>')
    titles = {"sources": "Where events get created", "methods": "How calendars get shared",
              "visits": "How deep people return", "surfaces": "Which surface named the calendar",
              "features": "Which features get used"}
    unset_only = []
    for key, title in titles.items():
        if key not in bd:
            continue
        items = [(dims[0] or "(not set)", mets[0]) for dims, mets in rows(bd[key])]
        if not items:
            continue
        # A dimension registered today has no history: GA4 does not backfill, so
        # every event recorded before it existed reports "(not set)" forever.
        # Showing a full-width bar labeled "(not set)" looks like a broken chart
        # rather than the expected consequence of when the dimension was created.
        if all(label == "(not set)" for label, _ in items):
            unset_only.append((title, sum(v for _, v in items)))
            continue
        A(f'<div class="card"><h3>{esc(title)}</h3>{bars(items)}</div>')

    if unset_only:
        rows_html = "".join(
            f"<li><b>{esc(t)}</b> &mdash; {esc(num(n))} events</li>" for t, n in unset_only)
        A(f'''<div class="note amber">
<h3>Waiting on new data</h3>
<p>These breakdowns have no values yet because their custom dimensions were
registered <b>after</b> the events were recorded, and GA4 <b>never backfills</b>
&mdash; historic events report <code>(not set)</code> permanently.</p>
<ul style="font-size:14px;color:var(--muted);margin:0 0 9px;padding-left:20px">{rows_html}</ul>
<p>Events collected from the registration date forward will segment normally.
Check again tomorrow.</p>
</div>''')
    A("</section>")

# ---- reach
by_people = sorted(reach_rows, key=lambda r: -r["users"])[:12]
by_loyalty = sorted([r for r in reach_rows if r["users"] >= 3],
                    key=lambda r: -r["per"])[:12]

A(f'''<section>
<h2>Reach: how many people, versus how often</h2>
<p class="lede">Two different questions, and a calendar can score high on one and
low on the other. <b>People</b> is distinct visitors; <b>views each</b> is how
hard those same people are reloading it.</p>

<div class="card">
  <h3>Seen by the most different people</h3>
  {table(["Calendar", "People", "Views", "Views each"],
         [[f"<code>{esc(r['path'])}</code>", num(r["users"]),
           num(r["views"]), num(r["per"], 1)]
          for r in by_people],
         ["l", "r", "r", "r"])}
</div>

<div class="card">
  <h3>Reloaded hardest by the fewest people</h3>
  <p class="lede" style="margin-bottom:0">Three or more people, ranked by views
  each. A high number here is a small group depending on the calendar daily.</p>
  {table(["Calendar", "Views each", "People", "Views"],
         [[f"<code>{esc(r['path'])}</code>", num(r["per"], 1), num(r["users"]),
           num(r["views"])]
          for r in by_loyalty],
         ["l", "r", "r", "r"])}
</div>

<div class="note">
<h3>How to read the two together</h3>
<p><b>Many people, few views each</b> is a calendar being discovered or shared
around. <b>Few people, many views each</b> is a small group who depend on it
&mdash; the strongest signal that a calendar matters to someone.</p>
<p>There is deliberately no new-versus-returning split per calendar: GA4
credits a person's first visit to whichever page it happened on, so someone who
first opened the homepage counts as "returning" on every calendar after it.</p>
</div>
</section>''')

# ---- where from
dev = [(dims[0], mets[0]) for dims, mets in rows(d.get("devices"))]
chan = [(dims[0], mets[0]) for dims, mets in rows(d.get("channels"))]
ctry = [(dims[0], mets[0]) for dims, mets in rows(d.get("countries"))]
A(f'''<section>
<h2>Where people come from</h2>
<div class="card"><h3>Device</h3>{bars(dev)}</div>
<div class="card"><h3>Channel</h3>{bars(chan)}</div>
<div class="card"><h3>Country</h3>{bars(ctry)}</div>
</section>''')

# ---- config health
if missing:
    A(f'''<section>
<h2>Reporting gaps</h2>
<div class="note amber">
<h3>{len(missing)} event parameter{"s" if len(missing) != 1 else ""} cannot be broken down</h3>
<p>These are <b>collected</b>, but not queryable as a dimension until registered
in GA4 &mdash; and GA4 <b>never backfills</b>, so every day without them is a day
that can never be segmented later.</p>
<p>{" ".join("<code>" + esc(p) + "</code>" for p in missing)}</p>
<p style="margin-top:10px">Fix with <code>./scripts/stats.sh setup --create</code>.</p>
</div>
</section>''')
else:
    A('''<section>
<h2>Reporting gaps</h2>
<div class="note good"><h3>None</h3>
<p>Every event parameter is registered as a custom dimension and can be used as a
breakdown.</p></div>
</section>''')

A(f'''<footer>
Built by <code>./scripts/report.sh</code> from the GA4 Data API using local
credentials. Nothing here is served from pastecal.com. Window: last {days} days,
ending yesterday &mdash; GA4 daily tables lag 24 to 48 hours.
</footer>
</div>''')

sys.stdout.write("\n".join(parts))
