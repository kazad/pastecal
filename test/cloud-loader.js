// Loads the REAL browser services (CalendarDataService + CloudCalendarService + EventStore) into
// a fresh vm context, the way the page's <script> tags do, with just enough stubs for node:
// no Firebase (its ref() is never touched by the cloud path), an in-memory localStorage, and a
// Utils with debounce/uuid. Each call is an independent "tab" with its own statics and storage.
// Used by test/unit/cloud-calendar-service.test.js and cloudflare/test/cloud-service.test.mjs.
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const pub = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(pub, f), 'utf8');

function loadTab({ WebSocket = globalThis.WebSocket, base, search = '?backend=cf', hostname = 'localhost', storage = {} } = {}) {
    const store = { ...storage };
    const ctx = vm.createContext({
        console, setTimeout, clearTimeout, setInterval, clearInterval, crypto, URLSearchParams, fetch,
        WebSocket, JSON, Date, Math, Promise,
        firebase: { database: () => ({ ref: () => ({}) }) },
        localStorage: {
            getItem: (k) => (k in store ? store[k] : null),
            setItem: (k, v) => { store[k] = String(v); },
            removeItem: (k) => { delete store[k]; },
        },
        location: { search, hostname, origin: base || 'http://localhost:8787' },
    });
    const run = (src, name) => vm.runInContext(src, ctx, { filename: name });
    run(`const Utils = { debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; },
                        uuidv4() { return crypto.randomUUID(); } };`, 'utils-stub');
    run(read('models/Event.js'), 'Event.js');
    run(read('services/EventStore.js'), 'EventStore.js');
    run(read('services/CalendarDataService.js'), 'CalendarDataService.js');
    run(read('services/CloudCalendarService.js'), 'CloudCalendarService.js');
    return {
        ctx, store,
        Cloud: run('CloudCalendarService', 'get'),
        Service: run('CalendarDataService', 'get'),       // what the apps see: Cloud when the flag is on
        EventStore: run('EventStore', 'get'),
        run,
    };
}
module.exports = { loadTab };
