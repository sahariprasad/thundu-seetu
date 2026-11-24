// app.js — screens and wiring. All logic that touches money lives in core.js.
import * as C from './core.js';
import * as DB from './db.js';
import * as Q from './qr.js';

// ================================================================ helpers

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const pad = (n) => String(n).padStart(2, '0');
function today() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
const fmtDay = (ds) => new Date(`${ds}T00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const fmtTime = (t) => new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const dayDiff = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 864e5);
const slug = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'trip';

function tilt(id) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return ((Math.abs(h) % 9) - 4) * 0.18;
}

// ---------------------------------------------------------------- motion

const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** What the next render should animate, and what the tally last showed. */
const fx = { drop: null, dropNew: false, shown: {} };

/** Roll a money figure from one amount to another. */
function countUp(el, from, to, cur) {
  if (calm() || from === to) return;
  const t0 = performance.now(), dur = 700;
  const step = (now) => {
    if (!el.isConnected) return;
    const p = Math.min(1, (now - t0) / dur);
    el.textContent = C.formatMoney(Math.round(from + (to - from) * (1 - (1 - p) ** 3)), cur);
    if (p < 1) requestAnimationFrame(step);
  };
  el.textContent = C.formatMoney(from, cur);
  requestAnimationFrame(step);
  // Frames pause while the app is in the background; never leave a half-counted figure.
  setTimeout(() => { if (el.isConnected) el.textContent = C.formatMoney(to, cur); }, dur + 50);
}

/** Rip a slip on screen into two halves, then close the gap it leaves. */
async function tearUp(el) {
  if (!el || calm()) return;
  const b = el.getBoundingClientRect();
  if (b.bottom < 0 || b.top > innerHeight) return;
  const left = el.firstElementChild;
  const right = left.cloneNode(true);
  right.removeAttribute('data-act');
  el.classList.add('tearing');
  left.classList.add('half-l');
  right.classList.add('half-r');
  el.append(right);
  const opts = { duration: 520, easing: 'cubic-bezier(.45,0,.7,1)', fill: 'forwards' };
  const away = (dx, dy, r) => [
    { transform: 'none', opacity: 1 },
    { offset: 0.22, transform: `translateX(${dx / 12}px) rotate(${r / 8}deg)`, opacity: 1 },
    { transform: `translate(${dx}px, ${dy}px) rotate(${r}deg)`, opacity: 0 },
  ];
  left.animate(away(-30, 16, -9), opts);
  await right.animate(away(30, 24, 8), opts).finished;
  await el.animate(
    [{ height: `${el.offsetHeight}px`, marginBottom: '14px' }, { height: '0px', marginBottom: '0px' }],
    { duration: 220, easing: 'ease-in-out', fill: 'forwards' },
  ).finished;
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

// ================================================================ state

const S = {
  device: null,
  clock: 0,
  piles: new Map(),   // trip id → events[]
  states: new Map(),  // trip id → reduced state (cache)
  me: {},             // trip id → member id this phone belongs to
  sentAt: {},         // trip id → clock when this phone last sent its pile
  lastImport: {},     // trip id → summary of the last pile taken in
  lastCur: {},        // trip id → currency last used on a slip
};

const pile = (g) => S.piles.get(g) || [];
function state(g) {
  if (!S.states.has(g)) S.states.set(g, C.reduce(pile(g)));
  return S.states.get(g);
}
function addToPile(events) {
  for (const e of events) {
    if (!S.piles.has(e.g)) S.piles.set(e.g, []);
    S.piles.get(e.g).push(e);
    S.states.delete(e.g);
    S.clock = Math.max(S.clock, e.t);
  }
}
const meOf = (g) => {
  const id = S.me[g];
  return id && state(g).members[id] ? id : null;
};
const nameOf = (st, id) => (id && st.members[id]?.name) || 'someone';

/** Write new slips (events) onto this phone's pile. */
async function emit(g, list) {
  const events = list.map(([k, d]) => {
    S.clock = C.nextClock(S.clock);
    const e = { id: uuid(), g, a: S.device, t: S.clock, k, d };
    if (S.me[g]) e.m = S.me[g];
    return e;
  });
  await DB.putEvents(events);
  addToPile(events);
  await DB.setMeta('clock', S.clock);
  return events;
}

async function setMe(g, id) {
  S.me[g] = id;
  await DB.setMeta(`me:${g}`, id);
}

function unsentCount(g) {
  const since = S.sentAt[g] || 0;
  return pile(g).filter((e) => e.a === S.device && e.t > since).length;
}

// ================================================================ routing

function route() {
  const [a, b, c] = location.hash.replace(/^#\/?/, '').split('/');
  if (a === 't' && b) return { view: 'trip', g: decodeURIComponent(b), tab: c || 'slips' };
  if (a === 'new') return { view: 'new' };
  return { view: 'home' };
}
const go = (hash) => { if (location.hash === hash) render(); else location.hash = hash; };

let lastRouteKey = '';
function render() {
  const r = route();
  const app = $('#app');
  if (r.view === 'trip' && !state(r.g).group) { go('#/'); return; }

  let html, tabs = false;
  if (r.view === 'home') html = homeView();
  else if (r.view === 'new') html = newTripView();
  else if (!meOf(r.g)) html = whoAmIView(r.g);
  else { html = tripView(r.g, r.tab); tabs = true; }

  const key = `${r.view}/${r.g}/${r.tab}`;
  const entered = key !== lastRouteKey;
  app.innerHTML = html;
  app.classList.toggle('no-tabs', !tabs);
  app.classList.toggle('entered', entered);
  document.title = r.view === 'trip' ? `${state(r.g).group.name} · thundu seetu` : 'thundu seetu';

  if (entered) window.scrollTo(0, 0);
  lastRouteKey = key;
  afterRender(r, entered);
}

/** Start the animations the last change asked for. */
function afterRender(r, entered) {
  if (fx.drop) {
    const el = $(`.slip[data-id="${CSS.escape(fx.drop)}"]`);
    if (el) {
      el.classList.add(fx.dropNew ? 'drop' : 'settle');
      const b = el.getBoundingClientRect();
      if (b.top < 0 || b.bottom > innerHeight - 90) el.scrollIntoView({ block: 'center', behavior: calm() ? 'auto' : 'smooth' });
    }
    fx.drop = null;
  }
  if (r.view === 'trip' && r.tab === 'tally') {
    const big = $('.standing .big[data-count]');
    const now = big ? Number(big.dataset.count) : 0;
    let was = entered ? 0 : fx.shown[r.g] ?? 0;
    if (Math.sign(was) !== Math.sign(now)) was = 0;
    if (big) countUp($('.num', big), Math.abs(was), Math.abs(now), big.dataset.cur);
    fx.shown[r.g] = now;
  }
}

// ================================================================ home

function homeView() {
  const trips = [...S.piles.keys()].map(state).filter((st) => st.group).sort((a, b) => b.lastT - a.lastT);
  return `
    <header class="brand">
      <h1>thundu seetu</h1>
      <p>a pocket of paper slips, reconciled</p>
    </header>
    ${trips.length ? trips.map(bundleCard).join('') : `
      <div class="empty">
        <div class="slip" style="--tilt:-1.5deg"><div class="paper torn tape">
          <p>No trips yet.<br>Start a bundle, or take in a friend's.</p>
        </div></div>
      </div>`}
    <div class="stack" style="margin-top:30px">
      <a class="btn block" href="#/new">Start a new trip</a>
      <button class="btn ghost block" data-act="qr-scan">Join a friend's trip — scan their pile</button>
      <button class="btn quiet block" data-act="import">…or take in an AirDropped pile</button>
    </div>
    <p class="muted small" style="text-align:center;margin-top:14px">
      Joining someone's trip? Ask them to open Pass around → <b>Show my pile</b>, then scan it.
    </p>`;
}

function bundleCard(st) {
  const t = C.tally(st);
  const slips = C.liveSlips(st).filter((s) => s.type !== 'payment').length;
  const names = st.memberOrder.map((id) => st.members[id].name);
  return `
    <article class="bundle">
      <span class="clip" aria-hidden="true"></span>
      <a class="bundle-btn" href="#/t/${encodeURIComponent(st.group.id)}/slips">
        <div class="paper">
          <h2>${esc(st.group.name)}</h2>
          <div class="people">${esc(names.join(', '))}</div>
          <div class="nums">
            <span class="muted small">${slips} slip${slips === 1 ? '' : 's'}</span>
            <span class="type">${C.formatMoney(t.spend, t.base)}</span>
          </div>
        </div>
      </a>
    </article>`;
}

// ================================================================ new trip

function newTripView() {
  const curOpts = Object.entries(C.CURRENCIES)
    .map(([k, v]) => `<option value="${k}" ${k === 'INR' ? 'selected' : ''}>${k} — ${esc(v.name)}</option>`).join('');
  return `
    <header class="top">
      <a class="icon-btn" href="#/" aria-label="Back">‹</a>
      <h1>A fresh bundle</h1>
    </header>
    <form id="new-trip" class="slip" autocomplete="off" style="--tilt:-.4deg">
      <div class="paper ruled torn tape" style="padding:26px 18px 30px 54px">
        <label class="field"><span>Trip</span>
          <input class="line-in" name="name" placeholder="Himalayas, Dec '26" maxlength="60" required>
        </label>
        <label class="field"><span>Count everything in</span>
          <select class="line-in" name="base">${curOpts}</select>
        </label>
        <label class="field"><span>Your name</span>
          <input class="line-in" name="me" placeholder="Hari" maxlength="30" required>
        </label>
        <div class="field" id="friends"><span>Fellow travellers</span>
          ${[1, 2, 3].map(() => friendInput()).join('')}
        </div>
        <button type="button" class="btn quiet sm" data-act="add-friend">+ one more</button>
        <div style="margin-top:22px"><button class="btn block" type="submit">Bundle it</button></div>
      </div>
    </form>
    <p class="muted small" style="text-align:center">Only names — no phone numbers, no accounts. You can add people later.</p>`;
}
const friendInput = () => `<input class="line-in" name="friend" placeholder="A friend's name" maxlength="30" style="margin-bottom:6px">`;

async function createTrip(form) {
  const f = new FormData(form);
  const name = String(f.get('name')).trim();
  const myName = String(f.get('me')).trim();
  const friends = f.getAll('friend').map((s) => String(s).trim()).filter(Boolean);
  if (!name || !myName) return toast('A trip name and your name, please');
  const g = uuid();
  const myId = uuid();
  await setMe(g, myId);
  await emit(g, [
    ['group.create', { name, base: f.get('base') || 'INR' }],
    ['member.add', { id: myId, name: myName }],
    ...friends.map((n) => ['member.add', { id: uuid(), name: n }]),
  ]);
  go(`#/t/${encodeURIComponent(g)}/slips`);
  toast('Bundle started. Friends join by scanning: Pass around → Show my pile.');
}

