"""Tests for the usage report's numbers (scripts/report_metrics.py) and for the
conclusions render_report.py draws from them.

    python3 -m unittest discover -s test/report

Synthetic payloads only: nothing here talks to GA4. Each test pins one defect the
report used to have, named in its docstring, so a regression says what broke.
"""

import datetime
import json
import os
import re
import subprocess
import sys
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
sys.path.insert(0, SCRIPTS)

import report_metrics as m  # noqa: E402

D = datetime.date


# ---------------------------------------------------------------- fixtures

def blk(rows_, row_count=None):
    out = {"rows": [{"dimensionValues": [{"value": v} for v in dims],
                     "metricValues": [{"value": str(x)} for x in mets]}
                    for dims, mets in rows_]}
    if row_count is not None:
        out["rowCount"] = row_count
    return out


def wk(day):
    return m.week_key(day)


def weeks_back(today, n):
    """ISO week keys for the n weeks before today's week, oldest first."""
    mon = today - datetime.timedelta(days=today.weekday())
    return [wk(mon - datetime.timedelta(weeks=i)) for i in range(n, 0, -1)]


def weekly_block(cells):
    """cells: {(week, path): people}"""
    return blk([((w, p), [u]) for (w, p), u in cells.items()])


def render(payload):
    res = subprocess.run([sys.executable, os.path.join(SCRIPTS, "render_report.py")],
                         input=json.dumps(payload), capture_output=True, text=True,
                         check=True)
    return res.stdout


def base_payload(today, **kw):
    p = {"overview": blk([(("new",), [10, 8, 30]), (("returning",), [5, 2, 60])]),
         "prevOverview": blk([(("new",), [10, 8, 30]), (("returning",), [5, 2, 60])]),
         "reach": {}, "prevReach": {}, "monthly": {}, "weekly": {},
         "daily": {}, "events": {}, "devices": {}, "channels": {}, "countries": {},
         "realtime": {}, "pages": {}, "dims": [], "breakdowns": {},
         "days": 28, "generated": "test", "today": today.isoformat()}
    p.update(kw)
    return p


def section(html_, heading):
    """The HTML of the <section> whose <h2> is `heading`."""
    i = html_.index(f"<h2>{heading}")
    return html_[i:html_.index("</section>", i)]


# ---------------------------------------------------------------- formatting

class Formatting(unittest.TestCase):
    def test_none_is_na_not_zero(self):
        """num(None) printed "0", so a missing year-ago base read as "0x"."""
        self.assertEqual(m.num(None), "n/a")
        self.assertEqual(m.times(None), "n/a")
        self.assertEqual(m.num(0), "0")

    def test_direction_tone(self):
        self.assertEqual(m.TONE[m.direction(0.5)], "warn")
        self.assertEqual(m.TONE[m.direction(1.5)], "good")
        self.assertEqual(m.TONE[m.direction(1.0)], "")
        self.assertEqual(m.TONE[m.direction(None)], "")


# ---------------------------------------------------------------- growth

def monthly_rows(start_ym, users, returning):
    y, mo = int(start_ym[:4]), int(start_ym[4:])
    out = []
    for u, r in zip(users, returning):
        out.append(((f"{y}{mo:02d}",), [u, u - r, u]))
        mo += 1
        if mo > 12:
            y, mo = y + 1, 1
    return blk(out)


