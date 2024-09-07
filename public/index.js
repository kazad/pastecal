// nanoid library
let nanoid = (t = 21) => {
  let e = "",
    r = crypto.getRandomValues(new Uint8Array(t));
  for (; t--;) {
    let n = 63 & r[t];
    e +=
      n < 36
        ? n.toString(36)
        : n < 62
          ? (n - 26).toString(36).toUpperCase()
          : n < 63
            ? nanoid(1) // replace with another random character
            : nanoid(1);
  }
  return e;
};

var Utils = {};

Utils.nanoid = nanoid;

// can we make this a mutator, where the get/set of a property on this automatically syncs to localstorage?
// TODO: find localstorage sync?
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

// date time parsing
function parseHumanWrittenCalendar(entry) {
  // Define regular expressions for different components
  const timePattern = /(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/gi;
  const timeRangePattern = /(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*-\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/gi;
  const datePattern = /(today|tomorrow|next\s+\w+|on\s+\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\w+\s+\d{1,2}(?:st|nd|rd|th)?)/gi;
  const durationPattern = /for\s+(\d+)\s*(minutes?|hours?|days?)/gi;
  const dayOfWeekPattern = /(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/gi;
  const subjectPattern = /^(.+?)(?=\s+(?:at|from|on|every|tomorrow|next|today|\d{1,2}\/\d{1,2}))/i;

  // Extract potential matches
  const timeMatches = entry.match(timePattern) || [];
  const timeRangeMatches = entry.match(timeRangePattern) || [];
  const dateMatches = entry.match(datePattern) || [];
  const durationMatches = entry.match(durationPattern) || [];
  const dayOfWeekMatches = entry.match(dayOfWeekPattern) || [];
  const subjectMatch = entry.match(subjectPattern);

  // Initialize extracted information
  let subject = subjectMatch ? subjectMatch[1].trim() : 'Event';
  let startTime = timeMatches[0] || null;
  let endTime = null;
  let date = dateMatches[0] || null;
  let duration = durationMatches[0] || null;

  // If a time range is found, split it into start and end time
  if (timeRangeMatches.length > 0) {
    const rangeMatch = timeRangeMatches[0].match(timeRangePattern);
    if (rangeMatch && rangeMatch.length >= 3) {
      startTime = rangeMatch[1].trim();
      endTime = rangeMatch[2].trim();
    }
  }

  // Parse the relative or absolute date into a JavaScript Date object
  let startDate = new Date();
  if (date) {
    if (date.toLowerCase() === 'tomorrow') {
      startDate.setDate(startDate.getDate() + 1);
    } else if (date.toLowerCase() !== 'today') {
      if (date.toLowerCase().includes('next')) {
        const dayOfWeek = date.split(/\s+/)[1];
        startDate = getNextWeekday(dayOfWeek);
      } else {
        // Handle dates like "December 15" or "12/15"
        const parsedDate = new Date(date);
        if (!isNaN(parsedDate.getTime())) {
          startDate = parsedDate;
        }
      }
    }
  }

  // Calculate end time if duration is specified
  if (duration) {
    const durationMatch = duration.match(/(\d+)\s*(minutes?|hours?|days?)/i);
    if (durationMatch) {
      const [, durationValue, durationUnit] = durationMatch;
      endTime = new Date(startDate);
      switch (durationUnit.toLowerCase()) {
        case 'minute':
        case 'minutes':
          endTime.setMinutes(endTime.getMinutes() + parseInt(durationValue));
          break;
        case 'hour':
        case 'hours':
          endTime.setHours(endTime.getHours() + parseInt(durationValue));
          break;
        case 'day':
        case 'days':
          endTime.setDate(endTime.getDate() + parseInt(durationValue));
          break;
      }
    }
  }

  // Format start and end times
  try {
    if (startTime) {
      startDate = setTimeFromString(startDate, startTime);
    }
    if (endTime && typeof endTime === 'string') {
      endTime = setTimeFromString(new Date(startDate), endTime);
    } else if (!(endTime instanceof Date)) {
      endTime = null;
    }
  } catch (error) {
    console.error("Error parsing time:", error.message);
    // Set default times if parsing fails
    startDate.setHours(0, 0, 0, 0);
    endTime = null;
  }

  // Format output
  return {
    subject,
    startDateTime: startDate.toISOString(),
    endDateTime: endTime ? endTime.toISOString() : null
  };
}

// Helper function to find the date of the next weekday
function getNextWeekday(weekday) {
  const daysOfWeek = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const day = daysOfWeek.indexOf(weekday.toLowerCase());
  const today = new Date();
  const currentDay = today.getDay();
  const daysUntilNext = (day - currentDay + 7) % 7 || 7;
  const nextDate = new Date(today);
  nextDate.setDate(today.getDate() + daysUntilNext);
  return nextDate;
}

// Helper function to set time from a string
function setTimeFromString(date, timeString) {
  if (typeof timeString !== 'string') {
    throw new Error('Invalid time string');
  }

  const timeParts = timeString.toLowerCase().match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (!timeParts) {
    throw new Error('Unable to parse time string');
  }

  let [, hours, minutes = '00', meridiem] = timeParts;
  hours = parseInt(hours);
  minutes = parseInt(minutes);

  if (meridiem === 'pm' && hours !== 12) {
    hours += 12;
  } else if (meridiem === 'am' && hours === 12) {
    hours = 0;
  }

  if (hours >= 24 || minutes >= 60) {
    throw new Error('Invalid time values');
  }

  date.setHours(hours, minutes, 0, 0);
  return date;
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
  "invalid time entry at 25:00",
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