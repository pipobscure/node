# Virtual File System

<!--introduced_in=v26.4.0-->

<!-- YAML
added: v26.4.0
-->

> Stability: 1 - Experimental

<!-- source_link=lib/vfs.js -->

The `node:vfs` module provides a virtual file system with a `node:fs`-like API.
It is useful for tests, fixtures, embedded assets, and other scenarios where you
need a self-contained file system without touching the actual file-system.

To access it:

```mjs
import vfs from 'node:vfs';
```

```cjs
const vfs = require('node:vfs');
```

This module is only available under the `node:` scheme, and only when Node.js
is started with the `--experimental-vfs` flag.

## Security

The VFS API is not a sandbox, permission system, or access-control mechanism.
It does not isolate untrusted code from the host file system or from other
Node.js capabilities. Code that can access a [`VirtualFileSystem`][] instance,
mount it, select its provider, or pass paths to it is trusted application code.

Mounting a VFS only redirects supported [`node:fs`][] calls whose resolved paths
are under the mount point. It does not prevent code from using other paths or
other Node.js APIs to access resources available to the process.
[`RealFSProvider`][] maps VFS paths under its configured root and rejects paths
that resolve outside that root, but that check is not a security boundary.
[`ZipProvider`][] has no real file-system paths of its own to escape; its
entries only ever exist within the archive's own namespace. Do not rely on VFS
to run untrusted code; use operating-system-level isolation, such as separate
users, containers, or platform sandboxes, when a security boundary is
required.

## Basic usage

```cjs
const vfs = require('node:vfs');

const myVfs = vfs.create();
myVfs.mkdirSync('/dir', { recursive: true });
myVfs.writeFileSync('/dir/hello.txt', 'Hello, VFS!');

console.log(myVfs.readFileSync('/dir/hello.txt', 'utf8')); // 'Hello, VFS!'
```

`vfs.create()` returns a [`VirtualFileSystem`][] instance backed by a
[`MemoryProvider`][] by default. The instance exposes synchronous,
callback-based, and promise-based file system methods that mirror the
shape of the [`node:fs`][] API. All paths are POSIX-style and absolute
(starting with `/`).

## `vfs.create([provider][, options])`

<!-- YAML
added: v26.4.0
-->

* `provider` {VirtualProvider} The provider to use. **Default:**
  `new MemoryProvider()`.
* `options` {Object}
  * `emitExperimentalWarning` {boolean} Whether to emit the experimental
    warning when the instance is created. **Default:** `true`.
* Returns: {VirtualFileSystem}

Convenience factory equivalent to `new VirtualFileSystem(provider, options)`.

```cjs
const vfs = require('node:vfs');

// Default in-memory provider
const memoryVfs = vfs.create();

// Explicit provider
const realVfs = vfs.create(new vfs.RealFSProvider('/tmp/vfs-root'));
```

## `vfs.registerProvider(entry)`

<!-- YAML
added: REPLACEME
-->

* `entry` {Object}
  * `name` {string} A short identifier for the provider, used in diagnostics.
  * `canHandle` {Function} `(resolvedPath, stats) => boolean`. Returns `true`
    if this provider should back `resolvedPath`. `stats` is the
    `fs.statSync()` result, so a provider can claim directories, files, or
    both. Prefer inspecting the stats and (for archives) the contents - for
    example, sniffing a magic-number signature - over trusting the file
    extension, so an archive can carry any name.
  * `create` {Function} `(resolvedPath, stats) => VirtualProvider`. Returns the
    provider that backs `resolvedPath`. Only ever called after `canHandle`
    returned `true` for the same path.

Registers a provider that the [`--vfs-mount`][] startup flag can select for a
mount source it recognizes. This is the extension point for supporting archive
formats beyond the built-in ZIP, or for wrapping the built-in directory and
ZIP providers: a module that implements, say, a 7-Zip provider registers it
here — typically from a module preloaded with [`--require`][], so it is in
place before `--vfs-mount` selects a provider:

```console
$ node --experimental-vfs -r @me/my-7z-provider --vfs-mount app.7z app.js
```

```cjs
// @me/my-7z-provider (the preloaded module)
const vfs = require('node:vfs');
const { SevenZipProvider } = require('./provider');

vfs.registerProvider({
  name: '7z',
  // Recognize by the 7-Zip signature, not the file name.
  canHandle(resolvedPath, stats) {
    if (!stats.isFile()) return false;
    const fd = require('fs').openSync(resolvedPath, 'r');
    try {
      const magic = Buffer.alloc(6);
      require('fs').readSync(fd, magic, 0, 6, 0);
      return magic.equals(Buffer.from([0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C]));
    } finally {
      require('fs').closeSync(fd);
    }
  },
  create(resolvedPath) { return new SevenZipProvider(resolvedPath); },
});
```

Selection rules for a `--vfs-mount` source:

* Registered providers are consulted first, in reverse registration order (the
  most recently registered wins), so a custom provider always takes precedence
  over the built-ins — even for a source they would otherwise handle. This lets
  a provider back, wrap, or vet any mount, including a directory (for example,
  a provider that wraps [`RealFSProvider`][], or one that verifies a signature
  before allowing use).
