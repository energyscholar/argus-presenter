/*!
 * zipread.mjs — minimal, dependency-free ZIP *reader*. SERVER-SIDE ONLY.
 *
 * Why hand-rolled: module packages are ZIP (S209 ruling), but this repo is deliberately
 * zero-dependency and Node ships no ZIP reader. It does ship `zlib.inflateRawSync`, which is
 * the only hard part — the container format around it is a few structs. ~1 file, no deps.
 *
 * Reader ONLY. We never write archives; a module package is produced elsewhere and consumed here.
 * Clients never see an archive — they receive assembled content, so nothing here reaches the browser.
 *
 * Supports the two methods that occur in practice: 0 (stored) and 8 (deflate).
 *
 * HOSTILE INPUT IS ASSUMED. A package may be uploaded. Guards, all on by default:
 *   - path traversal ("zip slip"): absolute paths, `..` segments and backslashes are REJECTED
 *   - decompression bombs: per-entry and total uncompressed caps
 *   - entry-count cap
 *   - CRC-32 verified on every extract (a corrupt package fails loudly, never silently)
 */
import { inflateRawSync } from 'zlib';

const EOCD_SIG = 0x06054b50;   // End Of Central Directory
const CEN_SIG  = 0x02014b50;   // Central directory file header
const LOC_SIG  = 0x04034b50;   // Local file header

export const DEFAULTS = {
  maxEntries: 2048,
  maxEntryBytes: 64 * 1024 * 1024,    // 64 MB per entry, uncompressed
  maxTotalBytes: 256 * 1024 * 1024,   // 256 MB per archive, uncompressed
};

/* ---- CRC-32 (table built once) ------------------------------------------ */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* ---- name safety --------------------------------------------------------- */
/** Reject anything that could escape the extraction root. Returns a safe relative path. */
export function safeEntryName(name) {
  if (typeof name !== 'string' || !name.length) throw new Error('zip: empty entry name');
  if (name.includes('\0')) throw new Error(`zip: NUL in entry name`);
  const n = name.replace(/\\/g, '/');                       // some writers emit backslashes
  if (n.startsWith('/') || /^[a-zA-Z]:\//.test(n)) throw new Error(`zip: absolute entry path: ${name}`);
  if (n.split('/').some((seg) => seg === '..')) throw new Error(`zip: path traversal in entry: ${name}`);
  return n;
}

/* ---- central directory --------------------------------------------------- */
function findEocd(buf) {
  // EOCD is 22 bytes + an optional comment of up to 65535. Scan backwards.
  const min = Math.max(0, buf.length - (22 + 0xffff));
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error('zip: no End Of Central Directory record (not a zip, or truncated)');
}

/**
 * List entries without decompressing anything.
 * @returns {Array<{name,method,compSize,size,crc,localOffset,isDir}>}
 */
export function listEntries(buf, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (!Buffer.isBuffer(buf)) throw new Error('zip: expected a Buffer');
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  const cenOff = buf.readUInt32LE(eocd + 16);
  if (count > o.maxEntries) throw new Error(`zip: too many entries (${count} > ${o.maxEntries})`);
  if (cenOff >= buf.length) throw new Error('zip: central directory offset out of range');

  const out = [];
  let p = cenOff;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) {
      throw new Error(`zip: bad central directory header at entry ${i}`);
    }
    const method   = buf.readUInt16LE(p + 10);
    const crc      = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const size     = buf.readUInt32LE(p + 24);
    const nameLen  = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen   = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const raw = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const isDir = raw.endsWith('/');
    out.push({ name: isDir ? raw : safeEntryName(raw), method, compSize, size, crc, localOffset, isDir });
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

/** Extract ONE entry to a Buffer. CRC is verified; a mismatch throws. */
export function readEntry(buf, entry, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (entry.isDir) return Buffer.alloc(0);
  if (entry.size > o.maxEntryBytes) {
    throw new Error(`zip: entry exceeds cap (${entry.size} > ${o.maxEntryBytes}): ${entry.name}`);
  }
  const lo = entry.localOffset;
  if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== LOC_SIG) {
    throw new Error(`zip: bad local header for ${entry.name}`);
  }
  // The LOCAL header's name/extra lengths may differ from the central ones — always use these.
  const flags    = buf.readUInt16LE(lo + 6);
  const nameLen  = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);

  // TAMPER GUARD: a crafted archive can disagree between the central directory and the local
  // header, so a scanner reading one sees different content than an extractor reading the other.
  // When bit 3 is clear the local header carries real values — they MUST match central.
  if (!(flags & 0x08)) {
    const lCrc = buf.readUInt32LE(lo + 14);
    const lComp = buf.readUInt32LE(lo + 18);
    const lSize = buf.readUInt32LE(lo + 22);
    if (lCrc !== entry.crc || lComp !== entry.compSize || lSize !== entry.size) {
      throw new Error(`zip: central/local header mismatch for ${entry.name} (tampered archive)`);
    }
  }
  const lName = buf.toString('utf8', lo + 30, lo + 30 + nameLen).replace(/\\/g, '/');
  if (lName !== entry.name) {
    throw new Error(`zip: name mismatch for ${entry.name} (local says ${lName})`);
  }

  const start = lo + 30 + nameLen + extraLen;
  const end = start + entry.compSize;
  if (end > buf.length) throw new Error(`zip: entry data out of range: ${entry.name}`);
  const raw = buf.subarray(start, end);

  let data;
  if (entry.method === 0) data = Buffer.from(raw);
  else if (entry.method === 8) data = inflateRawSync(raw, { maxOutputLength: o.maxEntryBytes });
  else throw new Error(`zip: unsupported compression method ${entry.method} for ${entry.name}`);

  if (data.length !== entry.size) {
    throw new Error(`zip: size mismatch for ${entry.name} (${data.length} != ${entry.size})`);
  }
  const got = crc32(data);
  if (got !== entry.crc) {
    throw new Error(`zip: CRC mismatch for ${entry.name} (corrupt package)`);
  }
  return data;
}

/**
 * Read a whole archive into a Map of safe-name -> Buffer. Directories are skipped.
 * Enforces the total uncompressed cap across all entries.
 */
export function readZip(buf, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const entries = listEntries(buf, o);
  const files = new Map();
  let total = 0;
  for (const e of entries) {
    if (e.isDir) continue;
    total += e.size;
    if (total > o.maxTotalBytes) {
      throw new Error(`zip: archive exceeds total cap (${total} > ${o.maxTotalBytes})`);
    }
    files.set(e.name, readEntry(buf, e, o));
  }
  return files;
}

/** Convenience: read one named entry as UTF-8 text (e.g. a package manifest). */
export function readText(buf, name, opts = {}) {
  const entries = listEntries(buf, opts);
  const want = safeEntryName(name);
  const e = entries.find((x) => x.name === want && !x.isDir);
  if (!e) throw new Error(`zip: entry not found: ${name}`);
  return readEntry(buf, e, opts).toString('utf8');
}
