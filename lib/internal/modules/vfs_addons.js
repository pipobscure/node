'use strict';

// Native addon ('.node' file) loading for a path inside an active VFS
// mount (whether mounted via the --vfs CLI flag or from plain userland
// code - internal/vfs/setup.js's activeVFSList covers both the same way).
// `dlopen()` needs a real path on disk - there's nothing to intercept at
// the fs-module level for that - so:
//  - a directory-backed mount (RealFSProvider) already has a real
//    underlying file; translate the virtual path back to it and dlopen
//    that directly, no copying needed.
//  - an archive-backed mount (ZipProvider) has no real backing file;
//    extract the entry's bytes to a real temp file named by content hash
//    (so repeated loads of the same addon within this process reuse the
//    same extraction instead of re-extracting) and dlopen that instead.
//    Each process gets its own pid-scoped temp directory - sharing one
//    across processes would let one process delete or overwrite a file
//    another process still has mapped. Extracted files are best-effort
//    removed when the process exits.

const {
  SafeSet,
} = primordials;

const { createHash } = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findVFSForPath } = require('internal/vfs/setup');

const extractedAddons = new SafeSet();
let cleanupRegistered = false;

function registerCleanup() {
  if (cleanupRegistered) { return; }
  cleanupRegistered = true;
  process.once('exit', () => {
    for (const extractedPath of extractedAddons) {
      try {
        fs.unlinkSync(extractedPath);
      } catch {
        // Best effort: the file may still be mapped (Windows keeps loaded
        // DLLs locked).
      }
    }
  });
}

/**
 * Extracts a VFS-internal addon to a real, content-hashed temp file (or
 * reuses one already extracted with the same content) and returns its path.
 * @param {import('internal/vfs/file_system').VirtualFileSystem} vfs
 * @param {string} vfsPath
 * @returns {string}
 */
function extractAddon(vfs, vfsPath) {
  const content = vfs.readFileSync(vfsPath);
  const hash = createHash('sha256').update(content).digest('hex');
  const dir = path.join(os.tmpdir(), `node-vfs-addons-${process.pid}`);
  const dest = path.join(dir, `${hash}.node`);

  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dir, { recursive: true });
    const tmpDest = `${dest}.${process.pid}.tmp`;
    fs.writeFileSync(tmpDest, content);
    try {
      fs.renameSync(tmpDest, dest);
    } catch (err) {
      // Another thread in this process (e.g. a worker_thread, which shares
      // our pid and thus our temp directory) extracting the same content
      // may have won the race; that's fine as long as the destination
      // exists now.
      try {
        fs.unlinkSync(tmpDest);
      } catch {
        // Ignore: best-effort cleanup of our own losing-race temp file.
      }
      if (!fs.existsSync(dest)) { throw err; }
    }
  }

  extractedAddons.add(dest);
  registerCleanup();
  return dest;
}

/**
 * Resolves the real, on-disk path to `dlopen()` for a native addon whose
 * virtual path is under an active VFS mount.
 * @param {string} vfsPath
 * @returns {string | null} The real path to dlopen, or null if `vfsPath` is
 *   not under an active VFS mount (the caller should dlopen it unchanged).
 */
function resolveAddonRealPath(vfsPath) {
  const found = findVFSForPath(vfsPath);
  if (found === null) { return null; }
  const { vfs, normalized } = found;
  const provider = vfs.provider;
  if (typeof provider.toRealPath === 'function') {
    return provider.toRealPath(vfs.toProviderPath(normalized));
  }
  return extractAddon(vfs, normalized);
}

module.exports = {
  resolveAddonRealPath,
};
