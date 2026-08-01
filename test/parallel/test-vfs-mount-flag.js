'use strict';

// Exercises --vfs-mount end to end: a normal entry script runs from the real
// file system but can read from one or more mounted VFSes - at the source's
// own path, or at an explicit `source=target` mount point - and a source no
// provider claims is rejected.

const common = require('../common');
const tmpdir = require('../common/tmpdir');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

tmpdir.refresh();
let id = 0;
function fixture(name) { return path.join(tmpdir.path, `${id++}-${name}`); }

async function writeZip(files, dest) {
  const entries = [];
  for (const { 0: name, 1: content } of Object.entries(files)) {
    entries.push(await zlib.ZipEntry.create(name, Buffer.from(content)));
  }
  const chunks = [];
  for await (const chunk of zlib.createZipArchive(entries)) chunks.push(chunk);
  fs.writeFileSync(dest, Buffer.concat(chunks));
}

function run(args) {
  return spawnSync(process.execPath, ['--experimental-vfs', ...args], { encoding: 'utf8' });
}

(async () => {
  // -- A plain directory mounts at its own path (RealFSProvider) --------------
  // Reads under the mount must reach the real files, not loop back through the
  // mount hook into the provider's own I/O.
  {
    const dir = fixture('data-dir');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'note.txt'), 'hello from the real dir');
    const script = fixture('read-dir.js');
    fs.writeFileSync(script,
                     `const fs = require('fs');\n` +
                     `console.log(fs.readFileSync(${JSON.stringify(dir)} + '/note.txt', 'utf8'));\n`);
    const res = run([`--vfs-mount=${dir}`, script]);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /hello from the real dir/);
  }

  // -- Mount-only: a normal entry script reads its own data from the mount ----
  {
    const dataZip = fixture('data.zip');
    await writeZip({ 'greeting.txt': 'hi from the archive' }, dataZip);
    const script = fixture('app.js');
    fs.writeFileSync(script,
                     `const fs = require('fs');\n` +
                     `console.log(fs.readFileSync(${JSON.stringify(dataZip)} + '/greeting.txt', 'utf8'));\n`);
    // The script itself is the entry; the archive is mounted as data.
    const res = run([`--vfs-mount=${dataZip}`, script]);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /hi from the archive/);
  }

  // -- Explicit, virtual mount point (source=target) -------------------------
  {
    const dataZip = fixture('data2.zip');
    await writeZip({ 'x.txt': 'mounted elsewhere' }, dataZip);
    const mountPoint = path.join(tmpdir.path, 'mnt-elsewhere'); // need not exist
    const script = fixture('app2.js');
    fs.writeFileSync(script,
                     `const fs = require('fs');\n` +
                     `console.log(fs.readFileSync(${JSON.stringify(mountPoint)} + '/x.txt', 'utf8'));\n`);
    const res = run([`--vfs-mount=${dataZip}=${mountPoint}`, script]);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /mounted elsewhere/);
  }

  // -- Multiple --vfs-mount, both active at once -----------------------------
  {
    const zipA = fixture('a.zip');
    const zipB = fixture('b.zip');
    await writeZip({ 'a.txt': 'from A' }, zipA);
    await writeZip({ 'b.txt': 'from B' }, zipB);
    const script = fixture('app3.js');
    fs.writeFileSync(script,
                     `const fs = require('fs');\n` +
                     `console.log(fs.readFileSync(${JSON.stringify(zipA)} + '/a.txt', 'utf8'));\n` +
                     `console.log(fs.readFileSync(${JSON.stringify(zipB)} + '/b.txt', 'utf8'));\n`);
    const res = run([`--vfs-mount=${zipA}`, `--vfs-mount=${zipB}`, script]);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /from A/);
    assert.match(res.stdout, /from B/);
  }

  // -- a source no provider claims is rejected -------------------------------
  {
    const bogus = fixture('mystery.bin');
    fs.writeFileSync(bogus, Buffer.from('not an archive of any known kind'));
    const res = run([`--vfs-mount=${bogus}`]);
    assert.notStrictEqual(res.status, 0);
    assert.match(res.stderr, /ERR_VFS_INVALID_TARGET/);
  }
})().then(common.mustCall());
