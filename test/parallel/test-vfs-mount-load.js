'use strict';

// Covers --vfs-mount / --vfs-load: running a mounted directory's entry point
// with require() resolving inside the mount, a provider registered by either a
// -r (CJS) or an --import (ESM) preload backing a non-directory source, a ZIP
// archive claimed by the built-in provider, a worker inheriting the mounts, and
// rejecting --vfs-load without a --vfs-mount.
//
// Native addon loading from a mount is not exercised here (it needs a compiled
// .node), only the startup wiring around it.

require('../common');
const tmpdir = require('../common/tmpdir');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawnSync } = require('child_process');

tmpdir.refresh();
let id = 0;
function fixture(name) { return path.join(tmpdir.path, `${id++}-${name}`); }

function run(args) {
  return spawnSync(process.execPath, ['--experimental-vfs', ...args], { encoding: 'utf8' });
}

// Node.js can be built without NODE_OPTIONS support, in which case the
// environment cannot carry a flag at all and there is nothing to assert.
const hasNodeOptions = !process.config.variables.node_without_node_options;

// A directory source: the entry point runs and require() resolves inside it.
{
  const dir = fixture('app');
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.js'),
                   "console.log(require('./lib/greet')());\n");
  fs.writeFileSync(path.join(dir, 'lib', 'greet.js'),
                   "module.exports = () => 'hello from inside the mount';\n");
  const res = run(['--vfs-load', `--vfs-mount=${dir}`]);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.match(res.stdout, /hello from inside the mount/);
}

// A provider registered by a -r (CommonJS) preload backs a custom file format.
{
  const providerModule = fixture('provider.js');
  fs.writeFileSync(providerModule, `
'use strict';
const fs = require('fs');
const vfs = require('node:vfs');
const MAGIC = Buffer.from('CUSTOMFMT');
vfs.registerProvider({
  name: 'customfmt',
  canHandle(p, stats) {
    if (!stats.isFile()) return false;
    const fd = fs.openSync(p, 'r');
    try {
      const buf = Buffer.alloc(MAGIC.length);
      fs.readSync(fd, buf, 0, MAGIC.length, 0);
      return buf.equals(MAGIC);
    } finally { fs.closeSync(fd); }
  },
  create(p) {
    const body = fs.readFileSync(p).subarray(MAGIC.length).toString('utf8');
    const provider = new vfs.MemoryProvider();
    provider.writeFileSync('/index.js', body);
    return provider;
  },
});
`);
  const target = fixture('app.customfmt');
  fs.writeFileSync(target, Buffer.concat([
    Buffer.from('CUSTOMFMT'),
    Buffer.from("console.log('hello from custom provider');"),
  ]));
  const res = run(['-r', providerModule, '--vfs-load', `--vfs-mount=${target}`]);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.match(res.stdout, /hello from custom provider/);
}

// A provider registered by an --import (ES module) preload: this only works
// because mounting is deferred until after the --import loop has run.
{
  const providerModule = fixture('provider.mjs');
  fs.writeFileSync(providerModule, `
import fs from 'node:fs';
import { registerProvider, MemoryProvider } from 'node:vfs';
const MAGIC = Buffer.from('ESMFMT');
registerProvider({
  name: 'esmfmt',
  canHandle(p, stats) {
    if (!stats.isFile()) return false;
    return fs.readFileSync(p).subarray(0, MAGIC.length).equals(MAGIC);
  },
  create(p) {
    const body = fs.readFileSync(p).subarray(MAGIC.length).toString('utf8');
    const provider = new MemoryProvider();
    provider.writeFileSync('/index.js', body);
    return provider;
  },
});
`);
  const target = fixture('app.esmfmt');
  fs.writeFileSync(target, Buffer.concat([
    Buffer.from('ESMFMT'),
    Buffer.from("console.log('hello from ESM-imported provider');"),
  ]));
  const res = run([
    '--import', pathToFileURL(providerModule).href,
    '--vfs-load', `--vfs-mount=${target}`,
  ]);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.match(res.stdout, /hello from ESM-imported provider/);
}

// A ZIP archive is claimed by the built-in provider (detected by opening it,
// not by extension).
{
  const zlib = require('zlib');
  const zipPath = fixture('app.zip');
  const entry = zlib.ZipEntry.createSync(
    'index.js', Buffer.from("console.log('hello from zip archive');"));
  const chunks = [];
  for (const chunk of zlib.createZipArchiveSync([entry])) chunks.push(chunk);
  fs.writeFileSync(zipPath, Buffer.concat(chunks));
  const res = run(['--vfs-load', `--vfs-mount=${zipPath}`]);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.match(res.stdout, /hello from zip archive/);
}

