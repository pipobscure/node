'use strict';

// Exercises the --vfs-manifest=<file> startup flag: every file actually
// read through a directory-backed --vfs mount - whether by module
// resolution or by the program's own plain fs.readFile*() calls - gets its
// path appended to <file>; the flag requires an explicit output path (no
// path is derived from the --vfs target), requires --vfs to be set and to
// target a directory, and a file read by a worker thread also lands in the
// same manifest (workers append to the same real file directly).

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

function runVfs(args) {
  return spawnSync(
    process.execPath,
    ['--experimental-vfs', ...args],
    { encoding: 'utf8' },
  );
}

function readManifestLines(manifestPath) {
  return fs.readFileSync(manifestPath, 'utf8').split('\n').filter((l) => l.length > 0);
}

// -- basic: module reads + a plain fs.readFileSync() both get recorded ----

{
  const dir = nextDir('basic');
  const manifestPath = path.join(tmpdir.path, 'basic.manifest');
  writeTree(dir, {
    'index.js':
      "const { greet } = require('./lib/helper.js');\n" +
      "const fs = require('fs');\n" +
      "const path = require('path');\n" +
      'console.log(greet());\n' +
      "console.log(fs.readFileSync(path.join(__dirname, 'data.txt'), 'utf8'));",
    'lib/helper.js': "module.exports = { greet: () => 'hi' };",
    'data.txt': 'some data',
  });
  const result = runVfs([`--vfs=${dir}`, `--vfs-manifest=${manifestPath}`]);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(result.stdout.trim(), 'hi\nsome data');

  assert.strictEqual(fs.existsSync(manifestPath), true);
  const lines = readManifestLines(manifestPath);
  assert.deepStrictEqual(new Set(lines), new Set([
    'index.js',
    'lib/helper.js',
    'data.txt',
  ]));
}

// -- requires --vfs -----------------------------------------------------

{
  const manifestPath = path.join(tmpdir.path, 'unused.manifest');
  const result = runVfs([`--vfs-manifest=${manifestPath}`, '-e', '0']);
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /ERR_MISSING_OPTION/);
}

// -- requires --experimental-vfs ----------------------------------------

{
  const manifestPath = path.join(tmpdir.path, 'gated.manifest');
  const result = spawnSync(
    process.execPath,
    [`--vfs-manifest=${manifestPath}`, '-e', '0'],
    { encoding: 'utf8' },
  );
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /--vfs-manifest requires --experimental-vfs/);
}

// -- requires --vfs to target a directory, not a zip ---------------------

{
  const dir = nextDir('zip-src');
  const zipPath = path.join(dir, 'app.zip');
  const manifestPath = path.join(tmpdir.path, 'zip-src.manifest');
  (async () => {
    const entry = await zlib.ZipEntry.create('index.js', Buffer.from("console.log('hi');"));
    const chunks = [];
    for await (const chunk of zlib.createZipArchive([entry])) chunks.push(chunk);
    fs.writeFileSync(zipPath, Buffer.concat(chunks));

    const result = runVfs([`--vfs=${zipPath}`, `--vfs-manifest=${manifestPath}`]);
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /ERR_VFS_MANIFEST_REQUIRES_DIRECTORY/);
  })().then(common.mustCall());
}

// -- a file read by a worker thread lands in the same manifest -----------

{
  const dir = nextDir('worker-dir');
  const manifestPath = path.join(tmpdir.path, 'worker-dir.manifest');
  writeTree(dir, {
    'worker-data.txt': 'read by the worker',
    'index.js':
      "const { Worker, isMainThread, parentPort } = require('worker_threads');\n" +
      'if (isMainThread) {\n' +
      '  const w = new Worker(__filename);\n' +
      "  w.on('message', () => {});\n" +
      '} else {\n' +
      "  const fs = require('fs');\n" +
      "  const path = require('path');\n" +
      "  fs.readFileSync(path.join(__dirname, 'worker-data.txt'), 'utf8');\n" +
      '  parentPort.postMessage(\'done\');\n' +
      '}',
  });
  const result = runVfs([`--vfs=${dir}`, `--vfs-manifest=${manifestPath}`]);
  assert.strictEqual(result.status, 0, result.stderr);

  const lines = readManifestLines(manifestPath);
  assert.ok(lines.includes('worker-data.txt'), `expected worker-data.txt in ${lines}`);
  assert.ok(lines.includes('index.js'), `expected index.js in ${lines}`);
}
