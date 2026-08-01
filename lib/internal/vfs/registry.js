'use strict';

// The registry of currently-mounted virtual file systems, kept in this tiny,
// dependency-light module on purpose. The module-resolution fast path
// (internal/modules/vfs_resolution, run on every stat()/package.json read)
// only needs to answer "is this path under a mount?" - almost always "no" -
// and must do so without dragging in the full internal/vfs machinery
// (setup/fd/errors/providers). That machinery is loaded only when a VFS is
// actually mounted, which is what pushes into `activeVFSList` here. Keeping
// this off the universal startup path also keeps it out of the startup
// snapshot (see test/parallel/test-bootstrap-modules.js).

const {
  ArrayPrototypeIndexOf,
  ArrayPrototypePush,
  ArrayPrototypeSplice,
} = primordials;

const { resolve } = require('path');

const activeVFSList = [];

function addVFS(vfs) {
  ArrayPrototypePush(activeVFSList, vfs);
}

function removeVFS(vfs) {
  const index = ArrayPrototypeIndexOf(activeVFSList, vfs);
  if (index === -1) return false;
  ArrayPrototypeSplice(activeVFSList, index, 1);
  return true;
}

// The VFS that should handle `filename`, plus its resolved path, or null.
// Fast: with no mounts (the common case) it returns before resolving anything.
function findVFSForPath(filename) {
  if (activeVFSList.length === 0) return null;
  const normalized = resolve(filename);
  for (let i = 0; i < activeVFSList.length; i++) {
    const vfs = activeVFSList[i];
    if (vfs.shouldHandle(normalized)) {
      return { vfs, normalized };
    }
  }
  return null;
}

// Like findVFSForPath, but also reports whether the entry exists in the mount.
function findVFSForExists(filename) {
  if (activeVFSList.length === 0) return null;
  const normalized = resolve(filename);
  for (let i = 0; i < activeVFSList.length; i++) {
    const vfs = activeVFSList[i];
    if (vfs.shouldHandle(normalized)) {
      return { vfs, exists: vfs.existsSync(normalized) };
    }
  }
  return null;
}

module.exports = {
  activeVFSList,
  addVFS,
  removeVFS,
  findVFSForPath,
  findVFSForExists,
};
