// core.js — the pure logic of thundu seetu. No DOM, no storage.
//
// The whole app is a pile of immutable "events" (paper slips, in the app's
// language). Every phone keeps its own pile. Reconciling two phones is just
// the union of their piles — order doesn't matter, duplicates don't matter.
// Everything you see on screen (slips, balances, who-pays-whom) is computed
// by replaying the pile through `reduce()`.

export const APP_ID = 'thundu-seetu';
export const BUNDLE_VERSION = 1;

export const CURRENCIES = {
  INR: { symbol: '₹', dp: 2, name: 'Indian rupee' },
  NPR: { symbol: 'NPR ', dp: 2, name: 'Nepali rupee' },
  BTN: { symbol: 'Nu ', dp: 2, name: 'Bhutanese ngultrum' },
  USD: { symbol: '$', dp: 2, name: 'US dollar' },
  EUR: { symbol: '€', dp: 2, name: 'Euro' },
  GBP: { symbol: '£', dp: 2, name: 'British pound' },
};

export const CATEGORIES = {
  food: { label: 'Food', icon: '🍲' },
  stay: { label: 'Stay', icon: '🛖' },
  travel: { label: 'Travel', icon: '🚙' },
  activity: { label: 'Activity', icon: '🥾' },
  shopping: { label: 'Shopping', icon: '🧣' },
  other: { label: 'Other', icon: '📎' },
};

export const SPLIT_MODES = ['equal', 'exact', 'percent', 'shares', 'adjust'];

export const EVENT_KINDS = [
  'group.create', 'group.update',
  'member.add', 'member.update',
  'rate.set',
  'slip.put', 'slip.delete',
];

// ---------------------------------------------------------------- money

export const dp = (cur) => CURRENCIES[cur]?.dp ?? 2;
export const symbol = (cur) => CURRENCIES[cur]?.symbol ?? `${cur} `;

/** "1,250.5" → 125050 (minor units). Returns null for anything that isn't a clean amount. */
export function toMinor(input, cur) {
  const s = String(input ?? '').replace(/[,\s₹]/g, '');
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
  const d = dp(cur);
  const [i, f = ''] = s.split('.');
  if (f.length > d) return null;
  const n = Number(i || '0') * 10 ** d + Number((f + '0'.repeat(d)).slice(0, d) || '0');
  return Number.isSafeInteger(n) ? n : null;
}

/** 125050 → "1250.5" — for putting an amount back into an input field. */
export function minorToInput(minor, cur) {
  const d = dp(cur);
  const whole = Math.floor(minor / 10 ** d);
  const frac = minor % 10 ** d;
  return frac ? `${whole}.${String(frac).padStart(d, '0').replace(/0+$/, '')}` : String(whole);
}

/** 125050 → "₹1,250.50". Drops ".00". `plus` adds a + to positive values. */
export function formatMoney(minor, cur, { plus = false, code = false } = {}) {
  const d = dp(cur);
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 10 ** d);
  const frac = abs % 10 ** d;
  const locale = cur === 'INR' || cur === 'NPR' ? 'en-IN' : 'en-US';
  let s = whole.toLocaleString(locale);
  if (frac) s += '.' + String(frac).padStart(d, '0');
  const sign = minor < 0 ? '−' : plus && minor > 0 ? '+' : '';
  return sign + (code ? `${cur} ` : symbol(cur)) + s;
}

// ---------------------------------------------------------------- splitting

/**
 * Split `total` minor units in proportion to integer weights, so the parts
 * always add up to exactly `total`. Leftover units go to the largest
 * remainders, ties broken by entry order — identical on every phone.
 */
export function allocate(total, entries) {
  const W = entries.reduce((s, [, w]) => s + w, 0);
  if (!(W > 0)) return null;
  const out = {};
  const rems = [];
  let used = 0;
  entries.forEach(([id, w], i) => {
    const q = Math.floor((total * w) / W);
    out[id] = q;
    used += q;
    rems.push({ id, r: total * w - q * W, i });
  });
  rems.sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; k < total - used; k++) out[rems[k].id] += 1;
  return out;
}

const fail = (error) => ({ ok: false, error });
const sortedIds = (obj) => Object.keys(obj || {}).sort();
const isNonNegInt = (n) => Number.isSafeInteger(n) && n >= 0;

/**
 * Work out who consumed how much of a slip.
 * split.values meaning per mode:
 *   equal   {member: 1}            — those sharing equally
 *   exact   {member: minor}        — must add up to the amount
 *   percent {member: 33.33}        — must add up to 100
 *   shares  {member: 2}            — proportional weights (decimals ok)
 *   adjust  {member: minor}        — extra on top; the rest is split equally
 */
