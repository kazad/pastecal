/**
 * The deploy scripts' safety checks, run for real with every external tool (gcloud, curl,
 * npm, firebase) replaced by a stub on PATH that only records it was called. Nothing here
 * touches the network or production.
 *
 *   - scripts/deploy-rules.sh: a mistyped flag (--dryrun) used to be ignored and upload the
 *     rules to production. It must exit 2 before it fetches a token, let alone uploads.
 *   - deploy.sh: refuses to deploy unless `npm run test:unit` passes; --skip-tests is the
 *     only way past, and it says so loudly.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '../..');

/** A PATH whose gcloud/curl/npm/firebase append "<name> <args>" to a log. */
function stubs({ npmExit = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pastecal-deploy-stubs-'));
  const log = path.join(dir, 'calls.log');
  const stub = (name, body) => {
    fs.writeFileSync(path.join(dir, name),
      `#!/usr/bin/env bash\necho "${name} $*" >> "${log}"\n${body}\n`, { mode: 0o755 });
  };
  stub('gcloud', 'echo fake-token');
  stub('curl', `printf '{}\\n200'`);
  stub('npm', `exit ${npmExit}`);
  stub('firebase', 'exit 0');
  return {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []),
    done: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function run(script, args, env) {
  return spawnSync('bash', [path.join(ROOT, script), ...args], { env, encoding: 'utf8', timeout: 60_000 });
}

test('deploy-rules.sh: a mistyped flag exits 2 before fetching a token or uploading', () => {
  for (const args of [['--dryrun'], ['dry-run'], ['--dry-run', '--extra']]) {
    const s = stubs();
    try {
      const r = run('scripts/deploy-rules.sh', args, s.env);
      assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
      assert.deepEqual(s.calls(), [], `${args.join(' ')} must not reach gcloud or curl`);
    } finally {
      s.done();
    }
  }
});

test('deploy-rules.sh: --dry-run uploads only as a server-side dry run', () => {
  const s = stubs();
  try {
    const r = run('scripts/deploy-rules.sh', ['--dry-run'], s.env);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const log = s.calls().join('\n');
    assert.equal(log.match(/^curl /gm)?.length, 1, log);
    assert.match(log, /\/\.settings\/rules\.json\?dryRun=true(\s|$)/);
  } finally {
    s.done();
  }
});

test('deploy.sh: failing tests stop the deploy before anything is deployed', () => {
  const s = stubs({ npmExit: 1 });
  try {
    const r = run('deploy.sh', ['functions'], s.env);
    assert.notEqual(r.status, 0);
    assert.ok(s.calls().some(c => c === 'npm run test:unit'), 'the tests were run');
    assert.ok(!s.calls().some(c => c.startsWith('firebase ')), `nothing deployed: ${s.calls()}`);
    assert.match(r.stdout, /tests failed -- not deploying/);
  } finally {
    s.done();
  }
});

test('deploy.sh: passing tests deploy; --skip-tests deploys without them, loudly', () => {
  let s = stubs();
  try {
    const r = run('deploy.sh', ['functions'], s.env);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(s.calls(), ['npm run test:unit', 'firebase deploy --only functions']);
  } finally {
    s.done();
  }

  s = stubs({ npmExit: 1 });
  try {
    const r = run('deploy.sh', ['--skip-tests', 'functions'], s.env);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(s.calls(), ['firebase deploy --only functions']);
    assert.match(r.stdout, /WARNING: --skip-tests/);
  } finally {
    s.done();
  }
});

test('deploy.sh: an unknown flag is refused, not read as a target', () => {
  const s = stubs();
  try {
    const r = run('deploy.sh', ['--skiptests', 'functions'], s.env);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.deepEqual(s.calls(), []);
  } finally {
    s.done();
  }
});
