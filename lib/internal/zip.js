'use strict';

const {
  ArrayPrototypePush,
  BigInt,
  Date,
  FunctionPrototypeCall,
  JSONStringify,
  Map,
  MapPrototypeClear,
  MapPrototypeDelete,
  MapPrototypeEntries,
  MapPrototypeGet,
  MapPrototypeGetSize,
  MapPrototypeHas,
  MapPrototypeKeys,
  MapPrototypeSet,
  MathMax,
  MathMin,
  Number,
  NumberIsInteger,
  NumberIsNaN,
  NumberMAX_SAFE_INTEGER,
  Promise,
  PromisePrototypeThen,
  PromiseResolve,
  StringPrototypeEndsWith,
  Symbol,
  SymbolAsyncDispose,
  SymbolAsyncIterator,
  SymbolDispose,
  SymbolIterator,
  SymbolToStringTag,
} = primordials;

const {
  codes: {
    ERR_INVALID_ARG_TYPE,
    ERR_INVALID_ARG_VALUE,
    ERR_INVALID_STATE,
    ERR_ZIP_ENTRY_CORRUPT,
    ERR_ZIP_ENTRY_NOT_FOUND,
    ERR_ZIP_ENTRY_TOO_LARGE,
    ERR_ZIP_INVALID_ARCHIVE,
    ERR_ZIP_NOT_WRITABLE,
    ERR_ZIP_UNSUPPORTED_FEATURE,
  },
} = require('internal/errors');
const {
  validateBoolean,
  validateFunction,
  validateInteger,
  validateObject,
  validateString,
  validateUint32,
} = require('internal/validators');
const {
  isAnyArrayBuffer,
  isArrayBufferView,
  isDate,
  isUint8Array,
} = require('internal/util/types');
const { Buffer, kMaxLength } = require('buffer');
const { FastBuffer } = require('internal/buffer');
const { Readable } = require('stream');
const fs = require('fs');
const { crc32: crc32Native } = internalBinding('zlib');

// `internal/zip` is required from `lib/zlib.js`, so it must not require the
// public `zlib` facade at load time (its module.exports is not yet
// populated). Compression is only needed once an entry is actually read or
// written, well after `zlib.js` has finished loading, so a lazy reference is
// enough to break the cycle.
let zlib;
function lazyZlib() {
  zlib ??= require('zlib');
  return zlib;
}

const EMPTY_BUFFER = new FastBuffer();
const BIGINT_MAX_SAFE_INTEGER = BigInt(NumberMAX_SAFE_INTEGER);

// ZIP record signatures (APPNOTE.TXT, PKWARE Inc.)
const SIG_LOCAL_FILE_HEADER = 0x04034b50; // sec. 4.3.7
const SIG_DATA_DESCRIPTOR = 0x08074b50; // sec. 4.3.9
const SIG_CENTRAL_FILE_HEADER = 0x02014b50; // sec. 4.3.12
const SIG_ZIP64_EOCD_RECORD = 0x06064b50; // sec. 4.3.14
const SIG_ZIP64_EOCD_LOCATOR = 0x07064b50; // sec. 4.3.15
const SIG_EOCD = 0x06054b50; // sec. 4.3.16

const MADE_BY_UNIX = 3; // sec. 4.4.2
const ZIP64_EXTRA_ID = 0x0001; // sec. 4.5.3

const SENTINEL16 = 0xffff;
const SENTINEL32 = 0xffffffff;

const FLAG_ENCRYPTED = 0x0001; // sec. 4.4.4 bit 0
const FLAG_DATA_DESCRIPTOR = 0x0008; // bit 3
const FLAG_UTF8 = 0x0800; // bit 11: name/comment are UTF-8 (EFS)

const METHOD_STORE = 0; // sec. 4.4.5
const METHOD_DEFLATE = 8; // sec. 4.4.5
const METHOD_ZSTD = 93; // sec. 4.4.5

const VERSION_DEFAULT = 20; // 2.0: deflate + directories (sec. 4.4.3)
const VERSION_ZIP64 = 45; // 4.5: Zip64 structures

const S_IFREG = 0o100000; // Unix mode type bits: regular file
const S_IFDIR = 0o040000; // Unix mode type bits: directory

const kFinalize = Symbol('kFinalize');
const kPromote = Symbol('kPromote');

// A default ceiling on the uncompressed size that the buffering read paths
// (`ZipEntry.prototype.content()`, and therefore `ZipBuffer`/`ZipFile`
// `get()`) will materialize in memory when the caller does not pass an
// explicit `maxSize`. An archive whose central directory declares a member
// larger than this is rejected before any large allocation happens. Callers
// that need larger members can either pass a per-call `maxSize` or raise the
// module default with `setMaxZipContentSize()`. The streaming read paths
// (`contentIterator()`, `ZipFile.prototype.stream()`) are bounded-memory by
// design and are not subject to this default.
const DEFAULT_MAX_ZIP_CONTENT_SIZE = 256 * 1024 * 1024; // 256 MiB
let maxZipContentSize = DEFAULT_MAX_ZIP_CONTENT_SIZE;

/**
 * @returns {number}
 */
function getMaxZipContentSize() {
  return maxZipContentSize;
}

/**
 * @param {number} size
 * @returns {void}
 */
function setMaxZipContentSize(size) {
  validateInteger(size, 'size', 0);
  maxZipContentSize = size;
}

// DOS date/time (sec. 4.4.6): local time by convention.
// time: bits 0-4 seconds/2, 5-10 minutes, 11-15 hours
// date: bits 0-4 day, 5-8 month, 9-15 years since 1980
function decodeDosDateTime(time, date) {
  // A zeroed/absent date field has month 0 and day 0, both invalid; the DOS
  // epoch is 1980-01-01. Month/day 0 are treated as 1 so a zero field decodes
  // to 1980-01-01 (and re-encodes to the same value).
  return new Date(
    ((date >>> 9) & 0x7f) + 1980,
    ((date >>> 5) & 0x0f || 1) - 1,
    (date & 0x1f) || 1,
    (time >>> 11) & 0x1f,
    (time >>> 5) & 0x3f,
    (time & 0x1f) * 2,
  );
}

function encodeDosDateTime(value) {
  const year = value.getFullYear();
  if (NumberIsNaN(year)) {
    throw new ERR_INVALID_ARG_VALUE('modified', value, 'must be a valid Date');
  }
  if (year < 1980) return { time: 0, date: (1 << 5) | 1 }; // Clamp to 1980-01-01 00:00:00
  if (year > 2107) {
    // Clamp to 2107-12-31 23:59:58
    return {
      time: (23 << 11) | (59 << 5) | 29,
      date: (127 << 9) | (12 << 5) | 31,
    };
  }
  const date =
    ((year - 1980) << 9) | ((value.getMonth() + 1) << 5) | value.getDate();
  const time =
    (value.getHours() << 11) |
    (value.getMinutes() << 5) |
    (value.getSeconds() >>> 1);
  return { time, date };
}

function validateArchiveRange(buffer, offset, length, what) {
  if (
    !NumberIsInteger(offset) ||
    offset < 0 ||
    !NumberIsInteger(length) ||
    length < 0 ||
    offset + length > buffer.length
  ) {
    throw new ERR_ZIP_INVALID_ARCHIVE(`${what} is out of bounds`);
  }
}

function readSafeUint64(buffer, offset) {
  if (offset + 8 > buffer.length) {
    throw new ERR_ZIP_INVALID_ARCHIVE('64-bit field is out of bounds');
  }
  const value = buffer.readBigUInt64LE(offset);
  if (value > BIGINT_MAX_SAFE_INTEGER) {
    throw new ERR_ZIP_INVALID_ARCHIVE('64-bit field exceeds the safe integer range');
  }
  return Number(value);
}

function writeSafeUint64(buffer, offset, value) {
  buffer.writeBigUInt64LE(BigInt(value), offset);
}

// Zip64 extended information extra field (sec. 4.5.3).
function parseZip64Extra(extra, want) {
  const wanted =
    want.uncompressedSize ||
    want.compressedSize ||
    want.localFileHeaderOffset ||
    want.diskNumber;
  if (!wanted) return {};
  let pos = 0;
  while (pos + 4 <= extra.length) {
    const id = extra.readUInt16LE(pos);
    const size = extra.readUInt16LE(pos + 2);
    if (pos + 4 + size > extra.length) {
      throw new ERR_ZIP_INVALID_ARCHIVE('extra field is malformed');
    }
    if (id === ZIP64_EXTRA_ID) {
      const result = {};
      let cursor = pos + 4;
      const end = pos + 4 + size;
      const take = (bytes) => {
        if (cursor + bytes > end) {
          throw new ERR_ZIP_INVALID_ARCHIVE(
            'the Zip64 extended information extra field is truncated');
        }
        const value = bytes === 8 ?
          readSafeUint64(extra, cursor) : extra.readUInt32LE(cursor);
        cursor += bytes;
        return value;
      };
      if (want.uncompressedSize) result.uncompressedSize = take(8);
      if (want.compressedSize) result.compressedSize = take(8);
      if (want.localFileHeaderOffset) result.localFileHeaderOffset = take(8);
      if (want.diskNumber) result.diskNumber = take(4);
      return result;
    }
    pos += 4 + size;
  }
  throw new ERR_ZIP_INVALID_ARCHIVE(
    'a field is 0xFFFFFFFF but the Zip64 extended information extra field is missing');
}

