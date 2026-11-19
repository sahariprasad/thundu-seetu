// QR passing: pack → frames → real QR images → decode → assemble → same pile.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import * as Q from '../qr.js';
import * as C from '../core.js';

const require = createRequire(import.meta.url);
const qrcode = require('../vendor/qrcode.js');
const jsQRmod = require('../vendor/jsQR.js');
const jsQR = jsQRmod.default || jsQRmod;

/** Draw a frame the way the app does and return RGBA pixels, like a camera grab would give. */
function render(frame, scale = 4) {
  const qr = qrcode(0, 'L');
  qr.addData(Q.toBinaryString(frame), 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const size = (n + 8) * scale;
  const px = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (!qr.isDark(r, c)) continue;
    for (let y = 0; y < scale; y++) for (let x = 0; x < scale; x++) {
      const i = (((r + 4) * scale + y) * size + (c + 4) * scale + x) * 4;
      px[i] = px[i + 1] = px[i + 2] = 0;
    }
  }
  return { px, size, version: (n - 17) / 4 };
}

/** A realistic trip: 4 people, ~9 days, ~250 slips with some edits. */
function bigTrip() {
  const g = randomUUID();
  const phones = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const people = phones.map(() => randomUUID());
  let t = 1_765_000_000_000;
  const ev = (k, d, i = 0) => ({ id: randomUUID(), g, a: phones[i], m: people[i], t: ++t, k, d });
  const evs = [ev('group.create', { name: 'Himalayas', base: 'INR' })];
  people.forEach((id, i) => evs.push(ev('member.add', { id, name: ['Hari', 'Priya', 'Arjun', 'Meera'][i] })));
  for (let n = 0; n < 250; n++) {
    const i = n % 4;
    const slip = {
      id: randomUUID(), type: 'expense', desc: `Dal bhat and chai, stop ${n}`, amount: 50000 + n * 37,
      currency: n % 3 ? 'INR' : 'NPR', date: `2026-12-${String(13 + (n % 9)).padStart(2, '0')}`, category: 'food',
      payers: { [people[i]]: 50000 + n * 37 }, split: { mode: 'equal', values: Object.fromEntries(people.map((p) => [p, 1])) },
    };
    const put = ev('slip.put', { slip, prev: null }, i);
    evs.push(put);
    if (n % 10 === 0) evs.push(ev('slip.put', { slip: { ...slip, amount: slip.amount + 100, payers: { [people[i]]: slip.amount + 100 } }, prev: put.id }, i));
  }
  return evs;
}

test('frame header and assembler handle duplicates, order and restarts', () => {
  const bytes = Uint8Array.from({ length: 1300 }, (_, i) => i % 251);
  const frames = Q.toFrames(bytes, 0x1234, 500);
  assert.equal(frames.length, 3);
  const a = new Q.Assembler();
  assert.equal(a.add(Uint8Array.of(1, 2, 3)), 'foreign');
  assert.equal(a.add(frames[2]), 'new');
  assert.equal(a.add(frames[2]), 'dup');
  assert.equal(a.add(frames[0]), 'new');
  assert.deepEqual(a.missing(), [1]);
  assert.equal(a.done, false);
  assert.equal(a.add(frames[1]), 'new');
  assert.ok(a.done);
  assert.deepEqual(a.bytes(), bytes);

  // A different showing (new session) starts over instead of mixing pieces.
  const b = new Q.Assembler();
  b.add(frames[0]);
  assert.equal(b.add(Q.toFrames(bytes, 0x9999, 500)[1]), 'restart');
  assert.equal(b.have, 1);
});

test('a full trip pile survives the QR round trip', async () => {
  const evs = bigTrip();
  const st = C.reduce(evs);
  const text = JSON.stringify(C.makeBundle(st, evs, 'Hari'));
  const packed = await Q.pack(text);
  assert.equal(packed[0], 1, 'should be compressed');
  const frames = Q.toFrames(packed);

  // Show the frames in a shuffled order with repeats, like a camera catching a looping display.
  const order = [...frames.keys(), ...frames.keys()].sort(() => Math.random() - 0.5);
  const a = new Q.Assembler();
  let maxVersion = 0;
  const decoded = new Map();
  for (const i of order) {
    if (!decoded.has(i)) {
      const { px, size, version } = render(frames[i]);
      maxVersion = Math.max(maxVersion, version);
      const code = jsQR(px, size, size);
      assert.ok(code, `frame ${i} should decode`);
      decoded.set(i, code.binaryData);
    }
    a.add(decoded.get(i));
  }
  assert.ok(a.done);
  const back = C.parseBundle(await Q.unpack(a.bytes()));
  assert.equal(back.events.length, evs.length);
  assert.equal(C.pileCode(back.events), C.pileCode(evs));

  console.log(`    ${evs.length} events · ${text.length} B JSON → ${packed.length} B packed → ${frames.length} QR frames (max version ${maxVersion})`);
  assert.ok(maxVersion <= 16, 'frames should stay camera-friendly');
});

test('uncompressed fallback still unpacks', async () => {
  const text = '{"hello":"world"}';
  const plain = Uint8Array.of(0, ...new TextEncoder().encode(text));
  assert.equal(await Q.unpack(plain), text);
});
