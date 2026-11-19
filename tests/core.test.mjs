// Run with: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../core.js';

const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);

test('toMinor parses amounts and rejects junk', () => {
  assert.equal(c.toMinor('1250', 'INR'), 125000);
  assert.equal(c.toMinor('1,250.5', 'INR'), 125050);
  assert.equal(c.toMinor('.75', 'INR'), 75);
  assert.equal(c.toMinor('12.345', 'INR'), null);
  assert.equal(c.toMinor('abc', 'INR'), null);
  assert.equal(c.toMinor('', 'INR'), null);
  assert.equal(c.toMinor('-5', 'INR'), null);
});

test('formatMoney uses Indian grouping and hides .00', () => {
  assert.equal(c.formatMoney(12345600, 'INR'), '₹1,23,456');
  assert.equal(c.formatMoney(125050, 'INR'), '₹1,250.50');
  assert.equal(c.formatMoney(-500, 'INR'), '−₹5');
  assert.equal(c.formatMoney(500, 'INR', { plus: true }), '+₹5');
  assert.equal(c.minorToInput(125050, 'INR'), '1250.5');
});

test('allocate always adds up exactly and is deterministic', () => {
  const r = c.allocate(1000, [['a', 1], ['b', 1], ['c', 1]]);
  assert.deepEqual(r, { a: 334, b: 333, c: 333 });
  for (const total of [1, 7, 99, 100001]) {
    const x = c.allocate(total, [['a', 3], ['b', 5], ['c', 0], ['d', 7]]);
    assert.equal(sum(x), total);
    assert.equal(x.c, 0);
  }
});

const slip = (split, amount = 100000) => ({ amount, currency: 'INR', date: '2026-12-14', payers: { a: amount }, split });

test('equal split', () => {
  const r = c.computeShares(slip({ mode: 'equal', values: { a: 1, b: 1, c: 1 } }));
  assert.ok(r.ok);
  assert.equal(sum(r.shares), 100000);
});

test('exact split must add up', () => {
  assert.ok(c.computeShares(slip({ mode: 'exact', values: { a: 60000, b: 40000 } })).ok);
  const bad = c.computeShares(slip({ mode: 'exact', values: { a: 60000, b: 30000 } }));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /₹100 still to assign/);
});

test('percent split', () => {
  const r = c.computeShares(slip({ mode: 'percent', values: { a: 33.33, b: 33.33, c: 33.34 } }));
  assert.ok(r.ok);
  assert.equal(sum(r.shares), 100000);
  assert.equal(c.computeShares(slip({ mode: 'percent', values: { a: 50, b: 40 } })).ok, false);
});

test('shares split', () => {
  const r = c.computeShares(slip({ mode: 'shares', values: { a: 2, b: 1, c: 1 } }));
  assert.deepEqual(r.shares, { a: 50000, b: 25000, c: 25000 });
});

test('adjust split: equal rest plus extras', () => {
  const r = c.computeShares(slip({ mode: 'adjust', values: { a: 10000, b: 0, c: 0 } }));
  assert.deepEqual(r.shares, { a: 40000, b: 30000, c: 30000 });
});

test('validateSlip catches payer mismatch', () => {
  const s = { ...slip({ mode: 'equal', values: { a: 1, b: 1 } }), payers: { a: 50000, b: 40000 } };
  assert.match(c.validateSlip(s, ['a', 'b']), /short/);
  assert.equal(c.validateSlip(slip({ mode: 'equal', values: { a: 1, b: 1 } }), ['a', 'b']), null);
});

// ---- A small trip, built on two phones that then reconcile.

let n = 0;
const ev = (a, t, k, d, m) => ({ id: `${a}-${++n}`, g: 'trip', a, m, t, k, d });

function trip() {
  return [
    ev('phoneA', 1, 'group.create', { name: 'Himalayas', base: 'INR' }, 'hari'),
    ev('phoneA', 2, 'member.add', { id: 'hari', name: 'Hari' }),
    ev('phoneA', 3, 'member.add', { id: 'priya', name: 'Priya' }),
    ev('phoneA', 4, 'member.add', { id: 'arjun', name: 'Arjun' }),
  ];
}
const expense = (id, amount, payer, extra = {}) => ({
  id, type: 'expense', desc: id, amount, currency: 'INR', date: '2026-12-14', category: 'food',
  payers: { [payer]: amount }, split: { mode: 'equal', values: { hari: 1, priya: 1, arjun: 1 } }, ...extra,
});

