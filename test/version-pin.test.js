'use strict';

// T-15 Version pin (spec section 2, decisions.md items 15 and 45): a bot that pins the
// base at tag v1.0.0 keeps that code after the base receives a new tag, until the
// bot changes its pin on purpose.
//
// Runs offline: the base is copied into a temporary git repository (dependencies
// removed, so npm installs nothing from the registry), tagged twice, and a temporary
// bot installs it by tag the same way a real bot does ("github:...#v1.0.0").

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' },
  });
}

function makeBaseRepo(dir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  const write = (version, marker) => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ ...pkg, version, dependencies: {}, scripts: {} }, null, 2));
    fs.writeFileSync(path.join(dir, 'src', 'index.js'), `'use strict';\nmodule.exports = { marker: '${marker}' };\n`);
  };
  run('git', ['init', '-q', '-b', 'main'], dir);
  write(pkg.version, 'first release');
  run('git', ['add', '-A'], dir);
  run('git', ['commit', '-q', '-m', 'release'], dir);
  run('git', ['tag', `v${pkg.version}`], dir);
  write('9.9.9', 'later release');
  run('git', ['commit', '-q', '-am', 'later'], dir);
  run('git', ['tag', 'v9.9.9'], dir);
  return pkg.version;
}

function installedBase(botDir) {
  const base = path.join(botDir, 'node_modules', 'whatsapp-bot-base');
  return {
    version: JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8')).version,
    marker: fs.readFileSync(path.join(base, 'src', 'index.js'), 'utf8').match(/marker: '([^']+)'/)[1],
  };
}

function install(botDir, baseDir, tag) {
  fs.writeFileSync(
    path.join(botDir, 'package.json'),
    JSON.stringify({ name: 'pin-test-bot', version: '0.0.0', private: true, dependencies: { 'whatsapp-bot-base': `git+file://${baseDir}#${tag}` } }, null, 2)
  );
  run(NPM, ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error'], botDir);
}

test('T-15 a bot pinned to the base tag keeps it after a new base tag, until it upgrades on purpose', { timeout: 120000 }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-'));
  try {
    const baseDir = path.join(tmp, 'base');
    const botDir = path.join(tmp, 'bot');
    fs.mkdirSync(baseDir);
    fs.mkdirSync(botDir);
    const version = makeBaseRepo(baseDir);

    install(botDir, baseDir, `v${version}`);
    assert.deepEqual(installedBase(botDir), { version, marker: 'first release' });

    // The base already has a newer tag; a fresh install of the bot still gets the pinned one.
    fs.rmSync(path.join(botDir, 'node_modules'), { recursive: true, force: true });
    run(NPM, ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error'], botDir);
    assert.deepEqual(installedBase(botDir), { version, marker: 'first release' });

    // Upgrade on purpose: the bot installs the new tag by name, which rewrites both
    // package.json and package-lock.json. (Editing package.json alone leaves the old
    // commit in the lock file, so npm keeps installing it.)
    run(NPM, ['install', `whatsapp-bot-base@git+file://${baseDir}#v9.9.9`, '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error'], botDir);
    assert.match(JSON.parse(fs.readFileSync(path.join(botDir, 'package.json'), 'utf8')).dependencies['whatsapp-bot-base'], /#v9\.9\.9$/);
    assert.deepEqual(installedBase(botDir), { version: '9.9.9', marker: 'later release' });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('T-15 the base declares a release version and the files a bot receives', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.version, /^[1-9]\d*\.\d+\.\d+$/, 'a release version, not 0.0.0');
  assert.equal(pkg.main, 'src/index.js');
  assert.deepEqual(pkg.files, ['src/']);
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.ok(readme.includes(`#v${pkg.version}"`), 'README shows the pin line for this version');
});
