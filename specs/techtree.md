# PasteCal Tech Tree (StarCraft Style)

```mermaid
graph LR
    %% Core foundations
    A[Base: ICS Import/Export] --> B[Live Sync (Firebase)]
    A --> C[Calendar CRUD UI]
    C --> D[Quick Add (NLP)]
    C --> E[Event Popovers & Editor]
    E --> F[Recurring Events (RRULE)]
    F --> G[Time Zone Handling]
    F --> H[Conflict Detection]

    %% Views
    C --> I[Views: Day/Week/Month]
    I --> J[Custom View Presets]
    I --> K[Year View]
    I --> L[Agenda View]
    J --> M[Saved View Profiles]

    %% Sharing & Access
    B --> N[Public/Private Links]
    N --> O[Read-Only Slugs]
    N --> P[Permissioned Editors]
    P --> Q[Audit Log / History]

    %% Collaboration
    B --> R[Presence Indicators]
    R --> S[Live Cursor / Selection]
    S --> T[Inline Comments]
    T --> U[Decision Threads]

    %% Automation / Intelligence
    D --> V[Smart Templates (patterns)]
    V --> W[Autofill Fields (location, video)]
    W --> X[Smart Reminders / Nudges]
    X --> Y[Auto-Suggest Meeting Slots]

    %% Integrations
    B --> Z[Push to External Calendars]
    Z --> AA[Two-Way Sync (Google/Outlook)]
    AA --> AB[Webhook/API Surface]

    %% Mobile / Native Feel
    C --> AC[PWA Shell]
    AC --> AD[Offline Cache]
    AD --> AE[Background Sync]

    %% Reliability / Scale
    B --> AF[Rate Limit & Abuse Guard]
    AF --> AG[Shard/Partition Calendars]
    AG --> AH[Cold Storage / Archive]

    %% Monetization / Teams
    P --> AI[Teams & Roles]
    AI --> AJ[Usage Insights Dashboard]
    AJ --> AK[Quota Controls / Billing]
```

- “Current” nodes include the base ICS import/export, quick add (NLP), core CRUD, multi-view support (Day/Week/Month/Year/Agenda), and sharing links.  
- Everything downstream is sequenced as future unlocks; follow the arrows for dependency order.  
- Use the mermaid diagram as a living map—extend nodes as features land.
