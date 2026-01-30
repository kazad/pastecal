# PasteCal LLM API Specification

## Executive Summary

This document specifies how pastecal.com can become LLM-friendly through a dedicated API, enabling AI assistants (ChatGPT, Claude, Gemini, etc.) to interact with calendars on behalf of users. The goal is to make PasteCal the go-to calendar for AI-first workflows.

---

## 1. Vision & Use Cases

### Why LLM Integration?

LLMs are increasingly becoming the interface through which users manage their lives. A calendar that speaks fluent LLM unlocks:

1. **Natural Language Scheduling**: "Schedule lunch with Sarah next Tuesday at noon"
2. **Cross-Calendar Intelligence**: "When am I free this week?" across multiple calendars
3. **Automated Workflows**: AI agents that book meetings, manage schedules, reschedule conflicts
4. **Smart Suggestions**: "Based on my calendar, when should I schedule deep work?"
5. **Meeting Prep**: "What's on my calendar tomorrow? Summarize my meetings."

### Target Users

| User Type | Use Case |
|-----------|----------|
| **Individual Users** | Ask AI to manage personal calendar via ChatGPT/Claude |
| **Developers** | Build AI-powered scheduling apps on top of PasteCal |
| **Teams** | AI assistants that coordinate group schedules |
| **Businesses** | Customer-facing AI that books appointments |

---

## 2. API Design

### 2.1 API Styles

PasteCal should offer **three complementary access methods**:

#### A. REST API (Primary)
Standard REST endpoints for CRUD operations. Easy to integrate, well-understood.

#### B. MCP Server (Model Context Protocol)
Native integration for Claude and other MCP-compatible assistants. Allows Claude to directly interact with calendars as a tool.

#### C. OpenAI-Compatible Actions/GPT Plugin
Schema-based integration for ChatGPT custom GPTs and similar platforms.

---

### 2.2 REST API Endpoints

**Base URL**: `https://api.pastecal.com/v1`

#### Authentication
```
Authorization: Bearer {api_key}
```

#### Calendars

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/calendars` | List all calendars accessible to this API key |
| `GET` | `/calendars/{id}` | Get calendar with all events |
| `POST` | `/calendars` | Create new calendar |
| `PATCH` | `/calendars/{id}` | Update calendar metadata |
| `DELETE` | `/calendars/{id}` | Delete calendar |

#### Events

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/calendars/{id}/events` | List events (with filtering) |
| `GET` | `/calendars/{id}/events/{eventId}` | Get single event |
| `POST` | `/calendars/{id}/events` | Create event |
| `POST` | `/calendars/{id}/events/parse` | Create event from natural language |
| `PATCH` | `/calendars/{id}/events/{eventId}` | Update event |
| `DELETE` | `/calendars/{id}/events/{eventId}` | Delete event |

#### Availability

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/calendars/{id}/availability` | Get free/busy times |
| `POST` | `/calendars/{id}/find-time` | Find available slots matching criteria |

#### Export

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/calendars/{id}/export.ics` | Export as iCalendar |
| `GET` | `/calendars/{id}/export.json` | Export as structured JSON |

---

### 2.3 Data Models

#### Calendar Object
```json
{
  "id": "abc123",
  "title": "Work Calendar",
  "created_at": "2024-01-15T10:00:00Z",
  "updated_at": "2024-01-20T15:30:00Z",
  "timezone": "America/New_York",
  "public_view_id": "xyz789",
  "event_count": 42,
  "options": {
    "default_view": "Month",
    "type_labels": ["Meeting", "Focus Time", "Personal", ...],
    "colors": ["#3b82f6", "#10b981", "#f59e0b", ...]
  }
}
```

#### Event Object
```json
{
  "id": "evt_abc123",
  "calendar_id": "abc123",
  "title": "Team Standup",
  "description": "Daily sync with engineering team",
  "start": "2024-01-20T09:00:00Z",
  "end": "2024-01-20T09:30:00Z",
  "timezone": "America/New_York",
  "is_all_day": false,
  "type": 1,
  "type_label": "Meeting",
  "recurrence": {
    "rule": "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
    "exceptions": ["2024-01-25T09:00:00Z"]
  },
  "created_at": "2024-01-10T08:00:00Z",
  "updated_at": "2024-01-15T12:00:00Z"
}
```

