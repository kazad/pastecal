# Instacalc Polling Feature

On any calendar you can configure poll settings (date range, filters like type 1/type 2). Shared poll links render those filtered events as a grid where visitors enter their name and mark availability, surfacing which options work for the group.

## Problem Statement
- Instacalc calendars are ideal for quickly sharing events, but coordinating mutually available dates still requires back-and-forth messaging or external tools (e.g. Doodle).  
- We need a lightweight poll overlay on top of an existing calendar so participants can mark availability against real events without juggling multiple tools or duplicating data.

## Goals
- Let calendar owners spin up an availability poll in under 30 seconds from the existing UI.
- Reuse existing calendar events (with filters like `type = 1`) so owners never re-enter slot details.
- Enable participants to vote on proposed time slots with minimal friction on desktop and mobile.
- Surface a clear "best option" and let the owner promote the winning slot into the calendar in one click.
- Preserve Instacalc's zero-login sharing model while preventing casual tampering.

## Non-Goals
- Full scheduling workflows (reminders, ICS invitations, RSVPs outside Instacalc).
- Arbitrary question/answer polling; the feature is scoped to availability across dates/times.
- Deep analytics or long-term storage guarantees; polls can expire and be garbage-collected after inactivity.

## Personas & Primary Use Cases
- **Calendar Creator**: initiates a poll while planning an event; may already have a calendar or may only use the poll.
- **Participant**: receives a link, records availability, optionally leaves a comment.
- **Facilitator** (optional): aligns on the final slot, locks the poll, and writes the outcome back to the calendar.

### Representative Scenarios
- Choosing a date for a team offsite or recurring meeting.
- Polling friends for a weekend trip timing.
- Quick internal poll with timezone-aware options (e.g., remote teams) where the poll filters to tentative events (type 1).

## UX Flow Outline
1. **Launch poll UI**  
   - Route pattern: `pastecal.com/{calendarId}/poll`.  
   - Entry points: toolbar button on the calendar, or direct URL sharing.  
   - Creator configures poll metadata (display name, optional description) and selects an event filter (e.g., `type = 1`, tag, or date range).  
   - Filter determines which calendar events are displayed as poll columns; defaults to future events of type 1 if present.
2. **Share & respond**  
   - Participants land on `/{calendarId}/poll` (no login).  
   - First action: set display name (persisted in local storage).  
   - Poll grid shows filtered events as columns and participant rows; users mark each slot as `Yes`, `Maybe`, `No`.  
   - Optional per-event comments or overall note.  
   - UI renders source event details (title, time, type badge) and can switch between list/grid views for accessibility.
3. **Finalize**  
   - Creator can pin winning event(s) based on response summaries.  
   - Optionally promotes the event (e.g., sets `type = confirmed`, adds note listing available participants).  
   - When finalised, poll responses become read-only; participants still view aggregated results.

## Functional Requirements
- Generate globally unique poll IDs per calendar and shareable URLs without authentication.
- Allow creators to tweak poll filters and settings until the poll is locked.
- Allow participants to add themselves (name + optional contact) and adjust responses until poll is locked or expired.
- Surface aggregate counts per slot (Yes/Maybe/No totals).
- Support a comment activity log (append-only, ordered by timestamp).
- Auto-expire polls after X days of inactivity (configurable, default 90 days).
- Provide optimistic UI with offline support via local storage cache.

## Non-Functional Requirements
- Reuse Firebase Realtime Database for storage; follow existing `calendars` pattern to keep hosting simple.
- Keep payload small (<100KB) to stay within RTDB free tier quotas; limit polls to <= 20 slots and <= 100 participants.
- Ensure idempotent writes via Cloud Functions to avoid duplicate participant rows.
- Respect accessibility: keyboard toggles, high-contrast state colors, screen reader labels.

## Data Model

### Calendar-Scoped Storage
```
/calendars/{calendarId}/polls/{pollId}
/calendars/{calendarId}/pollVotes/{pollId}/{participantId}
/calendars/{calendarId}/pollComments/{pollId}/{commentId}
/calendars/{calendarId}/pollConfigs/{pollId}  // cached filter + derived event IDs
```

### Poll Record (`/calendars/{calendarId}/polls/{pollId}`)
```json
{
  "id": "64e87f",
  "createdAt": 1719347200000,
  "updatedAt": 1719347355000,
  "status": "open",                // open | locked | archived
  "title": "Team Sync Poll",
  "description": "Pick a recurring time",
  "ownerSecret": "edit-e49e8c1",   // used to derive edit URL
  "publicId": "view-13bc7",        // used to derive share URL for /{calendarId}/poll
  "filter": {
    "type": [1, 2],                // event.types to include
    "dateRange": {
      "start": "2024-07-01",
      "end": "2024-07-31"
    },
    "eventIds": null               // populated once filter resolves
  },
  "timezone": "America/Los_Angeles",
  "slots": [
    {
      "slotId": "s1",
      "eventId": "evt-123",
      "label": "Mon 10am PDT - Weekly Sync",
      "start": "2024-07-01T17:00:00Z",
      "end": "2024-07-01T18:00:00Z",
      "type": 1,
      "createdAt": 1719347200000
    }
  ],
  "settings": {
    "allowMaybe": true,
    "allowComments": true,
    "maxParticipants": 100
  },
  "locks": {
    "lockedBy": "edit-e49e8c1",
    "lockedAt": null
  },
  "metrics": {
    "yesCounts": { "s1": 3 },
    "maybeCounts": { "s1": 2 },
    "noCounts": { "s1": 1 }
  }
}
```

