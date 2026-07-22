/** On-device cover-art extraction for audiobooks.
 *
 *  A book the user imported on the phone has no server to ask for its cover — the
 *  only source is the file itself, which already carries the art the producer
 *  embedded. This reads that art out entirely in the WebView, with ranged
 *  `Blob.slice` reads so a 500 MB m4b is never fully loaded: only its (small)
 *  `moov` metadata box is pulled into memory. Returns an image Blob (jpeg/png) or
 *  null when the file genuinely has no embedded art — never throws.
 *
 *  Supported: MP4/M4B/M4A (`moov/udta/meta/ilst/covr/data`) and MP3 (ID3v2 APIC).
 */

const MP4_FORMATS = new Set(['m4b', 'm4a', 'mp4', 'm4p', 'aac']);

export async function extractAudioCoverBlob(file: Blob, format: string): Promise<Blob | null> {
  const fmt = (format || '').toLowerCase();
  try {
    if (MP4_FORMATS.has(fmt)) return await extractMp4Cover(file);
    if (fmt === 'mp3') return await extractId3Cover(file);
  } catch {
    // Malformed or an unusual layout we don't parse — treat as "no cover" so the
    // caller falls back to the placeholder rather than surfacing an error.
  }
  return null;
}

// ── shared helpers ─────────────────────────────────────────────────────────────
function asciiType(v: DataView, at: number): string {
  return String.fromCharCode(v.getUint8(at), v.getUint8(at + 1), v.getUint8(at + 2), v.getUint8(at + 3));
}

/** PNG/JPEG magic-byte sniff, for the rare `covr` that doesn't tag its image type. */
function sniffImageMime(v: DataView, at: number): string {
  if (at + 4 <= v.byteLength && v.getUint8(at) === 0x89 && v.getUint8(at + 1) === 0x50) return 'image/png';
  return 'image/jpeg';
}

// ── MP4 / M4B ───────────────────────────────────────────────────────────────────
/** Walk the top-level boxes with ranged reads to find `moov` (which may sit at the
 *  front of a faststart file or at the very end), then parse only that box in
 *  memory to reach `moov/udta/meta/ilst/covr/data`. */
async function extractMp4Cover(file: Blob): Promise<Blob | null> {
  const size = file.size;
  let offset = 0;
  while (offset + 8 <= size) {
    const head = new DataView(await file.slice(offset, Math.min(offset + 16, size)).arrayBuffer());
    let boxSize = head.getUint32(0);
    const type = asciiType(head, 4);
    let headerLen = 8;
    if (boxSize === 1) {            // 64-bit largesize follows the type
      if (head.byteLength < 16) break;
      boxSize = Number(head.getBigUint64(8));
      headerLen = 16;
    } else if (boxSize === 0) {     // extends to end of file
      boxSize = size - offset;
    }
    if (boxSize < headerLen) break; // corrupt/degenerate header — give up
    if (type === 'moov') {
      const moov = new DataView(await file.slice(offset, offset + boxSize).arrayBuffer());
      return findCovr(moov, headerLen, moov.byteLength);
    }
    offset += boxSize;              // skip this box (e.g. the huge `mdat`) entirely
  }
  return null;
}

/** Recursively scan an in-memory box subtree for `covr/data`. `start`/`end` bound
 *  the region of CHILD boxes to walk. Returns an image Blob or null. */