export function computeShares(slip) {
  const { amount, currency, split } = slip;
  const vals = split?.values || {};
  const ids = sortedIds(vals);
  if (!Number.isSafeInteger(amount) || amount <= 0) return fail('Enter an amount');
  if (!ids.length) return fail('Pick who shares this');
  const money = (m) => formatMoney(m, currency);

  switch (split.mode) {
    case 'equal':
      return { ok: true, shares: allocate(amount, ids.map((id) => [id, 1])) };

    case 'exact': {
      if (!ids.every((id) => isNonNegInt(vals[id]))) return fail('Amounts must be positive');
      const sum = ids.reduce((s, id) => s + vals[id], 0);
      if (sum !== amount) {
        return fail(sum < amount ? `${money(amount - sum)} still to assign` : `${money(sum - amount)} too much assigned`);
      }
      return { ok: true, shares: Object.fromEntries(ids.map((id) => [id, vals[id]])) };
    }

    case 'percent': {
      const bp = ids.map((id) => [id, Math.round(Number(vals[id]) * 100)]);
      if (!bp.every(([, w]) => isNonNegInt(w))) return fail('Percentages must be positive');
      const sum = bp.reduce((s, [, w]) => s + w, 0);
      if (sum !== 10000) return fail(`Percentages add up to ${sum / 100}%, not 100%`);
      return { ok: true, shares: allocate(amount, bp) };
    }

    case 'shares': {
      const w = ids.map((id) => [id, Math.round(Number(vals[id]) * 1000)]);
      if (!w.every(([, x]) => isNonNegInt(x))) return fail('Shares must be positive');
      const shares = allocate(amount, w);
      return shares ? { ok: true, shares } : fail('Give someone at least one share');
    }

    case 'adjust': {
      if (!ids.every((id) => isNonNegInt(vals[id]))) return fail('Adjustments must be positive');
      const extra = ids.reduce((s, id) => s + vals[id], 0);
      if (extra > amount) return fail(`Adjustments are ${money(extra - amount)} more than the total`);
      const eq = allocate(amount - extra, ids.map((id) => [id, 1]));
      return { ok: true, shares: Object.fromEntries(ids.map((id) => [id, eq[id] + vals[id]])) };
    }

    default:
      return fail('Unknown split');
  }
}

/** Returns an error message, or null if the slip is good to save. */
export function validateSlip(slip, memberIds) {
  if (!Number.isSafeInteger(slip.amount) || slip.amount <= 0) return 'Enter an amount';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(slip.date || '')) return 'Pick a date';
  const payers = slip.payers || {};
  const pids = sortedIds(payers);
  if (!pids.length) return 'Who paid?';
  if (!pids.every((id) => Number.isSafeInteger(payers[id]) && payers[id] > 0)) return 'Paid amounts must be positive';
  const paid = pids.reduce((s, id) => s + payers[id], 0);
  if (paid !== slip.amount) {
    const diff = formatMoney(Math.abs(slip.amount - paid), slip.currency);
    return paid < slip.amount ? `Payers are ${diff} short` : `Payers are ${diff} over`;
  }
  const r = computeShares(slip);
  if (!r.ok) return r.error;
  if (memberIds) {
    const known = new Set(memberIds);
    if (![...pids, ...sortedIds(slip.split.values)].every((id) => known.has(id))) return 'Unknown person on this slip';
  }
  return null;
}

// ---------------------------------------------------------------- events

/** Hybrid-ish logical clock: wall time, but never goes backwards and always moves forward. */
export const nextClock = (last) => Math.max(Date.now(), (last || 0) + 1);

/** Total order every phone agrees on: clock, then device, then id. */
export function cmpEvents(x, y) {
  return x.t - y.t || (x.a < y.a ? -1 : x.a > y.a ? 1 : 0) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
}

const isStr = (s, max = 200) => typeof s === 'string' && s.length > 0 && s.length <= max;

/** Shape check for events arriving from another phone's file. */
export function isValidEvent(e) {
  return (
    e && typeof e === 'object' &&
    isStr(e.id, 64) && isStr(e.g, 64) && isStr(e.a, 64) &&
    (e.m === undefined || isStr(e.m, 64)) &&
    Number.isSafeInteger(e.t) && e.t > 0 &&
    EVENT_KINDS.includes(e.k) &&
    e.d && typeof e.d === 'object'
  );
}

/**
 * Replay a pile of events into the current picture of a trip.
 * Later events (by cmpEvents order) win when they touch the same thing.
 */