// ================================================================ who am I

function whoAmIView(g) {
  const st = state(g);
  return `
    <header class="top">
      <a class="icon-btn" href="#/" aria-label="Back">‹</a>
      <h1>${esc(st.group.name)}<span class="sub">One quick question</span></h1>
    </header>
    <div class="slip" style="--tilt:.4deg"><div class="paper torn tape" style="padding:24px 18px 28px">
      <h2 class="card-title">Which one of these is you?</h2>
      <div class="stack">
        ${st.memberOrder.map((id) => `<button class="btn ghost block" data-act="i-am" data-id="${esc(id)}">I'm ${esc(st.members[id].name)}</button>`).join('')}
      </div>
      <div style="margin-top:22px">
        <span class="label">Not on the list?</span>
        <div class="row">
          <input class="line-in grow" id="add-me-name" placeholder="Your name" maxlength="30">
          <button class="btn sm" data-act="add-me">Add me</button>
        </div>
      </div>
    </div></div>
    <p class="muted small" style="text-align:center">This only tells this phone who “you” are. It isn't shared.</p>`;
}

// ================================================================ trip shell

function tripView(g, tab) {
  const st = state(g);
  const body = { slips: slipsView, tally: tallyView, pass: passView, trip: tripTabView }[tab] || slipsView;
  const unsent = unsentCount(g);
  const T = (id, ico, label, dot) => `
    <a href="#/t/${encodeURIComponent(g)}/${id}" ${tab === id ? 'aria-current="page"' : ''}>
      <span class="ico" aria-hidden="true">${ico}</span>${label}${dot ? '<span class="dot" aria-label="unsent slips"></span>' : ''}
    </a>`;
  return `
    <header class="top">
      <a class="icon-btn" href="#/" aria-label="All trips">‹</a>
      <h1>${esc(st.group.name)}<span class="sub">${esc(st.memberOrder.map((id) => st.members[id].name).join(' · '))}</span></h1>
    </header>
    ${body(g, st)}
    ${tab === 'slips' ? `<button class="fab" data-act="new-slip" aria-label="Add a slip"><span>+ seetu</span></button>` : ''}
    <div class="tabbar"><nav>
      ${T('slips', '✎', 'Slips')}
      ${T('tally', '⚖', 'Tally')}
      ${T('pass', '⇄', 'Pass around', unsent > 0)}
      ${T('trip', '☰', 'Trip')}
    </nav></div>`;
}

// ================================================================ slips tab

function slipsView(g, st) {
  const slips = C.liveSlips(st);
  if (!slips.length) {
    return `<div class="empty">
      <div class="slip" style="--tilt:1.2deg"><div class="paper torn tape">
        <p>No seetus yet.<br>Tap <b>+ seetu</b> to jot down the first one.</p>
      </div></div>
    </div>`;
  }
  const t = C.tally(st);
  const first = slips[slips.length - 1].date;
  const days = [];
  for (const s of slips) {
    if (!days.length || days[days.length - 1].date !== s.date) days.push({ date: s.date, slips: [] });
    days[days.length - 1].slips.push(s);
  }
  const ctx = { g, st, me: meOf(g), sentAt: S.sentAt[g] || 0, invalid: new Set(t.invalid) };
  return days.map((d) => `
    <div class="day">
      <span class="hand">Day ${dayDiff(d.date, first) + 1} · ${esc(fmtDay(d.date))}</span>
      <span class="type">${t.byDay[d.date] ? C.formatMoney(t.byDay[d.date], t.base) : ''}</span>
    </div>
    ${d.slips.map((s) => slipCard(s, ctx)).join('')}
  `).join('');
}

const SPLIT_WORDS = { exact: 'split by amounts', percent: 'split by %', shares: 'split by shares', adjust: 'split with extras' };

function slipCard(s, { st, me, sentAt, invalid }) {
  const r = C.computeShares(s);
  const payers = Object.keys(s.payers || {});
  const money = (m) => C.formatMoney(m, s.currency);
  const isPay = s.type === 'payment';
  let title, line, mine = '';

  if (isPay) {
    const to = Object.keys(s.split.values)[0];
    title = `${esc(nameOf(st, payers[0]))} paid ${esc(nameOf(st, to))}`;
    line = s.desc ? esc(s.desc) : 'settling up';
    if (payers[0] === me) mine = 'you paid';
    else if (to === me) mine = 'you got this';
  } else {
    title = esc(s.desc);
    const by = payers.length === 1 ? (payers[0] === me ? 'you' : nameOf(st, payers[0])) : `${payers.length} people`;
    const n = Object.keys(s.split.values).length;
    const how = s.split.mode === 'equal'
      ? (n === st.memberOrder.length ? 'split by everyone' : `split between ${n}`)
      : SPLIT_WORDS[s.split.mode];
    line = `paid by ${esc(by)} · ${how}`;
    if (r.ok) mine = r.shares[me] ? `your share ${money(r.shares[me])}` : 'not yours';
  }

  let approx = '';
  if (s.currency !== st.group.base) {
    const conv = C.converter(s.currency, st.group.base, st.rates);
    approx = conv ? ` <span class="small muted">≈ ${C.formatMoney(conv(s.amount), st.group.base)}</span>` : ' <span class="small owe">no rate</span>';
  }

  const badges = [`✎ ${esc(nameOf(st, s.createdBy))}`];
  if (s.edits > 0) badges.push(`<span class="badge">edited${s.edits > 1 ? ` ${s.edits}×` : ''}</span>`);
  if (st.conflicts.has(s.id)) badges.push('<span class="badge warn">⚠ changed on two phones — check</span>');
  if (invalid.has(s.id)) badges.push(`<span class="badge warn">⚠ doesn't add up</span>`);
  if (s.a === S.device && s.t > sentAt) badges.push('<span class="badge fresh">● not passed around yet</span>');
  if (s.note) badges.push(`<span class="badge">“${esc(s.note)}”</span>`);

  const icon = isPay ? '🤝' : C.CATEGORIES[s.category]?.icon ?? '📎';
  return `
    <div class="slip ${isPay ? 'payment' : ''}" data-id="${esc(s.id)}" style="--tilt:${tilt(s.id)}deg">
      <button class="slip-btn" data-act="edit-slip" data-id="${esc(s.id)}">
        <div class="paper torn">
          <div class="slip-row">
            <span class="slip-icon" aria-hidden="true">${icon}</span>
            <div class="slip-main">
              <div class="slip-desc">${title}</div>
              <div class="slip-meta">${line}</div>
            </div>
            <div class="slip-amt">
              <span class="type">${money(s.amount)}</span>
              <span class="mine">${esc(mine)}</span>
            </div>
          </div>
          <div class="slip-foot">${badges.join('')}${approx}</div>
          ${isPay ? '<span class="stamp">PAID</span>' : ''}
        </div>
      </button>
    </div>`;
}

