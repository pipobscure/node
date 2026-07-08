'use strict';

// Exercises the --vfs=<target> startup flag end to end, by actually
// spawning `node --vfs=<fixture>` against small CJS/ESM fixture trees and
// ZIP archives built at test time: entry-point resolution, package.json
// "type"/main-field/node_modules resolution happening entirely inside the
// mount, the mount being scoped to its own target (not the whole real
// filesystem), worker_threads inheriting the mount, and a clear error for
// an invalid target.
//
// With --vfs active, argv[1] is unconditionally the mount root - as with
// `node <dir>` - so fixtures run via their own index.js / package.json
// "main", and any positional arguments are the app's own (argv[2] onward),
// never an entry-file override.

const common = require('../common');
const tmpdir = require('../common/tmpdir');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

tmpdir.refresh();
let fixtureId = 0;
function nextDir(name) {
  const dir = path.join(tmpdir.path, `${fixtureId++}-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeTree(dir, files) {
  for (const { 0: name, 1: content } of Object.entries(files)) {
    const filePath = path.join(dir, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
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

function runVfs(target, extraArgs = []) {
  return spawnSync(process.execPath, [`--vfs=${target}`, ...extraArgs], {
    encoding: 'utf8',
  });
}

(async () => {
  // -- Basic CJS entry: directory-backed and archive-backed -----------------
  //
  // No entry-file argument is ever passed: with --vfs active, argv[1] is
  // unconditionally the mount root itself, so the mount's own index.js /
  // package.json "main" decides what runs, exactly as `node <dir>` would.

  const cjsFiles = {
    'index.js': "console.log('hello from vfs cjs');",
  };

  {
    const dir = nextDir('cjs-dir');
    writeTree(dir, cjsFiles);
    const result = runVfs(dir);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(result.stdout.trim(), 'hello from vfs cjs');
  }

  {
    const dir = nextDir('cjs-zip-src');
    const zipPath = path.join(dir, 'app.zip');
    await zipFromTree(cjsFiles, zipPath);
    const result = runVfs(zipPath);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(result.stdout.trim(), 'hello from vfs cjs');
  }

  // -- Positional arguments are the app's own, passed straight through as ----
  // -- argv[2] onward - never treated as an entry-point override. This is ----
  // -- what lets a self-mounting shebang app (`#!/usr/bin/env node --vfs`) ----
  // -- take command-line arguments of its own.                            ----

  {
    const dir = nextDir('argv-passthrough');
    writeTree(dir, {
      'index.js': 'console.log(JSON.stringify(process.argv.slice(2)));',
    });
    const result = runVfs(dir, ['alpha', 'beta']);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.deepStrictEqual(JSON.parse(result.stdout.trim()), ['alpha', 'beta']);
  }

  // -- package.json "main" picks the entry file within the mount ------------

  {
    const dir = nextDir('main-field');
    writeTree(dir, {
      'package.json': JSON.stringify({ main: 'src/entry.js' }),
      'src/entry.js': "console.log('ran package main');",
    });
    const result = runVfs(dir);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(result.stdout.trim(), 'ran package main');
  }

  // -- ESM entry via package.json "type": "module" ---------------------------

  {
    const dir = nextDir('esm-dir');
    writeTree(dir, {
      'package.json': JSON.stringify({ type: 'module' }),
      'index.js': "console.log('esm entry:', typeof import.meta.url);",
    });
    const result = runVfs(dir);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(result.stdout.trim(), 'esm entry: string');
  }

  // -- Multi-file CJS app: relative require + node_modules resolution -------

  {
    const dir = nextDir('multi-file');
    writeTree(dir, {
      'index.js':
        "const { greet } = require('./lib/helper.js');\n" +
        "const pkg = require('mypkg');\n" +
        "console.log(greet() + '-' + pkg.value);",
      'lib/helper.js': "module.exports = { greet: () => 'hi' };",
      'node_modules/mypkg/package.json': JSON.stringify({ name: 'mypkg', main: 'index.js' }),
      'node_modules/mypkg/index.js': "module.exports = { value: 'pkg-value' };",
    });
    const result = runVfs(dir);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(result.stdout.trim(), 'hi-pkg-value');
  }

  // -- Invalid target ---------------------------------------------------------

  {
    const missing = path.join(tmpdir.path, 'does-not-exist');
    const result = runVfs(missing);
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /ERR_VFS_INVALID_TARGET/);
  }

  // -- Sandbox is scoped to the mount, not the whole real filesystem ---------

  {
    const dir = nextDir('scoped-dir');
    const outsideMarker = path.join(tmpdir.path, 'outside-marker.txt');
    fs.writeFileSync(outsideMarker, 'real content outside the mount');
    writeTree(dir, {
      'index.js':
        "const fs = require('fs');\n" +
        `console.log(fs.readFileSync(${JSON.stringify(outsideMarker)}, 'utf8'));`,
    });
    const result = runVfs(dir);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(result.stdout.trim(), 'real content outside the mount');
  }

  // -- worker_threads inherits the mount --------------------------------------
  //
  // The worker names its entry through `new Worker(__filename)`, resolved via
  // the (VFS-aware) module loader - independent of the main thread's argv[1].

  {
    const dir = nextDir('worker-dir');
    writeTree(dir, {
      'marker.txt': 'inside the mount',
      'index.js':
        "const { Worker, isMainThread, parentPort } = require('worker_threads');\n" +
        'if (isMainThread) {\n' +
        '  const w = new Worker(__filename);\n' +
        "  w.on('message', (msg) => { console.log(msg); });\n" +
        '} else {\n' +
        "  const fs = require('fs');\n" +
        "  const path = require('path');\n" +
        "  parentPort.postMessage(fs.readFileSync(path.join(__dirname, 'marker.txt'), 'utf8'));\n" +
        '}',
    });
    const result = runVfs(dir);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(result.stdout.trim(), 'inside the mount');
  }
})().then(common.mustCall());