class GrowthVerdict(unittest.TestCase):
    """The growth box was static text: always green, always "tracking"."""

    def test_lagging_is_not_green(self):
        tone, title, _ = m.growth_verdict(6.0, 1.0)
        self.assertIn("lagging", title)
        self.assertNotEqual(tone, "good")

    def test_tracking_is_green(self):
        tone, title, _ = m.growth_verdict(3.0, 2.9)
        self.assertEqual(tone, "good")
        self.assertIn("tracking", title)

    def test_shrinking_is_red(self):
        tone, _, _ = m.growth_verdict(0.5, 0.5)
        self.assertEqual(tone, "warn")

    def test_missing_is_neutral(self):
        tone, _, _ = m.growth_verdict(None, 2.0)
        self.assertEqual(tone, "")

    def test_rendered_box_follows_the_data(self):
        today = D(2026, 10, 15)
        users = [100 + 50 * i for i in range(13)]
        flat_ret = [20] * 13
        html_ = render(base_payload(today, monthsFrom="2025-10-01",
                                    monthly=monthly_rows("202510", users, flat_ret)))
        g = section(html_, "Growth")
        self.assertIn("lagging total growth", g)
        self.assertNotIn("tracking total growth", g)
        self.assertNotIn('note good', g)

        prop_ret = [u // 2 for u in users]
        g = section(render(base_payload(today, monthsFrom="2025-10-01",
                                        monthly=monthly_rows("202510", users, prop_ret))),
                    "Growth")
        self.assertIn("tracking total growth", g)
        self.assertIn('note good', g)

    def test_mom_tile_is_red_when_shrinking(self):
        """The month-over-month tile was hardcoded green."""
        today = D(2026, 10, 15)
        users = [1000 - 50 * i for i in range(13)]
        g = section(render(base_payload(today, monthsFrom="2025-10-01",
                                        monthly=monthly_rows("202510", users, [u // 2 for u in users]))),
                    "Growth")
        self.assertRegex(g, r'class="tile warn"><div class="v">-[\d.]+%')


class Months(unittest.TestCase):
    """365daysAgo..yesterday assumed the last month partial and the first whole."""

    def rows12(self):
        return monthly_rows("202510", [100] * 12, [10] * 12)   # Oct 25 .. Sep 26

    def test_on_the_third_nothing_is_partial(self):
        complete, partial = m.months(self.rows12(), D(2026, 10, 3), "2025-10-01")
        self.assertEqual(partial, [])
        self.assertEqual(len(complete), 12)
        self.assertEqual(complete[0]["ym"], "202510")   # whole month: kept as baseline

    def test_current_month_is_partial(self):
        rows_ = monthly_rows("202510", [100] * 13, [10] * 13)  # .. Oct 26
        complete, partial = m.months(rows_, D(2026, 10, 15), "2025-10-01")
        self.assertEqual([p["ym"] for p in partial], ["202610"])
        self.assertEqual(complete[-1]["ym"], "202609")

    def test_month_inside_the_lag_is_partial(self):
        """On the 1st, yesterday's data is still processing (GA4 24-48h)."""
        complete, partial = m.months(self.rows12(), D(2026, 10, 1), "2025-10-01")
        self.assertEqual([p["ym"] for p in partial], ["202609"])
        self.assertEqual(len(complete), 11)

    def test_mid_month_start_drops_the_baseline(self):
        complete, _ = m.months(self.rows12(), D(2026, 10, 3), "2025-10-02")
        self.assertEqual(complete[0]["ym"], "202511")


# ---------------------------------------------------------------- weeks / yoy

class Weeks(unittest.TestCase):
    def test_unsettled_week_is_dropped(self):
        """A week that ended yesterday is still inside GA4's processing lag."""
        monday = D(2026, 9, 28)            # Monday: last week ended yesterday
        last_week = wk(monday - datetime.timedelta(days=7))
        weeks, _ = m.fold_weekly(weekly_block({(last_week, "/a"): 2}), monday, "2026-01-05")
        self.assertNotIn(last_week, weeks)
        weeks, _ = m.fold_weekly(weekly_block({(last_week, "/a"): 2}),
                                 monday + datetime.timedelta(days=1), "2026-01-05")
        self.assertEqual(weeks[-1], last_week)

    def test_weeks_are_contiguous_even_without_rows(self):
        """Indexing only weeks that had rows shifted every "N weeks later"."""
        today = D(2026, 9, 30)
        ws = weeks_back(today, 10)
        weeks, _ = m.fold_weekly(weekly_block({(ws[0], "/a"): 1, (ws[-1], "/a"): 1}),
                                 today, m.week_monday(ws[0]).isoformat())
        self.assertEqual(weeks, ws)

    def test_partial_first_week_dropped_only_when_not_monday(self):
        today = D(2026, 9, 30)
        ws = weeks_back(today, 5)
        cells = weekly_block({(w, "/a"): 1 for w in ws})
        weeks, _ = m.fold_weekly(cells, today, m.week_monday(ws[0]).isoformat())
        self.assertEqual(weeks[0], ws[0])
        weeks, _ = m.fold_weekly(cells, today,
                                 (m.week_monday(ws[0]) + datetime.timedelta(days=2)).isoformat())
        self.assertEqual(weeks[0], ws[1])


def series_for(weeks, shared_by_week):
    return [{"week": w, "active": 0, "shared": shared_by_week.get(w, 0), "strong": 0}
            for w in weeks]


class YearOverYear(unittest.TestCase):
    """The "same 4 weeks a year ago" tile compared the window's FIRST 4 weeks
    (~47 weeks earlier), printed 0x for a missing base, and was always green."""

    def setUp(self):
        self.today = D(2026, 9, 30)
        self.weeks = weeks_back(self.today, 60)

    def test_compares_same_iso_weeks(self):
        last4 = self.weeks[-4:]
        ago = [f"{int(w[:4]) - 1}{w[4:]}" for w in last4]
        first4 = self.weeks[:4]
        shared = {w: 8 for w in last4}
        shared.update({w: 4 for w in ago})
        shared.update({w: 1 for w in first4})   # the old, wrong baseline
        x, why = m.yoy(series_for(self.weeks, shared))
        self.assertAlmostEqual(x, 2.0)
        self.assertEqual(why, "")

    def test_missing_year_ago_is_none(self):
        x, why = m.yoy(series_for(self.weeks[-40:], {w: 3 for w in self.weeks}))
        self.assertIsNone(x)
        self.assertIn("no data", why)

    def test_zero_base_is_none(self):
        last4 = self.weeks[-4:]
        x, why = m.yoy(series_for(self.weeks, {w: 3 for w in last4}))
        self.assertIsNone(x)

    def test_week_53_falls_back_to_52(self):
        known = {"202552": 1}
        self.assertEqual(m.year_ago("202653", known), "202552")
        self.assertEqual(m.year_ago("202610", known), "202510")

    def _render_ns(self, now, ago):
        cells = {}
        for i, w in enumerate(self.weeks):
            cells[(w, f"/solo{i}")] = 1
        last4 = self.weeks[-4:]
        for w in last4:
            for j in range(now):
                cells[(w, f"/now{j}")] = 2
            for j in range(ago):
                cells[(f"{int(w[:4]) - 1}{w[4:]}", f"/ago{j}")] = 2
        return section(render(base_payload(
            self.today, weekly=weekly_block(cells),
            weeklyFrom=m.week_monday(self.weeks[0]).isoformat())),
            "North star")

    def test_rendered_tile_direction(self):
        ns = self._render_ns(now=2, ago=4)
        self.assertIn('class="tile warn"><div class="v">0.5&times;', ns)
        ns = self._render_ns(now=4, ago=2)
        self.assertIn('class="tile good"><div class="v">2.0&times;', ns)

    def test_rendered_tile_na(self):
        ns = self._render_ns(now=2, ago=0)
        self.assertRegex(ns, r'<div class="v">n/a</div>\s*<div class="k">Last 4 weeks vs')
        self.assertNotIn("0.0&times;", ns)


# ---------------------------------------------------------------- cohorts

class Cohorts(unittest.TestCase):
    """Rates used open-ended windows: older cohorts had more time to share."""

    def setUp(self):
        self.weeks = [f"2026{i:02d}" for i in range(1, 31)]   # 30 contiguous weeks

    def cells(self, spec):
        return {(self.weeks[i], cal): u for cal, wks in spec.items() for i, u in wks.items()}

    def test_fixed_horizons(self):
        b = 10
        c = m.cohorts(self.weeks, self.cells({
            "/late-share": {b: 1, b + 10: 2},     # shared after the 4-week window
            "/early-share": {b: 1, b + 3: 2},     # last week of the window
            "/late-alive": {b: 1, b + 9: 1},      # traffic after week b+7
            "/alive": {b: 1, b + 7: 1},
            "/old": {2: 1, b: 2},                 # born inside the lookback
        }))[b]
        self.assertEqual(c["born"], 4)
        self.assertEqual(c["shared"], 1)
        self.assertEqual(c["alive"], 1)
        self.assertTrue(c["share_judged"] and c["alive_judged"])

    def test_young_cohorts_not_judged(self):
        last = len(self.weeks) - 1
        c = m.cohorts(self.weeks, self.cells({"/a": {last - 5: 2}}))[last - 5]
        self.assertTrue(c["share_judged"])
        self.assertFalse(c["alive_judged"])
        self.assertIsNone(m.leak({last - 5: c}))

    def test_leak_names_the_weaker_step(self):
        mk = lambda born, sh, al: {0: {"born": born, "shared": sh, "alive": al,
                                       "share_judged": True, "alive_judged": True}}
        self.assertEqual(m.leak(mk(20, 10, 4))["worse"], "retention")
        self.assertEqual(m.leak(mk(20, 2, 8))["worse"], "sharing")
        # 0% and 0% is not "survival is fine": neither step is singled out.
        self.assertEqual(m.leak(mk(20, 0, 0))["worse"], "both")
        self.assertFalse(m.leak(mk(5, 2, 1))["enough"])


# ---------------------------------------------------------------- KPIs

class Sharing(unittest.TestCase):
    """The sharing ratio summed users across calendars: one person's three
    calendars counted as three viewers."""

    def test_solo_calendars_are_not_sharing(self):
        weeks = ["202601", "202602"]
        cells = {("202602", "/mine1"): 1, ("202602", "/mine2"): 1,
                 ("202602", "/mine3"): 1, ("202601", "/group"): 1,
                 ("202602", "/group"): 3}
        self.assertEqual(m.share_rate(weeks, cells, 1), (1, 4))
        self.assertEqual(m.share_rate(weeks, cells, 1, offset=1), (0, 1))
        self.assertIsNone(m.share_rate(weeks, cells, 2, offset=1))


class Sticky(unittest.TestCase):
    """Required a "returning" visitor, which GA4 misattributes per page."""

    def test_no_returning_requirement(self):
        people = {"/group": 4, "/once": 5, "/duo": 2}
        weeks_active = {"/group": 3, "/once": 1, "/duo": 4}
        self.assertEqual(m.sticky(people, weeks_active, 4), ["/group"])
        self.assertEqual(m.sticky(people, weeks_active, 1), ["/group", "/once"])

    def test_reach_people_ignores_new_users(self):
        people = m.reach_people(blk([(("/g",), [10, 4, 4]), (("/",), [9, 9, 9]),
                                     (("/g/",), [1, 3, 0])]))
        self.assertEqual(people, {"/g": 4})


class Deltas(unittest.TestCase):
    def test_small_n_suppressed(self):
        self.assertEqual(m.delta(3, 1, n=1)[0], None)
        self.assertIn("too few", m.delta(3, 1, n=1)[2])
        self.assertAlmostEqual(m.delta(30, 20, n=20)[0], 50.0)
        self.assertEqual(m.delta(5, 0)[2], "no baseline")

    def test_rendered_chip(self):
        html_ = render(base_payload(D(2026, 9, 30)))
        k = section(html_, "The three numbers")
        self.assertIn("too few to compare (n=2)", k)
        self.assertNotIn("&uarr;", k)


class Truncation(unittest.TestCase):
    def test_detects_cap(self):
        self.assertEqual(m.truncation(blk([(("/a",), [1, 1, 0])], row_count=500)), (1, 500))
        self.assertIsNone(m.truncation(blk([(("/a",), [1, 1, 0])], row_count=1)))
        self.assertIsNone(m.truncation({}))

    def test_banner(self):
        html_ = render(base_payload(D(2026, 9, 30),
                                    reach=blk([(("/a",), [5, 3, 0])], row_count=900)))
        self.assertIn("Some numbers below are truncated", html_)
        self.assertIn("1 of 900 rows", html_)
        self.assertNotIn("truncated", render(base_payload(D(2026, 9, 30))))


class ReviewerPayload(unittest.TestCase):
    """The reviewer's generated payload: hostile strings, zero year-ago base."""

    PATH = os.environ.get("REPORT_PAYLOAD")

    @unittest.skipUnless(PATH and os.path.exists(PATH or ""), "set REPORT_PAYLOAD")
    def test_renders_without_zero_multiples_or_raw_html(self):
        with open(self.PATH) as f:
            html_ = render(json.load(f))
        self.assertNotIn("<script>alert", html_)
        self.assertNotRegex(html_, r'>0(\.0)?&times;<')


if __name__ == "__main__":
    unittest.main()