// ================================================================ tally tab

function tallyView(g, st) {
  const t = C.tally(st);
  const me = meOf(g);
  const name = (id) => esc(nameOf(st, id));
  const money = (m, cur = t.base) => C.formatMoney(m, cur);
  const my = t.net[me] || 0;

  const bigNum = (cls) => `<div class="big ${cls}" data-count="${my}" data-cur="${t.base}"><span class="sr">${money(Math.abs(my))}</span><span class="num" aria-hidden="true">${money(Math.abs(my))}</span></div>`;
  const standing = my > 0
    ? `<div class="hand">You get back</div>${bigNum('owed')}`
    : my < 0
      ? `<div class="hand">You owe</div>${bigNum('owe')}`
      : `<div class="hand">You're all square</div><div class="big">✓</div>`;

  const notes = [];
  for (const [cur, u] of Object.entries(t.unrated)) {
    notes.push(`<div class="note">${u.count} slip${u.count > 1 ? 's' : ''} in ${cur} ${u.count > 1 ? "aren't" : "isn't"} in these totals — there's no ${cur} → ${t.base} rate yet.
      <a href="#/t/${encodeURIComponent(g)}/trip">Set a rate</a>, or settle ${cur} separately below.</div>`);
  }
  if (t.invalid.length) notes.push(`<div class="note">${t.invalid.length} slip${t.invalid.length > 1 ? 's' : ''} don't add up and are left out. Open them on the Slips tab to fix.</div>`);

  const iouRows = (plan, cur) => plan.map((p) => `
    <div class="iou">
      <span class="who">${name(p.from)} <span class="arrow">→</span> ${name(p.to)}</span>
      <span class="type">${money(p.amount, cur)}</span>
      <button class="btn ghost sm" data-act="record-payment" data-from="${esc(p.from)}" data-to="${esc(p.to)}" data-amount="${p.amount}" data-cur="${cur}">Paid</button>
    </div>`).join('');

  const plan = C.settleUp(t.net, st.memberOrder);
  const extraPlans = Object.entries(t.unrated).map(([cur, u]) => {
    const p = C.settleUp(u.net, st.memberOrder);
    return p.length ? `<div class="label" style="margin-top:14px">In ${cur}</div>${iouRows(p, cur)}` : '';
  }).join('');

  const maxAbs = Math.max(1, ...Object.values(t.net).map(Math.abs));
  const bars = st.memberOrder.map((id, i) => {
    const v = t.net[id];
    const w = (Math.abs(v) / maxAbs) * 50;
    return `<div class="bar-row">
      <span class="name">${name(id)}</span>
      <span class="bar"><i class="${v >= 0 ? 'pos' : 'neg'}" style="width:${w}%;--i:${i}"></i></span>
      <span class="val ${v > 0 ? 'owed' : v < 0 ? 'owe' : 'muted'}">${v ? money(v, t.base).replace(/^/, v > 0 ? '+' : '') : '—'}</span>
    </div>`;
  }).join('');

  const days = Object.keys(t.byDay).length;
  const cats = Object.entries(t.byCategory).sort((a, b) => b[1] - a[1]);
  const maxCat = Math.max(1, ...cats.map(([, v]) => v));

  return `
    <div class="slip" style="--tilt:-.3deg"><div class="paper torn tape standing" style="padding-top:24px">${standing}
      <div class="muted small">across everything that's been passed around to this phone</div>
    </div></div>
    ${notes.join('')}

    <div class="slip" style="--tilt:.25deg"><div class="paper torn">
      <h2 class="card-title">To square up</h2>
      ${plan.length || extraPlans ? iouRows(plan, t.base) + extraPlans : '<p class="muted hand" style="font-size:17px;margin:4px 0">Nobody owes anybody. Lovely.</p>'}
      <div style="margin-top:10px"><button class="btn quiet sm" data-act="record-payment">+ Record some other payment</button></div>
    </div></div>

    <div class="slip" style="--tilt:-.2deg"><div class="paper torn">
      <h2 class="card-title">Where everyone stands</h2>
      ${bars}
      <p class="muted small" style="margin:8px 0 0">Green gets money back, red owes.</p>
    </div></div>

    <div class="slip" style="--tilt:.3deg"><div class="paper torn">
      <h2 class="card-title">The trip so far</h2>
      <div class="row" style="justify-content:space-between;margin-bottom:10px">
        <span>Spent together</span><span class="type" style="font-size:20px">${money(t.spend)}</span>
      </div>
      ${days ? `<div class="row muted small" style="justify-content:space-between;margin-bottom:14px"><span>Over ${days} day${days > 1 ? 's' : ''}, about</span><span class="type">${money(Math.round(t.spend / days))} a day</span></div>` : ''}
      <table class="ledger">
        <tr><th></th><th>Paid</th><th>Their share</th></tr>
        ${st.memberOrder.map((id) => `<tr><td>${name(id)}</td><td>${money(t.paid[id])}</td><td>${money(t.share[id])}</td></tr>`).join('')}
      </table>
      ${cats.length ? `<div style="margin-top:16px">${cats.map(([k, v], i) => `
        <div style="margin:10px 0">
          <div class="row" style="justify-content:space-between"><span>${C.CATEGORIES[k].icon} ${C.CATEGORIES[k].label}</span><span class="type small">${money(v)}</span></div>
          <div class="cat-bar"><i style="width:${(v / maxCat) * 100}%;--i:${i}"></i></div>
        </div>`).join('')}</div>` : ''}
      <div style="margin-top:14px"><button class="btn ghost sm" data-act="csv">Export as spreadsheet (CSV)</button></div>
    </div></div>`;
}

// ================================================================ pass around tab

function passView(g, st) {
  const evs = pile(g);
  const code = C.pileCode(evs);
  const unsent = unsentCount(g);
  const last = S.lastImport[g];
  const live = C.liveSlips(st);
  const wrote = {};
  for (const s of live) wrote[s.createdBy || '?'] = (wrote[s.createdBy || '?'] || 0) + 1;
  const lastByAuthor = {};
  for (const e of evs) if (e.m) lastByAuthor[e.m] = Math.max(lastByAuthor[e.m] || 0, e.t);

  return `
    <div class="slip" style="--tilt:-.4deg"><div class="paper torn tape pile-code" style="padding-top:24px">
      <div class="hand" style="font-size:18px">Your pile</div>
      <div class="code" aria-label="Pile code">${code}</div>
      <div class="muted small">${live.length} slip${live.length === 1 ? '' : 's'} · ${evs.length} notes in all</div>
      <p class="small" style="margin:12px 0 0">When every phone shows the <b>same code</b>, you're all reconciled.</p>
    </div></div>

    ${unsent ? `<div class="note">You've written ${unsent} note${unsent > 1 ? 's' : ''} the others haven't seen yet.</div>` : ''}
    ${last ? `<div class="note" style="border-left-color:var(--owed)">Last took in ${last.files} pile${last.files > 1 ? 's' : ''}${last.from.length ? ` from ${esc(last.from.join(', '))}` : ''} · ${esc(fmtTime(last.at))}<br>
      ${last.added ? `${last.added} new note${last.added > 1 ? 's' : ''} added.` : 'Nothing new — you already had all of it.'}</div>` : ''}

    <div class="slip" style="--tilt:.2deg"><div class="paper torn">
      <h2 class="card-title">Reconciling, the evening way</h2>
      <div class="row" style="margin:0 0 16px">
        <button class="btn grow" data-act="qr-show">Show my pile</button>
        <button class="btn ghost grow" data-act="qr-scan">Scan a pile</button>
      </div>
      <ol class="steps">
        <li>Pick a keeper. One by one, everyone taps <b>Show my pile</b> and the keeper taps <b>Scan a pile</b>.</li>
        <li>The keeper taps <b>Show my pile</b>, and everyone else scans it. Several phones can scan the same screen at once.</li>
        <li>Check that every phone shows the same pile code above. That's it, reconciled.</li>
      </ol>
      <p class="muted small" style="margin:0">Works with no signal and with Wi-Fi and Bluetooth off. It's only the camera.
        Turn the showing phone's brightness up. Scanning the same pile twice is harmless.</p>
    </div></div>

    <div class="slip" style="--tilt:.3deg"><div class="paper torn">
      <h2 class="card-title">Or use AirDrop</h2>
      <p class="small" style="margin:0 0 12px">Same idea, sent as a file. Handy for the keeper, who can take in everyone's files in one go.
        Needs Wi-Fi and Bluetooth switched on, but airplane mode is fine.</p>
      <div class="row">
        <button class="btn ghost grow" data-act="send">Send my pile</button>
        <button class="btn ghost grow" data-act="import">Take in piles</button>
      </div>
    </div></div>

    <div class="slip" style="--tilt:-.25deg"><div class="paper torn">
      <h2 class="card-title">Who's written what</h2>
      <ul class="who-wrote">
        ${st.memberOrder.map((id) => `<li><span class="hand">${esc(st.members[id].name)}</span>
          <span class="small muted">${wrote[id] || 0} slip${wrote[id] === 1 ? '' : 's'}${lastByAuthor[id] ? ` · latest ${esc(fmtTime(lastByAuthor[id]))}` : ''}</span></li>`).join('')}
      </ul>
      <p class="muted small" style="margin:10px 0 0">If someone's latest looks old here, you're missing their pile.</p>
    </div></div>`;
}

