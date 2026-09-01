// install.sh's handling of the API key.
//
// .env is rewritten wholesale on every install, so a key configured once has
// to be carried across updates deliberately. Getting this wrong loses the key
// on the next deploy and the only symptom is the delay reasons going blank —
// no error, nothing in the log. Hence a test.
//
// The functions are pulled out of the real script rather than copied, so this
// tracks the code instead of a snapshot of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL = path.join(ROOT, 'install.sh');

/**
 * Run write_env from the real installer against a throwaway APP_DIR.
 *
 * chown and info are stubbed: the real script runs as root, and this does not.
 */
async function writeEnv(dir, key) {
  const script = `
    set -eu
    APP_DIR='${dir}'
    APP_PORT=3000
    SNCF_API_KEY='${key}'
    info() { :; }
    chown() { :; }
    memory_ceiling() { echo 819; }
    eval "$(sed -n '/^stored_api_key()/,/^}/p' '${INSTALL}')"
    eval "$(sed -n '/^write_env()/,/^}/p' '${INSTALL}')"
    write_env
  `;
  execFileSync('sh', ['-c', script], { stdio: 'pipe' });
  return readFile(path.join(dir, '.env'), 'utf8');
}

async function scratch() {
  const dir = await mkdtemp(path.join(tmpdir(), 'traincon-env-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('a key given at install time is stored', async () => {
  const { dir, cleanup } = await scratch();
  try {
    const env = await writeEnv(dir, 'first-key');
    assert.match(env, /^SNCF_API_KEY=first-key$/m);
    assert.match(env, /^PORT=3000$/m);
    assert.match(env, /^GOMEMLIMIT=819MiB$/m);
    assert.match(env, new RegExp(`^TRAINCON_ROOT=${dir}$`, 'm'));
  } finally {
    await cleanup();
  }
});

test('an update with no key keeps the one already configured', async () => {
  const { dir, cleanup } = await scratch();
  try {
    await writeEnv(dir, 'first-key');
    // The usual update: curl | sh, with nothing in the environment.
    const env = await writeEnv(dir, '');
    assert.match(env, /^SNCF_API_KEY=first-key$/m, 'the key must survive an update');
  } finally {
    await cleanup();
  }
});

test('a new key replaces the stored one', async () => {
  const { dir, cleanup } = await scratch();
  try {
    await writeEnv(dir, 'first-key');
    const env = await writeEnv(dir, 'second-key');
    assert.match(env, /^SNCF_API_KEY=second-key$/m);
    assert.ok(!env.includes('first-key'), 'the old key must be gone');
  } finally {
    await cleanup();
  }
});

test('no key anywhere writes no key line', async () => {
  const { dir, cleanup } = await scratch();
  try {
    const env = await writeEnv(dir, '');
    assert.ok(!env.includes('SNCF_API_KEY'), 'an empty key line would be read as a key');
  } finally {
    await cleanup();
  }
});

test('.env holds a secret and is kept unreadable to others', async () => {
  const { dir, cleanup } = await scratch();
  try {
    await writeEnv(dir, 'first-key');
    const mode = (await stat(path.join(dir, '.env'))).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
  } finally {
    await cleanup();
  }
});

test('the key reaches the service through the file, never argv', async () => {
  // /proc/<pid>/cmdline is world-readable, so a key on a command line is a key
  // any local user can read. It must only ever be written to .env.
  const sh = await readFile(INSTALL, 'utf8');

  // The one place it is written is the .env heredoc.
  const writes = [...sh.matchAll(/SNCF_API_KEY/g)];
  assert.ok(writes.length > 0, 'the installer should handle a key at all');

  for (const line of sh.split('\n')) {
    if (!line.includes('$SNCF_API_KEY')) continue;
    const ok =
      line.includes('printf') || // written into .env
      line.includes('[ -n') || // tested
      line.includes('[ -z') ||
      line.includes('SNCF_API_KEY="'); // assigned
    assert.ok(ok, `key used outside a write or a test: ${line.trim()}`);
  }
});

test('an existing .env with unrelated settings does not confuse the reader', async () => {
  const { dir, cleanup } = await scratch();
  try {
    await writeFile(
      path.join(dir, '.env'),
      'PORT=3000\nNOT_THE_KEY=SNCF_API_KEY=decoy\nSNCF_API_KEY=real-key\n',
    );
    const env = await writeEnv(dir, '');
    assert.match(env, /^SNCF_API_KEY=real-key$/m);
    assert.ok(!env.includes('decoy'), 'must read the real line, not a lookalike');
  } finally {
    await cleanup();
  }
});
