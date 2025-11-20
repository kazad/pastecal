# PasteCal Pro / Premium Specification

## Philosophy
PasteCal's core value is frictionlessness: "No login, just a link." A Pro tier must not break this paradigm. Instead of forcing users to create a username/password account to upgrade, we should offer a **"Pay-per-Calendar"** or **"Calendar License"** model.

Users upgrade a *specific calendar* to unlock power features for that collaborative space.

## Monetization Model: "Boost this Calendar"
*   **Pricing:** One-time fee (e.g., $29/lifetime) or small annual subscription (e.g., $12/year) per calendar.
*   **Mechanism:**
    1.  User goes to `Settings > Upgrade to Pro`.
    2.  Stripe Checkout (Customer Email required).
    3.  Upon success, the Calendar ID is flagged as `isPro: true` in Firebase.
    4.  An "Admin Key" is emailed to the user to manage the subscription.

## Feature Set

### 1. Enhanced Security & Access Control
*   **Edit Locking:** Convert the public URL `pastecal.com/my-team` to **Read-Only** for the public, while issuing a secret **Admin Link** (or password) for editors.
    *   *Why:* Solves the "anyone can delete my events" risk for semi-public calendars.
*   **Password Protection:** Require a password to even *view* the calendar.

### 2. Branding & Whitelabeling
*   **Remove "PasteCal" Branding:** Remove the logo and "Powered by" links from the header and embedded views.
*   **Custom Logo:** Upload a team/company logo to replace the default.
*   **Custom Colors:** Full control over the UI color palette (header background, buttons) to match brand identity.

### 3. Data Safety & Recovery
*   **Owner Email Association:** Link an email address to the calendar *without* creating a full account.
    *   *Benefit:* Recover lost edit links.
    *   *Benefit:* Receive critical alerts (e.g., "Someone deleted 50 events").
*   **Change History / Audit Log:** View a log of who (IP/User Agent) changed what and when.
*   **Undo/Restore:** Ability to revert changes from the Audit Log.

### 4. Power Features
*   **Email Notifications:** Subscribers can opt-in to get email digests (Daily Agenda) or alerts when events are added/changed.
*   **File Attachments:** Allow uploading PDFs or images to event descriptions (requires Firebase Storage).
*   **Recurring Events+:** Advanced recurrence rules (e.g., "Last Friday of every month").
*   **Webhook / API Access:** trigger Zapier/Slack automations when events change.

## Implementation Strategy

### Phase 1: The "Lock" (MVP)
The most requested feature for a public shared calendar is stopping random people from editing it.
*   **Feature:** "Lock Public Access".
*   **Flow:** User pays -> Gets an `adminToken`.
*   **Logic:**
    *   Request to `GET /calendar` works.
    *   Request to `POST /calendar` (write) requires `Authorization: Bearer <adminToken>`.

### Phase 2: Branding
*   **Feature:** Upload Logo & Custom CSS.
*   **Logic:** Store `options.branding` in the calendar object. Frontend applies styles if `isPro` is valid.

### Phase 3: Notifications
*   **Feature:** "Notify me on changes."
*   **Logic:** Use Cloud Functions to watch the Realtime Database and send emails via SendGrid/Postmark to subscribed addresses.

## User Journey (Upgrade)

1.  User creates `pastecal.com/marketing-q4`.
2.  User clicks "Settings" icon.
3.  Sees "Upgrade to Pro" banner.
4.  kliks "Upgrade".
5.  Enters Email (for admin recovery) and Credit Card.
6.  Payment Success.
7.  **Instant Result:**
    *   Calendar gets a "Pro" badge.
    *   "Lock Editing" toggle becomes enabled.
    *   "Upload Logo" input appears.
    *   User receives an email with their "Admin/Owner Link" to manage the calendar in the future.
