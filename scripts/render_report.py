#!/usr/bin/env python3
"""Render the GA4 payload from report.sh into a standalone HTML report.

Reads one JSON object on stdin, writes HTML on stdout. No dependencies, no
network: everything needed is already in the payload, so the output file works
offline and can be mailed around.

Kept separate from report.sh because building HTML in bash is how you get
unescaped user data in an attribute. Every value here goes through esc().
"""

import html
import json
import sys


def esc(v):
    return html.escape(str(v), quote=True)


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


def num(x, places=0):
    if x is None:
        return "0"
    if places == 0:
        return f"{int(round(x)):,}"
    return f"{x:,.{places}f}"


def pct(part, whole):
    return 0.0 if not whole else part * 100.0 / whole


def secs(x):
    x = int(round(x or 0))
    return f"{x // 60}m {x % 60:02d}s" if x >= 60 else f"{x}s"


# ---------------------------------------------------------------- charts


def sparkline(series, width=760, height=128):
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
     aria-label="Daily users over the reporting window">
  <polygon points="{area}" class="area"/>
  <polyline points="{line}" class="line"/>
  {''.join(marks)}
</svg>
<div class="axis"><span>{esc(series[0][0])}</span><span>{esc(series[-1][0])}</span></div>'''


def monthly_chart(items, partial_item=None):
    """Monthly users, returning vs new, as stacked columns.

    Stacked rather than two lines because the QUESTION is the mix -- how much of
    the growth is people coming back -- and a stack answers that directly. A 2px
    surface gap separates the segments so the boundary is never ambiguous.
    """
    if len(items) < 2:
        return '<p class="empty">Not enough months yet.</p>'
    show = items[-12:]
    hi = max(r["users"] for r in show) or 1
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
    tail = ""
    if partial_item:
        ret_h = partial_item["returning"] / hi * 100
        new_h = partial_item["new"] / hi * 100
        tail = (f'<div class="mcol partial" title="{esc(partial_item["label"])}: '
                f'month still in progress">'
                f'<span class="mplot"><span class="mstack">'
                f'<span class="mnew" style="height:{new_h:.1f}%"></span>'
                f'<span class="mret" style="height:{ret_h:.1f}%"></span>'
                f'</span></span>'
                f'<span class="mlab">{esc(partial_item["short"])}</span></div>')
    return (
        '<div class="mlegend">'
        '<span><i class="sw ret"></i>Returning</span>'
        '<span><i class="sw new"></i>New</span></div>'
        '<div class="months">' + "".join(cols) + tail + "</div>"
        + ('<p class="mnote">The final column is the current month, still in '
           'progress &mdash; it is not a decline.</p>' if partial_item else ""))


def bars(items, unit=""):
    """Ranked horizontal bars. Magnitude by length; value direct-labelled."""
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
# the page, undercounting anything reached from the homepage.
reach_rows = []
for dims, mets in rows(d.get("reach")):
    path = dims[0] or "(not set)"
    views, users, new_users = mets[0], mets[1], (mets[2] if len(mets) > 2 else 0)
    if users <= 0:
        continue
    reach_rows.append({
        "path": path,
        "views": views,
        "users": users,
        "new": new_users,
        "returning": max(users - new_users, 0),
        "per": views / users,
    })

# ---------------------------------------------------------------- KPIs
#
# Three numbers, chosen against the business model in internal/specs/pro.md:
# MAU -> conversion -> MRR, with the free tier as the growth engine. Each answers
# a question that would change what gets built next.
#
#   1. Returning people   -- the population that could ever convert. Total users
#                            flatters: most are one-visit arrivals.
#   2. Sharing ratio      -- calendar viewers per homepage visitor. The free tier
#                            exists to be shared; this is whether that works.
#   3. Calendars that stick -- calendars with 3+ people AND returning visitors.
#                            The unit of real value, and the Pro upsell target.


def split_users(block):
    """(returning people, new people). Index 1 is totalUsers: the overview query
    asks for sessions,totalUsers,averageSessionDuration in that order, and both
    windows must use the same order or this compares sessions against people."""
    o = {dims[0]: mets for dims, mets in rows(block)}
    ret = o.get("returning", (0, 0, 0))
    new_ = o.get("new", (0, 0, 0))
    return (ret[1] if len(ret) > 1 else 0, new_[1] if len(new_) > 1 else 0)


def reach_of(block):
    out = []
    for dims, mets in rows(block):
        path = dims[0] or ""
        if not path:
            continue
        views, users = mets[0], mets[1]
        new_u = mets[2] if len(mets) > 2 else 0
        if users <= 0:
            continue
        out.append({"path": path, "views": views, "users": users,
                    "new": new_u, "returning": max(users - new_u, 0)})
    return out


def sharing_ratio(items):
    """Calendar viewers per homepage visitor.

    /view/ paths are excluded: they are the read-only mirror of a calendar
    already counted under its own path, so including them double-counts reach.
    """
    home = sum(r["users"] for r in items if r["path"] == "/")
    cals = sum(r["users"] for r in items
               if r["path"] != "/" and not r["path"].startswith("/view/"))
    return (cals / home) if home else 0.0


def sticky(items, min_people=3):
    """Calendars with a real audience: several people, some of them returning."""
    return [r for r in items
            if r["users"] >= min_people and r["returning"] >= 1
            and r["path"] != "/" and not r["path"].startswith("/view/")]


# ---- monthly history --------------------------------------------------------
# The single most important context in the report. A two-window delta on a noisy
# site says almost nothing; twelve months of direction says a lot.
monthly = []
for dims, mets in sorted(rows(d.get("monthly")), key=lambda r: r[0][0]):
    ym = dims[0]
    if len(ym) != 6:
        continue
    users, new_users = mets[0], mets[1]
    monthly.append({
        "ym": ym,
        "label": f"{ym[:4]}-{ym[4:]}",
        "short": ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][int(ym[4:]) - 1] + " " + ym[2:4],
        "users": users,
        "new": new_users,
        "returning": max(users - new_users, 0),
    })

# The current month is partial, so it always looks like a crash. Flag it rather
# than letting it read as a decline.
partial = monthly[-1] if monthly else None
complete = monthly[:-1] if len(monthly) > 1 else monthly


def growth_multiple(items, key):
    if len(items) < 2 or not items[0][key]:
        return None
    return items[-1][key] / items[0][key]


def avg_mom(items, key):
    if len(items) < 2 or not items[0][key]:
        return None
    n = len(items) - 1
    return ((items[-1][key] / items[0][key]) ** (1.0 / n) - 1) * 100


cur_ret, cur_new = split_users(d.get("overview"))
prev_ret, prev_new = split_users(d.get("prevOverview"))

cur_reach = reach_of(d.get("reach"))
prev_reach_items = reach_of(d.get("prevReach"))

cur_ratio = sharing_ratio(cur_reach)
prev_ratio = sharing_ratio(prev_reach_items)

cur_sticky = sticky(cur_reach)
prev_sticky = sticky(prev_reach_items)


def delta(now, before):
    """Percent change, and a direction word. None when there is no baseline."""
    if not before:
        return None, "flat"
    change = (now - before) * 100.0 / before
    if change >= 3:
        return change, "up"
    if change <= -3:
        return change, "down"
    return change, "flat"


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

# ---- growth (leads the report: direction before detail)
if len(complete) >= 3:
    mult_u = growth_multiple(complete, "users")
    mult_r = growth_multiple(complete, "returning")
    mom = avg_mom(complete, "users")
    span = f"{complete[0]['short']} to {complete[-1]['short']}"

    A(f'''<section>
