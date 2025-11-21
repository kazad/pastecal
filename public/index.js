// can we make this a mutator, where the get/set of a property on this automatically syncs to localstorage?
// TODO: find localstorage sync?
class RecentCalendars {
  constructor() {
    this.load();
  }

  load() {
    this.items = JSON.parse(localStorage.getItem('recentCalendars')) || [];
  }

  save() {
    localStorage.setItem('recentCalendars', JSON.stringify(this.items));
  }

  add(id, title) {
    // Find existing item to preserve pinned state
    const existingItem = this.items.find(item => item.id === id);
    const wasPinned = existingItem ? existingItem.pinned : false;

    // Remove if exists
    this.items = this.items.filter(item => item.id !== id);

    // Add to front, preserving pinned state
    this.items.unshift({
      id: id,
      title: title || id,
      pinned: wasPinned, // Preserve existing pinned state
      lastVisited: new Date().toISOString()
    });

    // Keep only last 10 unpinned items
    const pinnedItems = this.items.filter(item => item.pinned);
    const unpinnedItems = this.items.filter(item => !item.pinned).slice(0, 10);
    this.items = [...pinnedItems, ...unpinnedItems];

    this.save();
  }

  remove(id) {
    this.items = this.items.filter(item => item.id !== id);
    this.save();
  }

  togglePin(id) {
    const item = this.items.find(item => item.id === id);
    if (item) {
      item.pinned = !item.pinned;
      this.save();
    }
  }

  getAll() {
    return [...this.items].sort((a, b) => {
      // Pinned items first
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      // Then by last visited
      return new Date(b.lastVisited) - new Date(a.lastVisited);
    });
  }
}

var _calstore = _calstore ?? {};

Utils.init = function () {
  _calstore = _calstore ?? JSON.parse(localStorage.getItem("_calstore")) ?? {};
  _calstore.events = _calstore.events ?? [];
  Utils.sync();
  console.log(_calstore);

  // event handlers
  calendar.on({
    clickSchedule: function (e) {
      console.log("clickSchedule", e);
    },
    beforeCreateSchedule: function (e) {
      console.log("beforeCreateSchedule", e);
      // open a creation popup
      // If you dont' want to show any popup, just use `e.guide.clearGuideElement()`

      // then close guide element(blue box from dragging or clicking days)
      // e.guide.clearGuideElement();
      Utils.createEvent(e);
      Utils.render();
    },
    beforeUpdateSchedule: function (e) {
      console.log("beforeUpdateSchedule", e);
      e.schedule.start = e.start;
      e.schedule.end = e.end;
      // calendar.updateSchedule(e.schedule.id, e.schedule.calendarId, e.schedule);
      Utils.updateEvent(e);
      Utils.render();
    },
    beforeDeleteSchedule: function (e) {
      console.log("beforeDeleteSchedule", e);
      //cal.deleteSchedule(e.schedule.id, e.schedule.calendarId);
      Utils.deleteEvent(e);
      Utils.render();
    },
  });
};

Utils.sync = function () {
  localStorage.setItem("_calstore", JSON.stringify(_calstore));
  CalendarDataService.sync();
};
/*
schema:
  { 
  id: '1',
  calendarId: '1',
  title: 'my schedule',
  category: 'time',
  dueDateClass: '',
  start: '2018-01-18T22:30:00+09:00',
   end: '2018-01-19T02:30:00+09:00'
   }
*/

Utils.createEvent = function (e) {
  console.log("create event", e);
  var ev = {
    id: e.id ?? _calstore.events.length + 100,
    calendarId: e.calendarId ?? 1,
    title: e.title,
    category: e.category ?? "time",
    start: e.start._date.toISOString(),
    end: e.end._date.toISOString(),
  };

  _calstore.events.push(ev);
  Utils.sync();
};

Utils.updateEvent = function (e) {
  console.log("update event", e);

  // need better way to turn items from ScheduleEvent to a JSON object
  e = { ...e.schedule, ...e.changes };
  e.id = e.id ?? e.schedule.id;
  Utils.deleteEvent(e);
  Utils.createEvent(e);
  // easier: do a delete, then create
};

Utils.deleteEvent = function (e) {
  console.log("delete event", e);
  e.id = e.id ?? e.schedule.id;
  _calstore.events = _calstore.events.filter((ev) => ev.id != e.id);
  Utils.sync();
};

Utils.clearEvents = function () {
  _calstore.events = [];
  Utils.sync();
};

Utils.getEvents = function () {
  return _calstore.events;
};

Utils.render = function () {
  calendar.clear();
  calendar.createSchedules(Utils.getEvents());
};

function parseHumanWrittenCalendar(entry) {
  const parsedResults = chrono.parse(entry, new Date(), { forwardDate: true });

  if (parsedResults.length === 0) {
    return { subject: entry, startDateTime: null, endDateTime: null };
  }

  const result = parsedResults[0];
  let startDate = result.start.date();
  let endDate = result.end ? result.end.date() : null;

  // Extract the parsed text and the remaining text
  const parsedText = result.text;
  let remainingText = entry.replace(parsedText, '').trim();

  // Process duration in the remaining text
  const { subject, duration } = extractDuration(remainingText);

  // Apply duration if found
  if (duration && !endDate) {
    endDate = new Date(startDate.getTime() + duration);
  } else if (!endDate && !duration) {
    // Set default duration to 1 hour
    const defaultDuration = 60 * 60 * 1000; // 1 hour in milliseconds
    endDate = new Date(startDate.getTime() + defaultDuration);
  }

  return {
    subject: subject || 'Untitled Event',
    startDateTime: startDate.toISOString(),
    endDateTime: endDate ? endDate.toISOString() : null
  };
}

function extractDuration(text) {
  const durationRegex = /(?:(?:for|in)\s+)?(\d+(?:\.\d+)?)\s*(hour|hr|minute|min|day)s?/i;
  const match = text.match(durationRegex);

  if (!match) {
    return { subject: text, duration: null };
  }

  const [fullMatch, amount, unit] = match;
  let durationMs;

  switch (unit.toLowerCase()) {
    case 'hour':
    case 'hr':
      durationMs = parseFloat(amount) * 60 * 60 * 1000;
      break;
    case 'minute':
    case 'min':
      durationMs = parseFloat(amount) * 60 * 1000;
      break;
    case 'day':
      durationMs = parseFloat(amount) * 24 * 60 * 60 * 1000;
      break;
    default:
      durationMs = 0;
  }

  const subject = text.replace(fullMatch, '').replace(/\s+/g, ' ').trim();

  return { subject, duration: durationMs };
}

// Example usage and test cases
const testCases = [
  "meet someone tomorrow 2pm for 1 hour",
  "meeting tomorrow 2-3pm",
  "meeting 9/6/2024 2-3pm",
  "meeting 2pm november 11",
  "lunch with John next Tuesday at 12:30pm",
  "team standup every Monday at 9am for 15 minutes",
  "conference call on 15th December from 3pm to 4:30pm",
  "dentist appointment tomorrow at 10am",
  "project deadline on Friday at 5pm",
  "weekly review every Friday 4-5pm",
  "meeting with john tomorrow at 2pm for 1 hour",
  "meeting with no time specified"
];

/*
testCases.forEach(testCase => {
  console.log(`Input: "${testCase}"`);
  console.log(JSON.stringify(parseHumanWrittenCalendar(testCase), null, 2));
  console.log('---');
});
*/

Utils.parseHumanWrittenCalendar = parseHumanWrittenCalendar;