#### Availability Object
```json
{
  "calendar_id": "abc123",
  "timezone": "America/New_York",
  "range": {
    "start": "2024-01-20T00:00:00Z",
    "end": "2024-01-27T00:00:00Z"
  },
  "busy": [
    { "start": "2024-01-20T09:00:00Z", "end": "2024-01-20T10:00:00Z", "event_id": "evt_123" },
    { "start": "2024-01-20T14:00:00Z", "end": "2024-01-20T15:30:00Z", "event_id": "evt_456" }
  ],
  "free": [
    { "start": "2024-01-20T10:00:00Z", "end": "2024-01-20T14:00:00Z" },
    { "start": "2024-01-20T15:30:00Z", "end": "2024-01-20T18:00:00Z" }
  ]
}
```

---

### 2.4 Key API Features

#### Natural Language Event Creation

**Endpoint**: `POST /calendars/{id}/events/parse`

```json
// Request
{
  "text": "Lunch with Sarah next Tuesday at noon for 1 hour",
  "reference_time": "2024-01-20T10:00:00Z",
  "timezone": "America/New_York"
}

// Response
{
  "parsed": {
    "title": "Lunch with Sarah",
    "start": "2024-01-23T12:00:00-05:00",
    "end": "2024-01-23T13:00:00-05:00",
    "confidence": 0.95
  },
  "event": {
    "id": "evt_new123",
    "title": "Lunch with Sarah",
    ...
  },
  "interpretation": "Created 1-hour event on Tuesday, January 23rd at 12:00 PM EST"
}
```

#### Smart Time Finding

**Endpoint**: `POST /calendars/{id}/find-time`

```json
// Request
{
  "duration_minutes": 60,
  "range": {
    "start": "2024-01-20",
    "end": "2024-01-27"
  },
  "preferences": {
    "time_of_day": "afternoon",
    "days": ["monday", "wednesday", "friday"],
    "avoid_back_to_back": true
  },
  "limit": 5
}

// Response
{
  "suggestions": [
    {
      "start": "2024-01-22T14:00:00Z",
      "end": "2024-01-22T15:00:00Z",
      "score": 0.95,
      "reason": "Open afternoon slot on Monday, no adjacent meetings"
    },
    ...
  ]
}
```

#### Multi-Calendar Availability

**Endpoint**: `POST /availability/combined`

```json
// Request
{
  "calendar_ids": ["cal_abc", "cal_xyz"],
  "range": {
    "start": "2024-01-20",
    "end": "2024-01-27"
  },
  "timezone": "America/New_York"
}

// Response
{
  "combined_free": [
    { "start": "2024-01-20T14:00:00Z", "end": "2024-01-20T16:00:00Z" },
    ...
  ]
}
```

---

### 2.5 MCP Server Specification

For Claude and MCP-compatible assistants, PasteCal provides a native MCP server:

**Server Name**: `pastecal`

#### Tools

```typescript
// List calendars
list_calendars() -> Calendar[]

// Get calendar details
get_calendar(calendar_id: string) -> Calendar

// List events with optional filtering
list_events(
  calendar_id: string,
  start?: string,  // ISO date
  end?: string,    // ISO date
  type?: number,
  search?: string
) -> Event[]

// Create event from structured data
create_event(
  calendar_id: string,
  title: string,
  start: string,
  end: string,
  description?: string,
  type?: number,
  recurrence_rule?: string
) -> Event

// Create event from natural language
quick_add(
  calendar_id: string,
  text: string,
  reference_time?: string
) -> { event: Event, interpretation: string }

// Update event
update_event(
  calendar_id: string,
  event_id: string,
  updates: Partial<Event>
) -> Event

// Delete event
delete_event(calendar_id: string, event_id: string) -> { success: boolean }

// Get availability
get_availability(
  calendar_id: string,
  start: string,
  end: string
) -> Availability

// Find available time slots
find_time(
  calendar_id: string,
  duration_minutes: number,
  start: string,
  end: string,
  preferences?: TimePreferences
) -> TimeSuggestion[]
```