export function reduce(events) {
  const sorted = [...events].sort(cmpEvents);
  const st = {
    group: null,
    members: {},
    memberOrder: [],
    slips: {},
    history: {},      // slipId → [events], oldest first
    conflicts: new Set(), // slips edited on two phones from the same version
    rates: {},        // currency → { rate, t, m }
    lastT: 0,
    count: sorted.length,
  };
  const editedFrom = {}; // slipId → Set of `prev` values already seen

  for (const e of sorted) {
    st.lastT = Math.max(st.lastT, e.t);
    const d = e.d;
    switch (e.k) {
      case 'group.create':
        if (!st.group) st.group = { id: e.g, name: String(d.name || 'Trip'), base: d.base || 'INR', t: e.t, m: e.m };
        break;
      case 'group.update':
        if (st.group && isStr(d.name)) st.group.name = d.name;
        break;
      case 'member.add':
        if (isStr(d.id, 64) && !st.members[d.id]) {
          st.members[d.id] = { id: d.id, name: String(d.name || '?') };
          st.memberOrder.push(d.id);
        }
        break;
      case 'member.update':
        if (st.members[d.id] && isStr(d.name)) st.members[d.id].name = d.name;
        break;
      case 'rate.set':
        if (isStr(d.currency, 8) && Number(d.rate) > 0) st.rates[d.currency] = { rate: String(d.rate), t: e.t, m: e.m };
        break;
      case 'slip.put': {
        const s = d.slip;
        if (!s || !isStr(s.id, 64)) break;
        // Two edits made from the same version = two phones edited it apart.
        // An edit made from the current version (someone checked it) clears the flag.
        const prevKey = d.prev || '∅';
        const seen = (editedFrom[s.id] ??= new Set());
        if (seen.has(prevKey)) st.conflicts.add(s.id);
        else if ((st.slips[s.id]?.eventId ?? '∅') === prevKey) st.conflicts.delete(s.id);
        seen.add(prevKey);
        const hist = (st.history[s.id] ??= []);
        hist.push(e);
        const old = st.slips[s.id];
        st.slips[s.id] = {
          ...s,
          eventId: e.id,
          t: e.t,
          a: e.a,
          m: e.m,
          createdT: old?.createdT ?? e.t,
          createdBy: old?.createdBy ?? e.m,
          edits: hist.filter((x) => x.k === 'slip.put').length - 1,
          deleted: false,
        };
        break;
      }
      case 'slip.delete':
        (st.history[d.id] ??= []).push(e);
        if (st.slips[d.id]) Object.assign(st.slips[d.id], { deleted: true, eventId: e.id, t: e.t, a: e.a, m: e.m });
        break;
    }
  }
  return st;
}

/** Slips still standing, newest date first. */
export function liveSlips(st) {
  return Object.values(st.slips)
    .filter((s) => !s.deleted)
    .sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : y.createdT - x.createdT));
}

// ---------------------------------------------------------------- tally

/** Converter from `cur` minor units into base minor units, or null if no rate is known. */
export function converter(cur, base, rates) {
  if (cur === base) return (m) => m;
  const r = Number(rates[cur]?.rate);
  if (!(r > 0)) return null;
  const scale = 10 ** (dp(base) - dp(cur));
  return (m) => Math.round(m * r * scale);
}

const zeroes = (ids) => Object.fromEntries(ids.map((id) => [id, 0]));

/**
 * Net position of everyone in the trip's base currency.
 * net > 0: gets money back. net < 0: owes.
 * Slips in a currency without an exchange rate are tallied separately in `unrated`.
 */
export function tally(st) {
  const base = st.group?.base || 'INR';
  const ids = st.memberOrder;
  const out = {
    base,
    net: zeroes(ids),
    paid: zeroes(ids),    // spending only, payments excluded
    share: zeroes(ids),
    spend: 0,
    byCategory: {},
    byDay: {},
    unrated: {},          // cur → { net, count }
    invalid: [],
  };

  for (const s of liveSlips(st)) {
    const r = computeShares(s);
    if (!r.ok || validateSlip(s, ids)) { out.invalid.push(s.id); continue; }
    const conv = converter(s.currency, base, st.rates);
    if (!conv) {
      const u = (out.unrated[s.currency] ??= { net: zeroes(ids), count: 0 });
      u.count++;
      for (const [id, v] of Object.entries(s.payers)) u.net[id] += v;
      for (const [id, v] of Object.entries(r.shares)) u.net[id] -= v;
      continue;
    }
    // Convert the total once, then re-split it, so every number adds up exactly.
    const total = conv(s.amount);
    const paid = allocate(total, sortedIds(s.payers).map((id) => [id, s.payers[id]]));
    const share = allocate(total, sortedIds(r.shares).map((id) => [id, r.shares[id]]));
    for (const id in paid) out.net[id] += paid[id];
    for (const id in share) out.net[id] -= share[id];

    if (s.type === 'payment') continue;
    out.spend += total;
    for (const id in paid) out.paid[id] += paid[id];
    for (const id in share) out.share[id] += share[id];
    const cat = CATEGORIES[s.category] ? s.category : 'other';
    out.byCategory[cat] = (out.byCategory[cat] || 0) + total;
    out.byDay[s.date] = (out.byDay[s.date] || 0) + total;
  }
  return out;
}

