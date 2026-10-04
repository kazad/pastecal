// A stand-in for Firebase Realtime Database's REST API, just enough for the copy-back test:
//   GET  /calendars/<id>.json   (X-Firebase-ETag: true -> ETag header)   null when missing
//   PUT  /calendars/<id>.json   with If-Match: 412 unless the ETag is still current
// `store` is exposed so the test can write "as a pc.com browser" and read what the room wrote.
import http from 'node:http';
export function startFakeFirebase(port) {
    const store = new Map(), etags = new Map(); let n = 0; const log = []; const hooks = { onNextPut: null };
    const tag = (id) => etags.get(id) || 'null_etag';
    const server = http.createServer((req, res) => {
        const id = decodeURIComponent(new URL(req.url, 'http://x').pathname.replace(/^\/calendars\//, '').replace(/\.json$/, ''));
        let body = ''; req.on('data', (c) => (body += c));
        req.on('end', () => {
            log.push(`${req.method} ${id}`);
            if (req.method === 'GET') {
                res.setHeader('ETag', tag(id)); res.setHeader('Content-Type', 'application/json');
                return res.end(JSON.stringify(store.has(id) ? store.get(id) : null));
            }
            if (req.method === 'PUT') {
                if (hooks.onNextPut) { const f = hooks.onNextPut; hooks.onNextPut = null; f(); }   // someone else writes first
                const want = req.headers['if-match'];
                if (want && want !== tag(id)) { res.statusCode = 412; res.setHeader('ETag', tag(id)); return res.end('{"error":"conditional request failed"}'); }
                store.set(id, JSON.parse(body)); etags.set(id, `e${++n}`);
                res.setHeader('ETag', tag(id)); return res.end(body);
            }
            res.statusCode = 405; res.end();
        });
    });
    // As a pc.com browser would: a plain write that changes the ETag.
    const browserWrite = (id, cal) => { store.set(id, cal); etags.set(id, `e${++n}`); };
    return new Promise((resolve) => server.listen(port, () => resolve({ store, log, hooks, browserWrite, close: () => server.close() })));
}