function findCovr(v: DataView, start: number, end: number): Blob | null {
  let off = start;
  while (off + 8 <= end) {
    let boxSize = v.getUint32(off);
    const type = asciiType(v, off + 4);
    let headerLen = 8;
    if (boxSize === 1) {
      if (off + 16 > end) break;
      boxSize = Number(v.getBigUint64(off + 8));
      headerLen = 16;
    } else if (boxSize === 0) {
      boxSize = end - off;
    }
    if (boxSize < headerLen || off + boxSize > end) break;
    const childStart = off + headerLen;
    const childEnd = off + boxSize;

    if (type === 'udta' || type === 'ilst' || type === 'covr') {
      const found = findCovr(v, childStart, childEnd);
      if (found) return found;
    } else if (type === 'meta') {
      // `meta` is a FullBox: 4 bytes of version+flags precede its children.
      const found = findCovr(v, childStart + 4, childEnd);
      if (found) return found;
    } else if (type === 'data') {
      // covr/data payload: [4 bytes version+flags (image type)] [4 bytes reserved]
      // [image bytes]. flags 13 → JPEG, 14 → PNG; otherwise sniff the magic bytes.
      const flags = v.getUint32(childStart) & 0x00ffffff;
      const imgStart = childStart + 8;
      if (imgStart < childEnd) {
        const mime = flags === 14 ? 'image/png' : flags === 13 ? 'image/jpeg' : sniffImageMime(v, imgStart);
        // Copy out of the (large) moov buffer so it isn't retained by the Blob.
        const bytes = (v.buffer as ArrayBuffer).slice(v.byteOffset + imgStart, v.byteOffset + childEnd);
        return new Blob([bytes], { type: mime });
      }
    }
    off += boxSize;
  }
  return null;
}

// ── MP3 / ID3v2 APIC ──────────────────────────────────────────────────────────
/** Read a 4-byte synchsafe integer (7 bits per byte) — ID3v2 tag/frame sizes. */
function synchsafe(v: DataView, at: number): number {
  return (v.getUint8(at) << 21) | (v.getUint8(at + 1) << 14) | (v.getUint8(at + 2) << 7) | v.getUint8(at + 3);
}

/** Extract the first embedded picture (APIC frame) from an ID3v2.3/2.4 tag. */
async function extractId3Cover(file: Blob): Promise<Blob | null> {
  const head = new DataView(await file.slice(0, 10).arrayBuffer());
  if (asciiType(head, 0).slice(0, 3) !== 'ID3') return null;
  const major = head.getUint8(3);
  if (major !== 3 && major !== 4) return null;         // v2.2 uses 3-byte frame ids — skip
  const tagSize = synchsafe(head, 6);
  const tag = new DataView(await file.slice(10, 10 + tagSize).arrayBuffer());

  let off = 0;
  while (off + 10 <= tag.byteLength) {
    const id = asciiType(tag, off);
    // v2.4 frame sizes are synchsafe; v2.3 are plain big-endian uint32.
    const frameSize = major === 4 ? synchsafe(tag, off + 4) : tag.getUint32(off + 4);
    if (id === '\0\0\0\0' || frameSize <= 0) break;    // padding / end of frames
    const body = off + 10;
    if (id === 'APIC' && body + frameSize <= tag.byteLength) {
      return readApicFrame(tag, body, body + frameSize);
    }
    off = body + frameSize;
  }
  return null;
}

/** Parse an APIC frame body: [1 text-encoding][mime\0][1 picture-type][desc…][image]. */
function readApicFrame(v: DataView, start: number, end: number): Blob | null {
  let p = start;
  const enc = v.getUint8(p++);                          // 0/3 = single-byte, 1/2 = UTF-16
  let mime = '';
  while (p < end && v.getUint8(p) !== 0) { mime += String.fromCharCode(v.getUint8(p)); p++; }
  p++;                                                  // NUL after mime
  p++;                                                  // picture-type byte
  // Description is terminated by NUL in the frame's text encoding (UTF-16 → 2 bytes).
  if (enc === 1 || enc === 2) {
    while (p + 1 < end && !(v.getUint8(p) === 0 && v.getUint8(p + 1) === 0)) p += 2;
    p += 2;
  } else {
    while (p < end && v.getUint8(p) !== 0) p++;
    p++;
  }
  if (p >= end) return null;
  const type = mime.toLowerCase().includes('png') ? 'image/png' : 'image/jpeg';
  const bytes = (v.buffer as ArrayBuffer).slice(v.byteOffset + p, v.byteOffset + end);
  return new Blob([bytes], { type });
}
