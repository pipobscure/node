'use strict';

// Selection registry for the provider that backs a `--vfs-mount` source (a
// directory or an archive). This is distinct from the registry of *mounted*
// VFS instances (in internal/vfs/setup.js); this module answers the earlier
// question of *which provider* should back a given source.
//
// A provider claims a source by inspecting its stats and (for archives) its
// contents, never its extension, so an archive can carry any name
// (my-archive.bundle, app.jar, ...). Third-party providers - typically
// registered from a `-r` or `--import` preload via node:vfs's
// registerProvider() - are consulted before the built-ins (the directory
// RealFSProvider and the archive ZipProvider), so they can back, wrap, or vet
// any mount.

const {
  ArrayPrototypeUnshift,
  MathMin,
  StringPrototypeEndsWith,
  StringPrototypeToLowerCase,
} = primordials;

const { Buffer } = require('buffer');
const {
  validateFunction,
  validateObject,
  validateString,
} = require('internal/validators');

// An "End Of Central Directory" (EOCD) record: signature PK\x05\x06, a 22-byte
// fixed part, then an up-to-65535-byte trailing comment.
const EOCD_SIGNATURE = 0x06054b50; // 'PK\x05\x06', little-endian
const EOCD_MIN_SIZE = 22;
const ZIP_MAX_COMMENT = 0xffff;

// Whether `resolvedPath` is a ZIP archive. A ZIP is *defined* by its EOCD
// record near the end of the file, not by any leading bytes: the archive may
// be prefixed by arbitrary data (a shebang line, a self-extractor stub, ...),
// so a prefixed archive need not start with the `PK` local-header signature.
// Locate the archive the way a ZIP reader does - scan back from EOF for an
// EOCD signature whose comment-length field lands exactly on EOF - reading
// only the tail rather than the whole file.
function looksLikeZip(resolvedPath) {
  const fs = require('fs');
  const fd = fs.openSync(resolvedPath, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    if (size < EOCD_MIN_SIZE) return false;
    const readLen = MathMin(size, EOCD_MIN_SIZE + ZIP_MAX_COMMENT);
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, size - readLen);
    for (let i = readLen - EOCD_MIN_SIZE; i >= 0; i--) {
      if (buf.readUInt32LE(i) === EOCD_SIGNATURE &&
          i + EOCD_MIN_SIZE + buf.readUInt16LE(i + 20) === readLen) {
        return true;
      }
    }
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

// The built-ins are kept last so a registered provider that also claims a
// source wins - including for a directory, which lets a custom provider wrap
// or vet the default RealFSProvider (e.g. to record reads). Their require()s
// are deferred to create() so the machinery stays off the startup path until a
// mount actually needs it.
const providers = [
  {
    name: 'dir',
    canHandle(resolvedPath, stats) { return stats.isDirectory(); },
    create(resolvedPath) {
      const { RealFSProvider } = require('internal/vfs/providers/real');
      return new RealFSProvider(resolvedPath);
    },
  },
  {
    name: 'zip',
    canHandle(resolvedPath, stats) {
      if (!stats.isFile()) return false;
      // Fast path: a `.zip` name is taken at face value, skipping the read. A
      // ZIP under any other name still gets recognized by sniffing its bytes.
      if (StringPrototypeEndsWith(StringPrototypeToLowerCase(resolvedPath), '.zip')) {
        return true;
      }
      return looksLikeZip(resolvedPath);
    },
    create(resolvedPath) {
      const { ZipProvider } = require('internal/vfs/providers/ziparchive');
      const { ZipFile } = require('internal/zip');
      return new ZipProvider(ZipFile.openSync(resolvedPath));
    },
  },
];

/**
 * Registers a provider that `--vfs-mount` can select for a source (a directory
 * or an archive) it recognizes. The newest registration is consulted first,
 * and all registered providers outrank the built-ins (the directory
 * RealFSProvider and the archive ZipProvider), so a custom provider can back,
 * wrap, or vet any mount.
 * @param {object} entry
 * @param {string} entry.name A short identifier, used in diagnostics.
 * @param {(resolvedPath: string, stats: object) => boolean} entry.canHandle
 *   Returns `true` if this provider should back `resolvedPath`. Prefer
 *   inspecting the stats and (for archives) the contents over the file name.
 * @param {(resolvedPath: string, stats: object) => object} entry.create
 *   Returns the VirtualProvider backing `resolvedPath`.
 */
function registerProvider(entry) {
  validateObject(entry, 'entry');
  validateString(entry.name, 'entry.name');
  validateFunction(entry.canHandle, 'entry.canHandle');
  validateFunction(entry.create, 'entry.create');
  ArrayPrototypeUnshift(providers, {
    name: entry.name,
    canHandle: entry.canHandle,
    create: entry.create,
  });
}

/**
 * Returns a provider for `resolvedPath`, or `null` if none claims it.
 * @param {string} resolvedPath
 * @param {object} stats The `fs.statSync()` result for `resolvedPath`.
 * @returns {object | null}
 */
function selectProvider(resolvedPath, stats) {
  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i];
    if (provider.canHandle(resolvedPath, stats)) {
      return provider.create(resolvedPath, stats);
    }
  }
  return null;
}

module.exports = {
  registerProvider,
  selectProvider,
};
