IN PROGRESS:

## Checking the numbers

```bash
./scripts/report.sh             # full HTML report, opens in your browser
./scripts/report.sh -d 90       # different window
./scripts/report.sh -n -o r.html  # write only, don't open

./scripts/stats.sh              # visitors + product events, last 30 days
./scripts/stats.sh funnel       # of people offered a name, how many chose one
./scripts/stats.sh calendars    # busiest calendars, with visits-per-user
./scripts/stats.sh -d 90 events # any command takes -d for the window
./scripts/stats.sh -j summary   # -j for JSON instead of a table
./scripts/stats.sh setup        # check GA4 can actually answer the above
```

Auth is the ADC you already have; if it 401s, `gcloud auth login --update-adc`.

Two analytics views, deliberately separate:

- `scripts/stats.sh` — GA4, i.e. visitor behavior. Claim rate, return depth,
  where events get added, how calendars get shared.
- `internal/scripts/local-analytics.js` — Firebase, i.e. the data itself.
  Calendar count, titles, event counts, ICS feed hits. Serves HTML on :5197.

**Run `./scripts/stats.sh setup` before relying on any breakdown.** Event
parameters (`source`, `method`, `visit_bucket`, `where`, ...) are collected as
soon as the code ships, but are not queryable until a matching custom dimension
exists in GA4 — and GA4 does not backfill, so a dimension created today shows
nothing for yesterday.

`./scripts/stats.sh setup --create` makes all nine at once. It needs an Analytics
edit scope the default ADC does not carry, granted once with:

```bash
gcloud auth application-default login \
  --scopes=openid,https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/analytics.edit
```

FUTURE:

- Import other ICS calendars to current pastecal (have a list)
- Style top bar similar to instacalc
- Remember recents in localstorage
- Readonly flag
- Password protection
- Safer writing / conflict avoidance (https://firebase.google.com/docs/database/admin/save-data#node.js_8)
- Have public version. So, we have pastecal.com/zad (as public) and pastecal.com/zad?key=1234 as private. The key (hashed) gives the ID to subscribe to?
- Better (official) field (see: https://ej2.syncfusion.com/demos/ Scheduler > Editor > Window > Editor Template)

DONE:

- Event color
- Disable touch events for mobile (to avoid accidental changes)
- Add google tag manager and hotjar
- Date and view params (pastecal.com/test?d=2022-04-1&v=day)
- Add hotjar for feedback / recording
- Help / tour button
- Figure out creation and permissions issue
- Rename Calendar Title
- Visiting URL directly (/doesnotexist) should have button to create
- Have mode for full 24 hours
- Make it responsive (with all-hours moved via JS to just below the nav)
- Have it save the calendar to localstorage until you share it
- 5am mode

Security model:

```
calendars : {
    $GUID : {
        title,
        events,
        sharedID
    }
}

lookup : {
    $code : {
       GUID: $GUID
    }
}

shared : {
    sharedID :  {
        data
    }
}
```

- Issue: once you make a shortcode, it's in the ledger.
- When you password protect it, we're moving it from the ledger to
- We have server-side functions which are "registerShortcode(code, GUID)" and "protectShortcode(code, encrtyptedGUID)"
- Once it's password protected, can't be un-protected [for simplicity]
- One of the problems is anyone can make a test calendar, then decide to password protect it. Any user has admin access. ok.
- We should have server-side functions which are doing the syncing here? Or keep it simple. Have the client write to the shared entry as needed.

---
Troubleshooting: to import calendar items

const events = [... (event data)]

// programatically import

events.forEach(event => {
    app.handleQuickAddEvent({
      subject: event.title,
      startDateTime: event.start,
      endDateTime: event.end,
      type: event.type
    });
  });