// A worker inherits --vfs-mount, so a worker script that lives inside the mount
// (addressed here via the entry's own __dirname) resolves and runs.
{
  const dir = fixture('worker-app');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.js'), `
'use strict';
const path = require('path');
const { Worker } = require('worker_threads');
const w = new Worker(path.join(__dirname, 'worker.js'));
w.on('message', (m) => { console.log(m); process.exit(0); });
w.on('error', (e) => { console.error(e); process.exit(1); });
`);
  fs.writeFileSync(path.join(dir, 'worker.js'), `
'use strict';
require('worker_threads').parentPort.postMessage('hello from worker in mount');
`);
  const res = run(['--vfs-load', `--vfs-mount=${dir}`]);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.match(res.stdout, /hello from worker in mount/);
}

// --vfs-load requires a --vfs-mount to load from.
{
  const res = run(['--vfs-load']);
  assert.notStrictEqual(res.status, 0);
  assert.match(res.stderr, /--vfs-load requires at least one --vfs-mount/);
}

// --vfs-load[=index] selects which mount the entry point comes from. Two
// mounts whose entries are distinguishable pin down which one ran.
{
  const first = fixture('first');
  const second = fixture('second');
  for (const [dir, name] of [[first, 'first'], [second, 'second']]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.js'), `console.log('entry:${name}');\n`);
  }
  const mounts = [`--vfs-mount=${first}`, `--vfs-mount=${second}`];

  // Bare --vfs-load defaults to index 0, the first mount.
  const bare = run(['--vfs-load', ...mounts]);
  assert.strictEqual(bare.status, 0, bare.stderr);
  assert.match(bare.stdout, /entry:first/);

  // An explicit index selects that mount, in either order relative to mounts.
  for (const args of [['--vfs-load=1', ...mounts], [...mounts, '--vfs-load=1']]) {
    const res = run(args);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /entry:second/);
  }

  const zero = run([...mounts, '--vfs-load=0']);
  assert.strictEqual(zero.status, 0, zero.stderr);
  assert.match(zero.stdout, /entry:first/);

  // An index past the last --vfs-mount is rejected rather than silently
  // falling back to a mount that was given.
  const outOfRange = run([...mounts, '--vfs-load=2']);
  assert.notStrictEqual(outOfRange.status, 0);
  assert.match(outOfRange.stderr, /--vfs-load index is out of range/);

  // The index is meaningless without --vfs-load, so asking for one is an error
  // rather than a silently ignored flag.
  const indexAlone = run([...mounts, '--vfs-load-index=1']);
  assert.notStrictEqual(indexAlone.status, 0);
  assert.match(indexAlone.stderr, /--vfs-load-index requires --vfs-load/);
}

// --vfs-load picks the entry point, so it is refused in NODE_OPTIONS: the
// environment must not be able to redirect what a `node <args>` run executes.
// Everything but the flag under test is passed on the command line, so a build
// that ignores NODE_OPTIONS cannot make this pass for the wrong reason.
if (hasNodeOptions) {
  const dir = fixture('env-refused');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.js'), 'console.log("ran");\n');

  for (const flag of ['--vfs-load', '--vfs-load=0', '--vfs-load-index=0']) {
    const res = spawnSync(
      process.execPath,
      ['--experimental-vfs', `--vfs-mount=${dir}`],
      { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: flag } });
    assert.notStrictEqual(res.status, 0, `${flag} was accepted in NODE_OPTIONS`);
    assert.match(res.stderr, /is not allowed in NODE_OPTIONS/);
  }
}

// --experimental-vfs and --vfs-mount may arrive from different places. The
// options are validated once every source has been parsed, so a mount from
// NODE_OPTIONS is not rejected for an --experimental-vfs that only the command
// line carries.
if (hasNodeOptions) {
  const dir = fixture('env-mount-cli-flag');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.js'), 'console.log("ran");\n');

  const res = spawnSync(
    process.execPath, ['--experimental-vfs', '--vfs-load'],
    { encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: `--vfs-mount=${dir}` } });
  assert.strictEqual(res.status, 0, res.stderr);
  assert.match(res.stdout, /ran/);
}

// --vfs-mount is allowed in NODE_OPTIONS, but NODE_OPTIONS is parsed first, so
// its mounts are moved behind the command line's. The index therefore counts
// the mounts the invocation asked for, and the environment cannot change which
// mount --vfs-load runs; env mounts stay reachable at the higher indices.
if (hasNodeOptions) {
  const dirs = {};
  for (const name of ['envA', 'envB', 'cliX', 'cliY']) {
    dirs[name] = fixture(name);
    fs.mkdirSync(dirs[name], { recursive: true });
    fs.writeFileSync(path.join(dirs[name], 'index.js'),
                     `console.log('ran:${name}');\n`);
  }
  const withEnvMounts = (args) => spawnSync(
    process.execPath, ['--experimental-vfs', ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_OPTIONS: `--vfs-mount=${dirs.envA} --vfs-mount=${dirs.envB}`,
      },
    });
  const cliMounts = [`--vfs-mount=${dirs.cliX}`, `--vfs-mount=${dirs.cliY}`];

  for (const [flag, expected] of [
    ['--vfs-load', 'cliX'],   // Default index 0 is the first command-line mount
    ['--vfs-load=1', 'cliY'],
    ['--vfs-load=2', 'envA'], // Env mounts follow, in the order given
    ['--vfs-load=3', 'envB'],
  ]) {
    const res = withEnvMounts([...cliMounts, flag]);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, new RegExp(`ran:${expected}`));
  }

  // With no command-line mount there is nothing to put in front, so an
  // environment mount is still what index 0 selects.
  const envOnly = withEnvMounts(['--vfs-load']);
  assert.strictEqual(envOnly.status, 0, envOnly.stderr);
  assert.match(envOnly.stdout, /ran:envA/);
}

// Under --vfs-load the entry point comes from the mount, so no positional
// argument is consumed as one: every positional reaches the program verbatim
// from argv[2] onward, and argv[1] reports the mounted source.
{
  const dir = fixture('argv-app');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.js'),
                   'console.log(JSON.stringify(process.argv.slice(1)));\n');

  for (const extra of [[], ['alpha'], ['alpha', 'beta']]) {
    const res = run(['--vfs-load', `--vfs-mount=${dir}`, ...extra]);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.deepStrictEqual(JSON.parse(res.stdout), [dir, ...extra]);
  }

  // A path-like argument must not be resolved against the real file system the
  // way a genuine entry-point argument would be.
  const res = run(['--vfs-load', `--vfs-mount=${dir}`, './not/an/entry.js']);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.deepStrictEqual(JSON.parse(res.stdout), [dir, './not/an/entry.js']);
}