* If no registered provider claims the source, the built-ins handle it: a
  directory with [`RealFSProvider`][], and a file whose bytes are a ZIP archive
  with the built-in ZIP provider. A `.zip` name is accepted without reading the
  file, as a fast path; any other name is recognized by locating the archive's
  end-of-central-directory record.
* If no provider claims the source, `--vfs-mount` fails with
  `ERR_VFS_INVALID_TARGET`.

Registration is process-wide and affects only how the [`--vfs-mount`][] flag
chooses a provider; it does not change how [`vfs.create()`][] or
`new ZipProvider()` behave when a provider is passed explicitly.

## Class: `VirtualFileSystem`

<!-- YAML
added: v26.4.0
-->

A `VirtualFileSystem` wraps a [`VirtualProvider`][] and exposes a
`node:fs`-like API. Each instance maintains its own file tree.

### `new VirtualFileSystem([provider][, options])`

<!-- YAML
added: v26.4.0
-->

* `provider` {VirtualProvider} The provider to use. **Default:**
  `new MemoryProvider()`.
* `options` {Object}
  * `emitExperimentalWarning` {boolean} Whether to emit the experimental
    warning. **Default:** `true`.

### `vfs.provider`

<!-- YAML
added: v26.4.0
-->

* {VirtualProvider}

The provider backing this VFS instance.

### `vfs.readonly`

<!-- YAML
added: v26.4.0
-->

* {boolean}

`true` when the underlying provider is read-only.

### APIs

`VirtualFileSystem` implements the following methods, with the same
signatures as their [`node:fs`][] counterparts:

#### Synchronous API

* `existsSync(path)`
* `statSync(path[, options])`
* `lstatSync(path[, options])`
* `readFileSync(path[, options])`
* `writeFileSync(path, data[, options])`
* `appendFileSync(path, data[, options])`
* `readdirSync(path[, options])`
* `mkdirSync(path[, options])`
* `rmdirSync(path)`
* `unlinkSync(path)`
* `renameSync(oldPath, newPath)`
* `copyFileSync(src, dest[, mode])`
* `realpathSync(path[, options])`
* `readlinkSync(path[, options])`
* `symlinkSync(target, path[, type])`
* `accessSync(path[, mode])`
* `rmSync(path[, options])`
* `truncateSync(path[, len])`
* `ftruncateSync(fd[, len])`
* `linkSync(existingPath, newPath)`
* `chmodSync(path, mode)`
* `chownSync(path, uid, gid)`
* `lchownSync(path, uid, gid)`
* `utimesSync(path, atime, mtime)`
* `lutimesSync(path, atime, mtime)`
* `mkdtempSync(prefix)`
* `opendirSync(path[, options])`
* `openAsBlob(path[, options])`
* File-descriptor ops: `openSync`, `closeSync`, `readSync`, `writeSync`,
  `fstatSync`
* Streams: `createReadStream`, `createWriteStream`
* Watchers: `watch`, `watchFile`, `unwatchFile`

#### Callback API

`readFile`, `writeFile`, `stat`, `lstat`, `readdir`, `realpath`, `readlink`,
`access`, `open`, `close`, `read`, `write`, `rm`, `fstat`, `truncate`,
`ftruncate`, `link`, `mkdtemp`, `opendir`. Each takes a Node.js-style
callback `(err, ...result) => {}`.

#### Promise API

`vfs.promises` exposes the promise-based variants:

```cjs
const vfs = require('node:vfs');

async function example() {
  const myVfs = vfs.create();
  await myVfs.promises.writeFile('/file.txt', 'hello');
  const data = await myVfs.promises.readFile('/file.txt', 'utf8');
  return data;
}
example();
```

The promise namespace mirrors `fs.promises` and includes `readFile`,
`writeFile`, `appendFile`, `stat`, `lstat`, `readdir`, `mkdir`, `rmdir`,
`unlink`, `rename`, `copyFile`, `realpath`, `readlink`, `symlink`,
`access`, `rm`, `truncate`, `link`, `mkdtemp`, `chmod`, `chown`, `lchown`,
`utimes`, `lutimes`, `open`, `lchmod`, and `watch`.

## Class: `VirtualProvider`

<!-- YAML
added: v26.4.0
-->

The base class for all VFS providers. Subclasses implement the essential
primitives (such as `open`, `stat`, `readdir`, `mkdir`, `rmdir`, `unlink`,
`rename`, etc.) and inherit default implementations of the derived
methods (such as `readFile`, `writeFile`, `exists`, `copyFile`, `access`, etc.).

### Capability flags

* `provider.readonly` {boolean} **Default:** `false`.
* `provider.supportsSymlinks` {boolean} **Default:** `false`.
* `provider.supportsWatch` {boolean} **Default:** `false`.

### Creating custom providers

```cjs
const { VirtualProvider } = require('node:vfs');

class StaticProvider extends VirtualProvider {
  get readonly() { return true; }

  statSync(path) { /* ... */ }
  openSync(path, flags) { /* ... */ }
  readdirSync(path, options) { /* ... */ }
  // ...
}
```