### Participant Votes (`/calendars/{calendarId}/pollVotes/{pollId}/{participantId}`)
```json
{
  "participantId": "p-01hzyx",
  "displayName": "Casey",
  "createdAt": 1719347223000,
  "updatedAt": 1719347333444,
  "responses": {
    "s1": "yes",
    "s2": "no"
  },
  "comment": "I can shift if needed."
}
```

### Comments (`/calendars/{calendarId}/pollComments/{pollId}/{commentId}`)
```json
{
  "commentId": "c01",
  "author": "Kai",
  "body": "Week of July 8 works best.",
  "createdAt": 1719347402100
}
```

### Indexing & Denormalization
- Duplicate aggregate counts (`metrics`) on the poll record to render slot summaries without loading all votes.
- Keep participant responses in a separate branch to allow streaming updates without downloading poll metadata repeatedly.
- Snapshot derived `eventIds` inside `pollConfigs` so the poll grid can stay stable even if the calendar mutates; refresh on demand when owner updates filters.

## API & Sync Design

### Cloud Functions (Callable HTTPS)
- `createPoll(payload)`  
  - Validates `calendarId`, filter criteria, timezone, description.  
  - Resolves current event list matching filter (e.g., type 1) and stores derived `slots`.  
  - Generates `{pollId, ownerSecret, publicId}` and writes poll record inside the calendar node.
  - Returns edit/share URLs (`/{calendarId}/poll?token=...`).
- `updatePoll(params)`  
  - Guarded by owner secret; allows filter tweaks (re-resolving event list), settings updates, status changes.
- `recordVote(params)`  
  - Accepts participant display name + map of slot decisions + optional comment.  
  - Enforces max participants and dedupes by `(pollId, normalizedName)` using RTDB transactions.
  - Updates aggregate counts transactionally.
- `lockPoll(params)`  
  - Marks poll `status = locked` and optionally writes the chosen slot to the linked calendar (`calendars/{calendarId}/events`).
- `expirePollsCron` (scheduled)  
  - Runs daily, moves stale polls to `archived` and cleans secondary indexes (votes/comments) after retention window.

### Client Data Flow
- Creator and participants connect to `/calendars/{calendarId}/polls/{pollId}` and `/calendars/{calendarId}/pollVotes/{pollId}` via RTDB listeners.  
- Optimistic updates: client writes immediately, listens for server confirmation, rolls back if denied.
- For offline use, responses queued locally and replayed when connection restores (reuse existing offline cache utilities if present).

## Security & Access Control
- RTDB rules mirror calendars:
  - `/calendars/{calendarId}/polls/{pollId}` writable only by cloud functions using admin privileges.  
  - `/calendars/{calendarId}/pollVotes/{pollId}` writable by any client that presents a valid `publicId` token scoped to that poll (token embedded in URL fragment or generated via callable function).  
  - Votes are per-participant; allow updates only to your participant node (identified by signed cookie or ephemeral token).
- Owner secret stored client-side in edit URL; all admin actions use callable functions that verify the secret.
- Rate limit `recordVote` cloud function via Firebase App Check or IP throttling to mitigate spam.

## UI & Interaction Considerations
- Use table layout with sticky slot headers for large polls; collapse to stacked cards on mobile.  
- Provide quick toggle buttons (`Yes/Maybe/No`) with keyboard shortcuts `1/2/3`.  
- Show per-slot summary chips (Yes: 5, Maybe: 2, No: 1).  
- When locked, dim toggles and highlight the winning slot.
- Provide "Add alternative slot" action (optional) gated to owner or when enabled by settings.

## Integration with Calendars
- When locking, owner can choose **Add to calendar** which:
  1. Confirms event by updating its `type` or status and adding availability summary.
  2. Annotates event with poll URL for reference.
  3. Optionally converts participant list into event description for manual invites.
- Calendar view displays active polls inline (e.g., sidebar list) and lets users jump between calendar and poll surfaces.

## Operational Concerns
- **Quota management**: avoid unbounded writes by enforcing slot/participant caps and purging archived polls tied to inactive calendars.  
- **Data migration**: gate `/calendars/{calendarId}/polls` behind a feature flag; add SPA route handler for `/{calendarId}/poll` to load poll bundle lazily.  
- **Analytics**: log `poll_created`, `poll_responded`, `poll_locked` events to existing analytics pipeline (if any) for adoption tracking.

## Edge Cases & Open Questions
- Handling timezone shifts (DST) when polls span months; store slots in UTC with original timezone for display.  
- Allowing participants to edit their name after voting -- do we merge rows or treat as new participant?  
- Should owners be able to delete participant responses? (Default: yes, with audit trail entry.)  
- Do we need email notifications when poll updates? (Out of scope initially; consider webhook/notification integration later.)  
- Accessibility review and localization: ensure we expose ARIA labels and keep copy translation-friendly.

## Implementation Phases
1. **MVP (feature flag off)**  
   - Calendar-scoped poll creation (`/{calendarId}/poll`), filter configuration (type/date), shareable URLs, responses with live counts, manual lock.  
   - Basic SPA screens & RTDB rules.  
2. **Calendar integration & polish**  
   - Deep link from calendar sidebar, inline poll summaries on events, richer comment stream, responsive table improvements.  
   - Add App Check + rate limiting.  
3. **Growth & automation**  
   - Scheduled cleanup job, analytics dashboards, optional notifications.

Deliverables include frontend components (React/Svelte/Vue depending on current stack), Firebase rules updates, Cloud Functions, and integration tests for poll lifecycle.
