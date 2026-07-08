'use strict';

// The CJS/ESM loader mostly resolves and reads files through the public
// `fs` module, which any active VFS mount (internal/vfs/setup.js's
// activeVFSList, populated by every vfs.mount() call - whether from the
// --vfs CLI flag or from plain userland code) already redirects for any
// path under that mount. But a handful of module-resolution primitives
// bypass `fs` entirely and call straight into
// internalBinding('fs')/internalBinding('modules'), hitting the real
// filesystem no matter what's mounted. This file provides VFS-aware
// replacements for exactly those primitives, each matching the native
// function's contract precisely: when the given path is under an active
// VFS mount, do the equivalent work against that VirtualFileSystem
// (bounded at the mount's own root - never falling through past it into the
// real, unmounted parent directory); otherwise call the real native
// binding, unchanged.

const {
  ArrayIsArray,
  JSONParse,
  JSONStringify,
  StringPrototypeEndsWith,
} = primordials;

const { Buffer } = require('buffer');
const path = require('path');
const {
  codes: {
    ERR_INVALID_PACKAGE_CONFIG,
  },
} = require('internal/errors');
const { findVFSForPath } = require('internal/vfs/setup');

const internalFsBinding = internalBinding('fs');
const modulesBinding = internalBinding('modules');
const { internal: internalConstants } = internalBinding('constants');

/**
 * VFS-aware replacement for internalBinding('fs').internalModuleStat: -2
 * (not found/error), 0 (file), or 1 (directory) - callers only ever check
 * `>= 0` vs not, so any error collapses to -2 like a plain ENOENT would.
 * @param {string} filename
 * @returns {number}
 */
function internalModuleStat(filename) {
  const found = findVFSForPath(filename);
  if (found === null) { return internalFsBinding.internalModuleStat(filename); }
  try {
    return found.vfs.statSync(found.normalized).isDirectory() ? 1 : 0;
  } catch {
    return -2;
  }
}

/**
 * Reads and minimally parses a package.json at an exact path, matching the
 * shape `src/node_modules.cc`'s `PackageConfig::Serialize` produces:
 * `[name, main, type, imports, exports, filePath]`, or `undefined` if the
 * file doesn't exist. `imports`/`exports` are re-serialized to a JSON string
 * when they're objects/arrays, exactly like the native reader, so
 * `package_json_reader.js`'s existing lazy-parse-on-access getters keep
 * working unchanged.
 * @param {import('internal/vfs/file_system').VirtualFileSystem} vfs
 * @param {string} jsonPath
 * @returns {Array | undefined}
 */