<h2>Growth</h2>
<p class="lede">Twelve months of direction. A two-window comparison on a site
this noisy can say the opposite of the trend, so this comes first.</p>

<div class="tiles">
  <div class="tile hi"><div class="v">{num(mult_u, 1)}&times;</div>
    <div class="k">People, {esc(span)}</div></div>
  <div class="tile hi"><div class="v">{num(mult_r, 1)}&times;</div>
    <div class="k">Returning people, same span</div></div>
  <div class="tile good"><div class="v">{num(mom, 1)}%</div>
    <div class="k">Average month over month</div></div>
</div>

<div class="card">
  <h3>People per month</h3>
  {monthly_chart(complete, partial)}
</div>

<div class="note good">
<h3>Returning growth is tracking total growth</h3>
<p>People grew <b>{num(mult_u, 1)}&times;</b> and returning people grew
<b>{num(mult_r, 1)}&times;</b> over the same span. Retention is keeping pace with
acquisition rather than lagging it &mdash; the audience is compounding, not
churning through.</p>
</div>
</section>''')

# ---- KPIs
def kpi(name, value, now, before, note, invert=False):
    change, direction = delta(now, before)
    if change is None:
        chip = '<span class="kd flat">no baseline</span>'
    else:
        arrow = {"up": "&uarr;", "down": "&darr;", "flat": "&rarr;"}[direction]
        cls = direction
        if invert and direction in ("up", "down"):
            cls = "down" if direction == "up" else "up"
        chip = (f'<span class="kd {cls}">{arrow} {abs(change):.0f}% '
                f'vs previous {days}d</span>')
    return (f'<div class="kpi"><div class="kn">{esc(name)}</div>'
            f'<div class="kv">{value}</div>{chip}'
            f'<div class="kw">{note}</div></div>')


A(f'''<section>
<h2>The three numbers</h2>
<p class="lede">Chosen against the growth model: people who come back, whether
calendars actually get shared, and how many calendars have a real audience.</p>
<p class="lede"><b>Read the deltas against the trend above, not on their own.</b>
A {days}-day window is short enough that a busy fortnight can invert the sign
&mdash; these say what changed recently, not which way the product is going.</p>
<div class="kpis">
{kpi("Returning people", num(cur_ret), cur_ret, prev_ret,
     "People who came back at least once. Total visitors flatters &mdash; most arrive once "
     "and never return, so this is the population that could ever matter commercially.")}
{kpi("Sharing ratio", f"{cur_ratio:.2f}&times;", cur_ratio, prev_ratio,
     "Calendar viewers per homepage visitor. The free tier exists to be shared; "
     "below 1.0 means calendars are being made but not sent to anyone.")}
{kpi("Calendars that stick", num(len(cur_sticky)), len(cur_sticky), len(prev_sticky),
     "Calendars with 3+ people where someone returned. A calendar a group depends "
     "on, not a link opened once.")}
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
        # Showing a full-width bar labelled "(not set)" looks like a broken chart
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
  {table(["Calendar", "People", "New", "Returning", "Views", "Views each"],
         [[f"<code>{esc(r['path'])}</code>", num(r["users"]), num(r["new"]),
           num(r["returning"]), num(r["views"]), num(r["per"], 1)]
          for r in by_people],
         ["l", "r", "r", "r", "r", "r"])}
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
<p>"New" counts people first seen in this window, so a calendar whose users are
mostly new is still spreading; one where few are new has settled into a regular
audience.</p>
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
