# PasteCal Pro / Premium Specification

## Philosophy
While PasteCal's core value remains "No login, just a link" for instant creation, the Pro tier introduces a management layer for power users. By authenticating via **Google Login**, a user becomes the **Manager** of their calendars, unlocking advanced control, security, and customization without complicating the experience for their end-users (viewers/editors).

## Authentication & Account Model
*   **Google Login:** Used solely for the "Manager" role.
*   **Claiming:** Existing anonymous calendars can be "claimed" by a logged-in Manager.
*   **Manager Privileges:**
    *   Central dashboard to see all owned calendars.
    *   Ability to reset edit links/permissions.
    *   Access to billing and subscription settings.

## Pricing Tiers & Model: "Pay for Space, Not Seats"

We adopt the **Basecamp Model**: The Manager pays for the infrastructure and features, while their users (viewers, editors, family members) remain free and account-less. This aligns with our frictionless "viral" nature.

### 1. Free Tier (The Growth Engine)
*   **Cost:** $0
*   **Limits:** 1 Admin (Cookie-based), Unlimited Viewers.
*   **Features:** Basic creation, public editing (unless secret link), PasteCal branding.
*   **Goal:** Maximum virality. Every free calendar shared is a marketing impression.

### 2. Pro Tier (The "Peace of Mind" Plan)
*   **Cost:** **$9 / month** (or $89 / year)
*   **Target:** Freelancers, Power Individuals, Consultants.
*   **Capacity:** Up to **5 Managed Calendars**.
*   **Key Value:**
    *   **Locking:** Prevent public edits (Security).
    *   **Restores:** Undo accidental deletions.
    *   **Notifications:** Get emailed when clients book/change things.

### 3. Team Tier (The "Professional" Plan)
*   **Cost:** **$29 / month** (or $290 / year)
*   **Target:** Agencies, Small Businesses, Schools.
*   **Capacity:** Up to **25 Managed Calendars**.
*   **Key Value:**
    *   **Whitelabeling:** Remove "PasteCal" branding, add Company Logo.
    *   **API Access:** Integrate with internal tools.
    *   **Priority Support.**

---

## Indy SaaS Business Plan & Projections

### The Context (Micro-SaaS)
*   **Current Status:** ~500 MAU (Monthly Active Users).
*   **Growth Rate:** ~10% MoM (Organic/Viral).
*   **Differentiation:** "No Login" utility vs. complex suites.

### The Mathematics of Growth
With a sticky utility tool, the conversion rate to Paid usually hovers between **2% to 4%**. The "Lock" feature is a high-leverage trigger that may push this towards the higher end.

#### Year 1 Projection (The Grind)
*   **Growth:** 500 MAU $\rightarrow$ ~1,500 MAU (at 10% MoM).
*   **Conversion:** Conservative 2.5% (Early product).
*   **Paying Users:** ~38 subscribers.
*   **Blended ARPU:** $12 (Mostly Pro, some Team).
*   **Exit MRR:** **~$456/mo**.
*   **Strategy:** Focus on product stability and SEO.

#### Year 2 Projection (The Scale)
*   **Growth:** 1,500 MAU $\rightarrow$ ~4,700 MAU.
*   **Conversion:** Optimistic 4.0% (Mature features: Whitelabeling + API).
*   **Paying Users:** ~188 subscribers.
*   **Blended ARPU:** $15 (More business teams adopting).
*   **Exit MRR:** **~$2,820/mo** (~$34k ARR).
*   **Strategy:** Focus on B2B/Team features.

### Cash Flow Accelerator: The "Lifetime Deal" (LTD)
To fund early development and server costs without VC money:
*   **Offer:** "Founder's Club" - **$149 One-Time** for Lifetime Pro access.
*   **Limit:** First 50 spots only.
*   **Potential Influx:** $7,450 immediate cash.
*   **Benefit:** Creates 50 die-hard evangelists who will report bugs and share the tool.

## Feature Matrix

| Feature Category | Free (Anonymous) | Pro / Team / Enterprise (Manager) |
| :--- | :--- | :--- |
| **Creation** | Instant, Anonymous | Instant, Linked to Account |
| **Access Control** | Open (Anyone with link edits) | **Granular Modes:**<br>1. Public View / Private Edit<br>2. Password Protected<br>3. Team Only (Invite via email) |
| **Branding** | PasteCal Logo & Footer | **Whitelabel:**<br>1. Remove "Powered by PasteCal"<br>2. Custom Header Logo<br>3. Custom Brand Colors |
| **Data Safety** | None | **Recovery:**<br>1. Unlimited History/Audit Log<br>2. Snapshot Restores (Undo)<br>3. Daily Backups |
| **Notifications** | None | **Alerts:**<br>1. Email digests of changes<br>2. Slack notifications (via Webhook) |
| **Analytics** | None | **Insights:**<br>1. View counts<br>2. "Add to Calendar" click stats |
| **Integration** | Basic iCal Subscription | **Advanced:**<br>1. Webhooks (Zapier support)<br>2. API Access (Read/Write) |
| **Support** | Community / Docs | Priority Email Support |

## Detailed Feature Specs

### 1. The "Manager" Role
*   **Dashboard:** A unified view (`/dashboard`) listing all owned calendars with quick status indicators (Public/Private, Last Edited).
*   **Claiming Flow:** If a user is logged in and creates a calendar, it is auto-claimed. If they have an old anonymous calendar, they can visit the settings on that calendar and click "Claim to Account" (requires verifying they have the current edit URL).

### 2. Enhanced Security (The "Lock")
*   **Read-Only Public Links:** The most requested feature. The URL `pastecal.com/my-event` becomes read-only for the world.
*   **Manager Edit Access:** The Manager can always edit when logged in.
*   **Guest Edit Links:** Manager can generate specific "Editor Links" to share with trusted collaborators, which can be revoked later.

### 3. Whitelabeling & Branding
*   **Custom Domain (Enterprise?):** Potentially allow `cal.mycompany.com` mapping (Future).
*   **Visual Customization:**
    *   **Header:** Replace PasteCal title with Company Name.
    *   **Logo:** Upload square or rectangular logo.
    *   **Theme:** Pick primary accent color (buttons, links, current day highlight).

### 4. Analytics
*   Simple, privacy-friendly metrics to justify the cost.
*   "How many people viewed my schedule this week?"
*   "How many people exported to Google Calendar?"

## Implementation Roadmap

### Phase 1: Identity & Claiming
*   Implement Google Auth (Firebase Auth).
*   Create `/dashboard` route.
*   Implement "Claim Calendar" logic (link anonymous ID to User UID).

### Phase 2: The Paywall & Limits
*   Integrate Stripe Customer Portal.
*   Enforce calendar limits based on subscription status.

### Phase 3: Pro Features Rollout
1.  **Security:** Implement "Read-Only" mode (Server-side rule: only owner/editor token can WRITE).
2.  **Branding:** Allow saving branding config object to DB; Frontend applies it.
3.  **Backups:** Cloud Function to snapshot data daily for Pro calendars.