#### Resources

```typescript
// Calendar resource for context
pastecal://calendar/{calendar_id}

// Events resource for a date range
pastecal://calendar/{calendar_id}/events?start={date}&end={date}

// Today's agenda
pastecal://calendar/{calendar_id}/today
```

---

### 2.6 OpenAI Actions Schema

For ChatGPT GPTs and similar:

```yaml
openapi: 3.1.0
info:
  title: PasteCal API
  version: 1.0.0
  description: Calendar management for AI assistants

servers:
  - url: https://api.pastecal.com/v1

paths:
  /calendars/{calendar_id}/events:
    get:
      operationId: listEvents
      summary: List calendar events
      parameters:
        - name: calendar_id
          in: path
          required: true
          schema:
            type: string
        - name: start
          in: query
          schema:
            type: string
            format: date
        - name: end
          in: query
          schema:
            type: string
            format: date
      responses:
        '200':
          description: List of events

    post:
      operationId: createEvent
      summary: Create a new event
      # ... full schema

  /calendars/{calendar_id}/events/parse:
    post:
      operationId: quickAdd
      summary: Create event from natural language
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                text:
                  type: string
                  description: Natural language event description
              required:
                - text
```

---

## 3. Authentication & Authorization

### 3.1 API Keys

PasteCal uses API keys for authentication. Keys are scoped to specific calendars.

```
# Header format
Authorization: Bearer pcal_live_abc123xyz...
```

#### Key Types

| Type | Prefix | Permissions | Use Case |
|------|--------|-------------|----------|
| **Full Access** | `pcal_full_` | Read/write all linked calendars | Personal AI assistant |
| **Read Only** | `pcal_read_` | Read-only access | Sharing with others' AI |
| **Calendar Scoped** | `pcal_cal_` | Single calendar access | App integrations |

### 3.2 Calendar Linking

Users link calendars to their API key via:

1. **Web UI**: Settings → API Access → Link Calendar
2. **URL Parameter**: `pastecal.com/{calendar_id}?link_api_key={key}`
3. **API Call**: `POST /api-keys/{key}/calendars` with calendar ID

### 3.3 Rate Limits

| Tier | Requests/min | Requests/day |
|------|-------------|--------------|
| Free | 30 | 1,000 |
| Pro | 300 | 50,000 |
| Business | 1,000 | 500,000 |

### 3.4 OAuth (Future)

For third-party apps, OAuth 2.0 flow:

```
GET /oauth/authorize?client_id=...&redirect_uri=...&scope=calendars:read,events:write

POST /oauth/token
  grant_type=authorization_code
  code=...
  client_id=...
  client_secret=...
```

---

## 4. Pricing Model

### 4.1 Tier Structure

| Tier | Price | Target User | Key Features |
|------|-------|-------------|--------------|
| **Free** | $0/mo | Casual users | 1 API key, 1,000 calls/month, basic endpoints |
| **Pro** | $9/mo | Power users | 5 API keys, 50K calls/month, natural language parsing, availability API |
| **Business** | $29/mo | Teams/Apps | Unlimited keys, 500K calls/month, webhooks, priority support |
| **Enterprise** | Custom | Large orgs | SLA, dedicated support, custom limits, on-prem option |

### 4.2 Feature Matrix

