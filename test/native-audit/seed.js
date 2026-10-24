// node seed.js : creates/resets the audit calendars on the local server.
const f = require('./fixtures');
(async () => {
  const ids = { 'audit-native-a': f.baseEvents(), 'audit-big': f.bigEvents(600), 'audit-edit': f.baseEvents() };
  for (const [id, ev] of Object.entries(ids)) console.log(id, String(await f.reset(id, ev)).slice(0, 120));
  const c = await f.getCal('audit-native-a'); console.log('events stored:', (c.calendar.events || []).length, Object.keys(c));
})().catch((e) => { console.error(e); process.exit(1); });