// ================================================================ trip tab (settings)

function tripTabView(g, st) {
  const me = meOf(g);
  const base = st.group.base;
  const used = new Set(Object.values(st.slips).map((s) => s.currency));
  const shown = [...new Set([...used, ...Object.keys(st.rates)])].filter((c) => c !== base).sort();
  const addable = Object.keys(C.CURRENCIES).filter((c) => c !== base && !shown.includes(c));

  return `
    <div class="slip" style="--tilt:-.3deg"><div class="paper torn tape" style="padding-top:22px">
      <h2 class="card-title">Travellers</h2>
      <ul class="who-wrote">
        ${st.memberOrder.map((id) => `<li style="align-items:center">
          <span class="hand">${esc(st.members[id].name)}${id === me ? ' <span class="small muted">(this phone)</span>' : ''}</span>
          <button class="btn quiet sm" data-act="rename-member" data-id="${esc(id)}">Rename</button></li>`).join('')}
      </ul>
      <div class="row" style="margin-top:12px">
        <input class="line-in grow" id="new-member" placeholder="Add a traveller" maxlength="30">
        <button class="btn sm" data-act="add-member">Add</button>
      </div>
      <button class="btn quiet sm" style="margin-top:10px" data-act="change-me">This isn't my phone's person — change</button>
    </div></div>

    <div class="slip" style="--tilt:.25deg"><div class="paper torn">
      <h2 class="card-title">Money</h2>
      <p class="small muted" style="margin:0 0 10px">Everything is tallied in <b>${base}</b>. No internet up there, so agree on a rate together and enter it once — it passes around with the slips.</p>
      ${shown.map((cur) => rateRow(cur, base, st.rates[cur]?.rate)).join('')}
      ${addable.length ? `
        <div class="row" style="margin-top:10px">
          <span class="type">1</span>
          <select class="line-in" id="new-rate-cur" style="width:auto">${addable.map((c) => `<option>${c}</option>`).join('')}</select>
          <span>=</span>
          <input class="line-in type grow" id="new-rate" inputmode="decimal" placeholder="rate">
          <span class="type">${base}</span>
          <button class="btn sm" data-act="add-rate">Set</button>
        </div>` : ''}
    </div></div>

    <div class="slip" style="--tilt:-.2deg"><div class="paper torn">
      <h2 class="card-title">This bundle</h2>
      <div class="stack">
        <button class="btn ghost block" data-act="rename-trip">Rename trip</button>
        <button class="btn ghost block" data-act="backup">Save a copy of the pile</button>
        <button class="btn ghost block" data-act="csv">Export as spreadsheet (CSV)</button>
        <button class="btn danger block" data-act="delete-trip">Remove this trip from this phone</button>
      </div>
      <p class="muted small" style="margin:12px 0 0">Every phone that has taken in your pile is also a full backup.</p>
    </div></div>`;
}

const rateRow = (cur, base, rate) => `
  <div class="row" style="margin:6px 0">
    <span class="type">1 ${cur} =</span>
    <input class="line-in type grow" data-rate="${cur}" inputmode="decimal" value="${esc(rate || '')}" placeholder="not set">
    <span class="type">${base}</span>
    <button class="btn ghost sm" data-act="save-rate" data-cur="${cur}">Save</button>
  </div>`;

// ================================================================ slip sheet (add / edit)

let draft = null;
let sheetCleanup = null;   // stops cameras / timers when a sheet closes

function closeSheet() {
  sheetCleanup?.();
  sheetCleanup = null;
  draft = null;
  const root = $('#sheet-root');
  if (root.children.length && !calm()) {
    // Let the old sheet slide away on its own layer, so a new one can open at once.
    const scrolls = $$('.sheet', root).map((el) => el.scrollTop);
    const leaving = document.createElement('div');
    leaving.className = 'sheet-leaving';
    leaving.inert = true;
    leaving.setAttribute('aria-hidden', 'true');
    leaving.append(...root.childNodes);
    $$('[id]', leaving).forEach((el) => el.removeAttribute('id'));
    document.body.append(leaving);
    $$('.sheet', leaving).forEach((el, i) => { el.scrollTop = scrolls[i]; });
    setTimeout(() => leaving.remove(), 260);
  } else root.innerHTML = '';
  document.body.style.overflow = '';
}

function openSlipSheet(g, slipId) {
  const st = state(g);
  const s = slipId ? st.slips[slipId] : null;
  if (s?.type === 'payment') return openPaySheet(g, { slipId });
  const ids = st.memberOrder;
  const cur = s?.currency || S.lastCur[g] || st.group.base;
  draft = {
    kind: 'expense', g,
    id: s?.id || uuid(), isNew: !s, prev: s?.eventId || null,
    desc: s?.desc || '',
    amountStr: s ? C.minorToInput(s.amount, s.currency) : '',
    currency: cur,
    date: s?.date || today(),
    category: s?.category || 'food',
    note: s?.note || '',
    multiPay: s ? Object.keys(s.payers).length > 1 : false,
    payer: s ? Object.keys(s.payers)[0] : meOf(g),
    payStr: {},
    mode: s?.split.mode || 'equal',
    equal: new Set(s?.split.mode === 'equal' ? Object.keys(s.split.values) : ids),
    vals: { exact: {}, percent: {}, shares: {}, adjust: {} },
  };
  if (s) {
    for (const [id, v] of Object.entries(s.payers)) draft.payStr[id] = C.minorToInput(v, s.currency);
    if (s.split.mode !== 'equal') {
      const moneyMode = s.split.mode === 'exact' || s.split.mode === 'adjust';
      for (const [id, v] of Object.entries(s.split.values)) {
        draft.vals[s.split.mode][id] = moneyMode ? (v ? C.minorToInput(v, s.currency) : '') : String(v);
      }
    }
  }
  renderSlipSheet();
  if (!s) $('#slip-form [name=amount]')?.focus();
}

function currencyOptions(st, selected) {
  const base = st.group.base;
  const list = [base, ...Object.keys(C.CURRENCIES).filter((c) => c !== base)];
  return list.map((c) => `<option value="${c}" ${c === selected ? 'selected' : ''}>${c}</option>`).join('');
}

