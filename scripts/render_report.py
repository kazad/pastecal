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
    "slug_prompt_shown", "slug_claimed", "slug_autoassigned", "slug_claim_failed",
    "event_added", "calendar_shared", "calendar_returned",
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
NEEDED = ["where", "source", "method", "visit_bucket", "slug_length",
          "event_count_bucket", "has_custom_slug", "reason", "surface"]
missing = [p for p in NEEDED if not dims_list or p not in dims_list] if dims_list is not None else NEEDED

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
              "visits": "How deep people return", "surfaces": "Which surface named the calendar"}
    for key, title in titles.items():
        if key in bd:
            items = [(dims[0] or "(none)", mets[0]) for dims, mets in rows(bd[key])]
            if items:
                A(f'<div class="card"><h3>{esc(title)}</h3>{bars(items)}</div>')
    A("</section>")

# ---- calendars
A(f'''<section>
<h2>Busiest calendars</h2>
<p class="lede">Ranked by visits per person, which separates a standing schedule
people keep checking from a page that got linked once.</p>
{table(["Calendar", "Sessions", "People", "Visits each"],
       [[f"<code>{esc(p)}</code>", num(s), num(u), num(r, 1)] for p, s, u, r in cal_rows],
       ["l", "r", "r", "r"])}
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
