# Backups

## Cloudflare (current): daily full archive, kept forever

Every calendar (free and Pro) goes into one file a day in the R2 bucket `pastecal-backups` (staging:
`pastecal-backups-staging`), written by `cloudflare/src/BackupArchive.js` from a cron at 09:00 UTC:

| | |
|---|---|
| File | `archive/daily/YYYY-MM-DD.json.gz` -- one gzip stream of JSON lines (format: `cloudflare/src/archive-format.js`) |
| Contents | every calendar `{id, v, locked, calendar}` (as the per-calendar snapshot), every directory row (view links, short names, tombstones) |
| Not in it | editor keys / key hashes, owner ids, Pro settings, stats, history, accounts (emails, @handles) |
| Metadata | customMetadata `version, date, count, dirRows, absent, failed, bytes, gzBytes, parts, startedAt, finishedAt` |
| Retention | forever (never pruned) |
| Size | ~4 MB gzipped a day, ~1.5 GB a year |

How it runs: a singleton Durable Object takes one small step per alarm (one directory page, one page of the
snapshot list, or 200 calendars), writes it as a part under `archive/parts/`, and joins the parts at the end.
The old one-run backup (94ad206) never completed; this one finishes at any size. Rerunning a day overwrites it.
`firebase/` holds copies of the Firebase backups below; nothing here writes or prunes it.

Admin (Bearer IMPORT_SECRET): `POST /api/admin/backup/run`, `GET /api/admin/backup/{status,list,health}`.
Health is part of `./scripts/stats.sh health`: missing, over 26 hours old, or under 95% of the directory's
calendars shows under ATTENTION. Logs: `[backup:archive]` in Workers observability.

Restore one calendar (dry run first; `--apply` goes through the normal restore, so the replaced state is saved
as a restore point and Recent changes shows "Restored the full backup from <date>"):

```bash
node scripts/restore-from-archive.mjs --base https://pastecal.com --list
node scripts/restore-from-archive.mjs --base https://pastecal.com "<calendar id>" 2026-10-29
node scripts/restore-from-archive.mjs --base https://pastecal.com "<calendar id>" 2026-10-29 --apply
```

Per-calendar snapshots (`snapshots/<id>/<date>.json`, CalendarRoom.backupToR2) still run on every change; Pro
"restore an earlier version" reads those.

## Firebase (before Cloudflare)

Realtime Database is backed up daily by Firebase's built-in backup feature (Blaze only).
This file exists because that configuration lives in the Firebase console, not in the repo,
so the only way to know it existed was to go looking for the bucket.

## What runs

| | |
|---|---|
| Bucket | `gs://pastecal-web-default-rtdb-backups` (US-CENTRAL1, STANDARD) |
| Cadence | daily, ~22:24 UTC |
| Contents | `<ts>_pastecal-web-default-rtdb_data.json.gz` + a `_rules.json.gz` alongside |
| Retention | **90 days** (`config/backup-lifecycle.json`) |
| Size | ~7.7 MB gzipped per snapshot, ~37 MB raw; growing ~28 KB/day |

Retention was 30 days until 2026-09-14. It was raised to 90 after the issue #42/#43/#44
incident, where the snapshots that predated a data-losing bug were within days of aging out
while the bug was still being diagnosed. Ninety days costs about $0.014/month at current
size; the 30-day window was the binding constraint on being able to investigate at all.

To re-apply the policy (it is not deployed by `deploy.sh` — GCS lifecycle is not part of
`firebase deploy`):

```bash
gcloud storage buckets update gs://pastecal-web-default-rtdb-backups \
  --lifecycle-file=config/backup-lifecycle.json
```

## Restoring

A snapshot is the whole database, so restoring one calendar means extracting one key
rather than importing the file:

```bash
gcloud storage cp gs://pastecal-web-default-rtdb-backups/<ts>_..._data.json.gz .
gunzip <file>.gz
node -e 'const d=require("./<file>").calendars["<slug>"]; console.log(JSON.stringify(d,null,2))'
```

Restore `calendars/<slug>` **and** `calendars_readonly/<publicViewId>` together. They are
roughly the same size (17.6 MB / 18.8 MB across all calendars) and a restore that touches
only the first leaves every already-shared `/view/` link pointing at stale data.

Read the recovered JSON before writing it back. A calendar that is empty in the backup too
means the damage predates that snapshot, and writing it over live data destroys whatever
the user has since re-entered.

## Known gaps

Daily snapshots mean the exposure window is "since last night". Issue #44's calendar was
wiped on 14 Sep, after the 13 Sep backup — the loss fell squarely in that gap, and no
snapshot contains their data. Two mitigations are worth building and are not built yet:

- **Hourly deltas, 7-day retention.** Only ~24 of 5,203 calendars change on a given day, so
  an hourly pass that stores just the changed ones is ~1 KB/hour. That turns a 24-hour
  worst case into a 1-hour one for effectively no storage cost.
- **Mass-deletion alerting.** Nothing noticed that a calendar went from N events to 0 — a
  user had to report it. A daily diff of the last two snapshots flagging any calendar that
  lost more than half its events would surface this class of bug before an issue is filed.