/** Fewest-ish payments to square everyone up (greedy: biggest debtor pays biggest creditor). */
export function settleUp(net, order = Object.keys(net)) {
  const rank = (id) => order.indexOf(id);
  const by = (a, b) => b[1] - a[1] || rank(a[0]) - rank(b[0]);
  const cred = Object.entries(net).filter(([, v]) => v > 0).sort(by);
  const debt = Object.entries(net).filter(([, v]) => v < 0).map(([id, v]) => [id, -v]).sort(by);
  const out = [];
  let i = 0, j = 0;
  while (i < debt.length && j < cred.length) {
    const x = Math.min(debt[i][1], cred[j][1]);
    out.push({ from: debt[i][0], to: cred[j][0], amount: x });
    debt[i][1] -= x;
    cred[j][1] -= x;
    if (!debt[i][1]) i++;
    if (!cred[j][1]) j++;
  }
  return out;
}

// ---------------------------------------------------------------- reconciling

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * A short code for a whole pile. Two phones holding exactly the same slips
 * show the same code — the quick check that everyone is reconciled.
 */
export function pileCode(events) {
  const ids = events.map((e) => e.id).sort();
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ ids.length;
  for (const id of ids) {
    for (let i = 0; i < id.length; i++) {
      const c = id.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
    }
    h1 = Math.imul(h1 ^ 44, 0x01000193) >>> 0;
  }
  let n = (BigInt(h1) << 32n) | BigInt(h2);
  let s = '';
  for (let i = 0; i < 6; i++) { s += CROCKFORD[Number(n & 31n)]; n >>= 5n; }
  return `${s.slice(0, 3)}-${s.slice(3)}`;
}

/** The file one phone hands to another: the whole pile for one trip. */
export function makeBundle(st, events, fromName) {
  return {
    app: APP_ID,
    v: BUNDLE_VERSION,
    group: st.group.id,
    name: st.group.name,
    from: fromName || null,
    at: Date.now(),
    code: pileCode(events),
    events: [...events].sort(cmpEvents),
  };
}

export function parseBundle(text) {
  let o;
  try { o = JSON.parse(text); } catch { throw new Error("This file isn't a thundu seetu pile."); }
  if (!o || o.app !== APP_ID || !Array.isArray(o.events) || !isStr(o.group, 64)) {
    throw new Error("This file isn't a thundu seetu pile.");
  }
  if (o.v > BUNDLE_VERSION) throw new Error('This pile was made by a newer version of the app. Update the app first.');
  const events = o.events.filter((e) => isValidEvent(e) && e.g === o.group);
  if (!events.some((e) => e.k === 'group.create')) throw new Error('This pile is missing its trip — ask for a fresh copy.');
  return { group: o.group, name: String(o.name || 'Trip'), from: o.from ? String(o.from) : null, events, skipped: o.events.length - events.length };
}

/** Which incoming events are new to us. */
export function newEvents(have, incoming) {
  const ids = new Set(have.map((e) => e.id));
  const out = [];
  for (const e of incoming) if (!ids.has(e.id)) { ids.add(e.id); out.push(e); }
  return out;
}

// ---------------------------------------------------------------- export

export function toCSV(st) {
  const name = (id) => st.members[id]?.name ?? '?';
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const ids = st.memberOrder;
  const head = ['Date', 'Type', 'Description', 'Category', 'Currency', 'Amount', 'Paid by', ...ids.map((id) => `${name(id)} share`)];
  const rows = liveSlips(st).reverse().map((s) => {
    const r = computeShares(s);
    const m = (x) => minorToInput(x || 0, s.currency);
    return [
      s.date, s.type === 'payment' ? 'Payment' : 'Expense', s.desc, CATEGORIES[s.category]?.label ?? '',
      s.currency, m(s.amount),
      Object.entries(s.payers).map(([id, v]) => `${name(id)} ${m(v)}`).join('; '),
      ...ids.map((id) => (r.ok ? m(r.shares[id]) : '')),
    ];
  });
  return [head, ...rows].map((r) => r.map(q).join(',')).join('\n');
}
