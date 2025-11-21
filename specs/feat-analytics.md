# Analytics Feature Specification

## Overview

This document outlines the implementation of a **cost-effective analytics system** for the PasteCal calendar application using Firebase Analytics (completely free) to track user engagement, calendar usage, and performance metrics.

## Goals

- Track calendar usage patterns and user engagement
- Monitor public calendar views and ICS downloads
- Measure feature adoption and user flows
- Identify performance bottlenecks
- **Zero additional cost** - leverage existing Firebase infrastructure

## Architecture

### Approach: Firebase Analytics (Free Forever)
- **Client-side tracking**: Vue.js app with Firebase Analytics SDK
- **Server-side logging**: Cloud Functions analytics events
- **Dashboard**: Firebase Analytics console (free)
- **No additional infrastructure**: Uses existing Firebase project

## Key Metrics to Track

### 1. Calendar Usage
- Calendar creation/editing events
- Event additions/modifications
- Calendar sharing (public link creation)
- Calendar imports/exports

### 2. Public Calendar Performance
- Public calendar view counts (by slug)
- ICS download statistics
- Read-only link engagement
- Geographic distribution of viewers

### 3. User Engagement
- Session duration
- Feature usage patterns
- Navigation flows
- Error rates and bounce patterns

### 4. Performance Metrics
- Page load times
- Calendar render performance
- API response times
- Function execution efficiency

## Implementation Plan

### Phase 1: Basic Firebase Analytics Setup ⭐ HIGH PRIORITY

#### TODO-1.1: Add Firebase Analytics SDK
- [ ] Add Firebase Analytics import to `public/index.html`
- [ ] Initialize Analytics with existing Firebase config
- [ ] Verify Analytics is working in Firebase console

#### TODO-1.2: Basic Event Tracking
- [ ] Track calendar creation events
- [ ] Track public link generation
- [ ] Track calendar view events (editable vs read-only)
- [ ] Track ICS download events

### Phase 2: Enhanced Client-Side Tracking ⭐ MEDIUM PRIORITY

#### TODO-2.1: User Journey Analytics
- [ ] Track calendar editing sessions
- [ ] Monitor feature usage (settings, sharing, etc.)
- [ ] Track user engagement time
- [ ] Monitor error occurrences

#### TODO-2.2: Performance Tracking
- [ ] Track calendar load times
- [ ] Monitor Vue.js component render performance
- [ ] Track API call success/failure rates

### Phase 3: Server-Side Analytics ⭐ MEDIUM PRIORITY

#### TODO-3.1: Cloud Functions Analytics
- [ ] Add analytics logging to `generateICSV2` function
- [ ] Track calendar lookup patterns in `lookupCalendar`
- [ ] Monitor public link creation in `createPublicLink`
- [ ] Log case-insensitive lookup usage

#### TODO-3.2: Calendar Popularity Metrics
- [ ] Track most viewed public calendars
- [ ] Monitor geographic distribution of views
- [ ] Track peak usage times
- [ ] Monitor calendar size and complexity metrics

### Phase 4: Analytics Dashboard & Insights ⭐ LOW PRIORITY

#### TODO-4.1: Firebase Analytics Configuration
- [ ] Set up custom events in Firebase console
- [ ] Configure conversion funnels
- [ ] Set up audience segments
- [ ] Configure automated insights

#### TODO-4.2: Custom Analytics Views
- [ ] Create calendar-specific metrics dashboard
- [ ] Set up alerting for unusual patterns
- [ ] Generate weekly/monthly usage reports

## Technical Implementation

### Firebase Analytics SDK Integration

```javascript
// Add to Firebase config in index.html
import { getAnalytics, logEvent } from "firebase/analytics";

const analytics = getAnalytics(app);

// Example event tracking
logEvent(analytics, 'calendar_created', {
  calendar_id: calendar.id,
  has_events: calendar.events.length > 0
});
```

### Event Schema

#### Calendar Events
```javascript
// Calendar creation
logEvent(analytics, 'calendar_created', {
  calendar_id: string,
  has_events: boolean,
  event_count: number
});

// Public link creation
logEvent(analytics, 'public_link_created', {
  calendar_id: string,
  custom_slug: boolean,
  slug_length: number
});

// Calendar view
logEvent(analytics, 'calendar_viewed', {
  calendar_id: string,
  view_type: 'editable' | 'readonly',
  referrer: string
});
```

#### Performance Events
```javascript
// Page performance
logEvent(analytics, 'page_load_complete', {
  load_time_ms: number,
  calendar_size: number
});

// API performance  
logEvent(analytics, 'api_call', {
  function_name: string,
  duration_ms: number,
  success: boolean
});
```

### Cloud Functions Analytics

```javascript
// Add to functions/index.js
const { getAnalytics } = require('firebase-admin/analytics');

// Example in generateICSV2
exports.generateICSV2 = onRequest({ cors: true }, async (req, res) => {
    // ... existing code ...
    
    // Log analytics event
    console.log('ANALYTICS: ICS downloaded', {
        calendar_id: id,
        is_readonly: isReadOnly,
        event_count: calendarData.events?.length || 0,
        user_agent: req.headers['user-agent']
    });
});
```

## Cost Analysis

### Firebase Analytics (FREE)
- **Event tracking**: Unlimited events
- **Custom events**: Up to 500 distinct event types
- **User properties**: Up to 25 custom user properties
- **Audience creation**: Unlimited audiences
- **Dashboard access**: Full Firebase Analytics console

### Estimated Usage
- **Events per month**: ~10,000-50,000 (well within free limits)
- **Storage**: Minimal (event metadata only)
- **Compute**: No additional Cloud Function calls needed

### Alternative Costs (for comparison)
- Google Analytics 360: $150,000/year
- Mixpanel: $25-833/month depending on events
- Amplitude: $61-995/month
- **Firebase Analytics: $0/month** ✅

## Privacy & Compliance

### Data Collection
- No personally identifiable information (PII) collected
- Anonymous user IDs only
- IP addresses automatically anonymized by Firebase
- GDPR-compliant by default

### User Consent
- Analytics run without requiring explicit consent (anonymous)
- No cookies or local storage beyond Firebase SDK requirements
- Users can opt-out via browser settings

## Success Metrics

### Short-term (1-3 months)
- Analytics implementation complete
- Basic event tracking functional
- Dashboard showing usage patterns

### Medium-term (3-6 months)
- Identify top-performing calendar types
- Understand user journey bottlenecks
- Optimize based on performance data

### Long-term (6+ months)
- Data-driven feature development
- Performance optimization based on real usage
- Understanding seasonal usage patterns

## Next Steps

1. **Start with TODO-1.1**: Add Firebase Analytics SDK
2. **Implement TODO-1.2**: Basic event tracking
3. **Monitor results**: Verify events in Firebase console
4. **Iterate**: Add more events based on initial insights

## Benefits

✅ **Zero cost** - completely free forever  
✅ **Easy integration** - uses existing Firebase project  
✅ **Comprehensive insights** - tracks both client and server-side  
✅ **Scalable** - no usage limits or upgrade costs  
✅ **Privacy-compliant** - anonymous by default  
✅ **Real-time** - immediate insights in Firebase console