function renderSlipSheet() {
  const st = state(draft.g);
  const s = st.slips[draft.id];
  $('#sheet-root').innerHTML = `
    <div class="sheet-backdrop" data-act="close-sheet"></div>
    <form class="sheet ruled" id="slip-form" autocomplete="off" role="dialog" aria-label="${draft.isNew ? 'New slip' : 'Edit slip'}">
      <div class="sheet-head">
        <button type="button" class="btn quiet sm" data-act="close-sheet">Cancel</button>
        <h2>${draft.isNew ? 'A new seetu' : 'This seetu'}</h2>
        <button class="btn sm" type="submit">Save</button>
      </div>
      ${st.conflicts.has(draft.id) ? `<div class="note">Two phones changed this slip separately. The later change is shown. Check it's right and tap Save to settle it.</div>` : ''}
      <section>
        <div class="amount-wrap">
          <input class="amount-in" name="amount" inputmode="decimal" placeholder="0" value="${esc(draft.amountStr)}" aria-label="Amount">
          <select class="line-in" name="currency" aria-label="Currency">${currencyOptions(st, draft.currency)}</select>
        </div>
        <div class="hint" id="cur-hint"></div>
      </section>
      <label class="field"><span class="label">For</span>
        <input class="line-in" name="desc" placeholder="Dinner at the dhaba" maxlength="120" value="${esc(draft.desc)}">
      </label>
      <section>
        <div class="chips" role="group" aria-label="Kind">
          ${Object.entries(C.CATEGORIES).map(([k, c]) => `<button type="button" class="chip" data-act="cat" data-v="${k}" aria-pressed="${draft.category === k}">${c.icon} ${c.label}</button>`).join('')}
        </div>
      </section>
      <label class="field"><span class="label">On</span>
        <input class="line-in" type="date" name="date" value="${esc(draft.date)}">
      </label>
      <section id="pay-sec">${paySecHTML(st)}</section>
      <section id="split-sec">${splitSecHTML(st)}</section>
      <label class="field"><span class="label">Note <span class="small muted">(optional)</span></span>
        <input class="line-in" name="note" maxlength="200" value="${esc(draft.note)}" placeholder="the one with the view">
      </label>
      <p class="hint bad" id="form-err"></p>
      ${!draft.isNew ? historyHTML(st, draft.id) : ''}
      ${!draft.isNew ? `<div style="margin-top:24px"><button type="button" class="btn danger block" data-act="delete-slip">Tear up this slip</button></div>` : ''}
      ${s && !draft.isNew ? `<p class="small muted" style="text-align:center">Written by ${esc(nameOf(st, s.createdBy))} · ${esc(fmtTime(s.createdT))}</p>` : ''}
    </form>`;
  document.body.style.overflow = 'hidden';
  updatePreview();
}

function paySecHTML(st) {
  const ids = st.memberOrder;
  const chips = ids.map((id) => `<button type="button" class="chip" data-act="payer" data-id="${esc(id)}" aria-pressed="${!draft.multiPay && draft.payer === id}">${esc(st.members[id].name)}</button>`).join('');
  return `
    <div class="label">Paid by</div>
    <div class="chips">${chips}<button type="button" class="chip" data-act="payer" data-id="*" aria-pressed="${draft.multiPay}">Several people</button></div>
    ${draft.multiPay ? `
      <div class="people-list">
        ${ids.map((id) => `<div class="person"><span class="name">${esc(st.members[id].name)}</span>
          <input class="mini" data-pay="${esc(id)}" inputmode="decimal" placeholder="0" value="${esc(draft.payStr[id] || '')}" aria-label="${esc(st.members[id].name)} paid"></div>`).join('')}
      </div>
      <div class="hint" id="pay-hint"></div>` : ''}`;
}

const MODES = { equal: 'Equally', exact: 'Amounts', percent: '%', shares: 'Shares', adjust: '+ Extra' };
const MODE_HELP = {
  equal: 'Tap names to leave people out.',
  exact: 'Write down what each person had.',
  percent: 'Percentages have to add up to 100.',
  shares: 'E.g. 2 for someone who had a double room.',
  adjust: 'Split equally, plus extra for anyone who had more.',
};

function splitSecHTML(st) {
  const m = draft.mode;
  const rows = st.memberOrder.map((id) => {
    const nm = esc(st.members[id].name);
    if (m === 'equal') {
      return `<div class="person toggle" role="checkbox" tabindex="0" aria-checked="${draft.equal.has(id)}" data-act="toggle-eq" data-id="${esc(id)}">
        <span class="check" aria-hidden="true">✓</span><span class="name">${nm}</span><span class="calc" data-calc="${esc(id)}"></span></div>`;
    }
    return `<div class="person">
      <span class="name">${nm}</span>
      ${m === 'adjust' ? '<span class="unit">+</span>' : ''}
      <input class="mini" data-v="${esc(id)}" inputmode="decimal" placeholder="0" value="${esc(draft.vals[m][id] ?? '')}" aria-label="${nm}">
      ${m === 'percent' ? '<span class="unit">%</span>' : ''}
      ${m !== 'exact' ? `<span class="calc" data-calc="${esc(id)}"></span>` : ''}
    </div>`;
  }).join('');
  return `
    <div class="label">Split</div>
    <div class="seg" role="group" aria-label="How to split">
      ${Object.entries(MODES).map(([k, l]) => `<button type="button" data-act="mode" data-v="${k}" aria-pressed="${m === k}">${l}</button>`).join('')}
    </div>
    <div class="small muted" style="margin-top:8px">${MODE_HELP[m]}</div>
    <div class="people-list">${rows}</div>
    <div class="hint" id="split-hint"></div>`;
}

function historyHTML(st, id) {
  const h = st.history[id] || [];
  if (h.length < 2) return '';
  return `<section>
    <div class="label">History of this slip</div>
    <ul class="who-wrote">${h.map((e) => `<li>
      <span class="small">${esc(fmtTime(e.t))} · ${esc(nameOf(st, e.m))}</span>
      <span class="type small">${e.k === 'slip.delete' ? 'torn up' : C.formatMoney(e.d.slip.amount, e.d.slip.currency)}</span>
    </li>`).join('')}</ul>
  </section>`;
}

/** Turn the split inputs into split.values, or an error. */
function splitValues() {
  const m = draft.mode;
  const ids = state(draft.g).memberOrder;
  const values = {};
  if (m === 'equal') {
    for (const id of ids) if (draft.equal.has(id)) values[id] = 1;
    return Object.keys(values).length ? { values } : { error: 'Pick who shares this' };
  }
  for (const id of ids) {
    const s = String(draft.vals[m][id] ?? '').trim();
    if (m === 'adjust') {
      const v = s ? C.toMinor(s, draft.currency) : 0;
      if (v == null) return { error: 'Check the extra amounts' };
      values[id] = v;
      continue;
    }
    if (!s) continue;
    if (m === 'exact') {
      const v = C.toMinor(s, draft.currency);
      if (v == null) return { error: 'Check the amounts' };
      if (v > 0) values[id] = v;
    } else {
      const v = Number(s);
      if (!Number.isFinite(v) || v < 0) return { error: m === 'percent' ? 'Check the percentages' : 'Check the shares' };
      if (v > 0) values[id] = v;
    }
  }
  return Object.keys(values).length ? { values } : { error: 'Fill in at least one person' };
}

function payerValues(amount) {
  if (!draft.multiPay) return draft.payer ? { values: { [draft.payer]: amount } } : { error: 'Who paid?' };
  const values = {};
  for (const [id, s] of Object.entries(draft.payStr)) {
    if (!String(s).trim()) continue;
    const v = C.toMinor(s, draft.currency);
    if (v == null) return { error: 'Check the paid amounts' };
    if (v > 0) values[id] = v;
  }
  return Object.keys(values).length ? { values } : { error: 'Who paid?' };
}

function setHint(el, text, cls = '') {
  if (!el) return;
  el.textContent = text;
  el.className = `hint ${cls}`;
}

function updatePreview() {
  if (draft?.kind !== 'expense') return;
  const st = state(draft.g);
  const cur = draft.currency;
  const base = st.group.base;
  const money = (m) => C.formatMoney(m, cur);
  const amount = C.toMinor(draft.amountStr, cur);
  const ok = amount != null && amount > 0;

  // currency
  if (cur !== base) {
    const conv = C.converter(cur, base, st.rates);
    setHint($('#cur-hint'), conv
      ? (ok ? `≈ ${C.formatMoney(conv(amount), base)} at the trip's rate` : '')
      : `No ${cur} → ${base} rate yet. This slip will wait outside the totals until someone sets one in Trip.`);
  } else setHint($('#cur-hint'), '');

  // payers
  if (draft.multiPay) {
    const p = payerValues(0);
    const paid = p.values ? Object.values(p.values).reduce((a, b) => a + b, 0) : 0;
    if (p.error && p.error !== 'Who paid?') setHint($('#pay-hint'), p.error, 'bad');
    else if (!ok) setHint($('#pay-hint'), `${money(paid)} paid so far`);
    else if (paid === amount) setHint($('#pay-hint'), '✓ adds up', 'good');
    else setHint($('#pay-hint'), paid < amount ? `${money(amount - paid)} still unpaid` : `${money(paid - amount)} too much`, 'bad');
  }

  // shares
  $$('#slip-form [data-calc]').forEach((el) => { el.textContent = ''; });
  const sv = splitValues();
  const hint = $('#split-hint');
  if (sv.error) return setHint(hint, sv.error, 'bad');
  if (!ok) return setHint(hint, "Write the amount to see everyone's share");
  const r = C.computeShares({ amount, currency: cur, split: { mode: draft.mode, values: sv.values } });
  if (!r.ok) return setHint(hint, r.error, 'bad');
  for (const [id, v] of Object.entries(r.shares)) {
    const el = $(`#slip-form [data-calc="${CSS.escape(id)}"]`);
    if (el) el.textContent = money(v);
  }
  const n = Object.values(r.shares).filter((v) => v > 0).length;
  setHint(hint, draft.mode === 'equal' ? `Split ${n} way${n > 1 ? 's' : ''}` : '✓ adds up', draft.mode === 'equal' ? '' : 'good');
}

