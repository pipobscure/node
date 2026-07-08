'use strict';

require('../common');

const assert = require('node:assert');
const zlib = require('node:zlib');
const { test } = require('node:test');

async function buildArchive(entries, comment) {
  const chunks = [];
  for await (const chunk of zlib.createZipArchive(entries, comment)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function buildEocd({ diskNumber = 0, cdDiskNumber = 0, cdDiskRecords = 0,
                     totalRecords = 0, cdSize = 0, cdOffset = 0, comment = Buffer.alloc(0) } = {}) {
  const buf = Buffer.allocUnsafe(22 + comment.length);
  buf.writeUInt32LE(0x06054b50, 0);
  buf.writeUInt16LE(diskNumber, 4);
  buf.writeUInt16LE(cdDiskNumber, 6);
  buf.writeUInt16LE(cdDiskRecords, 8);
  buf.writeUInt16LE(totalRecords, 10);
  buf.writeUInt32LE(cdSize, 12);
  buf.writeUInt32LE(cdOffset, 16);
  buf.writeUInt16LE(comment.length, 20);
  comment.copy(buf, 22);
  return buf;
}

test('an empty or tiny buffer is rejected as an invalid archive', () => {
  for (const buf of [Buffer.alloc(0), Buffer.alloc(10), Buffer.from('not a zip')]) {
    assert.throws(() => [...zlib.ZipEntry.read(buf)], { code: 'ERR_ZIP_INVALID_ARCHIVE' });
  }
});

test('garbage or truncated data is rejected', () => {
  const garbage = Buffer.alloc(100, 0x41);
  assert.throws(() => [...zlib.ZipEntry.read(garbage)], { code: 'ERR_ZIP_INVALID_ARCHIVE' });

  const truncated = buildEocd({ totalRecords: 5, cdSize: 46 * 5 }).subarray(0, 10);
  assert.throws(() => [...zlib.ZipEntry.read(truncated)], { code: 'ERR_ZIP_INVALID_ARCHIVE' });
});

test('an EOCD-looking signature inside a trailing comment is not mistaken for the real one', async () => {
  const entry = await zlib.ZipEntry.create('f.txt', Buffer.from('hi'), { method: 'store' });
  // The comment scan walks backward through the trailing comment bytes
  // before it reaches the genuine EOCD signature; embedding 4 bytes that
  // look like one partway through must not be mistaken for the real record.
  const fakeSignature = String.fromCharCode(0x50, 0x4b, 0x05, 0x06);
  const archive = await buildArchive([entry], `before ${fakeSignature} after`);

  const read = [...zlib.ZipEntry.read(archive)];
  assert.strictEqual(read.length, 1);
  assert.strictEqual(read[0].name, 'f.txt');
});

test('a declared-size mismatch is rejected as corrupt', async () => {
  const entry = await zlib.ZipEntry.create('f.txt', Buffer.from('hello world'), { method: 'store' });
  const archive = await buildArchive([entry]);

  // Shrink the *declared* uncompressed size in the central directory record
  // without touching the stored bytes themselves, so the amount of data
  // produced no longer matches what the header promised.
  const tampered = Buffer.from(archive);
  const centralHeaderStart = 30 + 'f.txt'.length + 'hello world'.length;
  const uncompressedSizeOffset = centralHeaderStart + 24;
  tampered.writeUInt32LE(1, uncompressedSizeOffset);

  const [tamperedEntry] = zlib.ZipEntry.read(tampered);
  assert.strictEqual(tamperedEntry.size, 1);
  await assert.rejects(tamperedEntry.content(), { code: 'ERR_ZIP_ENTRY_CORRUPT' });
});

test('CRC-32 verification catches a single flipped byte, and can be disabled', async () => {
  const entry = await zlib.ZipEntry.create('f.txt', Buffer.from('hello world'), { method: 'store' });
  const archive = await buildArchive([entry]);
  const tampered = Buffer.from(archive);
  const contentStart = 30 + 'f.txt'.length;
  tampered[contentStart] ^= 0xff;

  const [tamperedEntry] = zlib.ZipEntry.read(tampered);
  await assert.rejects(tamperedEntry.content(), { code: 'ERR_ZIP_ENTRY_CORRUPT' });
  const unverified = await tamperedEntry.content({ verify: false });
  assert.strictEqual(unverified.length, 'hello world'.length);
});

test('content() enforces maxSize before allocating', async () => {
  const entry = await zlib.ZipEntry.create('f.txt', Buffer.from('hello world'));
  await assert.rejects(entry.content({ maxSize: 1 }), { code: 'ERR_ZIP_ENTRY_TOO_LARGE' });
});

test('a forged small header whose content inflates past maxSize is rejected', async () => {
  // The up-front maxSize check trusts the declared size, so a bomb forges a
  // tiny declared size to clear it; the decompressor's maxOutputLength backstop
  // must still catch the content actually inflating past the limit.
  for (const { method, re } of [
    { method: 'deflate', re: /inflates beyond/ },
    { method: 'zstd', re: /decompresses beyond/ },
  ]) {
    const entry = await zlib.ZipEntry.create('f.txt', Buffer.from('x'.repeat(5000)), { method });
    const archive = await buildArchive([entry]);
    const tampered = Buffer.from(archive);
    const eocd = tampered.length - 22; // No comment, so EOCD is the last 22 bytes
    const cdOffset = tampered.readUInt32LE(eocd + 16);
    tampered.writeUInt32LE(50, cdOffset + 24); // Forge declared uncompressedSize

    const [e] = zlib.ZipEntry.read(tampered);
    assert.strictEqual(e.size, 50); // 50 <= maxSize 100 clears the up-front check
    await assert.rejects(e.content({ maxSize: 100 }), { code: 'ERR_ZIP_ENTRY_TOO_LARGE', message: re });
    assert.throws(() => e.contentSync({ maxSize: 100 }), { code: 'ERR_ZIP_ENTRY_TOO_LARGE', message: re });
  }
});

test('getMaxZipContentSize()/setMaxZipContentSize() control the default guard', async () => {
  const original = zlib.getMaxZipContentSize();
  try {
    zlib.setMaxZipContentSize(1);
    const entry = await zlib.ZipEntry.create('f.txt', Buffer.from('hello world'));
    await assert.rejects(entry.content(), { code: 'ERR_ZIP_ENTRY_TOO_LARGE' });
  } finally {
    zlib.setMaxZipContentSize(original);
  }
  assert.strictEqual(zlib.getMaxZipContentSize(), original);
});

test('streaming a partially-consumed entry does not hang or leak', async () => {
  async function* source() {
    for (let i = 0; i < 1000; i++) {
      yield Buffer.alloc(1024, i & 0xff);
    }
  }
  const entry = zlib.ZipEntry.createStream('big.bin', source());
  let count = 0;
  let bytesSeen = 0;
  for await (const chunk of entry) {
    count++;
    bytesSeen += chunk.length;
    if (count > 2) break;
  }
  assert.ok(count > 2);
  assert.ok(bytesSeen > 0);
});

test('an overlong file name is rejected', async () => {
  await assert.rejects(
    zlib.ZipEntry.create('x'.repeat(70000), Buffer.alloc(0)),
    { code: 'ERR_ZIP_ENTRY_TOO_LARGE' },
  );
});

test('an empty file name is rejected', async () => {
  await assert.rejects(
    zlib.ZipEntry.create('', Buffer.alloc(0)),
    { code: 'ERR_INVALID_ARG_VALUE' },
  );
});

test('a multi-disk archive is rejected', () => {
  const eocd = buildEocd({ diskNumber: 1, cdDiskNumber: 1 });
  assert.throws(() => [...zlib.ZipEntry.read(eocd)], { code: 'ERR_ZIP_UNSUPPORTED_FEATURE' });
});

test('an encrypted entry is rejected', async () => {
  const entry = await zlib.ZipEntry.create('f.txt', Buffer.from('secret'), { method: 'store' });
  const archive = await buildArchive([entry]);
  // Set the encrypted bit (bit 0) in both the local and central header flags.
  const tampered = Buffer.from(archive);
  const localFlagsOffset = 6;
  tampered.writeUInt16LE(tampered.readUInt16LE(localFlagsOffset) | 0x0001, localFlagsOffset);
  const centralHeaderStart = 30 + 'f.txt'.length + 'secret'.length;
  const centralFlagsOffset = centralHeaderStart + 8;
  tampered.writeUInt16LE(tampered.readUInt16LE(centralFlagsOffset) | 0x0001, centralFlagsOffset);

  const [tamperedEntry] = zlib.ZipEntry.read(tampered);
  await assert.rejects(tamperedEntry.content(), { code: 'ERR_ZIP_UNSUPPORTED_FEATURE' });
});

test('an entry using an unsupported compression method is rejected', async () => {
  const entry = await zlib.ZipEntry.create('f.txt', Buffer.from('hi'), { method: 'store' });
  const archive = await buildArchive([entry]);
  // Set the method to 1 (Shrunk), which this implementation does not support,
  // in both the local and central headers.
  const tampered = Buffer.from(archive);
  const localMethodOffset = 8;
  tampered.writeUInt16LE(1, localMethodOffset);
  const centralHeaderStart = 30 + 'f.txt'.length + 'hi'.length;
  const centralMethodOffset = centralHeaderStart + 10;
  tampered.writeUInt16LE(1, centralMethodOffset);

  const [tamperedEntry] = zlib.ZipEntry.read(tampered);
  assert.strictEqual(tamperedEntry.method, 1);
  await assert.rejects(tamperedEntry.content(), { code: 'ERR_ZIP_UNSUPPORTED_FEATURE' });
  assert.throws(() => tamperedEntry.contentSync(), { code: 'ERR_ZIP_UNSUPPORTED_FEATURE' });
});