function readPackageJSONFile(vfs, jsonPath) {
  let raw;
  try {
    raw = vfs.readFileSync(jsonPath, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') { return undefined; }
    throw err;
  }
  let parsed;
  try {
    parsed = JSONParse(raw);
  } catch (err) {
    throw new ERR_INVALID_PACKAGE_CONFIG(jsonPath, undefined, err.message);
  }
  if (parsed === null || typeof parsed !== 'object' || ArrayIsArray(parsed)) {
    throw new ERR_INVALID_PACKAGE_CONFIG(jsonPath, undefined, 'not an object');
  }
  const name = typeof parsed.name === 'string' ? parsed.name : undefined;
  const main = typeof parsed.main === 'string' ? parsed.main : undefined;
  const type = parsed.type === 'commonjs' || parsed.type === 'module' ? parsed.type : 'none';
  const toRaw = (value) => {
    if (typeof value === 'string') { return value; }
    if (typeof value === 'object' && value !== null) { return JSONStringify(value); }
    return undefined;
  };
  const imports = toRaw(parsed.imports);
  const exports = toRaw(parsed.exports);
  return [name, main, type, imports, exports, jsonPath];
}

/**
 * VFS-aware replacement for internalBinding('modules').readPackageJSON:
 * reads one exact package.json path (no directory walking).
 * @param {string} jsonPath
 * @param {boolean} isESM
 * @param {string} [base]
 * @param {string} [specifier]
 * @returns {Array | undefined}
 */
function readPackageJSON(jsonPath, isESM, base, specifier) {
  const found = findVFSForPath(jsonPath);
  if (found === null) { return modulesBinding.readPackageJSON(jsonPath, isESM, base, specifier); }
  return readPackageJSONFile(found.vfs, found.normalized);
}

/**
 * Shared directory-climbing algorithm behind getNearestParentPackageJSON()/
 * getNearestParentPackageJSONType(): starting at the directory containing
 * `fromPath`, look for a package.json, then climb toward the mount's root -
 * stopping (not found) at a directory literally named node_modules, or the
 * moment climbing further would step outside the mount, whichever comes
 * first. Never falls through to the real parent directory above the mount.
 * @param {import('internal/vfs/file_system').VirtualFileSystem} vfs
 * @param {string} fromPath
 * @returns {Array | undefined}
 */
function findPackageJSONUpward(vfs, fromPath) {
  let dir = path.dirname(fromPath);
  while (true) {
    if (path.basename(dir) === 'node_modules') { return undefined; }
    const found = readPackageJSONFile(vfs, path.join(dir, 'package.json'));
    if (found !== undefined) { return found; }
    if (dir === vfs.mountPoint) { return undefined; }
    const parent = path.dirname(dir);
    if (parent === dir) { return undefined; }
    dir = parent;
  }
}

/**
 * VFS-aware replacement for
 * internalBinding('modules').getNearestParentPackageJSON.
 * @param {string} checkPath
 * @returns {Array | undefined}
 */
function getNearestParentPackageJSON(checkPath) {
  const found = findVFSForPath(checkPath);
  if (found === null) { return modulesBinding.getNearestParentPackageJSON(checkPath); }
  return findPackageJSONUpward(found.vfs, found.normalized);
}

/**
 * VFS-aware replacement for
 * internalBinding('modules').getNearestParentPackageJSONType.
 * @param {string} checkPath
 * @returns {string | undefined}
 */
function getNearestParentPackageJSONType(checkPath) {
  const found = findVFSForPath(checkPath);
  if (found === null) { return modulesBinding.getNearestParentPackageJSONType(checkPath); }
  const result = findPackageJSONUpward(found.vfs, found.normalized);
  return result === undefined ? undefined : result[2];
}

/**
 * Shared directory-climbing algorithm behind getPackageScopeConfig()/
 * getPackageType(): starting at the *same* directory as `resolvedPath`
 * itself (matching the native "./package.json"-relative-to-self behavior),
 * climb toward the mount root, stopping at a candidate that would live
 * directly inside a node_modules directory, or at the mount's own root.
 * @param {import('internal/vfs/file_system').VirtualFileSystem} vfs
 * @param {string} resolvedPath
 * @param {boolean} returnOnlyType
 * @returns {Array | string | undefined}
 */
function findPackageScopeConfig(vfs, resolvedPath, returnOnlyType) {
  const nodeModulesBoundary = path.join('node_modules', 'package.json');
  let dir = path.dirname(resolvedPath);
  while (true) {
    const candidate = path.join(dir, 'package.json');
    if (StringPrototypeEndsWith(candidate, nodeModulesBoundary)) { break; }
    const found = readPackageJSONFile(vfs, candidate);
    if (found !== undefined) { return returnOnlyType ? found[2] : found; }
    if (dir === vfs.mountPoint) { break; }
    const parent = path.dirname(dir);
    if (parent === dir) { break; }
    dir = parent;
  }
  return returnOnlyType ? undefined : path.join(dir, 'package.json');
}

/**
 * @param {string | URL} resolved
 * @returns {object | string}
 */
function getPackageScopeConfig(resolved) {
  const resolvedPath = `${resolved}`;
  const found = findVFSForPath(resolvedPath);
  if (found === null) { return modulesBinding.getPackageScopeConfig(resolvedPath); }
  return findPackageScopeConfig(found.vfs, found.normalized, false);
}

/**
 * @param {string | URL} url
 * @returns {string}
 */
function getPackageType(url) {
  const resolvedPath = `${url}`;
  const found = findVFSForPath(resolvedPath);
  if (found === null) { return modulesBinding.getPackageType(resolvedPath) ?? 'none'; }
  return findPackageScopeConfig(found.vfs, found.normalized, true) ?? 'none';
}

// Same order/semantics as esm/resolve.js's own legacyMainResolveExtensions -
// duplicated here (rather than imported) to avoid a dependency cycle between
// this file and the ESM resolver; both must stay in sync with
// src/node_file.cc's `legacy_main_extensions`.
const legacyMainExtensions = [
  '', '.js', '.json', '.node',
  '/index.js', '/index.json', '/index.node',
  '/index.js', '/index.json', '/index.node',
];
const kWithMainEnd = 7;

/**
 * VFS-aware replacement for internalBinding('fs').legacyMainResolve.
 * @param {string} packagePath
 * @param {string} [main]
 * @param {string} [base]
 * @returns {number | undefined}
 */
function legacyMainResolve(packagePath, main, base) {
  const found = findVFSForPath(packagePath);
  if (found === null) { return internalFsBinding.legacyMainResolve(packagePath, main, base); }
  const { vfs, normalized } = found;

  const isFile = (candidate) => {
    try {
      return !vfs.statSync(candidate).isDirectory();
    } catch {
      return false;
    }
  };

  if (typeof main === 'string') {
    const initial = path.resolve(normalized, main);
    for (let i = 0; i < kWithMainEnd; i++) {
      if (isFile(initial + legacyMainExtensions[i])) { return i; }
    }
  }

  const initial = path.resolve(normalized, './index');
  for (let i = kWithMainEnd; i < legacyMainExtensions.length; i++) {
    if (isFile(initial + legacyMainExtensions[i])) { return i; }
  }
  return undefined;
}

const WASM_MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d]);

/**
 * VFS-aware replacement for
 * internalBinding('fs').getFormatOfExtensionlessFile.
 * @param {string} filePath
 * @returns {number}
 */
function getFormatOfExtensionlessFile(filePath) {
  const found = findVFSForPath(filePath);
  if (found === null) { return internalFsBinding.getFormatOfExtensionlessFile(filePath); }
  try {
    const content = found.vfs.readFileSync(found.normalized);
    if (content.length >= 4 && content[0] === WASM_MAGIC[0] && content[1] === WASM_MAGIC[1] &&
        content[2] === WASM_MAGIC[2] && content[3] === WASM_MAGIC[3]) {
      return internalConstants.EXTENSIONLESS_FORMAT_WASM;
    }
  } catch {
    // Matches the native function's own fallback on open/read failure.
  }
  return internalConstants.EXTENSIONLESS_FORMAT_JAVASCRIPT;
}

module.exports = {
  internalModuleStat,
  readPackageJSON,
  getNearestParentPackageJSON,
  getNearestParentPackageJSONType,
  getPackageScopeConfig,
  getPackageType,
  legacyMainResolve,
  getFormatOfExtensionlessFile,
};