function buildSlip() {
  const st = state(draft.g);
  const amount = C.toMinor(draft.amountStr, draft.currency);
  if (amount == null || amount <= 0) return { error: 'Write down an amount' };
  const p = payerValues(amount);
  if (p.error) return p;
  const sv = splitValues();
  if (sv.error) return sv;
  const slip = {
    id: draft.id,
    type: 'expense',
    desc: draft.desc.trim() || C.CATEGORIES[draft.category].label,
    amount,
    currency: draft.currency,
    date: draft.date || today(),
    category: draft.category,
    payers: p.values,
    split: { mode: draft.mode, values: sv.values },
  };
  if (draft.note.trim()) slip.note = draft.note.trim();
  const err = C.validateSlip(slip, st.memberOrder);
  return err ? { error: err } : { slip };
}

// ================================================================ payment sheet

function openPaySheet(g, p = {}) {
  const st = state(g);
  const s = p.slipId ? st.slips[p.slipId] : null;
  const me = meOf(g);
  const cur = s?.currency || p.currency || st.group.base;
  const from = s ? Object.keys(s.payers)[0] : p.from || me;
  draft = {
    kind: 'payment', g,
    id: s?.id || uuid(), isNew: !s, prev: s?.eventId || null,
    from,
    to: s ? Object.keys(s.split.values)[0] : p.to || st.memberOrder.find((id) => id !== from),
    amountStr: s ? C.minorToInput(s.amount, s.currency) : p.amount ? C.minorToInput(p.amount, cur) : '',
    currency: cur,
    date: s?.date || today(),
    note: s?.desc || '',
  };
  const people = (act, sel) => st.memberOrder.map((id) => `<button type="button" class="chip" data-act="${act}" data-id="${esc(id)}" aria-pressed="${sel === id}">${esc(st.members[id].name)}</button>`).join('');
  $('#sheet-root').innerHTML = `
    <div class="sheet-backdrop" data-act="close-sheet"></div>
    <form class="sheet ruled" id="pay-form" autocomplete="off" role="dialog" aria-label="Payment">
      <div class="sheet-head">
        <button type="button" class="btn quiet sm" data-act="close-sheet">Cancel</button>
        <h2>${draft.isNew ? 'Money changed hands' : 'This payment'}</h2>
        <button class="btn sm" type="submit">Save</button>
      </div>
      <section><div class="label">Who paid</div><div class="chips">${people('pay-from', draft.from)}</div></section>
      <section><div class="label">to whom</div><div class="chips">${people('pay-to', draft.to)}</div></section>
      <section>
        <div class="amount-wrap">
          <input class="amount-in" name="amount" inputmode="decimal" placeholder="0" value="${esc(draft.amountStr)}" aria-label="Amount">
          <select class="line-in" name="currency" aria-label="Currency">${currencyOptions(st, draft.currency)}</select>
        </div>
      </section>
      <label class="field"><span class="label">On</span><input class="line-in" type="date" name="date" value="${esc(draft.date)}"></label>
      <label class="field"><span class="label">Note <span class="small muted">(optional)</span></span>
        <input class="line-in" name="note" maxlength="120" value="${esc(draft.note)}" placeholder="cash at Lukla"></label>
      <p class="hint bad" id="form-err"></p>
      ${!draft.isNew ? historyHTML(st, draft.id) + `<div style="margin-top:24px"><button type="button" class="btn danger block" data-act="delete-slip">Tear up this payment</button></div>` : ''}
    </form>`;
  document.body.style.overflow = 'hidden';
}

function buildPayment() {
  const st = state(draft.g);
  const amount = C.toMinor(draft.amountStr, draft.currency);
  if (amount == null || amount <= 0) return { error: 'Write down an amount' };
  if (!draft.from || !draft.to) return { error: 'Pick who paid whom' };
  if (draft.from === draft.to) return { error: "Someone can't pay themselves" };
  const slip = {
    id: draft.id, type: 'payment', desc: draft.note.trim(), amount, currency: draft.currency,
    date: draft.date || today(), category: 'other',
    payers: { [draft.from]: amount }, split: { mode: 'exact', values: { [draft.to]: amount } },
  };
  const err = C.validateSlip(slip, st.memberOrder);
  return err ? { error: err } : { slip };
}

let saving = false;
async function saveDraft() {
  if (saving || !draft) return;
  const res = draft.kind === 'payment' ? buildPayment() : buildSlip();
  if (res.error) {
    $('#form-err').textContent = res.error;
    toast(res.error);
    return;
  }
  const { g, isNew, prev, kind } = draft;
  saving = true;
  try {
    await emit(g, [['slip.put', { slip: res.slip, prev }]]);
    if (kind === 'expense') {
      S.lastCur[g] = res.slip.currency;
      DB.setMeta(`cur:${g}`, res.slip.currency);
    }
    const form = $('#pay-form');
    if (kind === 'payment' && isNew && form && !calm()) {
      form.insertAdjacentHTML('beforeend', '<span class="stamp slam" aria-hidden="true">PAID</span>');
      await wait(650);
    }
  } finally {
    saving = false;
  }
  fx.drop = res.slip.id;
  fx.dropNew = isNew;
  closeSheet();
  render();
  toast(kind === 'payment' ? (isNew ? 'Payment noted' : 'Payment updated') : isNew ? 'Slip added to the pile' : 'Slip updated');
}

// ================================================================ passing piles around

function shareOrDownload(file, onShared) {
  // Must run synchronously inside the tap, or iOS refuses to open the share sheet.
  if (navigator.canShare?.({ files: [file] })) {
    navigator.share({ files: [file] })
      .then(() => onShared?.())
      .catch((e) => { if (e.name !== 'AbortError') { download(file); onShared?.(); } });
  } else {
    download(file);
    onShared?.();
  }
}

function download(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  toast(`Saved ${file.name}`);
}

function pileFile(g) {
  const st = state(g);
  const myName = nameOf(st, meOf(g));
  const bundle = C.makeBundle(st, pile(g), myName);
  const name = `${slug(st.group.name)}-${slug(myName)}-${bundle.code}.json`;
  return new File([JSON.stringify(bundle)], name, { type: 'application/json' });
}

function sendPile(g) {
  const sentClock = S.clock;
  shareOrDownload(pileFile(g), async () => {
    S.sentAt[g] = sentClock;
    await DB.setMeta(`sent:${g}`, sentClock);
    render();
    toast('Pile sent. Ask them to take it in.');
  });
}

async function importFiles(files) {
  const items = [];
  for (const f of files) {
    try { items.push({ name: f.name, text: await f.text() }); } catch (e) { items.push({ name: f.name, error: e.message }); }
  }
  return importTexts(items);
}

/** Take in piles, whether they came as AirDropped files or through the camera. */
async function importTexts(items) {
  const byTrip = new Map();
  const errors = [];
  for (const f of items) {
    try {
      if (f.error) throw new Error(f.error);
      const b = C.parseBundle(f.text);
      const t = byTrip.get(b.group) || { files: 0, from: [], added: 0, isNew: !state(b.group).group };
      t.files++;
      if (b.from && !t.from.includes(b.from)) t.from.push(b.from);
      const fresh = C.newEvents(pile(b.group), b.events);
      if (fresh.length) {
        await DB.putEvents(fresh);
        addToPile(fresh);
      }
      t.added += fresh.length;
      byTrip.set(b.group, t);
    } catch (e) {
      errors.push(`${f.name}: ${e.message}`);
    }
  }
  await DB.setMeta('clock', S.clock);

  for (const [g, t] of byTrip) {
    S.lastImport[g] = { at: Date.now(), files: t.files, from: t.from, added: t.added };
    await DB.setMeta(`import:${g}`, S.lastImport[g]);
  }
  if (errors.length) alert(`Couldn't take in:\n\n${errors.join('\n')}`);
  if (!byTrip.size) return;

  const [[g, t]] = byTrip;
  const total = [...byTrip.values()].reduce((s, x) => s + x.added, 0);
  if (byTrip.size === 1) go(`#/t/${encodeURIComponent(g)}/${t.isNew ? 'slips' : 'pass'}`);
  else render();
  toast(t.isNew ? `Joined “${state(g).group.name}”` : total ? `Took in ${total} new note${total > 1 ? 's' : ''}` : 'Already had all of that');
}

// ================================================================ passing piles by camera (QR)

const scriptLoads = {};
function loadScript(src) {
  return (scriptLoads[src] ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => { delete scriptLoads[src]; reject(new Error(`Couldn't load ${src}`)); };
    document.head.append(s);
  }));
}
const loadQrEncoder = () => loadScript('vendor/qrcode.js').then(() => window.qrcode);
const loadQrReader = () => loadScript('vendor/jsQR.js').then(() => window.jsQR.default || window.jsQR);

const META_KINDS = new Set(['group.create', 'group.update', 'member.add', 'member.update', 'rate.set']);
const QR_SPEEDS = { normal: 250, slow: 600 };