// End of central directory record (sec. 4.3.16).
// Offset   Bytes   Description
// 0        4       Signature = 0x06054b50
// 4        2       Number of this disk
// 6        2       Disk where central directory starts
// 8        2       Number of central directory records on this disk
// 10       2       Total number of central directory records
// 12       4       Size of central directory (bytes)
// 16       4       Offset of start of central directory
// 20       2       Comment length (n)
// 22       n       Comment
class CentralEndHeader {
  #buffer;
  #offset;
  constructor(buffer, offset = 0) {
    validateArchiveRange(buffer, offset, 22, 'end of central directory record');
    if (buffer.readUInt32LE(offset) !== SIG_EOCD) {
      throw new ERR_ZIP_INVALID_ARCHIVE('end of central directory signature is invalid');
    }
    this.#buffer = buffer;
    this.#offset = offset;
    if (offset + this.byteLength > buffer.length) {
      throw new ERR_ZIP_INVALID_ARCHIVE('end of central directory record is truncated');
    }
  }
  get byteLength() { return 22 + this.commentLength; }
  get diskNumber() { return this.#buffer.readUInt16LE(this.#offset + 4); }
  get centralDirectoryDiskNumber() { return this.#buffer.readUInt16LE(this.#offset + 6); }
  get centralDirectoryDiskRecords() { return this.#buffer.readUInt16LE(this.#offset + 8); }
  get centralDirectoryTotalRecords() { return this.#buffer.readUInt16LE(this.#offset + 10); }
  get centralDirectorySize() { return this.#buffer.readUInt32LE(this.#offset + 12); }
  get centralDirectoryOffset() { return this.#buffer.readUInt32LE(this.#offset + 16); }
  get commentLength() { return this.#buffer.readUInt16LE(this.#offset + 20); }
  get commentBuffer() {
    const start = this.#offset + 22;
    return this.#buffer.subarray(start, start + this.commentLength);
  }
}

// Zip64 end of central directory record (sec. 4.3.14).
// 0    4   Signature = 0x06064b50
// 4    8   Size of remainder of this record
// 12   2   Version made by
// 14   2   Version needed to extract
// 16   4   Number of this disk
// 20   4   Disk where central directory starts
// 24   8   Number of central directory records on this disk
// 32   8   Total number of central directory records
// 40   8   Size of central directory
// 48   8   Offset of start of central directory
class Zip64EndRecord {
  #buffer;
  #offset;
  constructor(buffer, offset = 0) {
    validateArchiveRange(buffer, offset, 56, 'Zip64 end of central directory record');
    if (buffer.readUInt32LE(offset) !== SIG_ZIP64_EOCD_RECORD) {
      throw new ERR_ZIP_INVALID_ARCHIVE(
        'Zip64 end of central directory signature is invalid');
    }
    this.#buffer = buffer;
    this.#offset = offset;
  }
  get diskNumber() { return this.#buffer.readUInt32LE(this.#offset + 16); }
  get centralDirectoryDiskNumber() { return this.#buffer.readUInt32LE(this.#offset + 20); }
  get centralDirectoryDiskRecords() { return readSafeUint64(this.#buffer, this.#offset + 24); }
  get centralDirectoryTotalRecords() { return readSafeUint64(this.#buffer, this.#offset + 32); }
  get centralDirectorySize() { return readSafeUint64(this.#buffer, this.#offset + 40); }
  get centralDirectoryOffset() { return readSafeUint64(this.#buffer, this.#offset + 48); }
}

// Zip64 end of central directory locator (sec. 4.3.15).
// 0    4   Signature = 0x07064b50
// 4    4   Disk with the Zip64 end of central directory record
// 8    8   Offset of the Zip64 end of central directory record
// 16   4   Total number of disks
class Zip64EndLocator {
  #buffer;
  #offset;
  constructor(buffer, offset = 0) {
    validateArchiveRange(buffer, offset, 20, 'Zip64 end of central directory locator');
    if (buffer.readUInt32LE(offset) !== SIG_ZIP64_EOCD_LOCATOR) {
      throw new ERR_ZIP_INVALID_ARCHIVE(
        'Zip64 end of central directory locator signature is invalid');
    }
    this.#buffer = buffer;
    this.#offset = offset;
  }
  get recordDiskNumber() { return this.#buffer.readUInt32LE(this.#offset + 4); }
  get recordOffset() { return readSafeUint64(this.#buffer, this.#offset + 8); }
  get totalDisks() { return this.#buffer.readUInt32LE(this.#offset + 16); }
}

// Central directory file header (sec. 4.3.12).
// 0    4   Signature = 0x02014b50
// 4    2   Version made by
// 6    2   Version needed to extract
// 8    2   General purpose bit flag
// 10   2   Compression method
// 12   2   Last modification time
// 14   2   Last modification date
// 16   4   CRC-32
// 20   4   Compressed size
// 24   4   Uncompressed size
// 28   2   File name length (n)
// 30   2   Extra field length (m)
// 32   2   File comment length (k)
// 34   2   Disk number where file starts
// 36   2   Internal file attributes
// 38   4   External file attributes
// 42   4   Relative offset of local file header
// 46   n   File name
// 46+n m   Extra field
// 46+n+m k File comment
class CentralFileHeader {
  #buffer;
  #offset;
  #zip64 = null;
  constructor(buffer, offset = 0) {
    validateArchiveRange(buffer, offset, 46, 'central directory header');
    if (buffer.readUInt32LE(offset) !== SIG_CENTRAL_FILE_HEADER) {
      throw new ERR_ZIP_INVALID_ARCHIVE('central directory header signature is invalid');
    }
    this.#buffer = buffer;
    this.#offset = offset;
    if (offset + this.byteLength > buffer.length) {
      throw new ERR_ZIP_INVALID_ARCHIVE('central directory header is truncated');
    }
  }
  get byteOffset() { return this.#offset; }
  get byteLength() {
    return 46 + this.fileNameLength + this.extraFieldLength + this.fileCommentLength;
  }
  get version() { return this.#buffer.readUInt16LE(this.#offset + 4); }
  // Spec field "version needed to extract" (sec. 4.4.3); not consumed today.
  // get versionNeeded() { return this.#buffer.readUInt16LE(this.#offset + 6); }
  get flags() { return this.#buffer.readUInt16LE(this.#offset + 8); }
  get compressionMethod() { return this.#buffer.readUInt16LE(this.#offset + 10); }
  get lastModified() {
    return decodeDosDateTime(
      this.#buffer.readUInt16LE(this.#offset + 12),
      this.#buffer.readUInt16LE(this.#offset + 14));
  }
  get crc32() { return this.#buffer.readUInt32LE(this.#offset + 16); }
  #resolveZip64() {
    if (this.#zip64 === null) {
      this.#zip64 = parseZip64Extra(this.extraField, {
        uncompressedSize: this.#buffer.readUInt32LE(this.#offset + 24) === SENTINEL32,
        compressedSize: this.#buffer.readUInt32LE(this.#offset + 20) === SENTINEL32,
        localFileHeaderOffset: this.#buffer.readUInt32LE(this.#offset + 42) === SENTINEL32,
        diskNumber: this.#buffer.readUInt16LE(this.#offset + 34) === SENTINEL16,
      });
    }
    return this.#zip64;
  }
  get compressedSize() {
    const value = this.#buffer.readUInt32LE(this.#offset + 20);
    return value === SENTINEL32 ? this.#resolveZip64().compressedSize : value;
  }
  get uncompressedSize() {
    const value = this.#buffer.readUInt32LE(this.#offset + 24);
    return value === SENTINEL32 ? this.#resolveZip64().uncompressedSize : value;
  }
  get fileNameLength() { return this.#buffer.readUInt16LE(this.#offset + 28); }
  get extraFieldLength() { return this.#buffer.readUInt16LE(this.#offset + 30); }
  get fileCommentLength() { return this.#buffer.readUInt16LE(this.#offset + 32); }
  get diskNumber() {
    const value = this.#buffer.readUInt16LE(this.#offset + 34);
    return value === SENTINEL16 ? this.#resolveZip64().diskNumber : value;
  }
  get internalFileAttributes() { return this.#buffer.readUInt16LE(this.#offset + 36); }
  get externalFileAttributes() { return this.#buffer.readUInt32LE(this.#offset + 38); }
  get localFileHeaderOffset() {
    const value = this.#buffer.readUInt32LE(this.#offset + 42);
    return value === SENTINEL32 ? this.#resolveZip64().localFileHeaderOffset : value;
  }
  get fileNameBuffer() {
    const start = this.#offset + 46;
    return this.#buffer.subarray(start, start + this.fileNameLength);
  }
  get fileName() { return this.fileNameBuffer.toString('utf8'); }
  get extraField() {
    const start = this.#offset + 46 + this.fileNameLength;
    return this.#buffer.subarray(start, start + this.extraFieldLength);
  }
  get fileCommentBuffer() {
    const start = this.#offset + 46 + this.fileNameLength + this.extraFieldLength;
    return this.#buffer.subarray(start, start + this.fileCommentLength);
  }
  get fileComment() { return this.fileCommentBuffer.toString('utf8'); }
  get mode() {
    const madeBy = this.version >>> 8;
    if (madeBy !== MADE_BY_UNIX) return 0;
    return (this.externalFileAttributes >>> 16) & 0x1ff;
  }
}

// Local file header (sec. 4.3.7).
// 0    4   Signature = 0x04034b50
// 4    2   Version needed to extract
// 6    2   General purpose bit flag
// 8    2   Compression method
// 10   2   Last modification time
// 12   2   Last modification date
// 14   4   CRC-32
// 18   4   Compressed size
// 22   4   Uncompressed size
// 26   2   File name length (n)
// 28   2   Extra field length (m)
// 30   n   File name
// 30+n m   Extra field
class LocalFileHeader {
  #buffer;
  #offset;
  constructor(buffer, offset = 0) {
    validateArchiveRange(buffer, offset, 30, 'local file header');
    if (buffer.readUInt32LE(offset) !== SIG_LOCAL_FILE_HEADER) {
      throw new ERR_ZIP_INVALID_ARCHIVE('local file header signature is invalid');
    }
    this.#buffer = buffer;
    this.#offset = offset;
    if (offset + this.byteLength > buffer.length) {
      throw new ERR_ZIP_INVALID_ARCHIVE('local file header is truncated');
    }
  }
  get byteLength() { return 30 + this.fileNameLength + this.extraFieldLength; }
  get flags() { return this.#buffer.readUInt16LE(this.#offset + 6); }
  // Spec field (sec. 4.4.5); the central directory's method is authoritative,
  // so the local copy is not consumed today.
  // get compressionMethod() { return this.#buffer.readUInt16LE(this.#offset + 8); }
  get lastModified() {
    return decodeDosDateTime(
      this.#buffer.readUInt16LE(this.#offset + 10),
      this.#buffer.readUInt16LE(this.#offset + 12));
  }
  get fileNameLength() { return this.#buffer.readUInt16LE(this.#offset + 26); }
  get extraFieldLength() { return this.#buffer.readUInt16LE(this.#offset + 28); }
  get fileName() {
    const start = this.#offset + 30;
    return this.#buffer.toString('utf8', start, start + this.fileNameLength);
  }
  static length(buffer, offset) {
    if (offset + 30 > buffer.length) return 0;
    return 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
  }
}

/**
 * Locates and validates the end-of-archive structures (EOCD, and the Zip64
 * EOCD locator/record when present) in `buffer`. `base` is the absolute
 * offset of `buffer[0]` when `buffer` is only the tail of a larger file; all
 * returned offsets are absolute. `buffer` must extend to the end of the
 * archive.
 * @returns {{
 *   prefix: number,
 *   totalRecords: number,
 *   centralDirectoryOffset: number,
 *   centralDirectorySize: number,
 *   comment: Buffer,
 * }}
 */
function findArchiveEnd(buffer, base = 0) {
  if (buffer.length < 22) {
    throw new ERR_ZIP_INVALID_ARCHIVE('no end of central directory record found');
  }
  const min = MathMax(0, buffer.length - (22 + SENTINEL16));
  let eocdPos = -1;
  // Pass 1: the comment must reach exactly to the end of the buffer (this
  // rejects a stray EOCD-looking signature inside an earlier comment).
  for (let pos = buffer.length - 22; pos >= min; pos--) {
    if (buffer.readUInt32LE(pos) !== SIG_EOCD) continue;
    if (pos + 22 + buffer.readUInt16LE(pos + 20) !== buffer.length) continue;
    eocdPos = pos;
    break;
  }
  if (eocdPos < 0) {
    // Pass 2: tolerate trailing padding after the EOCD (some streaming
    // writers pad their output to a fixed block size); take the last
    // candidate found.
    for (let pos = buffer.length - 22; pos >= min; pos--) {
      if (buffer.readUInt32LE(pos) !== SIG_EOCD) continue;
      if (pos + 22 + buffer.readUInt16LE(pos + 20) > buffer.length) continue;
      eocdPos = pos;
      break;
    }
  }
  if (eocdPos < 0) {
    throw new ERR_ZIP_INVALID_ARCHIVE('no end of central directory record found');
  }
  const eocd = new CentralEndHeader(buffer, eocdPos);
  let totalRecords = eocd.centralDirectoryTotalRecords;
  let centralDirectorySize = eocd.centralDirectorySize;
  let centralDirectoryOffset = eocd.centralDirectoryOffset;
  let prefix;
  const locatorPos = eocdPos - 20;
  if (
    locatorPos >= 0 &&
    buffer.readUInt32LE(locatorPos) === SIG_ZIP64_EOCD_LOCATOR
  ) {
    const locator = new Zip64EndLocator(buffer, locatorPos);
    if (locator.totalDisks > 1 || locator.recordDiskNumber !== 0) {
      throw new ERR_ZIP_UNSUPPORTED_FEATURE('multi-disk archives are not supported');
    }
    let recordPos = locator.recordOffset - base;
    if (
      !(recordPos >= 0 &&
        recordPos + 56 <= locatorPos &&
        buffer.readUInt32LE(recordPos) === SIG_ZIP64_EOCD_RECORD)
    ) {
      // Data was prepended to the archive, shifting the record; scan
      // backward from the locator instead of trusting its recorded offset.
      recordPos = -1;
      const floor = MathMax(0, locatorPos - 56 - SENTINEL16);
      for (let pos = locatorPos - 56; pos >= floor; pos--) {
        if (buffer.readUInt32LE(pos) !== SIG_ZIP64_EOCD_RECORD) continue;
        const size = buffer.readBigUInt64LE(pos + 4);
        if (size >= 44n && pos + 12 + Number(size) === locatorPos) {
          recordPos = pos;
          break;
        }
      }
      if (recordPos < 0) {
        throw new ERR_ZIP_INVALID_ARCHIVE('Zip64 end of central directory record not found');
      }
    }
    const zip64 = new Zip64EndRecord(buffer, recordPos);
    if (zip64.diskNumber !== 0 || zip64.centralDirectoryDiskNumber !== 0) {
      throw new ERR_ZIP_UNSUPPORTED_FEATURE('multi-disk archives are not supported');
    }
    if (zip64.centralDirectoryDiskRecords !== zip64.centralDirectoryTotalRecords) {
      throw new ERR_ZIP_UNSUPPORTED_FEATURE('multi-disk archives are not supported');
    }
    totalRecords = zip64.centralDirectoryTotalRecords;
    centralDirectorySize = zip64.centralDirectorySize;
    centralDirectoryOffset = zip64.centralDirectoryOffset;
    prefix = base + recordPos - (centralDirectoryOffset + centralDirectorySize);
  } else {
    if (eocd.diskNumber !== 0 || eocd.centralDirectoryDiskNumber !== 0) {
      throw new ERR_ZIP_UNSUPPORTED_FEATURE('multi-disk archives are not supported');
    }
    if (eocd.centralDirectoryDiskRecords !== totalRecords) {
      throw new ERR_ZIP_UNSUPPORTED_FEATURE('multi-disk archives are not supported');
    }
    prefix = base + eocdPos - (centralDirectoryOffset + centralDirectorySize);
  }
  if (prefix < 0) {
    throw new ERR_ZIP_INVALID_ARCHIVE('central directory does not fit inside the archive');
  }
  if (totalRecords * 46 > centralDirectorySize) {
    throw new ERR_ZIP_INVALID_ARCHIVE(
      'central directory record count is inconsistent with its size');
  }
  return {
    prefix,
    totalRecords,
    centralDirectoryOffset: centralDirectoryOffset + prefix,
    centralDirectorySize,
    comment: eocd.commentBuffer,
  };
}

// -- header builders (write path) --------------------------------------------

function buildLocalHeader(meta) {
  const streaming = (meta.flags & FLAG_DATA_DESCRIPTOR) !== 0;
  const zip64 =
    streaming ||
    meta.compressedSize >= SENTINEL32 ||
    meta.uncompressedSize >= SENTINEL32;
  const extraLength = zip64 ? 20 : 0;
  const buffer = Buffer.allocUnsafe(30 + meta.name.length + extraLength);
  buffer.writeUInt32LE(SIG_LOCAL_FILE_HEADER, 0);
  buffer.writeUInt16LE(zip64 ? VERSION_ZIP64 : VERSION_DEFAULT, 4);
  buffer.writeUInt16LE(meta.flags, 6);
  buffer.writeUInt16LE(meta.method, 8);
  const { time, date } = encodeDosDateTime(meta.modified);
  buffer.writeUInt16LE(time, 10);
  buffer.writeUInt16LE(date, 12);
  buffer.writeUInt32LE(streaming ? 0 : meta.crc, 14);
  buffer.writeUInt32LE(zip64 ? SENTINEL32 : meta.compressedSize, 18);
  buffer.writeUInt32LE(zip64 ? SENTINEL32 : meta.uncompressedSize, 22);
  buffer.writeUInt16LE(meta.name.length, 26);
  buffer.writeUInt16LE(extraLength, 28);
  meta.name.copy(buffer, 30);
  if (zip64) {
    const pos = 30 + meta.name.length;
    buffer.writeUInt16LE(ZIP64_EXTRA_ID, pos);
    buffer.writeUInt16LE(16, pos + 2);
    writeSafeUint64(buffer, pos + 4, streaming ? 0 : meta.uncompressedSize);
    writeSafeUint64(buffer, pos + 12, streaming ? 0 : meta.compressedSize);
  }
  return buffer;
}

function buildCentralHeader(meta, localOffset) {
  const zip64Streaming = (meta.flags & FLAG_DATA_DESCRIPTOR) !== 0;
  const u64 = meta.uncompressedSize >= SENTINEL32;
  const c64 = meta.compressedSize >= SENTINEL32;
  const o64 = localOffset >= SENTINEL32;
  const zip64Fields = (u64 ? 1 : 0) + (c64 ? 1 : 0) + (o64 ? 1 : 0);
  const extraLength = zip64Fields ? 4 + 8 * zip64Fields : 0;
  const zip64 = zip64Streaming || meta.compressedSize >= SENTINEL32 ||
    meta.uncompressedSize >= SENTINEL32 || zip64Fields > 0;
  const buffer = Buffer.allocUnsafe(
    46 + meta.name.length + extraLength + meta.comment.length);
  buffer.writeUInt32LE(SIG_CENTRAL_FILE_HEADER, 0);
  buffer.writeUInt16LE(
    (MADE_BY_UNIX << 8) | (zip64 ? VERSION_ZIP64 : VERSION_DEFAULT), 4);
  buffer.writeUInt16LE(zip64 ? VERSION_ZIP64 : VERSION_DEFAULT, 6);
  buffer.writeUInt16LE(meta.flags, 8);
  buffer.writeUInt16LE(meta.method, 10);
  const { time, date } = encodeDosDateTime(meta.modified);
  buffer.writeUInt16LE(time, 12);
  buffer.writeUInt16LE(date, 14);
  buffer.writeUInt32LE(meta.crc, 16);
  buffer.writeUInt32LE(c64 ? SENTINEL32 : meta.compressedSize, 20);
  buffer.writeUInt32LE(u64 ? SENTINEL32 : meta.uncompressedSize, 24);
  buffer.writeUInt16LE(meta.name.length, 28);
  buffer.writeUInt16LE(extraLength, 30);
  buffer.writeUInt16LE(meta.comment.length, 32);
  buffer.writeUInt16LE(0, 34); // disk number
  buffer.writeUInt16LE(meta.internal, 36);
  buffer.writeUInt32LE(meta.external, 38);
  buffer.writeUInt32LE(o64 ? SENTINEL32 : localOffset, 42);
  meta.name.copy(buffer, 46);
  let pos = 46 + meta.name.length;
  if (zip64Fields) {
    buffer.writeUInt16LE(ZIP64_EXTRA_ID, pos);
    buffer.writeUInt16LE(8 * zip64Fields, pos + 2);
    pos += 4;
    if (u64) {
      writeSafeUint64(buffer, pos, meta.uncompressedSize);
      pos += 8;
    }
    if (c64) {
      writeSafeUint64(buffer, pos, meta.compressedSize);
      pos += 8;
    }
    if (o64) {
      writeSafeUint64(buffer, pos, localOffset);
      pos += 8;
    }
  }
  meta.comment.copy(buffer, pos);
  return buffer;
}

// Zip64 data descriptor (sec. 4.3.9): emitted after a streamed entry, whose
// local header always carries a Zip64 extra field.
function buildDataDescriptor64(crc, compressedSize, uncompressedSize) {
  const buffer = Buffer.allocUnsafe(24);
  buffer.writeUInt32LE(SIG_DATA_DESCRIPTOR, 0);
  buffer.writeUInt32LE(crc, 4);
  writeSafeUint64(buffer, 8, compressedSize);
  writeSafeUint64(buffer, 16, uncompressedSize);
  return buffer;
}

function buildEndOfCentralDirectory(count, size, offset, comment) {
  const buffer = Buffer.allocUnsafe(22 + comment.length);
  buffer.writeUInt32LE(SIG_EOCD, 0);
  buffer.writeUInt16LE(0, 4); // disk number
  buffer.writeUInt16LE(0, 6); // Central directory disk number
  buffer.writeUInt16LE(MathMin(count, SENTINEL16), 8);
  buffer.writeUInt16LE(MathMin(count, SENTINEL16), 10);
  buffer.writeUInt32LE(MathMin(size, SENTINEL32), 12);
  buffer.writeUInt32LE(MathMin(offset, SENTINEL32), 16);
  buffer.writeUInt16LE(comment.length, 20);
  comment.copy(buffer, 22);
  return buffer;
}

function buildZip64EndRecord(count, size, offset) {
  const buffer = Buffer.allocUnsafe(56);
  buffer.writeUInt32LE(SIG_ZIP64_EOCD_RECORD, 0);
  writeSafeUint64(buffer, 4, 44); // Size of the remainder of this record
  buffer.writeUInt16LE((MADE_BY_UNIX << 8) | VERSION_ZIP64, 12);
  buffer.writeUInt16LE(VERSION_ZIP64, 14);
  buffer.writeUInt32LE(0, 16); // disk number
  buffer.writeUInt32LE(0, 20); // Central directory disk number
  writeSafeUint64(buffer, 24, count);
  writeSafeUint64(buffer, 32, count);
  writeSafeUint64(buffer, 40, size);
  writeSafeUint64(buffer, 48, offset);
  return buffer;
}

function buildZip64EndLocator(recordOffset) {
  const buffer = Buffer.allocUnsafe(20);
  buffer.writeUInt32LE(SIG_ZIP64_EOCD_LOCATOR, 0);
  buffer.writeUInt32LE(0, 4); // Disk with the Zip64 EOCD record
  writeSafeUint64(buffer, 8, recordOffset);
  buffer.writeUInt32LE(1, 16); // total disks
  return buffer;
}

// -- buffer coercion ----------------------------------------------------------

function toBuffer(value, name) {
  if (isUint8Array(value)) {
    return Buffer.isBuffer(value) ?
      value : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (isArrayBufferView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (isAnyArrayBuffer(value)) {
    return Buffer.from(value);
  }
  throw new ERR_INVALID_ARG_TYPE(
    name, ['Buffer', 'TypedArray', 'DataView', 'ArrayBuffer'], value);
}

// -- compression plumbing ------------------------------------------------------

function deflateRawAsync(buffer) {
  return new Promise((resolve, reject) => {
    lazyZlib().deflateRaw(buffer, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

function inflateRawAsync(buffer, options) {
  return new Promise((resolve, reject) => {
    lazyZlib().inflateRaw(buffer, options, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

async function* pumpThroughTransform(source, transform) {
  const input = Readable.from(source);
  input.on('error', (err) => transform.destroy(err));
  input.pipe(transform);
  try {
    yield* transform;
  } finally {
    if (!input.destroyed) input.destroy();
    if (!transform.destroyed) transform.destroy();
  }
}

function deflateRawStream(source) {
  return pumpThroughTransform(source, lazyZlib().createDeflateRaw());
}

function inflateRawStream(source) {
  return pumpThroughTransform(source, lazyZlib().createInflateRaw());
}

function zstdCompressAsync(buffer) {
  return new Promise((resolve, reject) => {
    lazyZlib().zstdCompress(buffer, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

function zstdDecompressAsync(buffer, options) {
  return new Promise((resolve, reject) => {
    lazyZlib().zstdDecompress(buffer, options, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

function zstdCompressStream(source) {
  return pumpThroughTransform(source, lazyZlib().createZstdCompress());
}

function zstdDecompressStream(source) {
  return pumpThroughTransform(source, lazyZlib().createZstdDecompress());
}

/**
 * @typedef {{
 *   name: string,
 *   flags: number,
 *   method: number,
 *   crc32: number,
 *   uncompressedSize: number,
 * }} ZipMemberInfo
 */

/**
 * Decodes one member's compressed byte stream: rejects encrypted entries and
 * unsupported compression methods, inflates method 8 or decompresses method
 * 93 (Zstandard), enforces the declared uncompressed size and verifies
 * CRC-32 (on by default).
 * @param {AsyncIterable<Buffer>} source
 * @param {ZipMemberInfo} info
 * @param {{ verify?: boolean, maxSize?: number }} [options]
 * @yields {Buffer}
 */
async function* decodeMemberStream(source, info, options) {
  if (info.flags & FLAG_ENCRYPTED) {
    throw new ERR_ZIP_UNSUPPORTED_FEATURE(
      `entry ${JSONStringify(info.name)} is encrypted`);
  }
  if (info.method !== METHOD_STORE && info.method !== METHOD_DEFLATE && info.method !== METHOD_ZSTD) {
    throw new ERR_ZIP_UNSUPPORTED_FEATURE(
      `entry ${JSONStringify(info.name)} uses compression method ${info.method}`);
  }
  const verify = options?.verify !== false;
  if (options?.maxSize !== undefined && info.uncompressedSize > options.maxSize) {
    throw new ERR_ZIP_ENTRY_TOO_LARGE(
      `entry ${JSONStringify(info.name)} declares ${info.uncompressedSize} bytes, ` +
      `exceeding the ${options.maxSize} byte limit`);
  }
  let produced = 0;
  let state = 0;
  const decoded = info.method === METHOD_DEFLATE ? inflateRawStream(source) :
    info.method === METHOD_ZSTD ? zstdDecompressStream(source) : source;
  for await (const chunk of decoded) {
    produced += chunk.length;
    if (produced > info.uncompressedSize) {
      throw new ERR_ZIP_ENTRY_CORRUPT(
        `entry ${JSONStringify(info.name)} inflates beyond its declared size of ` +
        `${info.uncompressedSize} bytes`);
    }
    if (verify) state = crc32Native(chunk, state);
    yield chunk;
  }
  if (produced !== info.uncompressedSize) {
    throw new ERR_ZIP_ENTRY_CORRUPT(
      `entry ${JSONStringify(info.name)} is truncated: got ${produced} of ` +
      `${info.uncompressedSize} bytes`);
  }
  if (verify && state !== info.crc32) {
    throw new ERR_ZIP_ENTRY_CORRUPT(
      `entry ${JSONStringify(info.name)} failed CRC-32 verification`);
  }
}

/**
 * The synchronous counterpart of `decodeMemberStream()`. There is no public
 * synchronous incremental inflate API, so - unlike the streaming path -
 * `compressed` must already be the member's complete compressed byte
 * stream, and the whole result is produced (and verified) in one call
 * rather than yielded incrementally.
 * @param {Buffer} compressed
 * @param {ZipMemberInfo} info
 * @param {{ verify?: boolean, maxSize?: number }} [options]
 * @returns {Buffer}
 */
function decodeMemberSync(compressed, info, options) {
  if (info.flags & FLAG_ENCRYPTED) {
    throw new ERR_ZIP_UNSUPPORTED_FEATURE(
      `entry ${JSONStringify(info.name)} is encrypted`);
  }
  if (info.method !== METHOD_STORE && info.method !== METHOD_DEFLATE && info.method !== METHOD_ZSTD) {
    throw new ERR_ZIP_UNSUPPORTED_FEATURE(
      `entry ${JSONStringify(info.name)} uses compression method ${info.method}`);
  }
  const verify = options?.verify !== false;
  if (options?.maxSize !== undefined && info.uncompressedSize > options.maxSize) {
    throw new ERR_ZIP_ENTRY_TOO_LARGE(
      `entry ${JSONStringify(info.name)} declares ${info.uncompressedSize} bytes, ` +
      `exceeding the ${options.maxSize} byte limit`);
  }
  let data;
  if (info.method === METHOD_DEFLATE) {
    try {
      data = lazyZlib().inflateRawSync(
        compressed, options?.maxSize !== undefined ? { maxOutputLength: options.maxSize } : undefined);
    } catch (err) {
      if (err?.code === 'ERR_BUFFER_TOO_LARGE') {
        throw new ERR_ZIP_ENTRY_TOO_LARGE(
          `entry ${JSONStringify(info.name)} inflates beyond the ${options.maxSize} byte limit`);
      }
      throw new ERR_ZIP_ENTRY_CORRUPT(
        `entry ${JSONStringify(info.name)} failed to inflate: ${err.message}`);
    }
  } else if (info.method === METHOD_ZSTD) {
    try {
      data = lazyZlib().zstdDecompressSync(
        compressed, options?.maxSize !== undefined ? { maxOutputLength: options.maxSize } : undefined);
    } catch (err) {
      if (err?.code === 'ERR_BUFFER_TOO_LARGE') {
        throw new ERR_ZIP_ENTRY_TOO_LARGE(
          `entry ${JSONStringify(info.name)} decompresses beyond the ${options.maxSize} byte limit`);
      }
      throw new ERR_ZIP_ENTRY_CORRUPT(
        `entry ${JSONStringify(info.name)} failed to decompress: ${err.message}`);
    }
  } else {
    data = compressed;
  }
  if (data.length !== info.uncompressedSize) {
    throw new ERR_ZIP_ENTRY_CORRUPT(
      `entry ${JSONStringify(info.name)} produced ${data.length} bytes, expected ` +
      `${info.uncompressedSize}`);
  }
  if (verify) {
    const crc = crc32Native(data, 0);
    if (crc !== info.crc32) {
      throw new ERR_ZIP_ENTRY_CORRUPT(
        `entry ${JSONStringify(info.name)} failed CRC-32 verification`);
    }
  }
  return data;
}

function createEntryMeta(filename, options) {
  validateString(filename, 'filename');
  const name = Buffer.from(filename, 'utf8');
  if (name.length === 0) {
    throw new ERR_INVALID_ARG_VALUE('filename', filename, 'must not be empty');
  }
  if (name.length > SENTINEL16) {
    throw new ERR_ZIP_ENTRY_TOO_LARGE(
      'the entry name must not exceed 65535 bytes when encoded as UTF-8');
  }
  let comment = EMPTY_BUFFER;
  if (options?.comment !== undefined) {
    validateString(options.comment, 'options.comment');
    comment = Buffer.from(options.comment, 'utf8');
    if (comment.length > SENTINEL16) {
      throw new ERR_ZIP_ENTRY_TOO_LARGE(
        'the entry comment must not exceed 65535 bytes when encoded as UTF-8');
    }
  }
  const isDirectory = StringPrototypeEndsWith(filename, '/');
  const mode = options?.mode ?? (isDirectory ? 0o755 : 0o644);
  validateUint32(mode, 'options.mode');
  const modified = options?.modified ?? new Date();
  if (!isDate(modified)) {
    throw new ERR_INVALID_ARG_TYPE('options.modified', 'Date', modified);
  }
  if (options?.method !== undefined &&
      options.method !== 'deflate' && options.method !== 'store' && options.method !== 'zstd') {
    throw new ERR_INVALID_ARG_VALUE(
      'options.method', options.method, "must be 'deflate', 'store', or 'zstd'");
  }
  const typeBits = isDirectory ? S_IFDIR : S_IFREG;
  const unixAttrs = (typeBits | (mode & 0o7777)) & SENTINEL16;
  const external = ((unixAttrs << 16) | (isDirectory ? 0x10 : 0)) >>> 0;
  return {
    name,
    comment,
    flags: FLAG_UTF8,
    method: 0,
    crc: 0,
    compressedSize: 0,
    uncompressedSize: 0,
    modified,
    external,
    internal: 0,
    pending: true,
  };
}

/**
 * A single file or directory inside a ZIP archive: reading, writing, and
 * (de)serializing one archive member.
 */
class ZipEntry {
  #central;
  #local;
  #content;
  #source = null;
  #meta = null;
  #serialized = false;
  // When #fd is non-null the entry is "file-backed": it holds no content
  // buffer, only a descriptor and the local-header offset, and reads its
  // compressed bytes from disk on demand (see #compressedBytes/#rawChunks).
  // #contentOffset caches the resolved start of the compressed data (a
  // number, not a buffer) once the local header has been read.
  #fd = null;
  #localOffset = -1;
  #contentOffset = -1;

  /**
   * @private
   */
  constructor(central, local, content, fd = null, localOffset = -1) {
    this.#central = central;
    this.#local = local;
    this.#content = content;
    this.#fd = fd;
    this.#localOffset = localOffset;
  }

  get compressed() { return this.method === 8; }
  get rawContent() { return this.#content; }
  get method() {
    return this.#meta ? this.#meta.method : this.#central.compressionMethod;
  }
  get flags() {
    return this.#meta ? this.#meta.flags : (this.#local ?? this.#central).flags;
  }
  get crc32() {
    if (this.#meta) {
      this.#assertNotPending();
      return this.#meta.crc;
    }
    return this.#central.crc32;
  }
  get name() {
    return this.#meta ? this.#meta.name.toString('utf8') : (this.#local ?? this.#central).fileName;
  }
  get comment() {
    return this.#meta ? this.#meta.comment.toString('utf8') : this.#central.fileComment;
  }
  get size() {
    if (this.#meta) {
      this.#assertNotPending();
      return this.#meta.uncompressedSize;
    }
    return this.#central.uncompressedSize;
  }
  get compressedSize() {
    if (this.#meta) {
      this.#assertNotPending();
      return this.#meta.compressedSize;
    }
    return this.#central.compressedSize;
  }
  get modified() {
    return this.#meta ? this.#meta.modified : (this.#local ?? this.#central).lastModified;
  }
  get mode() {
    if (this.#meta) return (this.#meta.external >>> 16) & 0x1ff;
    return this.#central.mode;
  }
  get isFile() { return !this.isDirectory; }
  get isDirectory() { return StringPrototypeEndsWith(this.name, '/'); }

  #assertNotPending() {
    if (this.#meta?.pending) {
      throw new ERR_INVALID_STATE(
        'this streaming entry has not finished serializing yet');
    }
  }

  #finalizeMeta() {
    if (this.#meta) {
      this.#assertNotPending();
      return this.#meta;
    }
    const central = this.#central;
    // Descriptor entries (bit 3) are re-emitted with known sizes/CRC and bit
    // 3 cleared: re-serialization never reproduces a bit-3 local header
    // without a data descriptor. Sizes come from the central directory
    // (Zip64-aware); foreign extra fields are dropped and Zip64 extras are
    // regenerated as needed.
    const meta = {
      name: central.fileNameBuffer,
      comment: central.fileCommentBuffer,
      flags: central.flags & ~FLAG_DATA_DESCRIPTOR,
      method: central.compressionMethod,
      crc: central.crc32,
      compressedSize: central.compressedSize,
      uncompressedSize: central.uncompressedSize,
      modified: central.lastModified,
      external: central.externalFileAttributes,
      internal: central.internalFileAttributes,
      pending: false,
    };
    this.#meta = meta;
    return meta;
  }

  // Resolve (and cache) the file offset where this file-backed entry's
  // compressed data begins, by reading the local file header - whose length
  // (fixed 30 bytes plus variable name/extra fields) is only known from the
  // file itself, not from the central directory.
  async #resolveContentOffset() {
    if (this.#contentOffset >= 0) return this.#contentOffset;
    const fixed = Buffer.allocUnsafe(30);
    await readFdFully(this.#fd, fixed, this.#localOffset);
    if (fixed.readUInt32LE(0) !== SIG_LOCAL_FILE_HEADER) {
      throw new ERR_ZIP_INVALID_ARCHIVE(
        `entry ${JSONStringify(this.name)} has an invalid local file header`);
    }
    this.#contentOffset = this.#localOffset + LocalFileHeader.length(fixed, 0);
    return this.#contentOffset;
  }
  #resolveContentOffsetSync() {
    if (this.#contentOffset >= 0) return this.#contentOffset;
    const fixed = Buffer.allocUnsafe(30);
    readFdFullySync(this.#fd, fixed, this.#localOffset);
    if (fixed.readUInt32LE(0) !== SIG_LOCAL_FILE_HEADER) {
      throw new ERR_ZIP_INVALID_ARCHIVE(
        `entry ${JSONStringify(this.name)} has an invalid local file header`);
    }
    this.#contentOffset = this.#localOffset + LocalFileHeader.length(fixed, 0);
    return this.#contentOffset;
  }
  // The in-memory raw bytes, or a clean state error when there are none - a
  // write-streaming entry (`createStream()`) has no readable content until it
  // has been serialized into a backing archive (after which `addEntry()`
  // promotes it to file-backed; see [kPromote]).
  #inMemoryCompressed() {
    if (this.#content === null) {
      throw new ERR_INVALID_STATE(
        'the content of a streaming entry is not available for reading');
    }
    return this.#content;
  }
  // The entry's raw (still-compressed) bytes. For an in-memory entry this is
  // the buffer it was built with; for a file-backed entry it is read from
  // disk on demand and never retained. Callers own the returned buffer.
  async #compressedBytes() {
    if (this.#fd === null) return this.#inMemoryCompressed();
    const size = this.compressedSize;
    // A member at or beyond the maximum Buffer length cannot be materialized
    // in one allocation; stream it instead. (kMaxLength equals the safe
    // integer ceiling on 64-bit, so a larger size fails to parse anyway.)
    if (size >= kMaxLength) {
      throw new ERR_ZIP_ENTRY_TOO_LARGE(
        `entry ${JSONStringify(this.name)} is too large to buffer ` +
        `(${size} compressed bytes); use contentIterator() instead`);
    }
    const start = await this.#resolveContentOffset();
    const compressed = Buffer.allocUnsafe(size);
    await readFdFully(this.#fd, compressed, start);
    return compressed;
  }
  #compressedBytesSync() {
    if (this.#fd === null) return this.#inMemoryCompressed();
    const size = this.compressedSize;
    if (size >= kMaxLength) {
      throw new ERR_ZIP_ENTRY_TOO_LARGE(
        `entry ${JSONStringify(this.name)} is too large to buffer ` +
        `(${size} compressed bytes); use contentIterator() instead`);
    }
    const start = this.#resolveContentOffsetSync();
    const compressed = Buffer.allocUnsafe(size);
    readFdFullySync(this.#fd, compressed, start);
    return compressed;
  }
  // The entry's raw compressed bytes as a bounded-memory chunk stream, read
  // straight from disk (file-backed entries only). Nothing is retained.
  async *#rawChunks() {
    const fd = this.#fd;
    let pos = await this.#resolveContentOffset();
    let remaining = this.compressedSize;
    while (remaining > 0) {
      const take = MathMin(READ_CHUNK_SIZE, remaining);
      const chunk = Buffer.allocUnsafe(take);
      await readFdFully(fd, chunk, pos);
      pos += take;
      remaining -= take;
      yield chunk;
    }
  }
  *#rawChunksSync() {
    const fd = this.#fd;
    let pos = this.#resolveContentOffsetSync();
    let remaining = this.compressedSize;
    while (remaining > 0) {
      const take = MathMin(READ_CHUNK_SIZE, remaining);
      const chunk = Buffer.allocUnsafe(take);
      readFdFullySync(fd, chunk, pos);
      pos += take;
      remaining -= take;
      yield chunk;
    }
  }

  /**
   * @param {{ verify?: boolean, maxSize?: number }} [options]
   * @returns {Promise<Buffer>}
   */
  async content(options) {
    if (this.flags & FLAG_ENCRYPTED) {
      throw new ERR_ZIP_UNSUPPORTED_FEATURE(
        `entry ${JSONStringify(this.name)} is encrypted`);
    }
    if (this.method !== METHOD_STORE && this.method !== METHOD_DEFLATE && this.method !== METHOD_ZSTD) {
      throw new ERR_ZIP_UNSUPPORTED_FEATURE(
        `entry ${JSONStringify(this.name)} uses compression method ${this.method}`);
    }
    const declared = this.size;
    const maxSize = options?.maxSize ?? maxZipContentSize;
    if (declared > maxSize) {
      throw new ERR_ZIP_ENTRY_TOO_LARGE(
        `entry ${JSONStringify(this.name)} declares ${declared} bytes, ` +
        `exceeding the ${maxSize} byte limit`);
    }
    const verify = options?.verify !== false;
    const compressed = await this.#compressedBytes();
    let data;
    if (this.method === METHOD_DEFLATE) {
      try {
        data = await inflateRawAsync(compressed, { maxOutputLength: maxSize });
      } catch (err) {
        if (err?.code === 'ERR_BUFFER_TOO_LARGE') {
          throw new ERR_ZIP_ENTRY_TOO_LARGE(
            `entry ${JSONStringify(this.name)} inflates beyond the ${maxSize} byte limit`);
        }
        throw new ERR_ZIP_ENTRY_CORRUPT(
          `entry ${JSONStringify(this.name)} failed to inflate: ${err.message}`);
      }
    } else if (this.method === METHOD_ZSTD) {
      try {
        data = await zstdDecompressAsync(compressed, { maxOutputLength: maxSize });
      } catch (err) {
        if (err?.code === 'ERR_BUFFER_TOO_LARGE') {
          throw new ERR_ZIP_ENTRY_TOO_LARGE(
            `entry ${JSONStringify(this.name)} decompresses beyond the ${maxSize} byte limit`);
        }
        throw new ERR_ZIP_ENTRY_CORRUPT(
          `entry ${JSONStringify(this.name)} failed to decompress: ${err.message}`);
      }
    } else {
      data = compressed;
    }
    if (data.length !== declared) {
      throw new ERR_ZIP_ENTRY_CORRUPT(
        `entry ${JSONStringify(this.name)} produced ${data.length} bytes, expected ${declared}`);
    }
    if (verify) {
      const crc = crc32Native(data, 0);
      if (crc !== this.crc32) {
        throw new ERR_ZIP_ENTRY_CORRUPT(
          `entry ${JSONStringify(this.name)} failed CRC-32 verification`);
      }
    }
    return data;
  }

  /**
   * The synchronous counterpart of `content()`. Blocks the event loop and
   * further JavaScript execution until the whole entry has been read and, if
   * applicable, inflated - use only where synchronous I/O is appropriate
   * (for example, short-lived scripts or startup code), not in code that
   * must stay responsive.
   * @param {{ verify?: boolean, maxSize?: number }} [options]
   * @returns {Buffer}
   */
  contentSync(options) {
    const declared = this.size;
    const maxSize = options?.maxSize ?? maxZipContentSize;
    if (declared > maxSize) {
      throw new ERR_ZIP_ENTRY_TOO_LARGE(
        `entry ${JSONStringify(this.name)} declares ${declared} bytes, ` +
        `exceeding the ${maxSize} byte limit`);
    }
    const compressed = this.#compressedBytesSync();
    return decodeMemberSync(compressed, {
      name: this.name,
      flags: this.flags,
      method: this.method,
      crc32: this.crc32,
      uncompressedSize: declared,
    }, { verify: options?.verify, maxSize });
  }

  // The raw (still-compressed) bytes as an async iterable, without buffering
  // the whole member: straight from disk for a file-backed entry, or the
  // single in-memory buffer otherwise. Throws synchronously for a pending
  // write-streaming entry, whose content is not yet available for reading.
  #rawSource() {
    if (this.#fd !== null) return this.#rawChunks();
    const content = this.#inMemoryCompressed();
    return (async function* () {
      if (content.length) yield content;
    })();
  }

  /**
   * Yields the entry's decompressed content as a bounded-memory async
   * iterator of `Buffer` chunks, decompressing on the way and (by default)
   * verifying CRC-32. For a file-backed entry (from `ZipFile.get()`) the
   * compressed bytes are read from disk as they are consumed and nothing is
   * retained.
   * @param {{ verify?: boolean, maxSize?: number }} [options]
   * @returns {AsyncGenerator<Buffer>}
   */
  contentIterator(options) {
    return decodeMemberStream(this.#rawSource(), {
      name: this.name,
      flags: this.flags,
      method: this.method,
      crc32: this.crc32,
      uncompressedSize: this.size,
    }, options);
  }

  *[SymbolIterator]() {
    if (this.#source) {
      throw new ERR_INVALID_STATE('a streaming entry cannot be serialized synchronously');
    }
    const meta = this.#finalizeMeta();
    yield buildLocalHeader(meta);
    if (this.#fd !== null) {
      yield* this.#rawChunksSync();
    } else if (this.#content?.length) {
      yield this.#content;
    }
  }

  async *[SymbolAsyncIterator]() {
    const source = this.#source;
    if (!source) {
      if (this.#fd !== null) {
        yield buildLocalHeader(this.#finalizeMeta());
        yield* this.#rawChunks();
        return;
      }
      yield* this[SymbolIterator]();
      return;
    }
    if (this.#serialized) {
      throw new ERR_INVALID_STATE('a streaming entry can only be serialized once');
    }
    this.#serialized = true;
    const meta = this.#meta;
    yield buildLocalHeader(meta);
    let state = 0;
    let uncompressedSize = 0;
    let compressedSize = 0;
    const counted = (async function* () {
      for await (const chunk of source) {
        if (!isUint8Array(chunk)) {
          throw new ERR_INVALID_ARG_TYPE('chunk', 'Uint8Array', chunk);
        }
        if (!chunk.length) continue;
        state = crc32Native(chunk, state);
        uncompressedSize += chunk.length;
        yield chunk;
      }
    })();
    const output = meta.method === METHOD_DEFLATE ? deflateRawStream(counted) :
      meta.method === METHOD_ZSTD ? zstdCompressStream(counted) : counted;
    for await (const chunk of output) {
      compressedSize += chunk.length;
      yield chunk;
    }
    meta.crc = state;
    meta.uncompressedSize = uncompressedSize;
    meta.compressedSize = compressedSize;
    meta.pending = false;
    yield buildDataDescriptor64(meta.crc, compressedSize, uncompressedSize);
  }

  /**
   * @private
   * @param {number} localOffset
   * @returns {Buffer}
   */
  [kFinalize](localOffset) {
    validateInteger(localOffset, 'localOffset', 0, NumberMAX_SAFE_INTEGER);
    return buildCentralHeader(this.#finalizeMeta(), localOffset);
  }

  // Rebind a just-serialized write-streaming entry to its on-disk copy so it
  // stops being dead weight: after `addEntry()`/`addEntrySync()` writes the
  // entry into `fd` at `localOffset` (its local-header start), the spent
  // source is dropped and the entry becomes a readable, re-serializable
  // file-backed entry (valid while `fd` stays open). Only a spent stream
  // entry - one with neither an in-memory buffer nor an existing backing fd -
  // is promoted; in-memory and already-file-backed entries are left as they
  // are. The kept `#meta` still supplies the (now-final) name/sizes/crc.
  [kPromote](fd, localOffset) {
    if (this.#content !== null || this.#fd !== null) return;
    this.#fd = fd;
    this.#localOffset = localOffset;
    this.#contentOffset = -1;
    this.#source = null;
    this.#serialized = false;
  }

  /**
   * @param {Buffer | TypedArray | DataView | ArrayBuffer} buffer
   * @yields {ZipEntry}
   */
  static *read(buffer) {
    const buf = toBuffer(buffer, 'buffer');
    const end = findArchiveEnd(buf);
    let pos = end.centralDirectoryOffset;
    const cdEnd = end.centralDirectoryOffset + end.centralDirectorySize;
    for (let index = 0; index < end.totalRecords; index++) {
      const central = new CentralFileHeader(buf, pos);
      if (pos + central.byteLength > cdEnd) {
        throw new ERR_ZIP_INVALID_ARCHIVE('central directory header is out of bounds');
      }
      if (central.diskNumber !== 0) {
        throw new ERR_ZIP_UNSUPPORTED_FEATURE('multi-disk archives are not supported');
      }
      const localOffset = central.localFileHeaderOffset + end.prefix;
      const local = new LocalFileHeader(buf, localOffset);
      const dataStart = localOffset + local.byteLength;
      const length = central.compressedSize;
      validateArchiveRange(buf, dataStart, length, 'entry data');
      const content = length ? buf.subarray(dataStart, dataStart + length) : EMPTY_BUFFER;
      yield new ZipEntry(central, local, content);
      pos = central.byteOffset + central.byteLength;
    }
  }

  /**
   * @param {string} filename
   * @param {Buffer | TypedArray | DataView | ArrayBuffer} data
   * @param {{
   *   comment?: string,
   *   mode?: number,
   *   modified?: Date,
   *   method?: 'deflate' | 'store' | 'zstd',
   * }} [options]
   * @returns {Promise<ZipEntry>}
   */
  static async create(filename, data, options) {
    const meta = createEntryMeta(filename, options);
    const content = toBuffer(data, 'data');
    const isDirectory = StringPrototypeEndsWith(filename, '/');
    if (isDirectory && content.length) {
      throw new ERR_INVALID_ARG_VALUE('data', data, 'must be empty for a directory entry');
    }
    meta.crc = crc32Native(content, 0);
    meta.uncompressedSize = content.length;
    let finalContent = content;
    let method = isDirectory || content.length === 0 || options?.method === 'store' ? METHOD_STORE :
      options?.method === 'zstd' ? METHOD_ZSTD : METHOD_DEFLATE;
    if (method === METHOD_DEFLATE) {
      const compressed = await deflateRawAsync(content);
      if (compressed.length >= content.length) {
        method = METHOD_STORE; // Deflate did not help; fall back to storing
      } else {
        finalContent = compressed;
      }
    } else if (method === METHOD_ZSTD) {
      const compressed = await zstdCompressAsync(content);
      if (compressed.length >= content.length) {
        method = METHOD_STORE; // Zstd did not help; fall back to storing
      } else {
        finalContent = compressed;
      }
    }
    meta.method = method;
    meta.compressedSize = finalContent.length;
    meta.pending = false;
    const entry = new ZipEntry(null, null, finalContent);
    entry.#meta = meta;
    return entry;
  }

  /**
   * The synchronous counterpart of `create()`. Blocks the event loop and
   * further JavaScript execution until done (including the deflate pass);
   * see `contentSync()`.
   * @param {string} filename
   * @param {Buffer | TypedArray | DataView | ArrayBuffer} data
   * @param {{
   *   comment?: string,
   *   mode?: number,
   *   modified?: Date,
   *   method?: 'deflate' | 'store' | 'zstd',
   * }} [options]
   * @returns {ZipEntry}
   */
  static createSync(filename, data, options) {
    const meta = createEntryMeta(filename, options);
    const content = toBuffer(data, 'data');
    const isDirectory = StringPrototypeEndsWith(filename, '/');
    if (isDirectory && content.length) {
      throw new ERR_INVALID_ARG_VALUE('data', data, 'must be empty for a directory entry');
    }
    meta.crc = crc32Native(content, 0);
    meta.uncompressedSize = content.length;
    let finalContent = content;
    let method = isDirectory || content.length === 0 || options?.method === 'store' ? METHOD_STORE :
      options?.method === 'zstd' ? METHOD_ZSTD : METHOD_DEFLATE;
    if (method === METHOD_DEFLATE) {
      const compressed = lazyZlib().deflateRawSync(content);
      if (compressed.length >= content.length) {
        method = METHOD_STORE; // Deflate did not help; fall back to storing
      } else {
        finalContent = compressed;
      }
    } else if (method === METHOD_ZSTD) {
      const compressed = lazyZlib().zstdCompressSync(content);
      if (compressed.length >= content.length) {
        method = METHOD_STORE; // Zstd did not help; fall back to storing
      } else {
        finalContent = compressed;
      }
    }
    meta.method = method;
    meta.compressedSize = finalContent.length;
    meta.pending = false;
    const entry = new ZipEntry(null, null, finalContent);
    entry.#meta = meta;
    return entry;
  }

  /**
   * @param {string} filename
   * @param {AsyncIterable<Buffer>} source
   * @param {{ comment?: string, mode?: number, modified?: Date, method?: 'deflate' | 'store' | 'zstd' }} [options]
   * @returns {ZipEntry}
   */
  static createStream(filename, source, options) {
    const meta = createEntryMeta(filename, options);
    if (StringPrototypeEndsWith(filename, '/')) {
      throw new ERR_INVALID_ARG_VALUE('filename', filename, 'a directory entry cannot be streamed');
    }
    meta.flags |= FLAG_DATA_DESCRIPTOR;
    meta.method = options?.method === 'store' ? METHOD_STORE :
      options?.method === 'zstd' ? METHOD_ZSTD : METHOD_DEFLATE;
    meta.pending = true;
    const entry = new ZipEntry(null, null, null);
    entry.#meta = meta;
    entry.#source = source;
    return entry;
  }
}

/**
 * `createZipArchive()`/`createZipArchiveSync()` (and the `ZipBuffer`
 * `toBuffer()`/`toBufferSync()` methods that forward to them) take a single
 * optional `options` argument that doubles as a plain archive comment: a
 * string is shorthand for `{ comment: options }`.
 * @param {string | { comment?: string, baseOffset?: number }} [options]
 * @returns {{ comment: string | undefined, baseOffset: number }}
 */
function normalizeArchiveOptions(options) {
  if (options === undefined) return { comment: undefined, baseOffset: 0 };
  if (typeof options === 'string') return { comment: options, baseOffset: 0 };
  validateObject(options, 'options');
  const { comment, baseOffset = 0 } = options;
  if (comment !== undefined) validateString(comment, 'options.comment');
  validateInteger(baseOffset, 'options.baseOffset', 0, NumberMAX_SAFE_INTEGER);
  return { comment, baseOffset };
}

/**
 * Serializes `entries` (a (async) iterable of `ZipEntry`) into a `Readable`
 * stream of archive byte chunks, automatically switching to Zip64 structures
 * once the entry count or any offset/size exceeds the classic 32-/16-bit
 * limits.
 *
 * `options.baseOffset` shifts every local/central header offset the archive
 * records by that many bytes, so the emitted bytes are self-describing even
 * when something else is written before them - for example, appending the
 * archive after `baseOffset` bytes already written to the same file, rather
 * than at its start.
 * @param {Iterable<ZipEntry> | AsyncIterable<ZipEntry>} entries
 * @param {string | { comment?: string, baseOffset?: number }} [options]
 * @returns {Readable}
 */
function createZipArchive(entries, options) {
  return Readable.from(generateZipArchive(entries, options), { objectMode: false });
}

async function* generateZipArchive(entries, options) {
  const { comment, baseOffset } = normalizeArchiveOptions(options);
  let commentBuffer = EMPTY_BUFFER;
  if (comment !== undefined) {
    commentBuffer = Buffer.from(comment, 'utf8');
    if (commentBuffer.length > SENTINEL16) {
      throw new ERR_ZIP_ENTRY_TOO_LARGE(
        'the archive comment must not exceed 65535 bytes when encoded as UTF-8');
    }
  }
  const centralHeaders = [];
  let pos = baseOffset;
  for await (const entry of entries) {
    const start = pos;
    for await (const chunk of entry) {
      yield chunk;
      pos += chunk.length;
    }
    ArrayPrototypePush(centralHeaders, entry[kFinalize](start));
  }
  const centralDirectoryOffset = pos;
  for (let i = 0; i < centralHeaders.length; i++) {
    const chunk = centralHeaders[i];
    yield chunk;
    pos += chunk.length;
  }
  const centralDirectorySize = pos - centralDirectoryOffset;
  const count = centralHeaders.length;
  const zip64 =
    count >= SENTINEL16 ||
    centralDirectoryOffset >= SENTINEL32 ||
    centralDirectorySize >= SENTINEL32;
  if (zip64) {
    const recordOffset = pos;
    yield buildZip64EndRecord(count, centralDirectorySize, centralDirectoryOffset);
    yield buildZip64EndLocator(recordOffset);
  }
  yield buildEndOfCentralDirectory(
    count, centralDirectorySize, centralDirectoryOffset, commentBuffer);
}

/**
 * The synchronous counterpart of `createZipArchive()`. `entries` must be a
 * plain (synchronous) `Iterable` of entries that don't require an
 * asynchronous serialization pass - a streaming entry created with
 * `ZipEntry.createStream()` throws when its turn to serialize comes up, the
 * same as calling `entry[Symbol.iterator]()` on one directly. Blocks the
 * event loop and further JavaScript execution until the whole archive
 * (including any deflate passes) has been produced; see
 * `zipEntry.contentSync()`.
 * @param {Iterable<ZipEntry>} entries
 * @param {string | { comment?: string, baseOffset?: number }} [options]
 * @yields {Buffer}
 */
function* createZipArchiveSync(entries, options) {
  const { comment, baseOffset } = normalizeArchiveOptions(options);
  let commentBuffer = EMPTY_BUFFER;
  if (comment !== undefined) {
    commentBuffer = Buffer.from(comment, 'utf8');
    if (commentBuffer.length > SENTINEL16) {
      throw new ERR_ZIP_ENTRY_TOO_LARGE(
        'the archive comment must not exceed 65535 bytes when encoded as UTF-8');
    }
  }
  const centralHeaders = [];
  let pos = baseOffset;
  for (const entry of entries) {
    const start = pos;
    for (const chunk of entry) {
      yield chunk;
      pos += chunk.length;
    }
    ArrayPrototypePush(centralHeaders, entry[kFinalize](start));
  }
  const centralDirectoryOffset = pos;
  for (let i = 0; i < centralHeaders.length; i++) {
    const chunk = centralHeaders[i];
    yield chunk;
    pos += chunk.length;
  }
  const centralDirectorySize = pos - centralDirectoryOffset;
  const count = centralHeaders.length;
  const zip64 =
    count >= SENTINEL16 ||
    centralDirectoryOffset >= SENTINEL32 ||
    centralDirectorySize >= SENTINEL32;
  if (zip64) {
    const recordOffset = pos;
    yield buildZip64EndRecord(count, centralDirectorySize, centralDirectoryOffset);
    yield buildZip64EndLocator(recordOffset);
  }
  yield buildEndOfCentralDirectory(
    count, centralDirectorySize, centralDirectoryOffset, commentBuffer);
}

/**
 * An in-memory view over the entries of a ZIP archive, writable in place:
 * entries can be added or removed, and `toBuffer()` serializes the current
 * set of entries into a fresh archive.
 */
class ZipBuffer {
  #entries = new Map();
  #comment;

  /**
   * @param {Buffer | TypedArray | DataView | ArrayBuffer} buffer
   */
  constructor(buffer) {
    const buf = toBuffer(buffer, 'buffer');
    this.#comment = findArchiveEnd(buf).comment;
    for (const entry of ZipEntry.read(buf)) {
      MapPrototypeSet(this.#entries, entry.name, entry);
    }
  }
  get writable() { return true; }
  get comment() { return this.#comment.toString('utf8'); }
  has(name) {
    validateString(name, 'name');
    return MapPrototypeHas(this.#entries, name);
  }
  get(name) {
    validateString(name, 'name');
    const entry = MapPrototypeGet(this.#entries, name);
    if (entry === undefined) throw new ERR_ZIP_ENTRY_NOT_FOUND(name);
    return entry;
  }
  /**
   * Adds an already-built entry, keyed by its own name (replacing any
   * existing entry of that name).
   * @param {ZipEntry} entry
   * @returns {ZipEntry}
   */
  addEntry(entry) {
    if (!(entry instanceof ZipEntry)) {
      throw new ERR_INVALID_ARG_TYPE('entry', 'ZipEntry', entry);
    }
    MapPrototypeSet(this.#entries, entry.name, entry);
    return entry;
  }
  /**
   * @param {string} filename
   * @param {Buffer | TypedArray | DataView | ArrayBuffer} data
   * @param {{ comment?: string, mode?: number, modified?: Date, method?: 'deflate' | 'store' | 'zstd' }} [options]
   * @returns {Promise<ZipEntry>}
   */
  async add(filename, data, options) {
    return this.addEntry(await ZipEntry.create(filename, data, options));
  }
  /**
   * The synchronous counterpart of `add()`. Blocks the event loop and
   * further JavaScript execution until done; see `zipEntry.contentSync()`.
   * @param {string} filename
   * @param {Buffer | TypedArray | DataView | ArrayBuffer} data
   * @param {{ comment?: string, mode?: number, modified?: Date, method?: 'deflate' | 'store' | 'zstd' }} [options]
   * @returns {ZipEntry}
   */
  addSync(filename, data, options) {
    return this.addEntry(ZipEntry.createSync(filename, data, options));
  }
  /**
   * @param {string} name
   * @returns {boolean}
   */
  delete(name) {
    validateString(name, 'name');
    return MapPrototypeDelete(this.#entries, name);
  }
  clear() {
    MapPrototypeClear(this.#entries);
  }
  keys() { return MapPrototypeKeys(this.#entries); }
  *values() {
    for (const name of this.keys()) yield this.get(name);
  }
  *entries() {
    for (const name of this.keys()) yield [name, this.get(name)];
  }
  get size() { return MapPrototypeGetSize(this.#entries); }
  [SymbolIterator]() { return this.entries(); }
  get [SymbolToStringTag]() { return 'ZipBuffer'; }
  forEach(callback, thisArg) {
    validateFunction(callback, 'callback');
    for (const { 0: key, 1: value } of MapPrototypeEntries(this.#entries)) {
      FunctionPrototypeCall(callback, thisArg === undefined ? this : thisArg, value, key, this);
    }
  }
  /**
   * Serializes the current set of entries into a fresh archive.
   * @param {string | { comment?: string, baseOffset?: number }} [options]
   * @returns {Promise<Buffer>}
   */
  async toBuffer(options) {
    const { comment, baseOffset } = normalizeArchiveOptions(options);
    const chunks = [];
    for await (const chunk of createZipArchive(this.values(), { comment: comment ?? this.comment, baseOffset })) {
      ArrayPrototypePush(chunks, chunk);
    }
    return Buffer.concat(chunks);
  }
  /**
   * The synchronous counterpart of `toBuffer()`. Blocks the event loop and
   * further JavaScript execution until the whole archive has been
   * serialized; see `zipEntry.contentSync()`.
   * @param {string | { comment?: string, baseOffset?: number }} [options]
   * @returns {Buffer}
   */
  toBufferSync(options) {
    const { comment, baseOffset } = normalizeArchiveOptions(options);
    const chunks = [];
    for (const chunk of createZipArchiveSync(this.values(), { comment: comment ?? this.comment, baseOffset })) {
      ArrayPrototypePush(chunks, chunk);
    }
    return Buffer.concat(chunks);
  }
  [SymbolDispose]() {
    MapPrototypeClear(this.#entries);
  }
}

const READ_CHUNK_SIZE = 4 * 1024 * 1024;
// EOCD + max comment + Zip64 locator + Zip64 record + slack for an
// extensible data sector.
const TAIL_LENGTH = 22 + SENTINEL16 + 20 + 56 + 4096;

// `ZipFile` operates on a plain numeric file descriptor (rather than an
// `fs.promises` `FileHandle`) so that a single instance can support both the
// async and the `Sync` methods: `fs.read`/`fs.write`/`fs.fstat`/
// `fs.ftruncate`/`fs.close` all accept a raw fd directly, same as their
// `*Sync` counterparts, so both call sites share one open file underneath.
function fsOpenAsync(path, flag) {
  return new Promise((resolve, reject) => {
    fs.open(path, flag, (err, fd) => (err ? reject(err) : resolve(fd)));
  });
}

function fsCloseAsync(fd) {
  return new Promise((resolve, reject) => {
    fs.close(fd, (err) => (err ? reject(err) : resolve()));
  });
}

function fsFstatAsync(fd) {
  return new Promise((resolve, reject) => {
    fs.fstat(fd, (err, stats) => (err ? reject(err) : resolve(stats)));
  });
}

function fsReadAsync(fd, buffer, offset, length, position) {
  return new Promise((resolve, reject) => {
    fs.read(fd, buffer, offset, length, position, (err, bytesRead) => (err ? reject(err) : resolve(bytesRead)));
  });
}

function fsWriteAsync(fd, buffer, offset, length, position) {
  return new Promise((resolve, reject) => {
    fs.write(fd, buffer, offset, length, position, (err, bytesWritten) => (err ? reject(err) : resolve(bytesWritten)));
  });
}

function fsFtruncateAsync(fd, len) {
  return new Promise((resolve, reject) => {
    fs.ftruncate(fd, len, (err) => (err ? reject(err) : resolve()));
  });
}

async function readFdFully(fd, buffer, position) {
  let done = 0;
  while (done < buffer.length) {
    const bytesRead = await fsReadAsync(fd, buffer, done, buffer.length - done, position + done);
    if (bytesRead <= 0) {
      throw new ERR_ZIP_INVALID_ARCHIVE('unexpected end of file');
    }
    done += bytesRead;
  }
}

function readFdFullySync(fd, buffer, position) {
  let done = 0;
  while (done < buffer.length) {
    const bytesRead = fs.readSync(fd, buffer, done, buffer.length - done, position + done);
    if (bytesRead <= 0) {
      throw new ERR_ZIP_INVALID_ARCHIVE('unexpected end of file');
    }
    done += bytesRead;
  }
}

function readCentralDirectory(buffer, count) {
  const result = [];
  let pos = 0;
  for (let index = 0; index < count; index++) {
    const header = new CentralFileHeader(buffer, pos);
    if (header.diskNumber !== 0) {
      throw new ERR_ZIP_UNSUPPORTED_FEATURE('multi-disk archives are not supported');
    }
    ArrayPrototypePush(result, header);
    pos += header.byteLength;
  }
  return result;
}

/**
 * Builds a fresh central directory (plus Zip64 structures and EOCD, as
 * needed) for `records`, an array of `{ entry, localOffset }` pairs already
 * in their final order and at their final (possibly pre-existing, possibly
 * freshly written) offsets.
 * @param {Array<{ entry: ZipEntry, localOffset: number }>} records
 * @param {number} centralDirectoryOffset
 * @param {Buffer} comment
 * @returns {{ centralHeaders: Buffer[], chunks: Buffer[] }}
 */
function buildCentralDirectoryChunks(records, centralDirectoryOffset, comment) {
  const centralHeaders = [];
  let centralDirectorySize = 0;
  for (let i = 0; i < records.length; i++) {
    const header = records[i].entry[kFinalize](records[i].localOffset);
    ArrayPrototypePush(centralHeaders, header);
    centralDirectorySize += header.length;
  }
  const count = records.length;
  const zip64 =
    count >= SENTINEL16 ||
    centralDirectoryOffset >= SENTINEL32 ||
    centralDirectorySize >= SENTINEL32;
  const chunks = [];
  for (let i = 0; i < centralHeaders.length; i++) ArrayPrototypePush(chunks, centralHeaders[i]);
  if (zip64) {
    const recordOffset = centralDirectoryOffset + centralDirectorySize;
    ArrayPrototypePush(chunks, buildZip64EndRecord(count, centralDirectorySize, centralDirectoryOffset));
    ArrayPrototypePush(chunks, buildZip64EndLocator(recordOffset));
  }
  ArrayPrototypePush(
    chunks, buildEndOfCentralDirectory(count, centralDirectorySize, centralDirectoryOffset, comment));
  return { centralHeaders, chunks };
}

/**
 * A random-access view over the entries of a ZIP archive on disk. Only the
 * archive tail and central directory are read up front; individual member
 * content is read lazily and on demand. Writable when opened with
 * `{ writable: true }`: adding or deleting an entry rewrites the central
 * directory in place, appending new entry content where the old central
 * directory used to be.
 *
 * Every method has a `*Sync` counterpart. The synchronous methods block the
 * Node.js event loop and further JavaScript execution until the operation
 * completes - use them only where synchronous I/O is appropriate (for
 * example, short-lived scripts or startup code), never in code that must
 * stay responsive. A synchronous method throws `ERR_INVALID_STATE` if called
 * while an asynchronous `addEntry()`/`add()`/`delete()`/`close()` on the same
 * `ZipFile` has not settled yet, since letting the two interleave could
 * corrupt the archive.
 */
class ZipFile {
  #fd;
  #writable;
  #comment;
  #centralDirectoryOffset;
  #entries = new Map();
  #queue = PromiseResolve();
  #pendingAsyncOps = 0;

  /**
   * @private
   */
  constructor(fd, centralHeaders, prefix, centralDirectoryOffset, comment, writable) {
    this.#fd = fd;
    this.#writable = writable;
    this.#comment = comment;
    this.#centralDirectoryOffset = centralDirectoryOffset;
    for (let i = 0; i < centralHeaders.length; i++) {
      const central = centralHeaders[i];
      MapPrototypeSet(this.#entries, central.fileName, {
        central,
        entry: undefined,
        localOffset: central.localFileHeaderOffset + prefix,
      });
    }
  }
  get writable() { return this.#writable; }
  get comment() { return this.#comment.toString('utf8'); }
  #assertWritable() {
    if (!this.#writable) throw new ERR_ZIP_NOT_WRITABLE();
  }
  #assertNotBusy() {
    if (this.#pendingAsyncOps > 0) {
      throw new ERR_INVALID_STATE(
        'cannot call a synchronous ZipFile method while an asynchronous ' +
        'add(), addEntry(), delete(), or close() call has not settled yet');
    }
  }
  #enqueue(fn) {
    this.#pendingAsyncOps++;
    const run = async () => {
      try {
        return await fn();
      } finally {
        this.#pendingAsyncOps--;
      }
    };
    const result = PromisePrototypeThen(this.#queue, run, run);
    this.#queue = PromisePrototypeThen(result, () => undefined, () => undefined);
    return result;
  }
  has(name) {
    validateString(name, 'name');
    return MapPrototypeHas(this.#entries, name);
  }
  // Return the lazy, file-backed ZipEntry handle for `info`, creating and
  // caching it on first access. The handle stores only a descriptor and the
  // local-header offset - never the member's content - so repeated `get()`s
  // return the same lightweight object and no content buffer is retained by
  // the ZipFile. Any read (`content()`, `contentIterator()`) goes to disk.
  #handleFor(info) {
    info.entry ??= new ZipEntry(info.central, null, null, this.#fd, info.localOffset);
    return info.entry;
  }
  /**
   * Returns a lazy, file-backed `ZipEntry` for `name`. Nothing is read from
   * disk here and no content is buffered; the entry reads (and, for
   * `content()`, decompresses) straight from the file on each access. The
   * returned entry is valid only while this `ZipFile` is open.
   * @param {string} name
   * @returns {Promise<ZipEntry>}
   */
  async get(name) {
    validateString(name, 'name');
    const info = MapPrototypeGet(this.#entries, name);
    if (info === undefined) throw new ERR_ZIP_ENTRY_NOT_FOUND(name);
    return this.#handleFor(info);
  }
  /**
   * The synchronous counterpart of `get()`. Like `get()`, it reads nothing
   * up front and buffers no content - it only builds the lazy handle - so it
   * does not itself block on I/O; see the class-level note on synchronous
   * methods for reads performed later through the returned entry.
   * @param {string} name
   * @returns {ZipEntry}
   */
  getSync(name) {
    this.#assertNotBusy();
    validateString(name, 'name');
    const info = MapPrototypeGet(this.#entries, name);
    if (info === undefined) throw new ERR_ZIP_ENTRY_NOT_FOUND(name);
    return this.#handleFor(info);
  }
  /**
   * Streams a member's decoded content without buffering the whole member,
   * as a `Readable` (verifying CRC-32 by default; `{ verify: false }` to opt
   * out). Sugar for wrapping `get(name).contentIterator(options)`; the
   * compressed bytes are read from disk as the stream is consumed.
   * @param {string} name
   * @param {{ verify?: boolean, maxSize?: number }} [options]
   * @returns {Promise<import('stream').Readable>}
   */
  async stream(name, options) {
    const entry = await this.get(name);
    return Readable.from(entry.contentIterator(options), { objectMode: false });
  }
  /**
   * Writes `entry`'s serialized bytes where the central directory currently
   * starts, then rewrites the central directory to include it. Replaces any
   * existing entry of the same name (its bytes become dead space, reclaimed
   * by `compact()`).
   * @param {ZipEntry} entry
   * @returns {Promise<ZipEntry>}
   */
  async addEntry(entry) {
    this.#assertWritable();
    if (!(entry instanceof ZipEntry)) {
      throw new ERR_INVALID_ARG_TYPE('entry', 'ZipEntry', entry);
    }
    return this.#enqueue(() => this.#doAdd(entry));
  }
  /**
   * @param {string} filename
   * @param {Buffer | TypedArray | DataView | ArrayBuffer} data
   * @param {{ comment?: string, mode?: number, modified?: Date, method?: 'deflate' | 'store' | 'zstd' }} [options]
   * @returns {Promise<ZipEntry>}
   */
  async add(filename, data, options) {
    this.#assertWritable();
    return this.addEntry(await ZipEntry.create(filename, data, options));
  }
  async #doAdd(entry) {
    const localOffset = this.#centralDirectoryOffset;
    let written = 0;
    for await (const chunk of entry) {
      await fsWriteAsync(this.#fd, chunk, 0, chunk.length, localOffset + written);
      written += chunk.length;
    }
    this.#centralDirectoryOffset = localOffset + written;
    MapPrototypeSet(this.#entries, entry.name, { central: null, entry, localOffset });
    await this.#rewriteCentralDirectory();
    // The entry now has a stable home in this archive; if it was a spent
    // streaming entry, rebind it to that on-disk copy so it stays readable.
    entry[kPromote](this.#fd, localOffset);
    return entry;
  }
  /**
   * The synchronous counterpart of `addEntry()`. `entry` must not be a
   * pending streaming entry (one created with `ZipEntry.createStream()`) -
   * there is no synchronous way to drain its asynchronous source. Blocks the
   * event loop until done; see the class-level note on synchronous methods.
   * @param {ZipEntry} entry
   * @returns {ZipEntry}
   */
  addEntrySync(entry) {
    this.#assertWritable();
    this.#assertNotBusy();
    if (!(entry instanceof ZipEntry)) {
      throw new ERR_INVALID_ARG_TYPE('entry', 'ZipEntry', entry);
    }
    const localOffset = this.#centralDirectoryOffset;
    let written = 0;
    for (const chunk of entry) {
      fs.writeSync(this.#fd, chunk, 0, chunk.length, localOffset + written);
      written += chunk.length;
    }
    this.#centralDirectoryOffset = localOffset + written;
    MapPrototypeSet(this.#entries, entry.name, { central: null, entry, localOffset });
    this.#rewriteCentralDirectorySync();
    entry[kPromote](this.#fd, localOffset);
    return entry;
  }
  /**
   * The synchronous counterpart of `add()`. Blocks the event loop until
   * done (including the deflate pass); see the class-level note on
   * synchronous methods.
   * @param {string} filename
   * @param {Buffer | TypedArray | DataView | ArrayBuffer} data
   * @param {{ comment?: string, mode?: number, modified?: Date, method?: 'deflate' | 'store' | 'zstd' }} [options]
   * @returns {ZipEntry}
   */
  addSync(filename, data, options) {
    this.#assertWritable();
    return this.addEntrySync(ZipEntry.createSync(filename, data, options));
  }
  /**
   * Removes an entry by name. The central directory is rewritten in place
   * (no new content is written, so the archive does not grow); the removed
   * entry's bytes become dead space, reclaimed by `compact()`.
   * @param {string} name
   * @returns {Promise<boolean>}
   */
  async delete(name) {
    this.#assertWritable();
    validateString(name, 'name');
    return this.#enqueue(() => this.#doDelete(name));
  }
  async #doDelete(name) {
    const existed = MapPrototypeDelete(this.#entries, name);
    if (existed) await this.#rewriteCentralDirectory();
    return existed;
  }
  /**
   * The synchronous counterpart of `delete()`. Blocks the event loop until
   * done; see the class-level note on synchronous methods.
   * @param {string} name
   * @returns {boolean}
   */
  deleteSync(name) {
    this.#assertWritable();
    this.#assertNotBusy();
    validateString(name, 'name');
    const existed = MapPrototypeDelete(this.#entries, name);
    if (existed) this.#rewriteCentralDirectorySync();
    return existed;
  }
  #liveRecords() {
    const records = [];
    const names = [];
    for (const { 0: name, 1: value } of MapPrototypeEntries(this.#entries)) {
      ArrayPrototypePush(records, {
        entry: value.entry ?? new ZipEntry(value.central, null, null),
        localOffset: value.localOffset,
      });
      ArrayPrototypePush(names, name);
    }
    return { records, names };
  }
  async #rewriteCentralDirectory() {
    const { records, names } = this.#liveRecords();
    const { centralHeaders, chunks } = buildCentralDirectoryChunks(
      records, this.#centralDirectoryOffset, this.#comment);
    let pos = this.#centralDirectoryOffset;
    for (let i = 0; i < chunks.length; i++) {
      await fsWriteAsync(this.#fd, chunks[i], 0, chunks[i].length, pos);
      pos += chunks[i].length;
    }
    await fsFtruncateAsync(this.#fd, pos);
    this.#adoptRewrittenCentralDirectory(names, centralHeaders, records);
  }
  #rewriteCentralDirectorySync() {
    const { records, names } = this.#liveRecords();
    const { centralHeaders, chunks } = buildCentralDirectoryChunks(
      records, this.#centralDirectoryOffset, this.#comment);
    let pos = this.#centralDirectoryOffset;
    for (let i = 0; i < chunks.length; i++) {
      fs.writeSync(this.#fd, chunks[i], 0, chunks[i].length, pos);
      pos += chunks[i].length;
    }
    fs.ftruncateSync(this.#fd, pos);
    this.#adoptRewrittenCentralDirectory(names, centralHeaders, records);
  }
  // Re-derives fresh, disk-backed central headers from what was just
  // written, so every entry - original or freshly added - is uniformly
  // readable by offset from now on, regardless of whether its in-memory
  // ZipEntry (e.g. a streaming entry, whose source can only be consumed
  // once) is still around.
  #adoptRewrittenCentralDirectory(names, centralHeaders, records) {
    for (let i = 0; i < names.length; i++) {
      MapPrototypeSet(this.#entries, names[i], {
        central: new CentralFileHeader(centralHeaders[i], 0),
        entry: undefined,
        localOffset: records[i].localOffset,
      });
    }
  }
  /**
   * Serializes the currently live entries into a fresh archive stream,
   * leaving behind any dead space left by prior `addEntry()`/`delete()`
   * calls. Does not modify the open file; pipe the result into a new one.
   * @param {string} [comment]
   * @returns {import('stream').Readable}
   */
  compact(comment) {
    const self = this;
    async function* liveEntries() {
      for (const name of self.keys()) {
        yield await self.get(name);
      }
    }
    return createZipArchive(liveEntries(), comment ?? this.comment);
  }
  /**
   * The synchronous counterpart of `compact()`. Blocks the event loop until
   * the whole archive has been read and re-serialized; see the class-level
   * note on synchronous methods.
   * @param {string} [comment]
   * @returns {Buffer}
   */
  compactSync(comment) {
    this.#assertNotBusy();
    const self = this;
    function* liveEntries() {
      for (const name of self.keys()) yield self.getSync(name);
    }
    const chunks = [];
    for (const chunk of createZipArchiveSync(liveEntries(), comment ?? this.comment)) {
      ArrayPrototypePush(chunks, chunk);
    }
    return Buffer.concat(chunks);
  }
  keys() { return MapPrototypeKeys(this.#entries); }
  *values() {
    for (const name of this.keys()) yield this.get(name);
  }
  /**
   * The synchronous counterpart of `values()`, yielding resolved `ZipEntry`
   * values instead of `Promise`s.
   * @yields {ZipEntry}
   */
  *valuesSync() {
    for (const name of this.keys()) yield this.getSync(name);
  }
  *entries() {
    for (const name of this.keys()) yield [name, this.get(name)];
  }
  /**
   * The synchronous counterpart of `entries()`, yielding resolved `ZipEntry`
   * values instead of `Promise`s.
   * @yields {[string, ZipEntry]}
   */
  *entriesSync() {
    for (const name of this.keys()) yield [name, this.getSync(name)];
  }
  async *[SymbolAsyncIterator]() {
    for (const promise of this.values()) yield await promise;
  }
  get size() { return MapPrototypeGetSize(this.#entries); }
  [SymbolIterator]() { return this.entries(); }
  get [SymbolToStringTag]() { return 'ZipFile'; }
  forEach(callback, thisArg) {
    validateFunction(callback, 'callback');
    for (const { 0: key, 1: value } of this.entries()) {
      FunctionPrototypeCall(callback, thisArg === undefined ? this : thisArg, value, key, this);
    }
  }
  /**
   * The synchronous counterpart of `forEach()`, invoking `callback` with a
   * resolved `ZipEntry` instead of a `Promise`.
   * @param {Function} callback
   * @param {*} [thisArg]
   */
  forEachSync(callback, thisArg) {
    validateFunction(callback, 'callback');
    for (const { 0: key, 1: value } of this.entriesSync()) {
      FunctionPrototypeCall(callback, thisArg === undefined ? this : thisArg, value, key, this);
    }
  }
  close() {
    return this.#enqueue(async () => {
      MapPrototypeClear(this.#entries);
      await fsCloseAsync(this.#fd);
    });
  }
  /**
   * The synchronous counterpart of `close()`; see the class-level note on
   * synchronous methods.
   */
  closeSync() {
    this.#assertNotBusy();
    MapPrototypeClear(this.#entries);
    fs.closeSync(this.#fd);
  }
  async [SymbolAsyncDispose]() {
    await this.close();
  }
  [SymbolDispose]() {
    this.closeSync();
  }
  /**
   * @param {string} filename
   * @param {{ writable?: boolean }} [options]
   * @returns {Promise<ZipFile>}
   */
  static async open(filename, options) {
    validateString(filename, 'filename');
    const writable = options?.writable ?? false;
    validateBoolean(writable, 'options.writable');
    const fd = await fsOpenAsync(filename, writable ? 'r+' : 'r');
    try {
      const stat = await fsFstatAsync(fd);
      const size = stat.size;
      const tailLength = MathMin(size, TAIL_LENGTH);
      const tail = Buffer.allocUnsafe(tailLength);
      await readFdFully(fd, tail, size - tailLength);
      const end = findArchiveEnd(tail, size - tailLength);
      if (end.centralDirectorySize > kMaxLength) {
        throw new ERR_ZIP_ENTRY_TOO_LARGE('the central directory is too large to buffer');
      }
      if (end.centralDirectoryOffset + end.centralDirectorySize > size) {
        throw new ERR_ZIP_INVALID_ARCHIVE('central directory is out of bounds');
      }
      const directory = Buffer.allocUnsafe(end.centralDirectorySize);
      await readFdFully(fd, directory, end.centralDirectoryOffset);
      const headers = readCentralDirectory(directory, end.totalRecords);
      return new ZipFile(fd, headers, end.prefix, end.centralDirectoryOffset, end.comment, writable);
    } catch (err) {
      try {
        await fsCloseAsync(fd);
      } catch {
        // The archive failed to parse; the close error is not actionable.
      }
      throw err;
    }
  }
  /**
   * The synchronous counterpart of `open()`. Blocks the event loop and
   * further JavaScript execution until the archive's tail and central
   * directory have been read; see the class-level note on synchronous
   * methods.
   * @param {string} filename
   * @param {{ writable?: boolean }} [options]
   * @returns {ZipFile}
   */
  static openSync(filename, options) {
    validateString(filename, 'filename');
    const writable = options?.writable ?? false;
    validateBoolean(writable, 'options.writable');
    const fd = fs.openSync(filename, writable ? 'r+' : 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const tailLength = MathMin(size, TAIL_LENGTH);
      const tail = Buffer.allocUnsafe(tailLength);
      readFdFullySync(fd, tail, size - tailLength);
      const end = findArchiveEnd(tail, size - tailLength);
      if (end.centralDirectorySize > kMaxLength) {
        throw new ERR_ZIP_ENTRY_TOO_LARGE('the central directory is too large to buffer');
      }
      if (end.centralDirectoryOffset + end.centralDirectorySize > size) {
        throw new ERR_ZIP_INVALID_ARCHIVE('central directory is out of bounds');
      }
      const directory = Buffer.allocUnsafe(end.centralDirectorySize);
      readFdFullySync(fd, directory, end.centralDirectoryOffset);
      const headers = readCentralDirectory(directory, end.totalRecords);
      return new ZipFile(fd, headers, end.prefix, end.centralDirectoryOffset, end.comment, writable);
    } catch (err) {
      try {
        fs.closeSync(fd);
      } catch {
        // The archive failed to parse; the close error is not actionable.
      }
      throw err;
    }
  }
}

module.exports = {
  ZipEntry,
  ZipFile,
  ZipBuffer,
  createZipArchive,
  createZipArchiveSync,
  getMaxZipContentSize,
  setMaxZipContentSize,
};
