// node summarize.js results.json : one line per test: status, error head, annotations.
const r = require(require('path').resolve(process.argv[2]));
const walk = (s, out = []) => { (s.specs || []).forEach((sp) => sp.tests.forEach((t) => out.push({ title: sp.title, t }))); (s.suites || []).forEach((x) => walk(x, out)); return out; };
for (const { title, t } of r.suites.flatMap((s) => walk(s))) {
  for (const res of t.results) {
    const err = (res.error?.message || '').replace(/\u001b\[[0-9;]*m/g, '').split('\n').filter(Boolean).slice(0, 4).join(' | ').slice(0, 400);
    const ann = (t.annotations || []).concat(res.annotations || []).map((a) => `${a.type}=${(a.description || '').slice(0, 160)}`).join(' ; ');
    console.log(`[${t.projectName}] ${res.status.toUpperCase()} ${title}${err ? '\n    ERR ' + err : ''}${ann ? '\n    ANN ' + ann : ''}`);
  }
}