/** State of the "show my pile as QR" sheet, so its buttons can reach it. */
let qrShow = null;

function sheetShell(title, body) {
  $('#sheet-root').innerHTML = `
    <div class="sheet-backdrop" data-act="close-sheet"></div>
    <div class="sheet plain" role="dialog" aria-label="${esc(title)}">
      <div class="sheet-head">
        <button type="button" class="btn quiet sm" data-act="close-sheet">Close</button>
        <h2>${esc(title)}</h2>
        <span style="width:64px"></span>
      </div>
      ${body}
    </div>`;
  document.body.style.overflow = 'hidden';
}

async function openQrShow(g) {
  const st = state(g);
  const all = pile(g);
  const since = S.sentAt[g] || 0;
  const mine = all.filter((e) => e.a === S.device && e.t > since);
  const myName = nameOf(st, meOf(g));

  sheetShell('Show my pile', `
    <div class="qr-wrap"><canvas id="qr-canvas" aria-label="QR code"></canvas></div>
    <p class="qr-caption type" id="qr-caption">Folding the slips…</p>
    <div class="seg" id="qr-modes" hidden></div>
    <p class="small muted" style="margin:12px 0 0">
      Hold this phone still and turn the brightness up. On the other phone: Pass around → <b>Scan a pile</b>
      (or, for a friend who's joining, <b>Join a friend's trip</b> on the home screen).
      It keeps watching until it has every piece. Missed ones come round again.
    </p>
    <div class="row" style="margin-top:14px;justify-content:space-between">
      <button class="btn quiet sm" data-act="qr-speed" id="qr-speed">Slower</button>
      <button class="btn sm" data-act="qr-done">They've got it</button>
    </div>`);

  const ctl = { g, mode: 'all', speed: 'normal', i: 0, frames: [], qrs: [], timer: null, wake: null, closed: false, sets: {}, openedAt: S.clock };
  qrShow = ctl;
  sheetCleanup = () => {
    ctl.closed = true;
    clearInterval(ctl.timer);
    ctl.wake?.release?.().catch(() => {});
    qrShow = null;
  };

  try {
    const [qrLib] = await Promise.all([loadQrEncoder()]);
    ctl.qrLib = qrLib;
    const pack = async (events) => Q.toFrames(await Q.pack(JSON.stringify(C.makeBundle(st, events, myName))));
    ctl.sets.all = await pack(all);
    // A small "just what's new from me" pile, plus the trip/people so it stands on its own.
    if (mine.length && mine.length < all.length - all.filter((e) => META_KINDS.has(e.k)).length) {
      ctl.sets.mine = await pack([...all.filter((e) => META_KINDS.has(e.k) && !mine.includes(e)), ...mine]);
    }
  } catch (e) {
    $('#qr-caption').textContent = `Couldn't make the QR codes: ${e.message}`;
    return;
  }
  if (ctl.closed) return;

  if (ctl.sets.mine) {
    const n = (k) => ctl.sets[k].length;
    const modes = $('#qr-modes');
    modes.hidden = false;
    modes.innerHTML = `
      <button type="button" data-act="qr-mode" data-v="all" aria-pressed="true">Everything · ${n('all')} piece${n('all') > 1 ? 's' : ''}</button>
      <button type="button" data-act="qr-mode" data-v="mine" aria-pressed="false">Just my new · ${n('mine')}</button>`;
  }
  try { ctl.wake = await navigator.wakeLock?.request('screen'); } catch { /* screen may dim; that's ok */ }
  setQrFrames(ctl, ctl.mode);
}

function setQrFrames(ctl, mode) {
  ctl.mode = mode;
  ctl.frames = ctl.sets[mode];
  ctl.qrs = [];
  ctl.i = 0;
  clearInterval(ctl.timer);
  const tick = () => {
    if (ctl.closed) return;
    const i = ctl.i;
    drawQr($('#qr-canvas'), ctl, i);
    const n = ctl.frames.length;
    $('#qr-caption').textContent = n === 1 ? 'All in one code' : `piece ${i + 1} of ${n}`;
    ctl.i = (i + 1) % n;
  };
  tick();
  if (ctl.frames.length > 1) ctl.timer = setInterval(tick, QR_SPEEDS[ctl.speed]);
}

function drawQr(canvas, ctl, i) {
  if (!canvas) return;
  let qr = ctl.qrs[i];
  if (!qr) {
    qr = ctl.qrLib(0, 'L');
    qr.addData(Q.toBinaryString(ctl.frames[i]), 'Byte');
    qr.make();
    ctl.qrs[i] = qr;
  }
  const n = qr.getModuleCount();
  const quiet = 4;
  const total = n + quiet * 2;
  const css = Math.min(window.innerWidth - 56, 440);
  const dpr = window.devicePixelRatio || 1;
  const cell = Math.max(1, Math.floor((css * dpr) / total));
  const px = cell * total;
  if (canvas.width !== px) {
    canvas.width = canvas.height = px;
    canvas.style.width = canvas.style.height = `${px / dpr}px`;
  }
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, px, px);
  g.fillStyle = '#000';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) if (qr.isDark(r, c)) g.fillRect((c + quiet) * cell, (r + quiet) * cell, cell, cell);
  }
}

async function openQrScan() {
  sheetShell('Scan a pile', `
    <div class="scan-box"><video id="scan-video" playsinline muted autoplay></video><div class="scan-frame"></div></div>
    <p class="qr-caption" id="scan-status">Opening the camera…</p>
    <div class="pieces" id="scan-pieces" aria-hidden="true"></div>
    <p class="small muted" style="margin:12px 0 0">Point at the QR code on the other phone and hold steady. Pieces fill in as they're caught, in any order.</p>`);

  const asm = new Q.Assembler();
  const ctl = { stream: null, raf: 0, closed: false };
  sheetCleanup = () => {
    ctl.closed = true;
    cancelAnimationFrame(ctl.raf);
    ctl.stream?.getTracks().forEach((t) => t.stop());
  };
  const status = (t, cls = '') => { const el = $('#scan-status'); if (el) { el.textContent = t; el.className = `qr-caption ${cls}`; } };

  let jsQR;
  try {
    jsQR = await loadQrReader();
    ctl.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
    });
  } catch (e) {
    status(e.name === 'NotAllowedError'
      ? 'Camera access was refused. Allow the camera for this app (Settings → Safari → Camera), then try again.'
      : `Couldn't open the camera: ${e.message}`, 'bad');
    return;
  }
  if (ctl.closed) { ctl.stream.getTracks().forEach((t) => t.stop()); return; }

  const video = $('#scan-video');
  video.srcObject = ctl.stream;
  await video.play().catch(() => {});
  status('Looking for a QR code…');

  const grab = document.createElement('canvas');
  const g = grab.getContext('2d', { willReadFrequently: true });
  let warned = false;

  const showPieces = () => {
    const el = $('#scan-pieces');
    if (!el) return;
    el.innerHTML = Array.from({ length: asm.count }, (_, i) => `<i class="${asm.pieces.has(i) ? 'got' : ''}"></i>`).join('');
    status(asm.count === 1 ? 'Got it' : `${asm.have} of ${asm.count} pieces`);
  };

  const finish = async () => {
    sheetCleanup?.();
    sheetCleanup = null;
    status('Got every piece — unfolding…', 'good');
    try {
      const text = await Q.unpack(asm.bytes());
      closeSheet();
      await importTexts([{ name: 'QR pile', text }]);
    } catch (e) {
      status(`That pile didn't unfold: ${e.message}. Try again.`, 'bad');
    }
  };

  const loop = () => {
    if (ctl.closed) return;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (video.readyState >= 2 && vw) {
      const side = Math.min(vw, vh);
      const size = Math.min(side, 720);
      if (grab.width !== size) grab.width = grab.height = size;
      g.drawImage(video, (vw - side) / 2, (vh - side) / 2, side, side, 0, 0, size, size);
      const code = jsQR(g.getImageData(0, 0, size, size).data, size, size, { inversionAttempts: 'dontInvert' });
      if (code?.binaryData?.length) {
        const r = asm.add(code.binaryData);
        if (r === 'new' || r === 'restart') { showPieces(); }
        else if (r === 'foreign' && !asm.count && !warned) { warned = true; status("That QR code isn't a seetu pile", 'bad'); }
        if (asm.done) { finish(); return; }
      }
    }
    ctl.raf = requestAnimationFrame(loop);
  };
  loop();
}

// ================================================================ actions

