// Flags: --expose-internals
'use strict';

// Unit-tests internal/modules/vfs_addons's resolveAddonRealPath() directly
// (rather than through an actual compiled native addon + --vfs child
// process, which this environment can't build): a directory-backed mount
// should resolve straight to the real underlying file, no copying; an
// archive-backed mount should extract to a content-hashed real temp file,
// reusing it on a repeated resolve of the same content.

const common = require('../common');
if (!common.hasCrypto) {
  common.skip('missing crypto');
}
const tmpdir = require('../common/tmpdir');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const { VirtualFileSystem } = require('internal/vfs/file_system');
const { RealFSProvider } = require('internal/vfs/providers/real');
const { ZipProvider } = require('internal/vfs/providers/archive');
const { resolveAddonRealPath } = require('internal/modules/vfs_addons');

tmpdir.refresh();

// -- directory-backed: returns the real underlying path, no extraction ----

{
  const dir = path.join(tmpdir.path, 'dir-mount');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'addon.node'), 'fake addon bytes');

  const provider = new RealFSProvider(dir);
  const vfs = new VirtualFileSystem(provider, { emitExperimentalWarning: false });
  vfs.mount(dir);

  const vfsPath = path.join(dir, 'addon.node');
  const realPath = resolveAddonRealPath(vfsPath);
  assert.strictEqual(realPath, path.join(dir, 'addon.node'));
  assert.strictEqual(fs.readFileSync(realPath, 'utf8'), 'fake addon bytes');

  // A path outside the mount is left for the caller to handle unchanged.
  assert.strictEqual(resolveAddonRealPath(path.join(tmpdir.path, 'elsewhere.node')), null);

  vfs.unmount();
}

// -- archive-backed: extracts to a content-hashed temp file ----------------

(async () => {
  const dir = path.join(tmpdir.path, 'zip-mount');
  fs.mkdirSync(dir, { recursive: true });
  const zipPath = path.join(dir, 'app.zip');
  const content = Buffer.from('fake addon bytes from zip');
  const entry = await zlib.ZipEntry.create('addon.node', content, { method: 'store' });
  const chunks = [];
  for await (const chunk of zlib.createZipArchive([entry])) chunks.push(chunk);
  fs.writeFileSync(zipPath, Buffer.concat(chunks));

  const zipFile = await zlib.ZipFile.open(zipPath);
  const provider = new ZipProvider(zipFile);
  const vfs = new VirtualFileSystem(provider, { emitExperimentalWarning: false });
  vfs.mount(zipPath);

  const vfsPath = path.join(zipPath, 'addon.node');
  const realPath = resolveAddonRealPath(vfsPath);

  const expectedHash = crypto.createHash('sha256').update(content).digest('hex');
  assert.strictEqual(path.basename(realPath), `${expectedHash}.node`);
  assert.strictEqual(fs.readFileSync(realPath, 'utf8'), 'fake addon bytes from zip');

  // Resolving the same content again reuses the same extracted file.
  assert.strictEqual(resolveAddonRealPath(vfsPath), realPath);

  vfs.unmount();
  await zipFile.close();
})().then(common.mustCall());
