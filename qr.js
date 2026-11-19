// qr.js — passing a pile through the camera, no radios at all.
//
// A pile file is compressed, cut into small pieces, and each piece is shown
// as one QR code. The showing phone cycles through the pieces over and over;
// the scanning phone keeps whatever pieces it catches until it has them all.
// Missing a frame is fine — it comes round again.
//
// Frame layout (raw bytes in QR "byte" mode):
//   0-1  "S1"          magic + format version
//   2-3  session id    so pieces from two different showings never mix
//   4-5  piece index   0-based
//   6-7  piece count
//   8…   piece bytes
// The joined pieces start with one flag byte: 1 = deflate-raw, 0 = plain JSON.

export const MAGIC = [0x53, 0x31];
export const HEADER = 8;
export const PIECE_SIZE = 480;   // ≈ QR version 15 at error-correction level L — easy for a phone camera
export const MAX_PIECES = 0xffff;

const canCompress = () => typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/** JSON text → bytes ready to cut into pieces. */
export async function pack(text) {
  const raw = new TextEncoder().encode(text);
  if (canCompress()) {
    const z = await pipe(raw, new CompressionStream('deflate-raw'));
    if (z.length < raw.length) return concat([Uint8Array.of(1), z]);
  }
  return concat([Uint8Array.of(0), raw]);
}

/** Joined pieces → JSON text. */
export async function unpack(bytes) {
  const body = bytes.subarray(1);
  if (bytes[0] === 0) return new TextDecoder().decode(body);
  if (bytes[0] !== 1) throw new Error('Unknown QR pile format');
  if (!canCompress()) throw new Error('This phone can’t unpack compressed piles — update iOS.');
  return new TextDecoder().decode(await pipe(body, new DecompressionStream('deflate-raw')));
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Cut packed bytes into frames (each one the full content of a QR code). */
export function toFrames(bytes, session = Math.floor(Math.random() * 0xffff), size = PIECE_SIZE) {
  const count = Math.max(1, Math.ceil(bytes.length / size));
  if (count > MAX_PIECES) throw new Error('This pile is too big for QR — use AirDrop.');
  const frames = [];
  for (let i = 0; i < count; i++) {
    const piece = bytes.subarray(i * size, (i + 1) * size);
    const f = new Uint8Array(HEADER + piece.length);
    f.set(MAGIC, 0);
    f[2] = session >> 8; f[3] = session & 255;
    f[4] = i >> 8; f[5] = i & 255;
    f[6] = count >> 8; f[7] = count & 255;
    f.set(piece, HEADER);
    frames.push(f);
  }
  return frames;
}

/** Bytes → the "binary string" qrcode-generator's byte mode expects (one char per byte). */
export const toBinaryString = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 4096) s += String.fromCharCode(...bytes.subarray(i, i + 4096));
  return s;
};

/** Collects pieces from scanned frames until the pile is complete. */
export class Assembler {
  constructor() { this.reset(); }

  reset() {
    this.session = null;
    this.count = 0;
    this.pieces = new Map();
  }

  /**
   * Feed one scanned frame. Returns what happened:
   * 'foreign' (not ours), 'new', 'dup', or 'restart' (a different showing began — started over).
   */
  add(frame) {
    const f = frame instanceof Uint8Array ? frame : Uint8Array.from(frame);
    if (f.length < HEADER || f[0] !== MAGIC[0] || f[1] !== MAGIC[1]) return 'foreign';
    const session = (f[2] << 8) | f[3];
    const index = (f[4] << 8) | f[5];
    const count = (f[6] << 8) | f[7];
    if (!count || index >= count) return 'foreign';
    let result = 'new';
    if (this.session !== session || this.count !== count) {
      result = this.session === null ? 'new' : 'restart';
      this.reset();
      this.session = session;
      this.count = count;
    }
    if (this.pieces.has(index)) return 'dup';
    this.pieces.set(index, f.slice(HEADER));
    return result;
  }

  get have() { return this.pieces.size; }
  get done() { return this.count > 0 && this.pieces.size === this.count; }
  missing() { return [...Array(this.count).keys()].filter((i) => !this.pieces.has(i)); }

  bytes() {
    if (!this.done) throw new Error('Pile not complete yet');
    return concat([...Array(this.count).keys()].map((i) => this.pieces.get(i)));
  }
}