| Feature | Free | Pro | Business | Enterprise |
|---------|------|-----|----------|------------|
| API Access | ✓ | ✓ | ✓ | ✓ |
| REST API | ✓ | ✓ | ✓ | ✓ |
| MCP Server | ✓ | ✓ | ✓ | ✓ |
| Natural Language Parsing | 100/mo | ✓ | ✓ | ✓ |
| Availability API | — | ✓ | ✓ | ✓ |
| Find Time API | — | ✓ | ✓ | ✓ |
| Multi-Calendar | — | ✓ | ✓ | ✓ |
| Webhooks | — | — | ✓ | ✓ |
| Custom Rate Limits | — | — | ✓ | ✓ |
| Priority Support | — | — | ✓ | ✓ |
| SLA | — | — | — | ✓ |
| Audit Logs | — | — | — | ✓ |

### 4.3 Usage-Based Pricing (Alternative)

For high-volume users, pay-as-you-go:

| Operation | Cost |
|-----------|------|
| Read operation | $0.0001 |
| Write operation | $0.0005 |
| Natural language parse | $0.001 |
| Find time query | $0.002 |

**Monthly minimum**: $5 (includes $5 in credits)

### 4.4 Pricing Rationale

1. **Low barrier to entry**: Free tier allows experimentation
2. **Value-aligned pricing**: Charge more for compute-heavy features (NLP, availability)
3. **Predictable costs**: Tiered pricing for most users, usage-based for outliers
4. **Competitive**: Cheaper than Calendly API, simpler than Google Calendar API

---

## 5. Implementation Roadmap

### Phase 1: Foundation (4-6 weeks)

1. **API Key System**
   - Key generation and management
   - Basic key-to-calendar linking
   - Rate limiting infrastructure

2. **Core REST Endpoints**
   - CRUD for calendars and events
   - Event filtering and search
   - ICS/JSON export

3. **Documentation**
   - OpenAPI spec
   - Interactive API docs (Swagger/Redoc)
   - Quick start guide

### Phase 2: LLM Features (4-6 weeks)

1. **Natural Language Endpoint**
   - Expose existing chrono-node parsing via API
   - Add confidence scores and interpretations
   - Handle edge cases and ambiguity

2. **Availability API**
   - Free/busy calculation
   - Multi-calendar merging
   - Find-time algorithm

3. **MCP Server**
   - Implement MCP protocol
   - Publish to MCP registry
   - Claude integration testing

### Phase 3: Polish & Scale (4-6 weeks)

1. **OpenAI Actions**
   - GPT Builder integration
   - Actions schema and testing
   - Example GPT templates

2. **Webhooks**
   - Event change notifications
   - Reliable delivery with retries
   - Webhook management UI

3. **Analytics & Billing**
   - Usage tracking
   - Stripe integration
   - Usage dashboard

### Phase 4: Enterprise (Ongoing)

1. **OAuth 2.0**
2. **Team management**
3. **Audit logging**
4. **On-premise deployment option**

---

## 6. Technical Architecture

### 6.1 API Gateway

```
                    ┌─────────────────┐
                    │   Cloudflare    │
                    │   (DDoS, CDN)   │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │  API Gateway    │
                    │  (Rate Limit,   │
                    │   Auth, Route)  │
                    └────────┬────────┘
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
┌───────▼───────┐   ┌───────▼───────┐   ┌───────▼───────┐
│  Calendar     │   │   Events      │   │  Availability │
│  Service      │   │   Service     │   │  Service      │
└───────┬───────┘   └───────┬───────┘   └───────┬───────┘
        │                   │                   │
        └───────────────────┼───────────────────┘
                            │
                   ┌────────▼────────┐
                   │  Firebase RTDB  │
                   │  (Primary DB)   │
                   └─────────────────┘
```

### 6.2 Key Components

| Component | Technology | Purpose |
|-----------|------------|---------|
| API Gateway | Firebase Functions + Express | Routing, auth, rate limiting |
| Calendar Service | Node.js | Calendar CRUD operations |
| Events Service | Node.js | Event management, filtering |
| Availability Service | Node.js | Free/busy calculation |
| NLP Service | Node.js + chrono-node | Natural language parsing |
| MCP Server | Node.js + @modelcontextprotocol/sdk | Claude integration |
| Key Store | Firebase RTDB | API key management |
| Rate Limiter | Redis (Upstash) | Request rate limiting |