const ACT = {
  import() { const inp = $('#file-in'); inp.value = ''; inp.click(); },
  'add-friend'() { $('#friends').insertAdjacentHTML('beforeend', friendInput()); $$('#friends input').at(-1).focus(); },

  async 'i-am'(el) { const g = route().g; await setMe(g, el.dataset.id); render(); },
  async 'add-me'() {
    const g = route().g;
    const n = $('#add-me-name').value.trim();
    if (!n) return toast('Your name?');
    const id = uuid();
    await setMe(g, id);
    await emit(g, [['member.add', { id, name: n }]]);
    render();
  },
  async 'change-me'() {
    const g = route().g;
    delete S.me[g];
    await DB.delMeta(`me:${g}`);
    render();
  },

  'new-slip'() { openSlipSheet(route().g); },
  'edit-slip'(el) { openSlipSheet(route().g, el.dataset.id); },
  'close-sheet'() { closeSheet(); },
  'record-payment'(el) {
    const d = el.dataset;
    openPaySheet(route().g, d.from ? { from: d.from, to: d.to, amount: Number(d.amount), currency: d.cur } : {});
  },
  async 'delete-slip'() {
    const st = state(draft.g);
    if (!confirm('Tear up this slip? Others will see it torn up once you pass piles around.')) return;
    const { g, id } = draft;
    closeSheet();
    try {
      await Promise.all([
        emit(g, [['slip.delete', { id, prev: st.slips[id]?.eventId }]]),
        tearUp($(`.slip[data-id="${CSS.escape(id)}"]`)),
      ]);
    } finally {
      render();
    }
    toast('Torn up');
  },

  cat(el) { draft.category = el.dataset.v; pressOnly(el); },
  payer(el) {
    const id = el.dataset.id;
    if (id === '*') {
      draft.multiPay = true;
      if (!Object.keys(draft.payStr).length && draft.payer) draft.payStr[draft.payer] = draft.amountStr;
    } else {
      draft.multiPay = false;
      draft.payer = id;
    }
    $('#pay-sec').innerHTML = paySecHTML(state(draft.g));
    updatePreview();
  },
  mode(el) {
    draft.mode = el.dataset.v;
    const st = state(draft.g);
    if (draft.mode === 'shares' && !Object.values(draft.vals.shares).some((v) => String(v).trim())) {
      for (const id of st.memberOrder) draft.vals.shares[id] = '1';
    }
    $('#split-sec').innerHTML = splitSecHTML(st);
    updatePreview();
  },
  'toggle-eq'(el) {
    const id = el.dataset.id;
    if (draft.equal.has(id)) draft.equal.delete(id); else draft.equal.add(id);
    el.setAttribute('aria-checked', draft.equal.has(id));
    updatePreview();
  },
  'pay-from'(el) { draft.from = el.dataset.id; pressOnly(el); },
  'pay-to'(el) { draft.to = el.dataset.id; pressOnly(el); },

  send() { sendPile(route().g); },
  'qr-show'() { openQrShow(route().g); },
  'qr-scan'() { openQrScan(); },
  async 'qr-done'() {
    // Someone scanned it: what this phone wrote up to now counts as passed around.
    const ctl = qrShow;
    closeSheet();
    if (!ctl) return;
    S.sentAt[ctl.g] = Math.max(S.sentAt[ctl.g] || 0, ctl.openedAt);
    await DB.setMeta(`sent:${ctl.g}`, S.sentAt[ctl.g]);
    render();
    toast('Pile passed. Check the pile codes match.');
  },
  'qr-mode'(el) {
    if (!qrShow) return;
    pressOnly(el);
    setQrFrames(qrShow, el.dataset.v);
  },
  'qr-speed'(el) {
    if (!qrShow) return;
    qrShow.speed = qrShow.speed === 'normal' ? 'slow' : 'normal';
    el.textContent = qrShow.speed === 'normal' ? 'Slower' : 'Faster';
    setQrFrames(qrShow, qrShow.mode);
  },
  backup() { shareOrDownload(pileFile(route().g)); },
  csv() {
    const st = state(route().g);
    shareOrDownload(new File([C.toCSV(st)], `${slug(st.group.name)}.csv`, { type: 'text/csv' }));
  },

  async 'rename-member'(el) {
    const g = route().g;
    const m = state(g).members[el.dataset.id];
    const n = prompt('New name', m.name)?.trim();
    if (n && n !== m.name) { await emit(g, [['member.update', { id: m.id, name: n }]]); render(); }
  },
  async 'add-member'() {
    const g = route().g;
    const n = $('#new-member').value.trim();
    if (!n) return toast('Name?');
    await emit(g, [['member.add', { id: uuid(), name: n }]]);
    render();
    toast(`${n} added`);
  },
  async 'rename-trip'() {
    const g = route().g;
    const n = prompt('Trip name', state(g).group.name)?.trim();
    if (n) { await emit(g, [['group.update', { name: n }]]); render(); }
  },
  'save-rate'(el) { saveRate(el.dataset.cur, $(`[data-rate="${el.dataset.cur}"]`).value); },
  'add-rate'() { saveRate($('#new-rate-cur').value, $('#new-rate').value); },
  async 'delete-trip'() {
    const g = route().g;
    const st = state(g);
    if (!confirm(`Remove “${st.group.name}” from this phone?\n\nFriends who have taken in your pile keep their copy. If nobody else has it, it's gone for good.`)) return;
    await DB.deleteTrip(g);
    for (const k of ['me', 'sent', 'import', 'cur']) await DB.delMeta(`${k}:${g}`);
    S.piles.delete(g);
    S.states.delete(g);
    go('#/');
    toast('Trip removed from this phone');
  },
};

async function saveRate(cur, raw) {
  const g = route().g;
  const s = String(raw).trim().replace(/,/g, '');
  const r = Number(s);
  if (!/^\d*\.?\d+$/.test(s) || !(r > 0)) return toast('Rate should be a number, like 0.625');
  await emit(g, [['rate.set', { currency: cur, rate: s }]]);
  render();
  toast(`1 ${cur} = ${s} ${state(g).group.base}`);
}

function pressOnly(el) {
  $$(`[data-act="${el.dataset.act}"]`, el.parentElement).forEach((b) => b.setAttribute('aria-pressed', b === el));
}

// ================================================================ wiring

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || !ACT[el.dataset.act]) return;
  e.preventDefault();
  Promise.resolve(ACT[el.dataset.act](el, e)).catch((err) => { console.error(err); toast(`Something went wrong: ${err.message}`); });
});

document.addEventListener('keydown', (e) => {
  if ((e.key === ' ' || e.key === 'Enter') && e.target.matches('[role="checkbox"][data-act]')) {
    e.preventDefault();
    e.target.click();
  }
  if (e.key === 'Escape' && $('#sheet-root').children.length) closeSheet();
});

document.addEventListener('input', (e) => {
  if (!draft || !e.target.closest('#slip-form, #pay-form')) return;
  const t = e.target;
  if (t.name === 'amount') draft.amountStr = t.value;
  else if (t.name === 'currency') draft.currency = t.value;
  else if (t.name === 'desc') draft.desc = t.value;
  else if (t.name === 'date') draft.date = t.value;
  else if (t.name === 'note') draft.note = t.value;
  else if (t.dataset.pay) draft.payStr[t.dataset.pay] = t.value;
  else if (t.dataset.v) draft.vals[draft.mode][t.dataset.v] = t.value;
  updatePreview();
});
document.addEventListener('change', (e) => {
  if (draft && e.target.name === 'currency') { draft.currency = e.target.value; updatePreview(); }
});

document.addEventListener('submit', (e) => {
  e.preventDefault();
  const id = e.target.id;
  const run = id === 'new-trip' ? createTrip(e.target) : id === 'slip-form' || id === 'pay-form' ? saveDraft() : null;
  Promise.resolve(run).catch((err) => { console.error(err); toast(`Couldn't save: ${err.message}`); });
});

$('#file-in').addEventListener('change', (e) => {
  const files = [...e.target.files];
  if (files.length) importFiles(files);
});

window.addEventListener('hashchange', () => { closeSheet(); render(); });

// ================================================================ boot

async function boot() {
  try {
    S.device = await DB.getMeta('device');
    if (!S.device) { S.device = uuid(); await DB.setMeta('device', S.device); }
    S.clock = await DB.getMeta('clock', 0);
    addToPile(await DB.allEvents());
    for (const g of S.piles.keys()) {
      S.me[g] = await DB.getMeta(`me:${g}`);
      S.sentAt[g] = await DB.getMeta(`sent:${g}`, 0);
      S.lastImport[g] = await DB.getMeta(`import:${g}`);
      S.lastCur[g] = await DB.getMeta(`cur:${g}`);
    }
  } catch (e) {
    $('#app').innerHTML = `<p class="boot">Couldn't open this phone's pile.<br><small>${esc(e.message)}</small></p>`;
    return;
  }
  render();

  // Ask Safari not to clear our data under storage pressure.
  navigator.storage?.persist?.().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('Offline cache unavailable', e));
  }
}

boot();
