// install.sh's architecture choice, and what it does with a download.
//
// Both matter more than they look. Picking the wrong build does not fail
// helpfully — the kernel says "Exec format error", which says nothing about
// why — and the installer runs what it downloads, as root, so "it arrived" is
// not the same as "it is what was built".
//
// The functions are pulled out of the real script rather than copied, so this
// tracks the code instead of a snapshot of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL = path.join(ROOT, 'install.sh');

/** Run detect_arch with `uname -m` reporting whatever the machine claims. */
function archFor(machine) {
  const script = `
    set -eu
    uname() { echo '${machine}'; }
    die() { echo "DIE: $*"; exit 3; }
    eval "$(sed -n '/^detect_arch()/,/^}/p' '${INSTALL}')"
    detect_arch
    echo "$GO_BINARY"
  `;
  try {
    return execFileSync('sh', ['-c', script], { stdio: 'pipe' }).toString().trim();
  } catch (e) {
    return `refused: ${e.stdout?.toString().trim() ?? ''}`;
  }
}

test('every architecture the release publishes is recognised', () => {
  const expected = {
    x86_64: 'traincon-linux-amd64',
    amd64: 'traincon-linux-amd64',
    aarch64: 'traincon-linux-arm64',
    arm64: 'traincon-linux-arm64',
    // The older Pis, which are exactly what something like this ends up on.
    armv7l: 'traincon-linux-armv7',
    armv6l: 'traincon-linux-armv7',
  };
  for (const [machine, binary] of Object.entries(expected)) {
    assert.equal(archFor(machine), binary, `uname -m = ${machine}`);
  }
});

test('an architecture with no build is refused, and says so', () => {
  // Better than downloading a binary that cannot run and leaving the operator
  // with "Exec format error" and no idea which part was wrong.
  const out = archFor('riscv64');
  assert.match(out, /refused/);
  assert.match(out, /riscv64/, 'the message should name what was found');
  assert.match(out, /amd64/, 'and what is available');
});

/** Run verify_download against a file and a SHA256SUMS body we control. */
async function verify(body, sums, { tool = true } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'traincon-verify-'));
  const file = path.join(dir, 'traincon');
  await writeFile(file, body);

  // curl is stubbed to serve the checksum file; the real one would fetch it
  // from the release.
  const script = `
    set -eu
    GH_REPO=example/repo
    info() { :; }
    warn() { echo "WARN: $*"; }
    die()  { echo "DIE: $*"; exit 3; }
    curl() { ${sums === null ? 'return 1' : `printf '%s\\n' '${sums}'`}; }
    ${tool ? '' : "sha256sum() { return 127; }\n    command() { return 1; }"}
    eval "$(sed -n '/^verify_download()/,/^}/p' '${INSTALL}')"
    verify_download '${file}' traincon-linux-amd64 v1.0.0
    echo OK
  `;
  try {
    const out = execFileSync('sh', ['-c', script], { stdio: 'pipe' }).toString().trim();
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: e.stdout?.toString().trim() ?? '' };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The digest of a known body, computed the way the installer will. */
function sha256(body) {
  return execFileSync('sh', ['-c', `printf '%s' '${body}' | sha256sum | awk '{print $1}'`])
    .toString()
    .trim();
}

test('a binary matching its published digest is accepted', async () => {
  const body = 'pretend-this-is-a-binary';
  const sums = `${sha256(body)}  traincon-linux-amd64`;
  const { ok } = await verify(body, sums);
  assert.ok(ok, 'a matching checksum should pass');
});

test('a binary that does not match is refused, not installed', async () => {
  // The whole point: this file is about to be run as root.
  const sums = `${'0'.repeat(64)}  traincon-linux-amd64`;
  const { ok, out } = await verify('pretend-this-is-a-binary', sums);
  assert.ok(!ok, 'a mismatched checksum must fail the install');
  assert.match(out, /refusing to install/);
});

test('a release with no checksum file still installs, with a warning', async () => {
  // A release predating SHA256SUMS should not become uninstallable, but the
  // operator should be told the check did not happen.
  const { ok, out } = await verify('pretend-this-is-a-binary', null);
  assert.ok(ok, 'a missing checksum file should not block the install');
  assert.match(out, /WARN/);
});

test('a checksum file that does not list this file warns rather than passing silently', async () => {
  const sums = `${'0'.repeat(64)}  something-else`;
  const { ok, out } = await verify('pretend-this-is-a-binary', sums);
  assert.ok(ok);
  assert.match(out, /WARN.*not listed/);
});