test('two piles merge to the same picture in any order', () => {
  const base = trip();
  const a = [...base, ev('phoneA', 10, 'slip.put', { slip: expense('dinner', 90000, 'hari') }, 'hari')];
  const b = [...base, ev('phoneB', 11, 'slip.put', { slip: expense('jeep', 60000, 'priya') }, 'priya')];

  const merged1 = [...a, ...c.newEvents(a, b)];
  const merged2 = [...b, ...c.newEvents(b, a)];
  assert.equal(merged1.length, 6);
  assert.equal(c.pileCode(merged1), c.pileCode(merged2));
  assert.notEqual(c.pileCode(a), c.pileCode(merged1));

  const t1 = c.tally(c.reduce(merged1));
  const t2 = c.tally(c.reduce(merged2));
  assert.deepEqual(t1.net, t2.net);
  // dinner 900 by Hari, jeep 600 by Priya, all split 3 ways → 500 each
  assert.deepEqual(t1.net, { hari: 40000, priya: 10000, arjun: -50000 });
  assert.equal(t1.spend, 150000);
  assert.equal(sum(t1.net), 0);

  const plan = c.settleUp(t1.net, ['hari', 'priya', 'arjun']);
  assert.deepEqual(plan, [
    { from: 'arjun', to: 'hari', amount: 40000 },
    { from: 'arjun', to: 'priya', amount: 10000 },
  ]);
});

test('later edit wins; concurrent edits are flagged; deletes remove from tally', () => {
  const base = trip();
  const put = ev('phoneA', 10, 'slip.put', { slip: expense('dinner', 90000, 'hari') }, 'hari');
  const editA = ev('phoneA', 20, 'slip.put', { slip: expense('dinner', 99000, 'hari'), prev: put.id }, 'hari');
  const editB = ev('phoneB', 21, 'slip.put', { slip: expense('dinner', 93000, 'hari'), prev: put.id }, 'priya');
  const st = c.reduce([...base, editB, put, editA]);
  assert.equal(st.slips.dinner.amount, 93000);
  assert.equal(st.slips.dinner.edits, 2);
  assert.ok(st.conflicts.has('dinner'));
  // Someone looks at the winning version and saves it again → resolved.
  const fix = ev('phoneA', 25, 'slip.put', { slip: expense('dinner', 93000, 'hari'), prev: editB.id }, 'hari');
  assert.equal(c.reduce([...base, put, editA, editB, fix]).conflicts.has('dinner'), false);

  const del = ev('phoneB', 30, 'slip.delete', { id: 'dinner', prev: editB.id }, 'priya');
  const st2 = c.reduce([...base, put, editA, editB, del]);
  assert.equal(c.liveSlips(st2).length, 0);
  assert.equal(c.tally(st2).spend, 0);
});

test('payments move balances but not spending', () => {
  const evs = [
    ...trip(),
    ev('phoneA', 10, 'slip.put', { slip: expense('dinner', 90000, 'hari') }),
    ev('phoneA', 11, 'slip.put', {
      slip: { id: 'pay1', type: 'payment', desc: 'Settle', amount: 30000, currency: 'INR', date: '2026-12-15',
        payers: { arjun: 30000 }, split: { mode: 'exact', values: { hari: 30000 } } },
    }),
  ];
  const t = c.tally(c.reduce(evs));
  assert.deepEqual(t.net, { hari: 30000, priya: -30000, arjun: 0 });
  assert.equal(t.spend, 90000);
});

test('foreign currency converts with a rate, waits without one', () => {
  const npr = expense('momo', 160000, 'hari', { currency: 'NPR' });
  const noRate = c.tally(c.reduce([...trip(), ev('phoneA', 10, 'slip.put', { slip: npr })]));
  assert.equal(noRate.spend, 0);
  assert.equal(noRate.unrated.NPR.count, 1);

  const rated = c.tally(c.reduce([
    ...trip(),
    ev('phoneA', 10, 'slip.put', { slip: npr }),
    ev('phoneA', 11, 'rate.set', { currency: 'NPR', rate: '0.625' }),
  ]));
  assert.equal(rated.spend, 100000); // NPR 1600 → ₹1000
  assert.equal(sum(rated.net), 0);
});

test('bundles round-trip and reject strangers', () => {
  const evs = trip();
  const st = c.reduce(evs);
  const text = JSON.stringify(c.makeBundle(st, evs, 'Hari'));
  const b = c.parseBundle(text);
  assert.equal(b.events.length, evs.length);
  assert.equal(b.from, 'Hari');
  assert.throws(() => c.parseBundle('{"hello":1}'), /isn't a thundu seetu pile/);
  assert.throws(() => c.parseBundle('not json'), /isn't a thundu seetu pile/);
  const tampered = JSON.parse(text);
  tampered.events.push({ id: 'x', g: 'other-trip', a: 'z', t: 5, k: 'slip.put', d: {} });
  assert.equal(c.parseBundle(JSON.stringify(tampered)).skipped, 1);
});

test('CSV export', () => {
  const csv = c.toCSV(c.reduce([...trip(), ev('phoneA', 10, 'slip.put', { slip: expense('dinner, "veg"', 90000, 'hari') })]));
  const lines = csv.split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[1], /"dinner, ""veg"""/);
  assert.match(lines[1], /"300"/);
});