The base class throws `ERR_METHOD_NOT_IMPLEMENTED` for any primitive
that has not been overridden, and rejects writes from a `readonly`
provider with `EROFS`.

## Class: `MemoryProvider`

<!-- YAML
added: v26.4.0
-->

The default in-memory provider. Stores files, directories, and symbolic
links in a `Map`-backed tree, supports symlinks (`supportsSymlinks ===
true`), and supports watching (`supportsWatch === true`).

### `memoryProvider.setReadOnly()`

<!-- YAML
added: v26.4.0
-->

Locks the provider into read-only mode. Subsequent writes through any
[`VirtualFileSystem`][] using this provider throw `EROFS`. There is no
way to revert the provider to writable.

```cjs
const vfs = require('node:vfs');

const provider = new vfs.MemoryProvider();
const myVfs = vfs.create(provider);
myVfs.writeFileSync('/seed.txt', 'initial');

provider.setReadOnly();

myVfs.writeFileSync('/x.txt', 'fail'); // throws EROFS
```

## Class: `RealFSProvider`

<!-- YAML
added: v26.4.0
-->

A provider that wraps a directory (i.e. one on the actual file system) and
exposes its contents through the VFS API. All VFS paths are resolved relative to
the root and verified to stay inside it; symbolic links resolving outside the
root are rejected. This path mapping is not a sandbox or access-control
mechanism.

### `new RealFSProvider(rootPath)`

<!-- YAML
added: v26.4.0
-->

* `rootPath` {string} The absolute file-system path to use as the root.
  Must be a non-empty string.

```cjs
const vfs = require('node:vfs');

const realVfs = vfs.create(new vfs.RealFSProvider('/tmp/vfs-root'));
realVfs.writeFileSync('/file.txt', 'hello'); // writes /tmp/vfs-root/file.txt
```

### `realFSProvider.rootPath`

<!-- YAML
added: v26.4.0
-->

* {string}

The resolved absolute path used as the root.

## Class: `ZipProvider`

<!-- YAML
added: REPLACEME
-->

A provider that exposes the entries of a ZIP archive - either a
[`zlib.ZipBuffer`][] (in memory) or a [`zlib.ZipFile`][] (on disk) - through
the VFS API. `provider.readonly` reflects the archive's own
[`zipFile.writable`][] flag: a `ZipBuffer` is always writable, and a
`ZipFile` is writable only when opened with `{ writable: true }`.

Directories are recognized both explicitly (an entry whose name ends in `/`)
and implicitly (any entry name starting with `"<dir>/"`). `readdir()` does
not support `{ recursive: true }`. Because a ZIP member cannot be edited or
read in place - only fully written or fully decompressed - a file opened for
writing only commits its content (as a new archive entry) when the handle is
closed.

Every method has a synchronous counterpart (`openSync()`, `statSync()`,
`readdirSync()`, and so on), backed by the equally complete synchronous
surface [`zlib.ZipBuffer`][]/[`zlib.ZipFile`][] expose. As with those, the
synchronous methods here block the Node.js event loop and further JavaScript
execution until the operation - including any deflate/inflate pass -
completes.

```cjs
const vfs = require('node:vfs');
const zlib = require('node:zlib');
const { readFileSync } = require('node:fs');

async function main() {
  const zip = new zlib.ZipBuffer(readFileSync('archive.zip'));
  const archiveVfs = vfs.create(new vfs.ZipProvider(zip));

  console.log(await archiveVfs.promises.readdir('/'));
  await archiveVfs.promises.writeFile('/new.txt', 'hello');
}
main();
```

### `new ZipProvider(source)`

<!-- YAML
added: REPLACEME
-->

* `source` {zlib.ZipBuffer|zlib.ZipFile} An already-open archive.

## Implementation details

### `Stats` objects

VFS `Stats` objects are real instances of [`fs.Stats`][] (or
[`fs.BigIntStats`][] when `{ bigint: true }` is requested). Their
fields use synthetic but stable values:

* `dev` is `4085` (the VFS device id).
* `ino` is monotonically increasing per process.
* `blksize` is `4096`.
* `blocks` is `Math.ceil(size / 512)`.
* Times default to the moment the entry was created/last modified.

[`--require`]: cli.md#-r---require-module
[`--vfs-mount`]: cli.md#--vfs-mountsourcetarget
[`MemoryProvider`]: #class-memoryprovider
[`RealFSProvider`]: #class-realfsprovider
[`VirtualFileSystem`]: #class-virtualfilesystem
[`VirtualProvider`]: #class-virtualprovider
[`ZipProvider`]: #class-zipprovider
[`fs.BigIntStats`]: fs.md#class-fsbigintstats
[`fs.Stats`]: fs.md#class-fsstats
[`node:fs`]: fs.md
[`vfs.create()`]: #vfscreateprovider-options
[`zipFile.writable`]: zlib.md#zipfilewritable
[`zlib.ZipBuffer`]: zlib.md#class-zlibzipbuffer
[`zlib.ZipFile`]: zlib.md#class-zlibzipfile