### 6.3 Data Schema Changes

New collections for API support:

```
/api_keys/{key_id}
  ├── key_hash: string (hashed key for lookup)
  ├── key_prefix: string (first 8 chars for display)
  ├── user_email: string (optional, for account linking)
  ├── tier: "free" | "pro" | "business"
  ├── calendars: string[] (linked calendar IDs)
  ├── created_at: timestamp
  ├── last_used_at: timestamp
  └── usage: {
        requests_today: number,
        requests_month: number,
        last_reset: timestamp
      }

/webhooks/{webhook_id}
  ├── api_key_id: string
  ├── calendar_id: string
  ├── url: string
  ├── events: string[] ("event.created", "event.updated", etc.)
  ├── secret: string
  └── created_at: timestamp
```

---

## 7. Security Considerations

### 7.1 API Key Security

- Keys are **hashed** (SHA-256) before storage
- Only key **prefix** stored for display (`pcal_live_abc1...`)
- Keys transmitted over **HTTPS only**
- Keys can be **revoked** instantly

### 7.2 Request Validation

- All inputs **validated and sanitized**
- Event dates validated for reasonable ranges
- Text fields limited to prevent abuse
- Recurrence rules validated against iCal spec

### 7.3 Rate Limiting

- Per-key limits enforced at gateway
- Sliding window algorithm
- 429 responses with `Retry-After` header
- Abuse detection for anomalous patterns

### 7.4 Audit Logging (Business+)

```json
{
  "timestamp": "2024-01-20T15:30:00Z",
  "api_key_prefix": "pcal_live_abc1",
  "action": "event.create",
  "calendar_id": "cal_123",
  "event_id": "evt_456",
  "ip_address": "203.0.113.50",
  "user_agent": "Claude/1.0"
}
```

---

## 8. Developer Experience

### 8.1 Documentation Structure

```
docs.pastecal.com/
├── Getting Started
│   ├── Quick Start (5 min tutorial)
│   ├── Authentication
│   └── Your First API Call
├── API Reference
│   ├── Calendars
│   ├── Events
│   ├── Availability
│   └── Webhooks
├── Guides
│   ├── Natural Language Events
│   ├── Finding Available Times
│   ├── Building a Scheduling Bot
│   └── Integrating with ChatGPT
├── Integrations
│   ├── MCP Server for Claude
│   ├── OpenAI Actions
│   └── Zapier
└── SDKs
    ├── JavaScript/TypeScript
    ├── Python
    └── cURL Examples
```

### 8.2 SDK Example (TypeScript)

```typescript
import { PasteCal } from 'pastecal';

const cal = new PasteCal('pcal_live_abc123...');

// Quick add with natural language
const event = await cal.quickAdd('my-calendar',
  'Lunch with Sarah tomorrow at noon'
);
console.log(`Created: ${event.title} at ${event.start}`);

// Find available times
const slots = await cal.findTime('my-calendar', {
  duration: 60,
  range: { start: '2024-01-20', end: '2024-01-27' },
  preferences: { timeOfDay: 'afternoon' }
});

// Get today's agenda
const today = await cal.getEvents('my-calendar', {
  start: new Date(),
  end: endOfDay(new Date())
});
```

### 8.3 Error Responses

```json
{
  "error": {
    "code": "event_conflict",
    "message": "Event overlaps with existing event",
    "details": {
      "conflicting_event_id": "evt_123",
      "conflicting_event_title": "Team Standup"
    }
  }
}
```

Standard error codes:
- `invalid_api_key` - Key missing or invalid
- `rate_limit_exceeded` - Too many requests
- `calendar_not_found` - Calendar doesn't exist
- `event_not_found` - Event doesn't exist
- `validation_error` - Invalid input data
- `event_conflict` - Scheduling conflict
- `insufficient_permissions` - Key lacks required scope

---

## 9. Success Metrics

### 9.1 Adoption Metrics

