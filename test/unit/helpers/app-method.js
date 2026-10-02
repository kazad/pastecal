// Pull one Vue method out of public/app.js by name and return it as a callable function,
// with the globals it reads passed in explicitly. Brace-matching from the opening `{`
// keeps nested blocks and object literals intact. Tests call the SHIPPED body this way
// instead of asserting on how its source is spelled.
const fs = require('node:fs');
const path = require('node:path');

const APP = fs.readFileSync(path.join(__dirname, '../../../public/app.js'), 'utf8');

function appMethod(name, globals = {}) {
  const sig = new RegExp(`\\n\\s{8}${name}\\(([^)]*)\\)\\s*\\{`);
  const m = sig.exec(APP);
  if (!m) throw new Error(`could not find ${name}() in public/app.js -- has it been renamed?`);
  const open = APP.indexOf('{', m.index + m[0].length - 1);
  let depth = 0, i = open;
  for (; i < APP.length; i++) {
    if (APP[i] === '{') depth++;
    else if (APP[i] === '}') { depth--; if (depth === 0) break; }
  }
  const names = Object.keys(globals);
  // eslint-disable-next-line no-new-func
  return new Function(...names, `return function(${m[1]}) {${APP.slice(open + 1, i)}}`)(
    ...names.map(n => globals[n]));
}

module.exports = { appMethod, APP };
