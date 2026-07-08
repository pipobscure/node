'use strict';

require('../common');

const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const zlib = require('node:zlib');
const { test } = require('node:test');

// Additional zip.js coverage beyond the other test-zlib-zip-*.js files:
// DOS date/time edge cases, the Zip64 extra-field parser's normal and
// out-of-range paths, the "data was prepended to the archive" central
// directory recovery scan, buffer-coercion variants, entry-metadata
// validation, streaming-entry state guards, the ZipBuffer/ZipFile
// iteration protocols, and several ZipFile (on-disk) error paths that
// aren't reachable through ZipBuffer alone.

async function buildArchive(entries, comment) {
  const chunks = [];
  for await (const chunk of zlib.createZipArchive(entries, comment)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function drain(iterable) {
  const chunks = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// -- DOS date/time -----------------------------------------------------------

test('a zeroed DOS date/time field decodes to the 1980-01-01 epoch', async () => {
  const entry = await zlib.ZipEntry.create('f.txt', Buffer.from('hi'), { method: 'store' });
  const archive = await buildArchive([entry]);
  const tampered = Buffer.from(archive);
  tampered.writeUInt16LE(0, 10); // local time
  tampered.writeUInt16LE(0, 12); // local date
  const centralStart = 30 + 'f.txt'.length + 'hi'.length;
  tampered.writeUInt16LE(0, centralStart + 12); // central time
  tampered.writeUInt16LE(0, centralStart + 14); // central date

  const [read] = zlib.ZipEntry.read(tampered);
  assert.strictEqual(read.modified.getTime(), new Date(1980, 0, 1, 0, 0, 0).getTime());
});

test('serializing an entry with an invalid modified Date is rejected', async () => {
  const entry = await zlib.ZipEntry.create('f.txt', Buffer.from('hi'), { modified: new Date(NaN) });
  await assert.rejects(buildArchive([entry]), { code: 'ERR_INVALID_ARG_VALUE' });
});

// -- Zip64 structures ---------------------------------------------------------

function buildZip64Record({ diskNumber = 0, cdDiskNumber = 0, cdDiskRecords = 0n,
                            cdTotalRecords = 0n, cdSize = 0n, cdOffset = 0n } = {}) {
  const buf = Buffer.allocUnsafe(56);
  buf.writeUInt32LE(0x06064b50, 0);
  buf.writeBigUInt64LE(44n, 4);
  buf.writeUInt16LE((3 << 8) | 45, 12); // Made by Unix, version 4.5
  buf.writeUInt16LE(45, 14);
  buf.writeUInt32LE(diskNumber, 16);
  buf.writeUInt32LE(cdDiskNumber, 20);
  buf.writeBigUInt64LE(cdDiskRecords, 24);
  buf.writeBigUInt64LE(cdTotalRecords, 32);
  buf.writeBigUInt64LE(cdSize, 40);
  buf.writeBigUInt64LE(cdOffset, 48);
  return buf;
}

function buildZip64Locator({ recordDiskNumber = 0, recordOffset = 0n, totalDisks = 1 } = {}) {
  const buf = Buffer.allocUnsafe(20);
  buf.writeUInt32LE(0x07064b50, 0);
  buf.writeUInt32LE(recordDiskNumber, 4);
  buf.writeBigUInt64LE(recordOffset, 8);
  buf.writeUInt32LE(totalDisks, 16);
  return buf;
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

// A minimal (zero-entry) Zip64 archive: record + locator + classic EOCD,
// with the locator pointing directly at the record.
function buildMinimalZip64Archive({ record, locator, eocd } = {}) {
  return Buffer.concat([
    buildZip64Record(record),
    buildZip64Locator({ recordOffset: 0n, ...locator }),
    buildEocd(eocd),
  ]);
}

test('a well-formed minimal Zip64 archive round-trips its comment', () => {
  const buf = buildMinimalZip64Archive({ eocd: { comment: Buffer.from('hi') } });
  const zip = new zlib.ZipBuffer(buf);
  assert.strictEqual(zip.size, 0);
  assert.strictEqual(zip.comment, 'hi');
});

test('a Zip64 locator declaring more than one disk is rejected', () => {
  const buf = buildMinimalZip64Archive({ locator: { totalDisks: 2 } });
  assert.throws(() => [...zlib.ZipEntry.read(buf)], { code: 'ERR_ZIP_UNSUPPORTED_FEATURE' });
});

test('a Zip64 locator pointing at another disk is rejected', () => {
  const buf = buildMinimalZip64Archive({ locator: { recordDiskNumber: 1 } });
  assert.throws(() => [...zlib.ZipEntry.read(buf)], { code: 'ERR_ZIP_UNSUPPORTED_FEATURE' });
});

test('a Zip64 record on another disk is rejected', () => {
  const buf = buildMinimalZip64Archive({ record: { diskNumber: 1 } });
  assert.throws(() => [...zlib.ZipEntry.read(buf)], { code: 'ERR_ZIP_UNSUPPORTED_FEATURE' });
});

test('a Zip64 record with inconsistent disk record counts is rejected', () => {
  const buf = buildMinimalZip64Archive({ record: { cdDiskRecords: 1n, cdTotalRecords: 2n } });
  assert.throws(() => [...zlib.ZipEntry.read(buf)], { code: 'ERR_ZIP_UNSUPPORTED_FEATURE' });
});

test('a Zip64 record is found by scanning backward when data was prepended', () => {
  // The locator's declared offset is wrong (as if the archive had been
  // prepended with extra bytes, e.g. a self-extractor stub, after the
  // record/locator were written), but the record still physically sits
  // immediately before the locator; findArchiveEnd() must recover it.
  const buf = buildMinimalZip64Archive({
    locator: { recordOffset: 999_999n },
    eocd: { comment: Buffer.from('recovered') },
  });
  const zip = new zlib.ZipBuffer(buf);
  assert.strictEqual(zip.comment, 'recovered');
});

test('a Zip64 record that cannot be found anywhere is rejected', () => {
  const buf = buildMinimalZip64Archive({ locator: { recordOffset: 999_999n } });
  buf.writeUInt32LE(0xdeadbeef, 0); // Also corrupt the record actually present
  assert.throws(() => [...zlib.ZipEntry.read(buf)], {
    code: 'ERR_ZIP_INVALID_ARCHIVE',
    message: /Zip64 end of central directory record not found/,
  });
});

// Patches a single-entry, single-record archive's central header to carry a
// synthetic Zip64 extra field for whichever of {uncompressedSize,
// compressedSize, localFileHeaderOffset, diskNumber} are provided, setting
// the corresponding 32-/16-bit field to the sentinel value that tells
// CentralFileHeader to resolve it from the extra field instead. A leading,
// unrelated TLV record is always included ahead of the Zip64 one, so the
// "skip past a foreign record" loop iteration is exercised too.
function injectZip64Extra(archive, name, contentLength, fields) {
  const centralHeaderStart = 30 + name.length + contentLength;
  const nameStart = centralHeaderStart + 46;
  const extraLengthOffset = centralHeaderStart + 30;
  assert.strictEqual(archive.readUInt16LE(extraLengthOffset), 0); // sanity: no existing extra

  const dummyTlv = Buffer.from([0x99, 0x99, 0x04, 0x00, 0xde, 0xad, 0xbe, 0xef]);
  const order = ['uncompressedSize', 'compressedSize', 'localFileHeaderOffset', 'diskNumber'];
  const dataLength = order.reduce(
    (total, key) => total + (key in fields ? (key === 'diskNumber' ? 4 : 8) : 0), 0);
  const zip64Tlv = Buffer.allocUnsafe(4 + dataLength);
  zip64Tlv.writeUInt16LE(0x0001, 0);
  zip64Tlv.writeUInt16LE(dataLength, 2);
  let pos = 4;
  for (const key of order) {
    if (!(key in fields)) continue;
    if (key === 'diskNumber') {
      zip64Tlv.writeUInt32LE(Number(fields[key]), pos);
      pos += 4;
    } else {
      zip64Tlv.writeBigUInt64LE(BigInt(fields[key]), pos);
      pos += 8;
    }
  }
  const extra = Buffer.concat([dummyTlv, zip64Tlv]);

  const before = archive.subarray(0, nameStart + name.length);
  const after = archive.subarray(nameStart + name.length); // comment + EOCD
  const patched = Buffer.concat([before, extra, after]);

  patched.writeUInt16LE(extra.length, extraLengthOffset);
  if ('uncompressedSize' in fields) patched.writeUInt32LE(0xffffffff, centralHeaderStart + 24);
  if ('compressedSize' in fields) patched.writeUInt32LE(0xffffffff, centralHeaderStart + 20);
  if ('localFileHeaderOffset' in fields) patched.writeUInt32LE(0xffffffff, centralHeaderStart + 42);
  if ('diskNumber' in fields) patched.writeUInt16LE(0xffff, centralHeaderStart + 34);

  const eocdOffset = patched.length - 22;
  assert.strictEqual(patched.readUInt32LE(eocdOffset), 0x06054b50);
  const oldCdSize = patched.readUInt32LE(eocdOffset + 12);
  patched.writeUInt32LE(oldCdSize + extra.length, eocdOffset + 12);

  return patched;
}

test('a foreign Zip64 extra field naming only the fields it needs still resolves', async () => {
  const name = 'f.txt';
  const content = Buffer.from('hello');
  const entry = await zlib.ZipEntry.create(name, content, { method: 'store' });
  const archive = await buildArchive([entry]);

  const patched = injectZip64Extra(archive, name, content.length, {
    uncompressedSize: content.length,
    compressedSize: content.length,
    localFileHeaderOffset: 0,
    diskNumber: 0,
  });

  const [read] = zlib.ZipEntry.read(patched);
  assert.strictEqual(read.size, content.length);
  assert.strictEqual(read.compressedSize, content.length);
  assert.strictEqual((await read.content()).toString(), 'hello');
});

test('a Zip64 extra field value beyond Number.MAX_SAFE_INTEGER is rejected', async () => {
  const name = 'f.txt';
  const content = Buffer.from('hello');
  const entry = await zlib.ZipEntry.create(name, content, { method: 'store' });
  const archive = await buildArchive([entry]);

  const patched = injectZip64Extra(archive, name, content.length, {
    uncompressedSize: 0xffffffffffffffffn,
  });

  const [read] = zlib.ZipEntry.read(patched);
  assert.throws(() => read.size, {
    code: 'ERR_ZIP_INVALID_ARCHIVE',
    message: /exceeds the safe integer range/,
  });
});

// Injects a raw, already-built Zip64 extra-field TLV (rather than one built
// via injectZip64Extra()'s field map), to exercise the parser's own
// malformed/truncated-input rejections.
function injectRawZip64Extra(archive, name, contentLength, extraBytes) {
  const centralHeaderStart = 30 + name.length + contentLength;
  const nameStart = centralHeaderStart + 46;
  const extraLengthOffset = centralHeaderStart + 30;
  assert.strictEqual(archive.readUInt16LE(extraLengthOffset), 0);
  const before = archive.subarray(0, nameStart + name.length);
  const after = archive.subarray(nameStart + name.length);
  const patched = Buffer.concat([before, extraBytes, after]);
  patched.writeUInt16LE(extraBytes.length, extraLengthOffset);
  patched.writeUInt32LE(0xffffffff, centralHeaderStart + 24); // uncompressedSize sentinel
  const eocdOffset = patched.length - 22;
  const oldCdSize = patched.readUInt32LE(eocdOffset + 12);
  patched.writeUInt32LE(oldCdSize + extraBytes.length, eocdOffset + 12);
  return patched;
}

test('a Zip64 extra-field TLV whose declared size overflows the extra field is rejected', async () => {
  const name = 'f.txt';
  const content = Buffer.from('hello');
  const entry = await zlib.ZipEntry.create(name, content, { method: 'store' });
  const archive = await buildArchive([entry]);

  const tlv = Buffer.allocUnsafe(8);
  tlv.writeUInt16LE(0x0001, 0);
  tlv.writeUInt16LE(100, 2); // claims 100 bytes of data, but none follow
  const patched = injectRawZip64Extra(archive, name, content.length, tlv);

  const [read] = zlib.ZipEntry.read(patched);
  assert.throws(() => read.size, {
    code: 'ERR_ZIP_INVALID_ARCHIVE',
    message: /extra field is malformed/,
  });
});

test('a Zip64 extra-field TLV too short for the field it claims to carry is rejected', async () => {
  const name = 'f.txt';
  const content = Buffer.from('hello');
  const entry = await zlib.ZipEntry.create(name, content, { method: 'store' });
  const archive = await buildArchive([entry]);

  // Declares only 4 bytes of data, but a sentinel uncompressedSize needs 8.
  const tlv = Buffer.allocUnsafe(8);
  tlv.writeUInt16LE(0x0001, 0);
  tlv.writeUInt16LE(4, 2);
  tlv.writeUInt32LE(123, 4);
  const patched = injectRawZip64Extra(archive, name, content.length, tlv);

  const [read] = zlib.ZipEntry.read(patched);
  assert.throws(() => read.size, {
    code: 'ERR_ZIP_INVALID_ARCHIVE',
    message: /Zip64 extended information extra field is truncated/,
  });
});

// -- buffer coercion -----------------------------------------------------------

test('create() accepts a DataView, a non-Uint8Array TypedArray, and an ArrayBuffer', async () => {
  const ab = new ArrayBuffer(4);
  new Uint8Array(ab).set([1, 2, 3, 4]);

  const dv = new DataView(ab, 1, 2);
  const fromDataView = await zlib.ZipEntry.create('dv.bin', dv);
  assert.strictEqual((await fromDataView.content()).length, 2);

  const i32 = new Int32Array([10, 20, 30]);
  const fromTypedArray = await zlib.ZipEntry.create('i32.bin', i32);
  assert.strictEqual((await fromTypedArray.content()).length, 12);

  const fromArrayBuffer = await zlib.ZipEntry.create('ab.bin', ab);
  assert.strictEqual((await fromArrayBuffer.content()).length, 4);
});

// -- entry-metadata validation -------------------------------------------------

test('create() validates comment length, modified type, and method value', async () => {
  await assert.rejects(
    zlib.ZipEntry.create('f.txt', Buffer.alloc(0), { comment: 'x'.repeat(70000) }),
    { code: 'ERR_ZIP_ENTRY_TOO_LARGE' },
  );
  await assert.rejects(
    zlib.ZipEntry.create('f.txt', Buffer.alloc(0), { modified: 123 }),
    { code: 'ERR_INVALID_ARG_TYPE' },
  );
  await assert.rejects(
    zlib.ZipEntry.create('f.txt', Buffer.alloc(0), { method: 'bogus' }),
    { code: 'ERR_INVALID_ARG_VALUE' },
  );
});

test('a directory entry must have empty content, for create(), createSync(), and createStream()', async () => {
  await assert.rejects(
    zlib.ZipEntry.create('dir/', Buffer.from('x')), { code: 'ERR_INVALID_ARG_VALUE' });
  assert.throws(
    () => zlib.ZipEntry.createSync('dir/', Buffer.from('x')), { code: 'ERR_INVALID_ARG_VALUE' });
  assert.throws(
    () => zlib.ZipEntry.createStream('dir/', (async function* () {})()), { code: 'ERR_INVALID_ARG_VALUE' });
});

test('createZipArchive()/createZipArchiveSync() validate the archive comment length', async () => {
  await assert.rejects(drain(zlib.createZipArchive([], 'x'.repeat(70000))),
                       { code: 'ERR_ZIP_ENTRY_TOO_LARGE' });
  assert.throws(() => [...zlib.createZipArchiveSync([], 'x'.repeat(70000))],
                { code: 'ERR_ZIP_ENTRY_TOO_LARGE' });
});

// -- streaming-entry state guards ----------------------------------------------

test('a pending streaming entry rejects size/crc32/compressedSize/content access', () => {
  const streaming = zlib.ZipEntry.createStream(
    'big.bin', (async function* () { yield Buffer.from('x'); })());
  assert.throws(() => streaming.size, { code: 'ERR_INVALID_STATE' });
  assert.throws(() => streaming.crc32, { code: 'ERR_INVALID_STATE' });
  assert.throws(() => streaming.compressedSize, { code: 'ERR_INVALID_STATE' });
  assert.throws(() => streaming.contentIterator(), { code: 'ERR_INVALID_STATE' });
  assert.throws(() => streaming.contentSync(), { code: 'ERR_INVALID_STATE' });
});

// Once a streaming entry has been serialized on its own (via createZipArchive,
// not into a writable ZipFile that would promote it), its source is spent and
// there is nothing to read back. Reads must fail with a clean state error, not
// silently decode an empty buffer and report ERR_ZIP_ENTRY_CORRUPT.
test('a spent (serialized-but-unpromoted) streaming entry rejects reads cleanly', async () => {
  const entry = zlib.ZipEntry.createStream('s.txt', (async function* () { yield Buffer.from('hello'); })());
  await drain(entry);
  await assert.rejects(entry.content(), { code: 'ERR_INVALID_STATE' });
  assert.throws(() => entry.contentSync(), { code: 'ERR_INVALID_STATE' });
  assert.throws(() => entry.contentIterator(), { code: 'ERR_INVALID_STATE' });
});

test('a streaming entry can only be serialized once', async () => {
  const entry = zlib.ZipEntry.createStream('a.bin', (async function* () { yield Buffer.from('x'); })());
  await drain(entry);
  await assert.rejects(drain(entry), { code: 'ERR_INVALID_STATE' });
});

test('a streaming entry rejects a non-Uint8Array chunk from its source', async () => {
  async function* badSource() {
    yield Buffer.alloc(0); // An empty chunk is silently skipped
    yield 'not a buffer';
  }
  const entry = zlib.ZipEntry.createStream('b.bin', badSource());
  await assert.rejects(drain(entry), { code: 'ERR_INVALID_ARG_TYPE' });
});

test('a streaming entry can use zstd compression end-to-end', async () => {
  const payload = 'zstd stream content '.repeat(50);
  async function* source() { yield Buffer.from(payload); }
  const entry = zlib.ZipEntry.createStream('c.bin', source(), { method: 'zstd' });
  const archive = await buildArchive([entry]);

  const [read] = zlib.ZipEntry.read(archive);
  assert.strictEqual(read.method, 93);
  assert.strictEqual((await read.content()).toString(), payload);
});

test('an error from a streaming entry\'s source propagates and cleans up (deflate and zstd)', async () => {
  for (const method of ['deflate', 'zstd']) {
    async function* badSource() {
      yield Buffer.from('some data before the error');
      throw new Error(`source blew up (${method})`);
    }
    const entry = zlib.ZipEntry.createStream('big.bin', badSource(), { method });
    await assert.rejects(drain(entry), { message: `source blew up (${method})` });
  }
});

// -- contentIterator() / decodeMemberStream() error paths ------------------------

test('contentIterator() enforces the same guards as content() and contentSync()', async () => {
  // Encrypted.
  {
    const entry = await zlib.ZipEntry.create('f.txt', Buffer.from('secret'), { method: 'store' });
    const archive = await buildArchive([entry]);
    const tampered = Buffer.from(archive);
    tampered.writeUInt16LE(tampered.readUInt16LE(6) | 0x0001, 6);
    const centralStart = 30 + 'f.txt'.length + 'secret'.length;
    tampered.writeUInt16LE(tampered.readUInt16LE(centralStart + 8) | 0x0001, centralStart + 8);
    const [read] = zlib.ZipEntry.read(tampered);
    await assert.rejects(drain(read.contentIterator()), { code: 'ERR_ZIP_UNSUPPORTED_FEATURE' });
  }
  // Unsupported compression method.
  {
    const entry = await zlib.ZipEntry.create('f.txt', Buffer.from('hi'), { method: 'store' });
    const archive = await buildArchive([entry]);
    const tampered = Buffer.from(archive);
    tampered.writeUInt16LE(1, 8);
    const centralStart = 30 + 'f.txt'.length + 'hi'.length;
    tampered.writeUInt16LE(1, centralStart + 10);
    const [read] = zlib.ZipEntry.read(tampered);
    await assert.rejects(drain(read.contentIterator()), { code: 'ERR_ZIP_UNSUPPORTED_FEATURE' });
  }
  // maxSize enforced up front.
  {
    const entry = await zlib.ZipEntry.create('f.txt', Buffer.from('hello world'));
    await assert.rejects(drain(entry.contentIterator({ maxSize: 1 })), { code: 'ERR_ZIP_ENTRY_TOO_LARGE' });
  }
  // Declared-size mismatch.
  {
    const entry = await zlib.ZipEntry.create('f.txt', Buffer.from('hello world'), { method: 'store' });
    const archive = await buildArchive([entry]);
    const tampered = Buffer.from(archive);
    const centralStart = 30 + 'f.txt'.length + 'hello world'.length;
    tampered.writeUInt32LE(1, centralStart + 24);
    const [read] = zlib.ZipEntry.read(tampered);
    await assert.rejects(drain(read.contentIterator()), { code: 'ERR_ZIP_ENTRY_CORRUPT' });
  }
  // CRC-32 mismatch, and disabling verification.
  {
    const entry = await zlib.ZipEntry.create('f.txt', Buffer.from('hello world'), { method: 'store' });
    const archive = await buildArchive([entry]);
    const tampered = Buffer.from(archive);
    tampered[30 + 'f.txt'.length] ^= 0xff;
    const [read] = zlib.ZipEntry.read(tampered);
    await assert.rejects(drain(read.contentIterator()), { code: 'ERR_ZIP_ENTRY_CORRUPT' });
    const unverified = await drain(read.contentIterator({ verify: false }));
    assert.strictEqual(unverified.length, 'hello world'.length);
  }
});

// -- content()/contentSync() zstd-specific branches ----------------------------

test('content() and contentSync() enforce maxSize and detect corruption for zstd entries', async () => {
  {
    const entry = await zlib.ZipEntry.create('f.txt', Buffer.from('y'.repeat(5000)), { method: 'zstd' });
    const archive = await buildArchive([entry]);
    const [read] = zlib.ZipEntry.read(archive);
    assert.strictEqual(read.method, 93);
    await assert.rejects(read.content({ maxSize: 10 }), { code: 'ERR_ZIP_ENTRY_TOO_LARGE' });
  }
  {
    const entry = await zlib.ZipEntry.create('f.txt', Buffer.from('z'.repeat(200)), { method: 'zstd' });
    const archive = await buildArchive([entry]);
    const tampered = Buffer.from(archive);
    const contentStart = 30 + 'f.txt'.length;
    tampered.fill(0xff, contentStart, contentStart + 4); // Break the zstd frame itself
    const [read] = zlib.ZipEntry.read(tampered);
    await assert.rejects(read.content(), { code: 'ERR_ZIP_ENTRY_CORRUPT' });
    assert.throws(() => read.contentSync(), { code: 'ERR_ZIP_ENTRY_CORRUPT' });
  }
});

// `decodeMemberSync()` (used by `ZipEntry.prototype.contentSync()`) duplicates
// `decodeMemberStream()`'s guards for its own, separate synchronous code
// path; exercise them through a disk-backed ZipFile.
test('ZipFile getSync().contentSync() enforces the same guards via decodeMemberSync()', async () => {
  async function writeTempArchive(archive, suffix) {
    const filePath = path.join(os.tmpdir(), `zip-coverage-contentsync-${process.pid}-${suffix}.zip`);
    await fs.writeFile(filePath, archive);
    return filePath;
  }

  // Encrypted.
  {
    const entry = await zlib.ZipEntry.create('f.txt', Buffer.from('secret'), { method: 'store' });
    const archive = await buildArchive([entry]);
    const tampered = Buffer.from(archive);
    tampered.writeUInt16LE(tampered.readUInt16LE(6) | 0x0001, 6);
    const centralStart = 30 + 'f.txt'.length + 'secret'.length;
    tampered.writeUInt16LE(tampered.readUInt16LE(centralStart + 8) | 0x0001, centralStart + 8);
    const filePath = await writeTempArchive(tampered, 'encrypted');
    const zf = zlib.ZipFile.openSync(filePath);
    assert.throws(() => zf.getSync('f.txt').contentSync(), { code: 'ERR_ZIP_UNSUPPORTED_FEATURE' });
    zf.closeSync();
    await fs.unlink(filePath);
  }
  // maxSize, for both the deflate and the zstd decode branch.
  for (const method of ['deflate', 'zstd']) {
    const entry = await zlib.ZipEntry.create('f.txt', Buffer.from('y'.repeat(5000)), { method });
    const archive = await buildArchive([entry]);
    const filePath = await writeTempArchive(archive, `maxsize-${method}`);
    const zf = zlib.ZipFile.openSync(filePath);
    assert.throws(() => zf.getSync('f.txt').contentSync({ maxSize: 10 }), { code: 'ERR_ZIP_ENTRY_TOO_LARGE' });
    zf.closeSync();
    await fs.unlink(filePath);
  }
  // A genuine decompression failure (not just a CRC mismatch after a
  // successful decode).
  {
    const entry = await zlib.ZipEntry.create('f.txt', Buffer.from('y'.repeat(500)), { method: 'deflate' });
    const archive = await buildArchive([entry]);
    const tampered = Buffer.from(archive);
    const contentStart = 30 + 'f.txt'.length;
    tampered.fill(0xff, contentStart, contentStart + 4);
    const filePath = await writeTempArchive(tampered, 'deflate-corrupt');
    const zf = zlib.ZipFile.openSync(filePath);
    assert.throws(() => zf.getSync('f.txt').contentSync(), { code: 'ERR_ZIP_ENTRY_CORRUPT' });
    zf.closeSync();
    await fs.unlink(filePath);
  }
  // Declared-size mismatch ("produced N bytes, expected M").
  {
    const entry = await zlib.ZipEntry.create('f.txt', Buffer.from('hello world'), { method: 'store' });
    const archive = await buildArchive([entry]);
    const tampered = Buffer.from(archive);
    const centralStart = 30 + 'f.txt'.length + 'hello world'.length;
    tampered.writeUInt32LE(1, centralStart + 24);
    const filePath = await writeTempArchive(tampered, 'size-mismatch');
    const zf = zlib.ZipFile.openSync(filePath);
    assert.throws(() => zf.getSync('f.txt').contentSync(), { code: 'ERR_ZIP_ENTRY_CORRUPT' });
    zf.closeSync();
    await fs.unlink(filePath);
  }
});

test('contentIterator() rejects an entry that inflates to less than its declared size', async () => {
  const entry = await zlib.ZipEntry.create('f.txt', Buffer.from('hi'), { method: 'store' });
  const archive = await buildArchive([entry]);
  const tampered = Buffer.from(archive);
  const centralStart = 30 + 'f.txt'.length + 'hi'.length;
  tampered.writeUInt32LE(1000, centralStart + 24); // Declared size grown beyond reality
  const [read] = zlib.ZipEntry.read(tampered);
  await assert.rejects(drain(read.contentIterator()), {
    code: 'ERR_ZIP_ENTRY_CORRUPT',
    message: /is truncated/,
  });
});

// -- ZipBuffer / ZipFile iteration protocols -----------------------------------

test('ZipBuffer exposes Map-like forEach/values/entries/iteration/toStringTag', async () => {
  const archive = await buildArchive([
    await zlib.ZipEntry.create('a.txt', Buffer.from('1')),
    await zlib.ZipEntry.create('b.txt', Buffer.from('2')),
  ]);
  const zip = new zlib.ZipBuffer(archive);

  const seen = [];
  zip.forEach((entry, key, self) => {
    seen.push(key);
    assert.strictEqual(self, zip);
    assert.strictEqual(entry.name, key);
  });
  assert.deepStrictEqual(seen.sort(), ['a.txt', 'b.txt']);

  assert.deepStrictEqual([...zip.values()].map((e) => e.name).sort(), ['a.txt', 'b.txt']);
  assert.deepStrictEqual([...zip.entries()].map(([k]) => k).sort(), ['a.txt', 'b.txt']);
  assert.deepStrictEqual([...zip].map(([k]) => k).sort(), ['a.txt', 'b.txt']);
  assert.strictEqual(Object.prototype.toString.call(zip), '[object ZipBuffer]');
  assert.throws(() => zip.addEntry({}), { code: 'ERR_INVALID_ARG_TYPE' });
});

test('ZipFile exposes the same iteration protocol, plus its Sync counterparts', async () => {
  const archive = await buildArchive([
    await zlib.ZipEntry.create('a.txt', Buffer.from('1')),
    await zlib.ZipEntry.create('b.txt', Buffer.from('2')),
  ]);
  const filePath = path.join(os.tmpdir(), `zip-coverage-iteration-${process.pid}.zip`);
  await fs.writeFile(filePath, archive);

  const zf = await zlib.ZipFile.open(filePath);
  try {
    const pending = [];
    zf.forEach((valuePromise) => pending.push(valuePromise));
    await Promise.all(pending); // Let every dangling get() settle before closing

    zf.forEachSync(() => {});
    assert.deepStrictEqual([...zf.valuesSync()].map((e) => e.name).sort(), ['a.txt', 'b.txt']);
    assert.deepStrictEqual([...zf.entriesSync()].map(([k]) => k).sort(), ['a.txt', 'b.txt']);
    assert.deepStrictEqual([...zf.keys()].sort(), ['a.txt', 'b.txt']);
    assert.strictEqual(zf.size, 2);
    assert.strictEqual(Object.prototype.toString.call(zf), '[object ZipFile]');

    const names = [];
    for await (const entry of zf) names.push(entry.name);
    assert.deepStrictEqual(names.sort(), ['a.txt', 'b.txt']);

    // Synchronous iteration (Symbol.iterator) yields [name, Promise<ZipEntry>].
    const syncPairs = [...zf];
    assert.deepStrictEqual(syncPairs.map(([k]) => k).sort(), ['a.txt', 'b.txt']);
    const resolved = await Promise.all(syncPairs.map(([, v]) => v));
    assert.deepStrictEqual(resolved.map((e) => e.name).sort(), ['a.txt', 'b.txt']);
  } finally {
    await zf[Symbol.asyncDispose]();
  }

  const writable = await zlib.ZipFile.open(filePath, { writable: true });
  await assert.rejects(writable.addEntry({}), { code: 'ERR_INVALID_ARG_TYPE' });
  assert.throws(() => writable.addEntrySync({}), { code: 'ERR_INVALID_ARG_TYPE' });
  await writable.close();

  const zf2 = zlib.ZipFile.openSync(filePath);
  zf2[Symbol.dispose]();

  await fs.unlink(filePath);
});

// -- ZipFile (on-disk) error paths ---------------------------------------------

test('ZipFile.open()/openSync() reject a file with no end-of-central-directory record', async () => {
  const filePath = path.join(os.tmpdir(), `zip-coverage-garbage-${process.pid}.zip`);
  await fs.writeFile(filePath, Buffer.from('not a zip file, just garbage bytes'));
  try {
    await assert.rejects(zlib.ZipFile.open(filePath), { code: 'ERR_ZIP_INVALID_ARCHIVE' });
    assert.throws(() => zlib.ZipFile.openSync(filePath), { code: 'ERR_ZIP_INVALID_ARCHIVE' });
  } finally {
    await fs.unlink(filePath);
  }
});

test('ZipFile get()/getSync()/stream() reject a missing entry name', async () => {
  const archive = await buildArchive([await zlib.ZipEntry.create('a.txt', Buffer.from('x'))]);
  const filePath = path.join(os.tmpdir(), `zip-coverage-notfound-${process.pid}.zip`);
  await fs.writeFile(filePath, archive);
  const zf = await zlib.ZipFile.open(filePath);
  try {
    await assert.rejects(zf.get('missing'), { code: 'ERR_ZIP_ENTRY_NOT_FOUND' });
    assert.throws(() => zf.getSync('missing'), { code: 'ERR_ZIP_ENTRY_NOT_FOUND' });
    await assert.rejects(zf.stream('missing'), { code: 'ERR_ZIP_ENTRY_NOT_FOUND' });
  } finally {
    await zf.close();
    await fs.unlink(filePath);
  }
});

test('a corrupted local file header offset is rejected when the entry is read', async () => {
  const name = 'a.txt';
  const content = Buffer.from('hello');
  const archive = await buildArchive([await zlib.ZipEntry.create(name, content, { method: 'store' })]);
  const centralHeaderStart = 30 + name.length + content.length;
  const tampered = Buffer.from(archive);
  // Point the local file header offset at the central directory itself
  // (signature 0x02014b50, not the local-header signature 0x04034b50).
  tampered.writeUInt32LE(centralHeaderStart, centralHeaderStart + 42);
  const filePath = path.join(os.tmpdir(), `zip-coverage-badlocal-${process.pid}.zip`);
  await fs.writeFile(filePath, tampered);

  const zf = await zlib.ZipFile.open(filePath);
  const zfSync = zlib.ZipFile.openSync(filePath);
  try {
    // get() is lazy; the corrupt header is only seen when the entry is read.
    await assert.rejects((await zf.get(name)).content(), { code: 'ERR_ZIP_INVALID_ARCHIVE' });
    assert.throws(() => zfSync.getSync(name).contentSync(), { code: 'ERR_ZIP_INVALID_ARCHIVE' });
  } finally {
    await zf.close();
    zfSync.closeSync();
    await fs.unlink(filePath);
  }
});

test('a declared compressed size reaching past the end of the file is rejected', async () => {
  const name = 'a.txt';
  const content = Buffer.from('hello');
  const archive = await buildArchive([await zlib.ZipEntry.create(name, content, { method: 'store' })]);
  const centralHeaderStart = 30 + name.length + content.length;
  const tampered = Buffer.from(archive);
  tampered.writeUInt32LE(archive.length * 10, centralHeaderStart + 20); // compressedSize
  const filePath = path.join(os.tmpdir(), `zip-coverage-eof-${process.pid}.zip`);
  await fs.writeFile(filePath, tampered);

  const zf = await zlib.ZipFile.open(filePath);
  const zfSync = zlib.ZipFile.openSync(filePath);
  try {
    // get() is lazy; the truncated read is only hit when the entry is read.
    await assert.rejects((await zf.get(name)).content(), { code: 'ERR_ZIP_INVALID_ARCHIVE' });
    assert.throws(() => zfSync.getSync(name).contentSync(), { code: 'ERR_ZIP_INVALID_ARCHIVE' });
  } finally {
    await zf.close();
    zfSync.closeSync();
    await fs.unlink(filePath);
  }
});

test('content()/contentSync() refuse to buffer an entry declaring more than kMaxLength bytes', async () => {
  const name = 'f.txt';
  const content = Buffer.from('hello');
  const archive = await buildArchive([await zlib.ZipEntry.create(name, content, { method: 'store' })]);

  // A Zip64-declared compressedSize equal to kMaxLength is the largest value
  // that still parses (readSafeUint64 caps at the safe-integer ceiling, which
  // is kMaxLength on 64-bit) yet is too large to hold in a single buffer.
  // get()/getSync() are lazy and never read here; the refusal happens when the
  // buffering read paths try to allocate - no multi-GB file is needed, since
  // the check runs before any read.
  const centralHeaderStart = 30 + name.length + content.length;
  const nameStart = centralHeaderStart + 46;
  const tlv = Buffer.allocUnsafe(4 + 8);
  tlv.writeUInt16LE(0x0001, 0);
  tlv.writeUInt16LE(8, 2);
  tlv.writeBigUInt64LE(BigInt(require('node:buffer').kMaxLength), 4);
  const before = archive.subarray(0, nameStart + name.length);
  const after = archive.subarray(nameStart + name.length);
  const patched = Buffer.concat([before, tlv, after]);
  patched.writeUInt16LE(tlv.length, centralHeaderStart + 30);
  patched.writeUInt32LE(0xffffffff, centralHeaderStart + 20); // compressedSize sentinel
  const eocdOffset = patched.length - 22;
  patched.writeUInt32LE(patched.readUInt32LE(eocdOffset + 12) + tlv.length, eocdOffset + 12);

  const toolargeFilePath = path.join(os.tmpdir(), `zip-coverage-toolarge-${process.pid}.zip`);
  await fs.writeFile(toolargeFilePath, patched);
  const zf2 = await zlib.ZipFile.open(toolargeFilePath);
  const zf2Sync = zlib.ZipFile.openSync(toolargeFilePath);
  try {
    // get()/getSync() are lazy, so they resolve without touching the member.
    const entry = await zf2.get(name);
    await assert.rejects(entry.content(),
                         { code: 'ERR_ZIP_ENTRY_TOO_LARGE', message: /use contentIterator\(\) instead/ });
    assert.throws(() => zf2Sync.getSync(name).contentSync(),
                  { code: 'ERR_ZIP_ENTRY_TOO_LARGE', message: /use contentIterator\(\) instead/ });
  } finally {
    await zf2.close();
    zf2Sync.closeSync();
    await fs.unlink(toolargeFilePath);
  }
});

// -- forcing Zip64 structures without a multi-gigabyte archive -----------------

test('createZipArchiveSync() also switches to Zip64 structures at 0xFFFF entries', () => {
  const ZIP64_EOCD_SIGNATURE = Buffer.from([0x50, 0x4b, 0x06, 0x06]);
  const entries = [];
  for (let i = 0; i < 0x10000; i++) {
    entries.push(zlib.ZipEntry.createSync(`entry-${i}`, Buffer.alloc(0), { method: 'store' }));
  }
  const chunks = [];
  for (const chunk of zlib.createZipArchiveSync(entries)) chunks.push(chunk);
  const archive = Buffer.concat(chunks);
  assert.ok(archive.includes(ZIP64_EOCD_SIGNATURE));
  assert.strictEqual([...zlib.ZipEntry.read(archive)].length, 0x10000);
}, { timeout: 120_000 });

// -- createZipArchive()'s single options argument, baseOffset, and Readable return --

const CENTRAL_FILE_HEADER_SIGNATURE = Buffer.from([0x50, 0x4b, 0x01, 0x02]);

test('createZipArchive() returns a pipeable, async-iterable, non-object-mode Readable', async () => {
  const { Readable } = require('node:stream');
  const entry = await zlib.ZipEntry.create('f.txt', Buffer.from('hi'));
  const stream = zlib.createZipArchive([entry]);
  assert.ok(stream instanceof Readable);
  assert.strictEqual(stream.readableObjectMode, false);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.strictEqual([...zlib.ZipEntry.read(Buffer.concat(chunks))][0].name, 'f.txt');
});

test('createZipArchive()/createZipArchiveSync() take a plain string as comment shorthand', async () => {
  const entry = await zlib.ZipEntry.create('f.txt', Buffer.from('hi'));
  const zip = new zlib.ZipBuffer(await drain(zlib.createZipArchive([entry], 'hello')));
  assert.strictEqual(zip.comment, 'hello');

  const entrySync = zlib.ZipEntry.createSync('f.txt', Buffer.from('hi'));
  const chunks = [...zlib.createZipArchiveSync([entrySync], 'hello-sync')];
  const zipSync = new zlib.ZipBuffer(Buffer.concat(chunks));
  assert.strictEqual(zipSync.comment, 'hello-sync');
});

test('createZipArchive()/createZipArchiveSync() take an { comment, baseOffset } options object', async () => {
  const entry = await zlib.ZipEntry.create('f.txt', Buffer.from('hi'));
  const zip = new zlib.ZipBuffer(await drain(zlib.createZipArchive([entry], { comment: 'hi there' })));
  assert.strictEqual(zip.comment, 'hi there');
});

test('createZipArchive()/createZipArchiveSync() reject a non-string, non-object options argument', async () => {
  await assert.rejects(drain(zlib.createZipArchive([], 123)), { code: 'ERR_INVALID_ARG_TYPE' });
  assert.throws(() => [...zlib.createZipArchiveSync([], 123)], { code: 'ERR_INVALID_ARG_TYPE' });
  await assert.rejects(drain(zlib.createZipArchive([], null)), { code: 'ERR_INVALID_ARG_TYPE' });
});

test('createZipArchive()/createZipArchiveSync() validate options.baseOffset', async () => {
  await assert.rejects(drain(zlib.createZipArchive([], { baseOffset: -1 })), { code: 'ERR_OUT_OF_RANGE' });
  await assert.rejects(drain(zlib.createZipArchive([], { baseOffset: 1.5 })), { code: 'ERR_OUT_OF_RANGE' });
  assert.throws(() => [...zlib.createZipArchiveSync([], { baseOffset: -1 })], { code: 'ERR_OUT_OF_RANGE' });
});

test('options.baseOffset shifts every recorded offset, so a prefixed archive is ' +
     'self-describing without relying on prefix auto-detection', async () => {
  const entry = await zlib.ZipEntry.create('f.txt', Buffer.from('hello offset'));
  const prefix = Buffer.from('#!/bin/sh\nexit 0\n');

  const shifted = await drain(zlib.createZipArchive([entry], { baseOffset: prefix.byteLength }));
  const shiftedCentral = shifted.indexOf(CENTRAL_FILE_HEADER_SIGNATURE);
  assert.strictEqual(shifted.readUInt32LE(shiftedCentral + 42), prefix.byteLength);

  const entryUnshifted = await zlib.ZipEntry.create('f.txt', Buffer.from('hello offset'));
  const unshifted = await drain(zlib.createZipArchive([entryUnshifted]));
  const unshiftedCentral = unshifted.indexOf(CENTRAL_FILE_HEADER_SIGNATURE);
  assert.strictEqual(unshifted.readUInt32LE(unshiftedCentral + 42), 0);

  const combined = Buffer.concat([prefix, shifted]);
  const zip = new zlib.ZipBuffer(combined);
  assert.strictEqual((await zip.get('f.txt').content()).toString(), 'hello offset');
});

test('zipBuffer.toBuffer()/toBufferSync() forward the same string/options-object shorthand', async () => {
  const zip = new zlib.ZipBuffer(await drain(zlib.createZipArchive([])));
  await zip.add('f.txt', Buffer.from('hi'));

  assert.strictEqual(new zlib.ZipBuffer(await zip.toBuffer('a comment')).comment, 'a comment');
  assert.strictEqual(new zlib.ZipBuffer(await zip.toBuffer({ comment: 'an object comment' })).comment,
                     'an object comment');
  assert.strictEqual(new zlib.ZipBuffer(zip.toBufferSync('sync comment')).comment, 'sync comment');

  const prefix = Buffer.from('junk\n');
  const shifted = await zip.toBuffer({ baseOffset: prefix.byteLength });
  const shiftedCentral = shifted.indexOf(CENTRAL_FILE_HEADER_SIGNATURE);
  assert.strictEqual(shifted.readUInt32LE(shiftedCentral + 42), prefix.byteLength);
});