| Metric | Target (6 months) |
|--------|-------------------|
| API Keys Created | 10,000 |
| Monthly Active API Users | 2,000 |
| API Calls / Month | 5M |
| MCP Installations | 500 |
| GPT Actions Integrations | 100 |

### 9.2 Revenue Metrics

| Metric | Target (6 months) |
|--------|-------------------|
| Pro Subscribers | 500 |
| Business Subscribers | 50 |
| Monthly API Revenue | $7,000 |

### 9.3 Quality Metrics

| Metric | Target |
|--------|--------|
| API Uptime | 99.9% |
| P95 Latency | < 200ms |
| NLP Parse Accuracy | > 90% |
| Support Response Time | < 24 hours |

---

## 10. Competitive Analysis

### 10.1 Comparison with Alternatives

| Feature | PasteCal | Google Calendar API | Calendly API | Cal.com API |
|---------|----------|--------------------|--------------| ------------|
| Setup Complexity | Low (API key) | High (OAuth, project) | Medium | Medium |
| Free Tier | Yes | Yes (limited) | No | Yes |
| Natural Language | Yes | No | No | No |
| MCP Support | Yes | No | No | No |
| Zero-Login Calendars | Yes | No | No | No |
| Pricing | $9-29/mo | Free (with limits) | $12+/mo | $12+/mo |

### 10.2 Unique Value Propositions

1. **Simplest Integration**: API key in 30 seconds, no OAuth complexity
2. **AI-Native**: Built for LLM workflows with NLP and MCP
3. **Zero-Login**: No user accounts required, wiki-style calendars
4. **Affordable**: Lower cost than scheduling-focused competitors
5. **Open Ecosystem**: Works with any AI assistant, not locked to one platform

---

## 11. Open Questions

1. **Event conflict handling**: Should API auto-detect conflicts? Prevent or warn?
2. **Multi-timezone**: How to handle calendars with events in multiple timezones?
3. **Real-time subscriptions**: WebSocket/SSE for live calendar updates?
4. **Batch operations**: Support for bulk event creation/updates?
5. **Calendar templates**: Pre-built calendars for common use cases?

---

## Appendix A: Example Prompts for LLM Testing

```
# Basic operations
"What's on my calendar tomorrow?"
"Add a meeting with John at 3pm on Friday"
"Delete my dentist appointment"
"Move the team standup to 10am"

# Natural language complexity
"Schedule a 2-hour deep work block sometime next week, preferably in the morning"
"I need to meet with Sarah for about an hour, what times work this week?"
"Cancel all my meetings on Friday"
"Add a recurring standup every weekday at 9am"

# Multi-calendar
"Am I free on Tuesday afternoon?"
"When can John and I both meet this week?"
"Block off family time every Sunday from 10-2"

# Intelligent queries
"What does my week look like?"
"When am I most busy this month?"
"How much time do I spend in meetings?"
```

---

## Appendix B: MCP Server Configuration

```json
{
  "mcpServers": {
    "pastecal": {
      "command": "npx",
      "args": ["-y", "@pastecal/mcp-server"],
      "env": {
        "PASTECAL_API_KEY": "pcal_live_..."
      }
    }
  }
}
```

---

## Appendix C: Webhook Payload Examples

```json
// event.created
{
  "event": "event.created",
  "timestamp": "2024-01-20T15:30:00Z",
  "calendar_id": "cal_abc123",
  "data": {
    "event": {
      "id": "evt_xyz789",
      "title": "Team Meeting",
      "start": "2024-01-25T14:00:00Z",
      "end": "2024-01-25T15:00:00Z"
    }
  }
}

// event.updated
{
  "event": "event.updated",
  "timestamp": "2024-01-20T15:35:00Z",
  "calendar_id": "cal_abc123",
  "data": {
    "event": { ... },
    "changes": {
      "start": {
        "old": "2024-01-25T14:00:00Z",
        "new": "2024-01-25T15:00:00Z"
      }
    }
  }
}
```

---

*Last updated: 2024-01-20*
*Version: 1.0.0*
