#!/usr/bin/env node
/**
 * Preflight guard for `npm run test:unit:fast`.
 *
 * unit/ics.test.js requires functions/index.js, which pulls in firebase-admin →
 * jsonwebtoken → jwa → buffer-equal-constant-time. That last package reads
 * `SlowBuffer.prototype` at module scope, and on a runtime without
 * `buffer.SlowBuffer` the require throws before a single test runs. Node reports
 * that as "test failed" with a stack trace pointing into node_modules — which
 * looks like a broken test rather than a missing runtime API.
 *
 * Failing here instead turns that into one actionable line.
 *
 * This checks the CAPABILITY, not the version number. It used to reject every
 * Node above 22, which turned away 23 and 24 — both still ship SlowBuffer and run
 * the suite fine — on the strength of a guess about when it would be removed.
 * When the dependency is installed it is required for real, so the answer is
 * whatever the dependency itself does on this runtime; otherwise the guard falls
 * back to the API it needs.
 *
 * This is not fixable by upgrading: buffer-equal-constant-time has only ever
 * published 1.0.0 and 1.0.1 (both read SlowBuffer at module scope), and it is a
 * hard transitive dependency of jsonwebtoken, which firebase-admin requires — on
 * the latest versions of both.
 */

const path = require('path');

const MIN = 20; // node:test and global fetch, which the suite uses
const [major] = process.versions.node.split('.').map(Number);

function slowBufferProblem() {
  let resolved = null;
  try {
    resolved = require.resolve('buffer-equal-constant-time', {
      paths: [path.join(__dirname, '..', 'functions')],
    });
  } catch {
    // functions/ deps not installed: test the API the package reads instead.
  }
  if (resolved) {
    try {
      require(resolved);
      return null;
    } catch (err) {
      return `requiring buffer-equal-constant-time failed: ${err.message}`;
    }
  }
  return typeof require('buffer').SlowBuffer === 'function'
    ? null
    : 'this runtime has no buffer.SlowBuffer';
}

const problem = major < MIN
  ? `Node ${MIN} or newer is required`
  : slowBufferProblem();

if (problem) {
  const lines = [
    '',
    `  ✖ Node ${process.versions.node} cannot run the unit tests: ${problem}.`,
    '',
    '    unit/ics.test.js loads functions/index.js → firebase-admin → jsonwebtoken,',
    '    whose buffer-equal-constant-time dependency reads SlowBuffer when it is',
    '    required. On a runtime without it the require throws before any test runs.',
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
