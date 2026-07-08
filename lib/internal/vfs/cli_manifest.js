'use strict';

// When --vfs-manifest=<file> is active alongside a directory-backed --vfs
// mount, every file actually read through that mount during this run -
// whether by module resolution or by the running program's own node:fs
// calls (e.g. fs.readFile(`${__dirname}/data.txt`) is a completely ordinary
// pattern, not just requires/imports) - has its VFS-relative path appended,
// one per line, to <file> as soon as it's read, rather than buffered and
// flushed at exit: that way nothing is lost if the process is killed rather
// than exiting normally. Since worker threads share the real filesystem
// with the main thread (they're threads, not separate processes), every
// worker just appends to that very same file directly - O_APPEND writes
// don't interleave/overwrite each other across threads (or processes), so
// no cross-thread coordination is needed beyond that.
//
// This hooks internal/vfs/provider.js's kReadObserver slot rather than
// patching any method: readFile()/readFileSync() are the one place every
// read converges (module loader or direct node:fs calls alike, since both
// route through the same provider), so checking there - once, from code
// that already runs on every read - is enough on its own.

const {
  RegExpPrototypeSymbolReplace,
  SafeSet,
} = primordials;

const { kReadObserver } = require('internal/vfs/provider');

const kLeadingSlashRE = /^\/+/;

/**
 * @param {import('internal/vfs/provider').VirtualProvider} provider The
 *   provider backing the --vfs mount (a RealFSProvider, always, since
 *   --vfs-manifest requires a directory target).
 * @param {string} resolvedTarget The resolved --vfs directory target (used
 *   only for the error message below).
 * @param {boolean} isDirectory Whether resolvedTarget is a directory -
 *   already known by the caller (setupVfsMount()), which classified it to
 *   pick a provider in the first place.
 * @param {string} manifestPath The resolved --vfs-manifest output path.
 */
function startCliVfsManifest(provider, resolvedTarget, isDirectory, manifestPath) {
  if (!isDirectory) {
    const {
      codes: {
        ERR_VFS_MANIFEST_REQUIRES_DIRECTORY,
      },
    } = require('internal/errors');
    throw new ERR_VFS_MANIFEST_REQUIRES_DIRECTORY(resolvedTarget);
  }

  const fs = require('fs');
  if (internalBinding('worker').isMainThread) {
    // Only the real main thread starts a fresh manifest; a worker thread
    // appends to whatever the main thread (or an earlier-started worker)
    // already wrote, rather than wiping it out mid-run. Safe without extra
    // coordination: a worker can only be spawned by code running after its
    // spawner's own bootstrap (and thus this truncation) has completed.
    fs.writeFileSync(manifestPath, '');
  }

  const seenHere = new SafeSet();
  provider[kReadObserver] = (providerPath) => {
    try {
      const relative = RegExpPrototypeSymbolReplace(kLeadingSlashRE, providerPath, '');
      if (relative === '' || seenHere.has(relative)) return;
      seenHere.add(relative);
      fs.appendFileSync(manifestPath, relative + '\n');
    } catch {
      // Best effort: never let this bookkeeping break the actual read that
      // triggered it.
    }
  };
}

module.exports = {
  startCliVfsManifest,
};
