// Flags: --experimental-vfs
'use strict';

// Regression test: module resolution (require()/createRequire()) must work
// through *any* mounted VFS - not just one mounted via the --vfs CLI flag.
// internal/modules/vfs_resolution.js's native-bypass replacements
// (internalModuleStat, package.json reading, legacyMainResolve, ...) look up
// the active mount via internal/vfs/setup.js's general activeVFSList, the
// same registry any vfs.mount() call - CLI-driven or plain userland code -
// registers with. Before this, they only recognized the CLI's own mount,
// so requiring a file out of a programmatically-mounted VFS (the pattern a
// single-executable-application bootstrap script uses: mount an embedded
// ZipBuffer, then createRequire() into it) would fail with MODULE_NOT_FOUND
// even though plain fs.readFileSync() against the same path worked fine.

const common = require('../common');
const tmpdir = require('../common/tmpdir');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { createRequire } = require('module');
const vfs = require('node:vfs');

tmpdir.refresh();

// -- archive-backed, mounted programmatically (no --vfs flag involved) ----

(async () => {
  const entries = [
    await zlib.ZipEntry.create('app.js',
                               Buffer.from("module.exports = require('./lib/helper.js').greet();")),
    await zlib.ZipEntry.create('lib/helper.js',
                               Buffer.from("module.exports = { greet: () => 'hi from zip' };")),
  ];
  const chunks = [];
  for await (const chunk of zlib.createZipArchive(entries)) chunks.push(chunk);
  const archive = Buffer.concat(chunks);

  const zip = new zlib.ZipBuffer(archive);
  const provider = new vfs.ZipProvider(zip);
  const myVfs = vfs.create(provider);
  myVfs.mount('/zip-app');

  // Plain fs calls already worked before this fix; confirm they still do.
  assert.strictEqual(fs.existsSync('/zip-app/app.js'), true);

  // The actual regression: require() through the same mount.
  const result = createRequire('/zip-app/_.js')('./app.js');
  assert.strictEqual(result, 'hi from zip');

  myVfs.unmount();
})().then(common.mustCall());

// -- directory-backed, mounted programmatically ----------------------------

{
  const dir = path.join(tmpdir.path, 'dir-app');
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'app.js'),
                   "module.exports = require('./lib/helper.js').greet();");
  fs.writeFileSync(path.join(dir, 'lib', 'helper.js'),
                   "module.exports = { greet: () => 'hi from dir' };");

  const provider = new vfs.RealFSProvider(dir);
  const myVfs = vfs.create(provider);
  myVfs.mount('/dir-app');

  const result = createRequire('/dir-app/_.js')('./app.js');
  assert.strictEqual(result, 'hi from dir');

  myVfs.unmount();
}
