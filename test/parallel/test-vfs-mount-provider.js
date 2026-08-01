'use strict';

// Exercises custom --vfs-mount providers registered via node:vfs's
// registerProvider() from a `-r` preload. A plain entry script reads a file
// from the mount to observe which provider backed it:
//   1. a custom provider backs a --vfs-mount of its own file format,
//   2. the built-in ZIP provider recognizes a ZIP by its bytes, not its name,
//   3. a custom provider is tried before the built-ins (precedence), and
//   4. a custom provider can claim a directory, overriding RealFSProvider.

const common = require('../common');
const tmpdir = require('../common/tmpdir');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

tmpdir.refresh();
let id = 0;
function fixture(name) { return path.join(tmpdir.path, `${id++}-${name}`); }

async function zipFromTree(files, dest) {
  const entries = [];
  for (const { 0: name, 1: content } of Object.entries(files)) {
    entries.push(await zlib.ZipEntry.create(name, Buffer.from(content)));
  }
  const chunks = [];
  for await (const chunk of zlib.createZipArchive(entries)) chunks.push(chunk);
  fs.writeFileSync(dest, Buffer.concat(chunks));
}

// A -r preload registering a provider for a "CUSTOMFMT" file format that
// serves a data.txt made from the bytes after the magic.
const customProvider = fixture('custom-provider.js');
fs.writeFileSync(customProvider, `
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
    provider.writeFileSync('/data.txt', body);
    return provider;
  },
});
`);

// A -r preload whose provider claims every source (proves precedence).
const greedyProvider = fixture('greedy-provider.js');
fs.writeFileSync(greedyProvider, `
'use strict';
const vfs = require('node:vfs');
vfs.registerProvider({
  name: 'greedy',
  canHandle() { return true; },
  create() {
    const provider = new vfs.MemoryProvider();
    provider.writeFileSync('/data.txt', 'greedy provider won');
    return provider;
  },
});
`);

// A -r preload whose provider claims directories (overrides RealFSProvider).
const dirProvider = fixture('dir-provider.js');
fs.writeFileSync(dirProvider, `
'use strict';
const vfs = require('node:vfs');
vfs.registerProvider({
  name: 'dir-override',
  canHandle(p, stats) { return stats.isDirectory(); },
  create() {
    const provider = new vfs.MemoryProvider();
    provider.writeFileSync('/data.txt', 'custom dir provider won');
    return provider;
  },
});
`);

// Writes a plain entry script that prints `<mountPoint>/data.txt`.
function consumerFor(mountPoint) {
  const script = fixture('consumer.js');
  fs.writeFileSync(script,
                   `const fs = require('fs');\n` +
                   `console.log(fs.readFileSync(${JSON.stringify(mountPoint)} + '/data.txt', 'utf8'));\n`);
  return script;
}

function run(args) {
  return spawnSync(process.execPath, ['--experimental-vfs', ...args], { encoding: 'utf8' });
}

(async () => {
  // 1. A custom file-format provider backs a --vfs-mount of its own format.
  {
    const target = fixture('app.customfmt');
    fs.writeFileSync(target, Buffer.concat([
      Buffer.from('CUSTOMFMT'), Buffer.from('hello from custom provider'),
    ]));
    const res = run(['-r', customProvider, `--vfs-mount=${target}`, consumerFor(target)]);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /hello from custom provider/);
  }

  // 2. The built-in ZIP provider recognizes a ZIP by its bytes (named .bundle).
  {
    const target = fixture('app.bundle');
    await zipFromTree({ 'data.txt': 'hello from bundled zip' }, target);
    const res = run([`--vfs-mount=${target}`, consumerFor(target)]);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /hello from bundled zip/);
  }

  // 3. A custom provider wins over the built-in ZIP provider for a real ZIP.
  {
    const target = fixture('real.zip');
    await zipFromTree({ 'data.txt': 'built-in zip content' }, target);
    const res = run(['-r', greedyProvider, `--vfs-mount=${target}`, consumerFor(target)]);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /greedy provider won/);
    assert.doesNotMatch(res.stdout, /built-in zip content/);
  }

  // 4. A custom provider can claim a directory, overriding RealFSProvider.
  {
    const dir = fixture('a-real-dir');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'data.txt'), 'real dir content');
    const res = run(['-r', dirProvider, `--vfs-mount=${dir}`, consumerFor(dir)]);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /custom dir provider won/);
    assert.doesNotMatch(res.stdout, /real dir content/);
  }
})().then(common.mustCall());
