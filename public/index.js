// nanoid library
let nanoid = (t = 21) => {
  let e = "",
    r = crypto.getRandomValues(new Uint8Array(t));
  for (; t--; ) {
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

// can we make this a mutator, where the get/set of a property on this automatically syncs to localstorage?
// TODO: find localstorage sync?
var _calstore = {};

Utils.init = function () {
  _calstore = JSON.parse(localStorage.getItem("_calstore")) ?? {};
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
