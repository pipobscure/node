'use strict';

require('../common');

const assert = require('node:assert');
const zlib = require('node:zlib');
const { test } = require('node:test');

async function buildArchive(entries, comment) {
  const chunks = [];
  for await (const chunk of zlib.createZipArchive(entries, comment)) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

test('round-trips a small archive through ZipEntry.read', async () => {
  const entries = [
    await zlib.ZipEntry.create('hello.txt', Buffer.from('Hello, world!'.repeat(20))),
    await zlib.ZipEntry.create('raw.bin', Buffer.from([1, 2, 3, 4, 5]), { method: 'store' }),
    await zlib.ZipEntry.create('empty.txt', Buffer.alloc(0)),
    await zlib.ZipEntry.create('dir/', Buffer.alloc(0)),
  ];
  const archive = await buildArchive(entries, 'test comment');

  const read = [...zlib.ZipEntry.read(archive)];
  assert.strictEqual(read.length, 4);

  const byName = new Map(read.map((entry) => [entry.name, entry]));
  assert.strictEqual((await byName.get('hello.txt').content()).toString(),
                     'Hello, world!'.repeat(20));
  assert.strictEqual(byName.get('hello.txt').method, 8);
  assert.deepStrictEqual(await byName.get('raw.bin').content(), Buffer.from([1, 2, 3, 4, 5]));
  assert.strictEqual(byName.get('raw.bin').method, 0);
  assert.strictEqual((await byName.get('empty.txt').content()).length, 0);
  assert.strictEqual(byName.get('dir/').isDirectory, true);
  assert.strictEqual(byName.get('hello.txt').isFile, true);
});

test('ZipBuffer indexes entries by name', async () => {
  const entries = [
    await zlib.ZipEntry.create('a.txt', Buffer.from('a')),
    await zlib.ZipEntry.create('b.txt', Buffer.from('b')),
  ];
  const archive = await buildArchive(entries);
  using zip = new zlib.ZipBuffer(archive);

  assert.strictEqual(zip.size, 2);
  assert.strictEqual(zip.has('a.txt'), true);
  assert.strictEqual(zip.has('missing.txt'), false);
  assert.strictEqual((await zip.get('a.txt').content()).toString(), 'a');
  assert.deepStrictEqual([...zip.keys()].sort(), ['a.txt', 'b.txt']);

  assert.throws(() => zip.get('missing.txt'), { code: 'ERR_ZIP_ENTRY_NOT_FOUND' });
});

test('an incompressible or empty entry falls back to store', async () => {
  const random = require('node:crypto').randomBytes(4096);
  const entry = await zlib.ZipEntry.create('random.bin', random);
  assert.strictEqual(entry.method, 0);
  assert.deepStrictEqual(await entry.content(), random);

  const empty = await zlib.ZipEntry.create('empty.bin', Buffer.alloc(0));
  assert.strictEqual(empty.method, 0);
});

test('explicit store option is honored even for compressible data', async () => {
  const data = Buffer.from('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  const entry = await zlib.ZipEntry.create('stored.txt', data, { method: 'store' });
  assert.strictEqual(entry.method, 0);
  assert.deepStrictEqual(entry.rawContent, data);
});

test('the zstd method compresses and round-trips through an archive', async () => {
  const data = Buffer.from('zstd content '.repeat(200));
  const entry = await zlib.ZipEntry.create('z.txt', data, { method: 'zstd' });
  assert.strictEqual(entry.method, 93);
  assert.ok(entry.compressedSize < data.length);
  assert.deepStrictEqual(await entry.content(), data);

  const archive = await buildArchive([entry]);
  const [read] = zlib.ZipEntry.read(archive);
  assert.strictEqual(read.method, 93);
  assert.deepStrictEqual(await read.content(), data);
});

test('an incompressible entry with method zstd falls back to store', async () => {
  const random = require('node:crypto').randomBytes(4096);
  const entry = await zlib.ZipEntry.create('random.bin', random, { method: 'zstd' });
  assert.strictEqual(entry.method, 0);
  assert.deepStrictEqual(await entry.content(), random);
});

test('crc32 chains the same way as zlib.crc32', async () => {
  const data = Buffer.from('the quick brown fox jumps over the lazy dog');
  const entry = await zlib.ZipEntry.create('f.txt', data);
  assert.strictEqual(entry.crc32, zlib.crc32(data));
});

test('createZipArchive rejects an overlong comment', async () => {
  await assert.rejects(
    buildArchive([], 'x'.repeat(70000)),
    { code: 'ERR_ZIP_ENTRY_TOO_LARGE' },
  );
});

test('directory entries cannot carry content', async () => {
  await assert.rejects(
    zlib.ZipEntry.create('dir/', Buffer.from('x')),
    { code: 'ERR_INVALID_ARG_VALUE' },
  );
});
