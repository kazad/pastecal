#!/usr/bin/env node
// Print the unit tests that run WITHOUT the Firebase emulator, newline-separated.
//
// Why this exists: the fast suite used to name every file explicitly in package.json, so a
// new test only ran if someone remembered to add it there. Two files (calendar-model,
// linkify) sat in the repo passing and unrun. Discovery is now automatic; *.emulator.test.js
// is excluded because those need `firebase emulators:exec` and run in test:unit:emulator.
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, 'unit');
const files = fs.readdirSync(dir)
  .filter(f => f.endsWith('.test.js') && !f.endsWith('.emulator.test.js'))
  .sort()
  .map(f => path.join('test/unit', f));

if (!files.length) {
  console.error('No unit tests found in test/unit — is the directory right?');
  process.exit(1);
}
process.stdout.write(files.join('\n') + '\n');
