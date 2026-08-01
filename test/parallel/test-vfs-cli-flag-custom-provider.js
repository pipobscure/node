'use strict';

// Exercises custom --vfs-mount providers registered via node:vfs's
// registerProvider(), from a `-r` (CJS) or `--import` (ESM) preload, end to
// end:
//   1. a preloaded custom provider backs a --vfs-mount of its own file format,
//   2. the built-in ZIP provider recognizes a ZIP by its bytes even when the
//      file is not named `.zip` (byte sniffing, not extension),
//   3. a custom provider is always tried before the built-in providers, so it
//      can claim (or vet) a file the built-in would otherwise handle,
//   4. a file no provider claims fails with a clear error,
//   5. a custom provider can claim a *directory*, overriding the built-in
//      RealFSProvider (the mechanism a read-recording provider would use), and
//   6. a provider registered from an --import (ESM) preload backs a --vfs-load
//      entry - i.e. mounting and entry resolution are deferred past --import.

const common = require('../common');
const tmpdir = require('../common/tmpdir');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pathToFileURL } = require('url');
const { spawnSync } = require('child_process');

tmpdir.refresh();
let fixtureId = 0;
function fixturePath(name) {
  return path.join(tmpdir.path, `${fixtureId++}-${name}`);
}

async function zipFromTree(files, dest) {
  const entries = [];
  for (const { 0: name, 1: content } of Object.entries(files)) {
    entries.push(await zlib.ZipEntry.create(name, Buffer.from(content)));
  }
  const chunks = [];
  for await (const chunk of zlib.createZipArchive(entries)) chunks.push(chunk);
  fs.writeFileSync(dest, Buffer.concat(chunks));
}

// A CJS preload that registers a provider for a toy "CUSTOMFMT" file format:
// the magic bytes followed by the JS source that becomes the mount's index.js.
const customProviderModule = fixturePath('custom-provider.js');
fs.writeFileSync(customProviderModule, `
'use strict';
const fs = require('fs');
const vfs = require('node:vfs');
const MAGIC = Buffer.from('CUSTOMFMT');

vfs.registerProvider({
  name: 'customfmt',
  canHandle(resolvedPath, stats) {
    if (!stats.isFile()) return false;
    const fd = fs.openSync(resolvedPath, 'r');
    try {
      const buf = Buffer.alloc(MAGIC.length);
      fs.readSync(fd, buf, 0, MAGIC.length, 0);
      return buf.equals(MAGIC);
    } finally {
      fs.closeSync(fd);
    }
  },
  create(resolvedPath) {
    const body = fs.readFileSync(resolvedPath).subarray(MAGIC.length).toString('utf8');
    const provider = new vfs.MemoryProvider();
    provider.writeFileSync('/index.js', body);
    return provider;
  },
});
`);

// A CJS preload whose provider claims *every* source - used to prove custom
// providers win over the built-ins even for a real ZIP.
const greedyProviderModule = fixturePath('greedy-provider.js');
fs.writeFileSync(greedyProviderModule, `
'use strict';
const vfs = require('node:vfs');
vfs.registerProvider({
  name: 'greedy',
  canHandle() { return true; },
  create() {
    const provider = new vfs.MemoryProvider();
    provider.writeFileSync('/index.js', "console.log('greedy provider won');");
    return provider;
  },
});
`);

// A CJS preload whose provider claims *directories*, overriding RealFSProvider.
const dirProviderModule = fixturePath('dir-provider.js');
fs.writeFileSync(dirProviderModule, `
'use strict';
const vfs = require('node:vfs');
vfs.registerProvider({
  name: 'dir-override',
  canHandle(resolvedPath, stats) { return stats.isDirectory(); },
  create() {
    const provider = new vfs.MemoryProvider();
    provider.writeFileSync('/index.js', "console.log('custom dir provider won');");
    return provider;
  },
});
`);

// An ESM preload (loaded via --import) that registers a provider serving an
// entry point. --import providers back a --vfs-load entry as well as data
// mounts: mounting - and, for --vfs-load, entry resolution - is deferred until
// after --import runs.
const esmProviderModule = fixturePath('esm-provider.mjs');
fs.writeFileSync(esmProviderModule, `
import vfs from 'node:vfs';
vfs.registerProvider({
  name: 'esmfmt',
  canHandle(resolvedPath, stats) {
    return stats.isFile() && resolvedPath.endsWith('.esmfmt');
  },
  create() {
    const provider = new vfs.MemoryProvider();
    provider.writeFileSync('/index.js', "console.log('esm provider won');");
    return provider;
  },
});
`);

function run(args) {
  return spawnSync(
    process.execPath,
    ['--experimental-vfs', ...args],
    { encoding: 'utf8' },
  );
}

(async () => {
  // 1. A preloaded custom provider backs a --vfs-mount of its own format.
  {
    const target = fixturePath('app.customfmt');
    fs.writeFileSync(target, Buffer.concat([
      Buffer.from('CUSTOMFMT'),
      Buffer.from("console.log('hello from custom provider');"),
    ]));
    const res = run(['-r', customProviderModule, '--vfs-load', `--vfs-mount=${target}`]);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /hello from custom provider/);
  }

  // 2. The built-in ZIP provider recognizes a ZIP by its bytes, not its name:
  //    a real ZIP archive named `.bundle` still mounts and runs.
  {
    const target = fixturePath('app.bundle');
    await zipFromTree({ 'index.js': "console.log('hello from bundled zip');" }, target);
    const res = run(['--vfs-load', `--vfs-mount=${target}`]);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /hello from bundled zip/);
  }

  // 3. A custom provider is tried before the built-ins: given a real ZIP, the
  //    greedy custom provider still wins.
  {
    const target = fixturePath('real.zip');
    await zipFromTree({ 'index.js': "console.log('built-in zip ran');" }, target);
    const res = run(['-r', greedyProviderModule, '--vfs-load', `--vfs-mount=${target}`]);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /greedy provider won/);
    assert.doesNotMatch(res.stdout, /built-in zip ran/);
  }

  // 4. A file no provider claims (not a ZIP, no custom provider) is rejected.
  {
    const target = fixturePath('mystery.bin');
    fs.writeFileSync(target, Buffer.from('not an archive of any known kind'));
    const res = run([`--vfs-mount=${target}`]);
    assert.notStrictEqual(res.status, 0);
    assert.match(res.stderr, /ERR_VFS_INVALID_TARGET/);
  }

  // 5. A custom provider can claim a directory, overriding RealFSProvider.
  {
    const dir = fixturePath('a-real-dir');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'index.js'), "console.log('real dir ran');");
    const res = run(['-r', dirProviderModule, '--vfs-load', `--vfs-mount=${dir}`]);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /custom dir provider won/);
    assert.doesNotMatch(res.stdout, /real dir ran/);
  }

  // 6. A provider registered from an --import (ESM) preload backs a --vfs-load
  //    entry: both mounting and entry resolution are deferred until after
  //    --import has run.
  {
    const target = fixturePath('app.esmfmt');
    fs.writeFileSync(target, 'ignored by the provider');
    const res = run([
      '--import', pathToFileURL(esmProviderModule).href,
      '--vfs-load', `--vfs-mount=${target}`,
    ]);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /esm provider won/);
  }
})().then(common.mustCall());
