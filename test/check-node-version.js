#!/usr/bin/env node
/**
 * Preflight guard for `npm run test:unit:fast`.
 *
 * unit/ics.test.js requires functions/index.js, which pulls in firebase-admin →
 * jsonwebtoken → jwa → buffer-equal-constant-time. That last package reads
 * `SlowBuffer.prototype`, and SlowBuffer was removed from Node in v24. On a newer
 * runtime the require throws before a single test runs, and node reports it as
 * "test failed" with a stack trace pointing into node_modules — which looks like a
 * broken test rather than a wrong Node version.
 *
 * Failing here instead turns that into one actionable line.
 *
 * This is not fixable by upgrading: buffer-equal-constant-time has only ever
 * published 1.0.0 and 1.0.1 (both read SlowBuffer at module scope), and it is a
 * hard transitive dependency of jsonwebtoken, which firebase-admin requires — on
 * the latest versions of both. Node 20–22 is a real constraint, not stale pinning.
 */

const [major] = process.versions.node.split('.').map(Number);
const MIN = 20;
const MAX = 22; // Node 24 removed SlowBuffer, which jsonwebtoken's deps still read

if (major < MIN || major > MAX) {
  const lines = [
    '',
    `  ✖ Node ${process.versions.node} cannot run the unit tests (need Node ${MIN}–${MAX}).`,
    '',
    '    unit/ics.test.js loads functions/index.js → firebase-admin → jsonwebtoken,',
    '    which uses the SlowBuffer API that Node removed in v24. The require throws',
    '    before any test executes.',
    '',
    '    Fix: switch runtime, then re-run.',
    '',
    '      nvm use          # reads .nvmrc (Node 22)',
    '',
    '    Upgrading dependencies will not help: buffer-equal-constant-time has only',
    '    ever published 1.0.x, and jsonwebtoken still requires it on latest.',
    '',
  ];
  console.error(lines.join('\n'));
  process.exit(1);
}
