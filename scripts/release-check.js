'use strict';

// Release procedure step 1 (test-plan.md): run the whole suite and report T-01 to T-17.
// Each test ID counts the top-level tests whose name contains it. A test ID with no
// test, a failure, or a skipped test makes the check fail. T-15 (version pin) can only
// run once a base tag exists (stage 3), so it is reported as "not run yet" and does
// not fail the check before the first tag.
//
// Run: node scripts/release-check.js   (with FIRESTORE_EMULATOR_HOST set, or Firestore
// cases are skipped and the check fails, decisions.md item 23)

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const AFTER_FIRST_TAG = new Set(['T-15']);

const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'test/**/*.test.js'], {
  cwd: path.join(__dirname, '..'),
  encoding: 'utf8',
  env: process.env,
  maxBuffer: 64 * 1024 * 1024,
});
const lines = run.stdout.split('\n');
const tests = lines
  .map((line) => /^(ok|not ok) \d+ - (.*?)( # SKIP.*)?$/.exec(line))
  .filter(Boolean)
  .map((m) => ({ ok: m[1] === 'ok', name: m[2], skipped: Boolean(m[3]) }));
const total = (name) => Number((lines.find((l) => l.startsWith(`# ${name} `)) || '').split(' ')[2] || 0);

let pass = run.status === 0;
console.log('| Test | Tests | Failed | Skipped | Result |');
console.log('|---|---|---|---|---|');
for (let i = 1; i <= 17; i += 1) {
  const id = `T-${String(i).padStart(2, '0')}`;
  const mine = tests.filter((t) => t.name.includes(id));
  const failed = mine.filter((t) => !t.ok).length;
  const skipped = mine.filter((t) => t.skipped).length;
  let result = 'pass';
  if (mine.length === 0) result = AFTER_FIRST_TAG.has(id) ? 'not run yet (needs a base tag)' : 'MISSING';
  else if (failed > 0) result = 'FAIL';
  else if (skipped > 0) result = 'SKIPPED';
  if (result === 'MISSING' || result === 'FAIL' || result === 'SKIPPED') pass = false;
  console.log(`| ${id} | ${mine.length} | ${failed} | ${skipped} | ${result} |`);
}
console.log(`\nWhole suite: ${total('tests')} tests, ${total('pass')} pass, ${total('fail')} fail, ${total('skipped')} skipped, ${total('todo')} todo`);
if (total('skipped') > 0) pass = false;
console.log(pass ? 'RELEASE CHECK PASS' : 'RELEASE CHECK FAIL');
process.exitCode = pass ? 0 : 1;
