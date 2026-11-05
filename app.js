import { CONFIG } from './firebase-config.js';

const DEMO = !CONFIG || !CONFIG.apiKey;
const TZ = 'Asia/Dhaka';
const FB = 'https://www.gstatic.com/firebasejs/10.12.0';
const $ = (s, e = document) => e.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- state ----------
const S = { items: [], snapshots: [], ledger: [], audit: [], settings: [], connectors: [], webhooks: [] };
const LOADED = {};
let A, user = 'demo', started = false, ticking = false, lastSnapTs = 0, pendingRender = false, snapTimer = null;

// ---------- structure (labels only; all names/values live in Firestore) ----------
const GROUPS = {
  cash: { label: 'Cash & Accounts', kind: 'asset' },
  courier: { label: 'Courier Receivables', kind: 'asset' },
  stock: { label: 'Inventory', kind: 'asset' },
  otherAsset: { label: 'Other Assets', kind: 'asset' },
  supplier: { label: 'Supplier Dues', kind: 'liability' },
  otherLiab: { label: 'Other Liabilities', kind: 'liability' },
  owner: { label: 'Owner Adjustment', kind: 'equity' },
  metric: { label: 'EcomDrive report', kind: 'info' },
  expense: { label: 'Expenses', kind: 'info' }
};
const PAGES = {
  accounts: ['cash'], courier: ['courier'], stock: ['stock', 'otherAsset'],
  suppliers: ['supplier', 'otherLiab'], owner: ['owner'], metrics: ['metric']
};
const NAV = [
  ['overview', 'Overview'], ['sheet', 'Live Sheet'], ['actions', 'Quick Actions'], ['balance', 'Assets & Dues'],
  ['accounts', 'Accounts'], ['courier', 'Courier'], ['stock', 'Inventory'], ['metrics', 'Ecomdrive & Metrics'], ['expenses', 'Expenses'],
  ['suppliers', 'Suppliers & Dues'], ['owner', 'Owner Adjustment'], ['ledger', 'Ledger'],
  ['daily', 'Daily Profit & Cash'], ['errors', 'Errors'], ['integrations', 'Integrations'], ['audit', 'Audit Logs'], ['settings', 'Settings']
];
const NAV_GROUPS = [
  ['হিসাব', ['overview', 'sheet', 'actions', 'daily', 'ledger']],
  ['সম্পদ', ['balance', 'accounts', 'courier', 'stock', 'metrics', 'expenses', 'suppliers', 'owner']],
  ['আরও', ['errors', 'integrations', 'audit', 'settings']]
];

// ---------- defaults (used only to seed Firestore the first time) ----------
const DEF = {
  base: 'BDT', interval: 5, onChange: true, ownerInNetWorth: false, codOn: true, codPct: '1',
  times: ['00:01'], rates: { USD: '122.00', USDT: '122.00' },
  types: {
    customer_payment: { label: 'Customer payment received', cash: 'in', fin: false, profit: 'revenue' },
    sale_on_credit: { label: 'Sale (not yet paid / courier)', cash: 'none', fin: false, profit: 'revenue' },
    cogs: { label: 'Cost of goods sold', cash: 'none', fin: false, profit: 'expense' },
    expense: { label: 'Expense paid', cash: 'out', fin: false, profit: 'expense' },
    supplier_payment: { label: 'Supplier payment (existing due)', cash: 'out', fin: false, profit: 'none' },
    credit_purchase: { label: 'Credit purchase (supplier due up)', cash: 'none', fin: false, profit: 'none' },
    courier_settlement: { label: 'Courier settlement received', cash: 'in', fin: false, profit: 'none' },
    transfer: { label: 'Internal transfer', cash: 'none', fin: false, profit: 'none' },
    owner_contribution: { label: 'Owner capital contribution', cash: 'in', fin: true, profit: 'none' },
    owner_withdrawal: { label: 'Owner withdrawal', cash: 'out', fin: true, profit: 'none' },
    loan_received: { label: 'Loan received', cash: 'in', fin: true, profit: 'none' },
    capital_add: { label: 'Add (not profit today)', cash: 'in', fin: true, profit: 'none' },
    capital_withdraw: { label: 'Withdraw (not a loss today)', cash: 'out', fin: true, profit: 'none' }
  }
};
const SEED_ITEMS = [
  { name: 'Total Stock Value', group: 'stock', currency: 'BDT' },
  { name: 'Packaging XYZ', group: 'supplier', currency: 'BDT' },
  { name: 'Owner Adjustment', group: 'owner', currency: 'BDT' }
];

// ---------- money (integer minor units = paisa/cents) ----------
const toMinor = v => {
  let s = String(v ?? '').replace(/[,৳\s]/g, '');
  if (!s || isNaN(Number(s))) return null;
  const neg = s.startsWith('-'); s = s.replace(/^[-+]/, '');
  const [i, f = ''] = s.split('.');
  const m = parseInt(i || '0', 10) * 100 + parseInt((f + '00').slice(0, 2), 10);
  return neg ? -m : m;
};
const fmt = (m, cur = cfg().base) => {
  if (m == null) return '—';
  const abs = Math.abs(m);
  const t = (abs / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (m < 0 ? '-' : '') + (cur === 'BDT' ? '৳' : cur + ' ') + t;
};
const inputVal = m => ((m || 0) / 100).toFixed(2);

// ---------- time (Asia/Dhaka) ----------
const dkDate = d => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
const hhmm = d => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
const dt = v => {
  if (!v) return '—';
  const d = new Date(v);
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric' }).format(d);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
  return `${day}, ${time}`;
};

// ---------- settings ----------
const cfg = () => ({ ...DEF, ...(S.settings.find(x => x.id === 'main') || {}) });
const rate = (cur, c = cfg()) => cur === c.base ? 1 : parseFloat(c.rates?.[cur]);
let WARN = [];
const toBase = (m, cur, c = cfg()) => {
  if (!cur || cur === c.base) return m;
  const r = rate(cur, c);
  if (!r) { WARN.push('Missing exchange rate for ' + cur); return 0; }
  return Math.round(m * r);
};
const conv = (m, from, to, c = cfg()) => {
  if (from === to) return m;
  const f = rate(from, c), t = rate(to, c);
  if (!f || !t) return null;
  return Math.round(m * f / t);
};

// ---------- accounting engine ----------
const ECOM_SALE = new Set(['Ecomdrive · Shipped', 'Ecomdrive · Pending', 'Ecomdrive · RTS', 'Ecomdrive · Pending Return']);
const ECOM_FEE = new Set(['Ecomdrive · Shipped delivery', 'Ecomdrive · Pending delivery', 'Ecomdrive · RTS delivery', 'Ecomdrive · Pending Return delivery']);
const AWAITING = 'Steadfast · Awaiting approval';
const feeNameOf = saleName => saleName + ' delivery';
function deliveryMinor(saleName, items = S.items) {
  const it = items.find(i => !i.archived && i.name === feeNameOf(saleName) && i.include !== false);
  if (!it) return 0;
  return Math.abs(toBase(it.balance || 0, it.currency));
}
function sheetSaleNow(it, c = cfg()) {
  const gross = toBase(it.balance || 0, it.currency, c);
  return afterCod(gross - deliveryMinor(it.name, S.items), c);
}
function undoAfterCod(net, c = cfg()) {
  const pct = codPct(c);
  if (!pct || net == null) return net;
  const guess = Math.round(net / (1 - pct / 100));
  for (let d = -8; d <= 8; d++) {
    if (afterCod(guess + d, c) === net) return guess + d;
  }
  return guess;
}
function saleSheetValue(snap, name, raw) {
  if (raw == null || !ECOM_SALE.has(name)) return raw;
  if (snap?.ecomNet >= 2) return raw;
  if (snap?.ecomNet === 1) {
    const fee = deliveryMinor(name);
    return afterCod(undoAfterCod(raw + fee) - fee);
  }
  const feeRaw = feeValueInSnap(snap, feeNameOf(name));
  const fee = feeRaw == null ? 0 : Math.abs(feeRaw);
  const gross = snap?.codApplied ? undoAfterCod(raw) : raw;
  return afterCod(gross - fee);
}
function feeValueInSnap(snap, feeName) {
  if (!snap?.names) return null;
  for (const [id, n] of Object.entries(snap.names)) {
    if (n !== feeName) continue;
    const v = snap.values?.[id];
    return v == null ? null : v;
  }
  return null;
}
function snapCell(snap, it) {
  if (!snap || !it) return null;
  const raw = snap.values?.[it.id];
  if (raw == null) return null;
  if (!ECOM_SALE.has(it.name)) return raw;
  return saleSheetValue(snap, it.name, raw);
}
function sheetCod(name) {
  return ECOM_SALE.has(name) || name === AWAITING;
}
function codPct(c = cfg()) {
  if (c.codOn === false) return 0;
  const n = parseFloat(String(c.codPct ?? '1').replace('%', ''));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, 100);
}
function afterCod(v, c = cfg()) {
  const pct = codPct(c);
  if (!pct || v == null) return v;
  const cut = Math.round(Math.abs(v) * pct / 100);
  return v < 0 ? v + cut : v - cut;
}
function compute(items = S.items, c = cfg()) {
  WARN = [];
  const T = { cash: 0, courier: 0, stock: 0, otherAsset: 0, supplier: 0, otherLiab: 0, owner: 0, ecomSale: 0, ecomFee: 0 }, parts = [];
  // Collapse duplicate courier/cash rows so Count off on one id cannot leave clones still counting.
  const list = collapseActiveItemDupes(items.filter(i => !i.archived));
  for (const it of list) {
    let v = toBase(it.balance || 0, it.currency, c);
    if (ECOM_SALE.has(it.name)) v = afterCod(v - deliveryMinor(it.name, list), c);
    else if (sheetCod(it.name)) v = afterCod(v, c);
    const inc = isCountOff(it.name) ? false : it.include !== false;
    parts.push({ it, v, inc });
    if (!inc) continue;
    if (T[it.group] !== undefined) T[it.group] += v;
    else if (ECOM_SALE.has(it.name)) T.ecomSale += v;
    else if (ECOM_FEE.has(it.name)) T.ecomFee += Math.abs(v);
  }
  const assets = T.cash + T.courier + T.stock + T.otherAsset;
  const liab = T.supplier + T.otherLiab;
  const nw = assets - liab + T.ecomSale + (c.ownerInNetWorth ? T.owner : 0);
  return { ...T, assets, liab, nw, parts, warn: [...new Set(WARN)] };
}
const sortedSnaps = () => [...S.snapshots].sort((a, b) => a.ts < b.ts ? -1 : 1);
const latestSnap = () => { const s = sortedSnaps(); return s[s.length - 1]; };

function daily(date) {
  const c = cfg(), E = S.ledger.filter(e => e.date === date);
  let inflow = 0, outflow = 0, fin = 0, rev = 0, exp = 0, hasRev = false, hasExp = false;
  const byType = {};
  for (const e of E) {
    const r = c.types[e.type]; if (!r) continue;
    const sg = e.sign || 1, v = (toBase(e.amount, e.currency, c) || 0) * sg;
    if (r.cash === 'in') { r.fin ? fin += v : inflow += v; }
    if (r.cash === 'out') { r.fin ? fin -= v : outflow += v; }
    if (r.profit === 'revenue') { rev += v; hasRev = true; }
    if (r.profit === 'expense') { exp += v; hasExp = true; }
    byType[e.type] = (byType[e.type] || 0) + v;
  }
  const label = !E.length ? 'Incomplete data (no entries)' : (hasRev && hasExp) ? 'Based on recorded entries' : 'Estimated (revenue or expense entries missing)';
  return { E, inflow, outflow, fin, opCF: inflow - outflow, cf: inflow - outflow + fin, rev, exp, profit: rev - exp, label, byType };
}
function dayBounds(date) {
  const snaps = sortedSnaps();
  const prev = [...snaps].reverse().find(s => s.date < date);
  const today = snaps.filter(s => s.date === date);
  return { opening: prev || today[0] || null, closing: today[today.length - 1] || null, prevDay: prev || null, openingIsPrev: !!prev };
}
const todayStr = () => dkDate(new Date());

// ---------- data adapters ----------
function localAdapter() {
  const subs = {};
  const mem = {};
  const load = c => { try { return JSON.parse(localStorage.getItem('hisab_' + c) || '[]'); } catch { return JSON.parse(mem[c] || '[]'); } };
  const save = (c, v) => { mem[c] = JSON.stringify(v); try { localStorage.setItem('hisab_' + c, mem[c]); } catch { /* storage unavailable: kept in memory */ } };
  const push = c => subs[c]?.(load(c));
  return {
    auth: null,
    listen(c, cb) { subs[c] = cb; cb(load(c)); },
    async add(c, o) { const id = 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); const a = load(c); a.push({ id, ...o }); save(c, a); push(c); return id; },
    async set(c, id, o) { const a = load(c); const i = a.findIndex(x => x.id === id); if (i < 0) a.push({ id, ...o }); else a[i] = { ...a[i], ...o }; save(c, a); push(c); },
    async del(c, id) { save(c, load(c).filter(x => x.id !== id)); push(c); },
    async wipe() { Object.keys(S).forEach(c => localStorage.removeItem('hisab_' + c)); }
  };
}
async function fsAdapter() {
  const { initializeApp } = await import(`${FB}/firebase-app.js`);
  const fs = await import(`${FB}/firebase-firestore.js`);
  const au = await import(`${FB}/firebase-auth.js`);
  const app = initializeApp(CONFIG), db = fs.getFirestore(app), auth = au.getAuth(app);
  const lim = { snapshots: 3000, ledger: 3000, audit: 500 };
  return {
    auth: {
      onChange: cb => au.onAuthStateChanged(auth, cb),
      login: (e, p) => au.signInWithEmailAndPassword(auth, e, p),
      logout: () => au.signOut(auth),
      async open() {
        if (auth.currentUser) return auth.currentUser;
        return new Promise(resolve => {
          const unsub = au.onAuthStateChanged(auth, async u => {
            unsub();
            if (u) { resolve(u); return; }
            try {
              const res = await fetch(stockApiBase() + '/api/firebase-auth', { credentials: 'include' });
              if (res.ok) {
                const data = await res.json().catch(() => ({}));
                if (data.email && data.password) {
                  resolve(await au.signInWithEmailAndPassword(auth, data.email, data.password));
                  return;
                }
              }
            } catch { /* try anonymous next */ }
            try { resolve(await au.signInAnonymously(auth)); }
            catch { resolve(null); }
          });
        });
      }
    },
    listen(c, cb) {
      const col = fs.collection(db, c);
      const q = lim[c] ? fs.query(col, fs.orderBy('ts', 'desc'), fs.limit(lim[c])) : col;
      fs.onSnapshot(
        q,
        s => cb(s.docs.map(d => ({ id: d.id, ...d.data() }))),
        e => {
          toast(e.message);
          // Still notify so keepLocalRows can restore hisab_* mirror instead of leaving S empty.
          try { cb([]); } catch { /* ignore */ }
        }
      );
    },
    async add(c, o) { return (await fs.addDoc(fs.collection(db, c), o)).id; },
    set: (c, id, o) => fs.setDoc(fs.doc(db, c, id), o, { merge: true }),
    del: (c, id) => fs.deleteDoc(fs.doc(db, c, id))
  };
}

// ---------- helpers ----------
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.remove('hidden'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), 3500); }
const audit = (action, detail) => A.add('audit', { ts: new Date().toISOString(), by: user, action, detail: String(detail).slice(0, 500) }).catch(() => { });
const chg = (cur, prev) => {
  if (prev == null) return '<span class="muted">—</span>';
  const d = cur - prev, p = prev ? (d / Math.abs(prev) * 100).toFixed(1) + '%' : '—';
  return `<span class="${d > 0 ? 'pos' : d < 0 ? 'neg' : 'muted'}">${d > 0 ? '▲' : d < 0 ? '▼' : ''} ${fmt(Math.abs(d))} (${p})</span>`;
};

// ---------- snapshots / scheduler ----------
async function snapshot(source = 'auto') {
  if (window.__holdSnap) return;
  const t = compute(), now = new Date();
  const values = {}, names = {};
  t.parts.forEach(p => {
    if (!p.inc || ECOM_FEE.has(p.it.name)) return;
    if (!p.it?.id || p.it.name == null) return;
    names[p.it.id] = p.it.name;
    values[p.it.id] = ECOM_SALE.has(p.it.name) ? sheetSaleNow(p.it) : p.v;
  });
  lastSnapTs = now.getTime();
  if (source === 'auto' && cfg().skipUnchanged) {
    const p = latestSnap(), pv = p?.values || {}, ks = Object.keys(values);
    if (p && ks.length === Object.keys(pv).length && ks.every(k => pv[k] === values[k])) return; // nothing changed since the last row
  }
  const row = {
    ts: now.toISOString(), date: dkDate(now), source, by: user, values, names, ecomNet: 2, codApplied: codPct() > 0 ? 1 : 0,
    totals: { cash: t.cash, courier: t.courier, stock: t.stock, supplier: t.supplier + t.otherLiab, owner: t.owner, assets: t.assets, liab: t.liab, nw: t.nw }
  };
  const id = await cloudAdd('snapshots', row, 10000);
  if (!id) throw new Error(window.__cloudErr || 'Could not save Live Sheet row');
  if (!S.snapshots.some(s => s.id === id)) S.snapshots.push({ id, ...row });
  if (source !== 'open') await absorbCountFix();
}
/** Wipe every Live Sheet row (keeps accounts/balances) and write one fresh opening row. */
async function clearLiveSheet() {
  window.__purgeSnapshots = true;
  const purgedAt = Date.now();
  try { localStorage.setItem('hisab_sheet_purged_at', String(purgedAt)); } catch { /* ignore */ }
  // Collect every known id (memory + disk) before wiping — cloud may hold rows not in S.
  const idSet = new Set();
  for (const s of S.snapshots || []) if (s?.id) idSet.add(s.id);
  for (const s of readLocalMirror('snapshots')) if (s?.id) idSet.add(s.id);
  const ids = [...idSet];
  S.snapshots = [];
  lastSnapTs = 0;
  try { localStorage.setItem('hisab_snapshots', '[]'); } catch { /* ignore */ }
  // Delete in parallel batches — many rows are local-only mirrors.
  for (let i = 0; i < ids.length; i += 20) {
    const batch = ids.slice(i, i + 20);
    await Promise.all(batch.map(id => withTimeout(A.del('snapshots', id), 2000, 'del').catch(() => {})));
  }
  try { localStorage.setItem('hisab_snapshots', '[]'); } catch { /* ignore */ }
  S.snapshots = [];
  try {
    await snapshot('open');
  } finally {
    // Keep purge guard up through open so a mid-flight onSnapshot cannot resurrect history.
    window.__purgeSnapshots = false;
  }
  S.snapshots = collapseDupOpenSnaps(S.snapshots || []);
  // Remove leftover local open twin created when cloud add timed out after succeeding.
  for (const s of readLocalMirror('snapshots')) {
    if (s?.source === 'open' && String(s.id || '').startsWith('l') && !(S.snapshots || []).some(x => x.id === s.id)) {
      withTimeout(A.del('snapshots', s.id), 1500, 'del').catch(() => {});
    }
  }
  persistSnapshotMirror(S.snapshots || []);
  audit('sheet.clear', 'Live Sheet cleared; opening row ' + (latestSnap()?.id || ''));
  toast('Live Sheet cleared · fresh start');
  render(true);
}
function scheduleSnap() {
  if (!cfg().onChange) return;
  clearTimeout(snapTimer);
  snapTimer = setTimeout(() => {
    snapshot('change')
      .then(() => { if (page === 'sheet') render(true); })
      .catch(e => toast(e.message || 'Live Sheet row was not saved'));
  }, 800);
}
function sameSnapValues(a, b) {
  const ak = Object.keys(a?.values || {}), bk = Object.keys(b?.values || {});
  if (ak.length !== bk.length) return false;
  return ak.every(k => a.values[k] === b.values[k]);
}
function courierStep(a, b) {
  const ids = new Set([...Object.keys(a?.values || {}), ...Object.keys(b?.values || {})]);
  const moves = [];
  for (const id of ids) {
    const from = a?.values?.[id], to = b?.values?.[id];
    if (from === to) continue;
    const name = b?.names?.[id] || a?.names?.[id] || '';
    if (!/^Pathao · |^Steadfast · /.test(name)) return null;
    moves.push({ from: from == null ? null : from, to: to == null ? null : to });
  }
  return moves;
}
function isCountFix(older, mid, last) {
  const d1 = (mid.totals?.nw || 0) - (older.totals?.nw || 0);
  const d2 = (last.totals?.nw || 0) - (mid.totals?.nw || 0);
  if (!d1 || !d2 || Math.sign(d1) === Math.sign(d2)) return false;
  if (Math.abs(Math.abs(d1) - Math.abs(d2)) > 100) return false;
  const up = courierStep(older, mid), down = courierStep(mid, last);
  if (!up?.length || !down?.length) return false;
  const counted = up.some(m => !m.from && m.to);
  const cleared = down.some(m => m.from && !m.to);
  return counted && cleared;
}
async function absorbCountFix() {
  if (!LOADED.snapshots || S.snapshots.length < 3) return;
  const distinct = [];
  for (const s of sortedSnaps()) {
    const prev = distinct[distinct.length - 1];
    if (prev && prev.totals?.nw === s.totals?.nw && sameSnapValues(prev, s)) continue;
    distinct.push(s);
  }
  if (distinct.length < 3) return;
  const mid = distinct[distinct.length - 2];
  if (!isCountFix(distinct[distinct.length - 3], mid, distinct[distinct.length - 1])) return;
  await A.del('snapshots', mid.id);
}
async function tick() {
  if (!started) return;
  if (ticking) {
    if (window.__tickStartedAt && Date.now() - window.__tickStartedAt > 120000) {
      console.warn('hisab: tick stuck, releasing');
      ticking = false;
    } else return;
  }
  if (window.__calcBusy && window.__calcStartedAt && Date.now() - window.__calcStartedAt > 12 * 60000) forceReleaseCalc();
  const settingsReady = LOADED.settings || S.settings.some(r => r.id === 'main');
  if (!settingsReady) return;
  // Do NOT require LOADED.snapshots — empty/cleared sheet must still interval-calc
  ticking = true;
  window.__tickStartedAt = Date.now();
  try {
    try { await withTimeout(migrate(), 25000, 'migrate timed out'); }
    catch (e) { console.warn(e); }
    const c = cfg(), now = new Date(), last = latestSnap();
    const lastMs = Math.max(lastSnapTs, last ? new Date(last.ts).getTime() : 0);
    const lastDate = lastMs ? dkDate(new Date(lastMs)) : null;
    const hm = hhmm(now);
    // Prefer in-memory lastCalcAt; fall back to localStorage mirror if S is stale
    let lastCalc = c.lastCalcAt ? new Date(c.lastCalcAt).getTime() : 0;
    if (!lastCalc) {
      try {
        const m = (JSON.parse(localStorage.getItem('hisab_settings') || '[]').find(r => r.id === 'main') || {}).lastCalcAt;
        if (m) lastCalc = new Date(m).getTime() || 0;
      } catch { /* ignore */ }
    }
    const every = Math.max(0, Number(c.interval) || 0);
    const calcDue = every > 0 && !window.__calcBusy && Date.now() - lastCalc >= every * 60000;
    if (calcDue) {
      await calculateNow(false);
    } else if (lastMs && !window.__calcBusy) {
      if (lastDate && lastDate !== dkDate(now)) await snapshot('day-open');
      else if (c.times?.includes(hm) && !S.snapshots.some(s => s.source === 'sched-' + hm && s.date === dkDate(now))) await snapshot('sched-' + hm);
      await applySmsBalances(false);
      if (!window.__dollarAt || Date.now() - window.__dollarAt >= 60000) {
        window.__dollarAt = Date.now();
        await applyDollar(false);
      }
    }
  } catch (e) { console.error(e); }
  finally { ticking = false; window.__tickStartedAt = 0; }
  $('#clock').textContent = dt(new Date());
}

// ---------- mutations ----------
function stockApiBase() {
  // UI+API share one origin on :8787 (and on VPS behind nginx). Only legacy :5500 static needs a separate API URL.
  if (location.port === '5500') return 'http://127.0.0.1:8787';
  return '';
}
function api(path, opts = {}) {
  const ms = opts.timeoutMs;
  const { timeoutMs, ...rest } = opts;
  if (!ms) return fetch(stockApiBase() + path, { credentials: 'include', ...rest });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(stockApiBase() + path, { credentials: 'include', ...rest, signal: ctrl.signal })
    .catch(err => {
      if (err?.name === 'AbortError') throw new Error('Timed out after ' + Math.round(ms / 1000) + 's');
      throw err;
    })
    .finally(() => clearTimeout(t));
}
async function checkEcomdriveStock(quiet) {
  if (window.__stockBusy) return 'busy';
  window.__stockBusy = true;
  window.__stockErr = '';
  window.__stockMsg = 'Checking EcomDrive…';
  render(true);
  try {
    const res = await api('/api/ecomdrive/stock-value', { method: 'POST', timeoutMs: 120000 });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Stock checker is not running. In the worker folder, run: node server.mjs');
    const m = toMinor(data.costValue);
    if (m === null) throw new Error('EcomDrive did not return a cost value');
    let it = S.items.find(i => !i.archived && i.group === 'stock' && i.name === 'Total Stock Value');
    const now = new Date().toISOString();
    const prev = it ? (it.balance || 0) : m;
    if (!it) {
      const seed = { name: 'Total Stock Value', group: 'stock', currency: cfg().base, balance: m, prev: m, opening: m, include: true, archived: false, order: S.items.length, updatedAt: now, source: 'ecomdrive', status: 'auto' };
      const id = await cloudAdd('items', seed, 5000);
      it = S.items.find(i => i.id === id) || { id: id || localId(), ...seed };
      if (!S.items.some(x => x.id === it.id)) S.items.push(it);
    } else if (prev !== m) {
      it.prev = prev;
      it.balance = m;
    }
    it.updatedAt = now;
    it.source = 'ecomdrive';
    await cloudSet('items', it.id, { prev: it.prev, balance: it.balance, updatedAt: now, source: 'ecomdrive' }, 5000);
    audit('stock.check', `Total Stock Value ${fmt(prev)} → ${fmt(it.balance)} from EcomDrive ${data.section || ''}`);
    if (!window.__holdSnap) {
      try { await snapshot('ecomdrive'); } catch (err) { window.__cloudErr = err.message || window.__cloudErr; }
    }
    window.__stockMsg = `Total stock value ${fmt(it.balance)} · qty ${data.stockQty ?? '—'} · ${data.products ?? '—'} products · Live Sheet updated`;
    if (window.__cloudErr && !quiet) toast('Stock ok · cloud slow/failed, kept on this device');
    else if (!quiet) toast('Total stock value updated on the Live Sheet');
  } catch (err) {
    window.__stockErr = err.message;
    window.__stockMsg = '';
    if (!quiet) toast(err.message);
  } finally {
    window.__stockBusy = false;
    if (!quiet) render(true);
  }
}
const REPORT_FIELDS = [['Shipped', 'Ecomdrive · Shipped'], ['Pending', 'Ecomdrive · Pending'], ['RTS', 'Ecomdrive · RTS'], ['Pending Return', 'Ecomdrive · Pending Return']];
const DELIVERY_FIELDS = [['Shipped', 'Ecomdrive · Shipped delivery'], ['Pending', 'Ecomdrive · Pending delivery'], ['RTS', 'Ecomdrive · RTS delivery'], ['Pending Return', 'Ecomdrive · Pending Return delivery']];
async function saveMetricAmount(name, m, now) {
  let it = S.items.find(i => !i.archived && i.group === 'metric' && i.name === name);
  if (!it) {
    const seed = { name, group: 'metric', currency: cfg().base, balance: m, prev: m, opening: m, include: true, archived: false, order: S.items.length, updatedAt: now, source: 'ecomdrive', status: 'auto' };
    const id = await cloudAdd('items', seed, 5000);
    it = S.items.find(i => i.id === id) || { id: id || localId(), ...seed };
    if (!S.items.some(x => x.id === it.id)) S.items.push(it);
  } else if ((it.balance || 0) !== m) {
    it.prev = it.balance || 0;
    it.balance = m;
  }
  it.updatedAt = now;
  it.source = 'ecomdrive';
  await cloudSet('items', it.id, { prev: it.prev, balance: it.balance, updatedAt: now, source: 'ecomdrive' }, 5000);
  return it;
}
async function checkEcomdriveReport(quiet) {
  if (window.__reportBusy) return 'busy';
  window.__reportBusy = true;
  window.__reportErr = '';
  window.__reportMsg = 'Checking EcomDrive report…';
  if (!quiet) render(true);
  try {
    const res = await api('/api/ecomdrive/report', { method: 'POST', timeoutMs: 120000 });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Report checker is not running. In the worker folder, run: node server.mjs');
    const now = new Date().toISOString();
    const metrics = data.metrics;
    if (!metrics || typeof metrics !== 'object') throw new Error('EcomDrive report did not return the sales fields. Previous amounts were kept.');
    const bits = [];
    const missing = [];
    for (const [label, name] of REPORT_FIELDS) {
      const row = metrics[label];
      const m = toMinor(row?.revenue);
      if (m === null) { missing.push(label); bits.push(`${label} kept previous`); continue; }
      await saveMetricAmount(name, m, now);
      bits.push(`${label} ${fmt(m)} (${row.orders ?? 0})`);
    }
    for (const [label, name] of DELIVERY_FIELDS) {
      const row = metrics[label];
      const m = toMinor(row?.delivery);
      if (m === null) { missing.push(label + ' delivery'); bits.push(`${label} delivery kept previous`); continue; }
      const neg = m === 0 ? 0 : -Math.abs(m);
      await saveMetricAmount(name, neg, now);
      bits.push(`${label} delivery ${fmt(neg)}`);
    }
    if (missing.length && missing.length === REPORT_FIELDS.length + DELIVERY_FIELDS.length) {
      throw new Error('EcomDrive report fields were empty. Previous amounts were kept.');
    }
    audit('report.check', 'EcomDrive All: ' + bits.join(', '));
    if (!window.__holdSnap) {
      try { await snapshot('ecomdrive'); } catch (err) { window.__cloudErr = err.message || window.__cloudErr; }
    }
    const nets = REPORT_FIELDS.map(([, name]) => {
      const it = S.items.find(i => !i.archived && i.name === name);
      return it ? `${name.replace('Ecomdrive · ', '')} on sheet ${fmt(sheetSaleNow(it))}` : '';
    }).filter(Boolean);
    window.__reportMsg = `All filter · ${bits.join(' · ')} · ${nets.join(' · ')} · delivery off first, then COD${missing.length ? ' · kept previous for ' + missing.join(', ') : ''}`;
    if (!quiet) toast('EcomDrive report updated');
  } catch (err) {
    window.__reportErr = err.message;
    window.__reportMsg = '';
    if (!quiet) toast(err.message);
  } finally {
    window.__reportBusy = false;
    if (!quiet) render(true);
  }
}
function sameName(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}
function isUsdtDue(it) {
  const n = String(it?.name || '').trim().toLowerCase();
  return n === 'usdt due' || n === 'usd due' || n === 'usd due / other due' || n === 'usdt-due';
}
const USDT_DUE_ID = 'usdt-due';
function pickBestUsdtDue(rows) {
  const list = (rows || []).filter(i => i && (i.id === USDT_DUE_ID || isUsdtDue(i)));
  if (!list.length) return null;
  return [...list].sort((a, b) => {
    const ab = Math.abs(Number(a.balance) || 0), bb = Math.abs(Number(b.balance) || 0);
    if (ab !== bb) return bb - ab;
    return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  })[0];
}
/** Manual USDT supplier — keep balance/prev; never re-seed zeros over a real amount. */
async function ensureUsdtDue() {
  if (!LOADED.items) return;
  const mirrored = readLocalMirror('items');
  const best = pickBestUsdtDue([...(S.items || []), ...mirrored]);
  const now = new Date().toISOString();
  if (best) {
    const bal = Number(best.balance) || 0;
    // If history was wiped (prev 0 but balance set), treat current as baseline — don't show fake ▲ from 0.
    const prevKeep = (best.prev != null && Number(best.prev) !== 0) ? Number(best.prev) : bal;
    const row = {
      name: 'USDT DUE',
      group: 'supplier',
      currency: best.currency || cfg().base,
      balance: bal,
      prev: prevKeep,
      opening: best.opening != null ? best.opening : bal,
      include: best.include !== false,
      archived: false,
      order: best.order ?? S.items.length,
      updatedAt: now,
      source: 'manual',
      status: 'manual',
      externalId: '',
      category: best.category || ''
    };
    // Drop duplicate USDT rows (old l* copies) so cloud zeros cannot win later.
    S.items = S.items.filter(i => !(i.id === USDT_DUE_ID || isUsdtDue(i)) || i.id === USDT_DUE_ID);
    let found = S.items.find(i => i.id === USDT_DUE_ID);
    if (!found) {
      found = { id: USDT_DUE_ID, ...row };
      S.items.push(found);
    } else Object.assign(found, row);
    await cloudSet('items', USDT_DUE_ID, row, 6000);
    try {
      const key = 'hisab_items';
      const rows = JSON.parse(localStorage.getItem(key) || '[]').filter(r => !(r.id === USDT_DUE_ID || isUsdtDue(r)) || r.id === USDT_DUE_ID);
      const i = rows.findIndex(r => r.id === USDT_DUE_ID);
      if (i < 0) rows.push({ id: USDT_DUE_ID, ...row });
      else rows[i] = { id: USDT_DUE_ID, ...rows[i], ...row };
      localStorage.setItem(key, JSON.stringify(rows));
    } catch { /* ignore */ }
  } else {
    const seed = {
      name: 'USDT DUE',
      group: 'supplier',
      currency: cfg().base,
      balance: 0,
      prev: 0,
      opening: 0,
      include: true,
      archived: false,
      order: S.items.length,
      updatedAt: now,
      source: 'manual',
      status: 'manual',
      externalId: ''
    };
    await cloudSet('items', USDT_DUE_ID, seed, 6000);
    if (!S.items.some(x => x.id === USDT_DUE_ID)) S.items.push({ id: USDT_DUE_ID, ...seed });
  }
  if (!cfg().usdtDueReady) {
    let main = S.settings.find(x => x.id === 'main');
    if (!main) { main = { id: 'main' }; S.settings.push(main); }
    main.usdtDueReady = true;
    await cloudSet('settings', 'main', { usdtDueReady: true }, 5000);
  }
}
const ACCOUNT_MATCH = [
  ['bkash', /bkash|b-kash/i],
  ['nagad', /nagad/i],
  ['dbbl', /dbbl|dutch-bangla/i],
  ['eps', /\beps\b/i],
  ['pathao', /pathao\s*pay/i],
  ['pubali', /pubali/i]
];
function accountKey(name) {
  const hit = ACCOUNT_MATCH.find(([, re]) => re.test(String(name || '')));
  return hit ? hit[0] : '';
}
function findCashAccount(keyOrName, externalId) {
  const cash = S.items.filter(i => !i.archived && i.group === 'cash');
  const prefer = list => {
    if (!list.length) return null;
    return [...list].sort((a, b) => {
      const al = String(a.id || '').startsWith('l') ? 1 : 0;
      const bl = String(b.id || '').startsWith('l') ? 1 : 0;
      if (al !== bl) return al - bl;
      const ae = a.externalId ? 0 : 1, be = b.externalId ? 0 : 1;
      if (ae !== be) return ae - be;
      return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
    })[0];
  };
  if (externalId) {
    const byId = cash.filter(i => i.externalId === externalId);
    if (byId.length) return prefer(byId);
    const byDoc = cash.find(i => i.id === ('ea_' + externalId));
    if (byDoc) return byDoc;
  }
  const byName = cash.filter(i => sameName(i.name, keyOrName));
  if (byName.length) return prefer(byName);
  const key = accountKey(keyOrName);
  if (!key) return null;
  const loose = cash.filter(i => accountKey(i.name) === key && (!externalId || !i.externalId || i.externalId === externalId));
  return prefer(loose);
}
/** Same logical cash wallet → archive extras (cloud timeout / local mirror often creates doubles). */
async function mergeDuplicateCashAccounts() {
  const cash = S.items.filter(i => !i.archived && i.group === 'cash');
  const buckets = new Map();
  for (const it of cash) {
    let k;
    if (it.externalId) k = 'ext:' + it.externalId;
    else {
      const ak = accountKey(it.name);
      k = ak ? 'key:' + ak : 'name:' + String(it.name || '').trim().toLowerCase();
    }
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(it);
  }
  // Fold SMS-style key:bkash into whatever already has externalId + same accountKey
  for (const [k, list] of [...buckets.entries()]) {
    if (!k.startsWith('key:')) continue;
    const ak = k.slice(4);
    const host = [...buckets.entries()].find(([hk, xs]) => hk.startsWith('ext:') && xs.some(x => accountKey(x.name) === ak));
    if (!host) continue;
    host[1].push(...list);
    buckets.delete(k);
  }
  // Same display name without shared key/ext still counts as one row
  const byName = new Map();
  for (const it of cash) {
    const nm = String(it.name || '').trim().toLowerCase();
    if (!nm) continue;
    if (!byName.has(nm)) byName.set(nm, []);
    byName.get(nm).push(it);
  }
  for (const list of byName.values()) {
    if (list.length < 2) continue;
    const ids = new Set(list.map(i => i.id));
    let merged = false;
    for (const [, xs] of buckets) {
      if (xs.some(x => ids.has(x.id))) {
        for (const it of list) if (!xs.some(x => x.id === it.id)) xs.push(it);
        merged = true;
        break;
      }
    }
    if (!merged) buckets.set('name:' + String(list[0].name).trim().toLowerCase(), list.slice());
  }
  let removed = 0;
  const now = new Date().toISOString();
  for (const list of buckets.values()) {
    const uniq = [];
    const seen = new Set();
    for (const it of list) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      uniq.push(it);
    }
    if (uniq.length < 2) continue;
    uniq.sort((a, b) => {
      const al = String(a.id || '').startsWith('l') ? 1 : 0;
      const bl = String(b.id || '').startsWith('l') ? 1 : 0;
      if (al !== bl) return al - bl;
      const as = String(a.id || '').startsWith('ea_') ? 0 : 1;
      const bs = String(b.id || '').startsWith('ea_') ? 0 : 1;
      if (as !== bs) return as - bs;
      const ae = a.externalId ? 0 : 1, be = b.externalId ? 0 : 1;
      if (ae !== be) return ae - be;
      return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
    });
    const keep = uniq[0];
    for (const dup of uniq.slice(1)) {
      if (keep.externalId && !dup.externalId) { /* absorb */ }
      else if (!keep.externalId && dup.externalId) keep.externalId = dup.externalId;
      dup.archived = true;
      dup.updatedAt = now;
      if (String(dup.id || '').startsWith('l')) {
        S.items = S.items.filter(x => x.id !== dup.id);
        try { await A.del('items', dup.id); } catch { /* local-only */ }
        try {
          const key = 'hisab_items';
          const rows = JSON.parse(localStorage.getItem(key) || '[]').filter(x => x.id !== dup.id);
          localStorage.setItem(key, JSON.stringify(rows));
        } catch { /* ignore */ }
      } else {
        await cloudSet('items', dup.id, { archived: true, updatedAt: now }, 4000);
      }
      removed++;
    }
  }
  return removed;
}
async function checkEcomdriveSuppliers(quiet) {
  if (window.__supBusy) return 'busy';
  window.__supBusy = true;
  window.__supErr = '';
  window.__supMsg = 'Syncing active suppliers…';
  if (!quiet) render(true);
  try {
    const res = await api('/api/ecomdrive/suppliers', { method: 'POST', timeoutMs: 120000 });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Supplier sync is not running. In the worker folder, run: node server.mjs');
    const rows = data.suppliers || [];
    const now = new Date().toISOString();
    let order = S.items.length;
    let changed = 0;
    for (const s of rows) {
      const m = toMinor(s.due);
      if (m === null) throw new Error('Invalid due for ' + s.name);
      const stableId = 'es_' + String(s.id);
      let it = S.items.find(i => !i.archived && i.group === 'supplier' && !isUsdtDue(i) && (i.externalId === s.id || i.id === stableId || sameName(i.name, s.name)));
      if (!it) {
        // First time only: prev = balance so Previous is not a fake zero wipe.
        const seed = { name: s.name, group: 'supplier', currency: cfg().base, balance: m, prev: m, opening: m, include: true, archived: false, order: order++, dueDate: s.dueDate || '', externalId: s.id, updatedAt: now, source: 'ecomdrive', status: 'auto' };
        await cloudSet('items', stableId, seed, 6000);
        it = { id: stableId, ...seed };
        if (!S.items.some(x => x.id === it.id)) S.items.push(it);
        changed++;
      } else {
        const prevBal = it.balance || 0;
        it.name = s.name;
        it.dueDate = s.dueDate || '';
        it.externalId = s.id;
        it.updatedAt = now;
        it.source = 'ecomdrive';
        it.archived = false;
        if (prevBal !== m) {
          it.prev = prevBal;
          it.balance = m;
          changed++;
        }
        await cloudSet('items', it.id, {
          name: s.name, prev: it.prev, balance: it.balance, dueDate: s.dueDate || '',
          externalId: s.id, updatedAt: now, source: 'ecomdrive', archived: false, group: 'supplier'
        }, 6000);
      }
    }
    // Do NOT zero suppliers missing from this pull — keep last known due (USDT DUE / manual stay untouched).
    audit('supplier.sync', rows.map(s => s.name + ' ' + s.due).join(', '));
    let sheetNote = window.__holdSnap ? 'sheet row after Calculate' : 'Live Sheet updated';
    if (!window.__holdSnap) {
      try { await snapshot('ecomdrive'); }
      catch (err) { sheetNote = 'numbers updated (sheet cloud save failed)'; window.__cloudErr = err.message || window.__cloudErr; }
    }
    const total = rows.reduce((n, s) => n + (toMinor(s.due) || 0), 0);
    window.__supMsg = `${rows.length} active · due ${fmt(total)} · ${changed} balance update(s) · ${sheetNote}`;
    if (window.__cloudErr && !quiet) toast('Suppliers ok · cloud slow/failed, kept on this device');
    else if (!quiet) toast('Supplier dues updated — previous kept');
  } catch (err) {
    window.__supErr = err.message;
    window.__supMsg = '';
    if (!quiet) toast(err.message);
  } finally {
    window.__supBusy = false;
    if (!quiet) render(true);
  }
}
const PAYMENT_CYCLE = {
  'Steadfast · Unpaid amount': { key: 'steadfast', role: 'open' },
  'Steadfast · Last paid amount': { key: 'steadfast', role: 'paid' },
  'Pathao · Last processing': { key: 'pathao', role: 'open' },
  'Pathao · Last paid': { key: 'pathao', role: 'paid' }
};
function decidePayment(prev, open, paid) {
  prev = prev || {};
  const openId = open?.id || '';
  const paidId = paid?.id || '';
  const dismissedOpen = prev.dismissedState !== 'paid' && prev.dismissedId && prev.dismissedId === openId;
  const dismissedPaid = prev.dismissedState === 'paid' && prev.dismissedId === paidId;
  if (openId && !dismissedOpen) {
    return { count: 'open', watch: { id: openId, state: open.state || 'unpaid', dismissedId: prev.dismissedId || '', dismissedState: prev.dismissedState || '' } };
  }
  const wasOpen = prev.id && prev.state && prev.state !== 'paid';
  if (paidId && wasOpen && !dismissedPaid && (!openId || openId !== prev.id)) {
    return { count: 'paid', watch: { id: paidId, state: 'paid', dismissedId: '', dismissedState: '' } };
  }
  if (paidId && prev.id === paidId && prev.state === 'paid' && !dismissedPaid) {
    return { count: 'paid', watch: { ...prev, id: paidId, state: 'paid', dismissedId: '', dismissedState: '' } };
  }
  if (paidId && !prev.id && !prev.dismissedId) {
    return { count: 'paid', watch: { id: paidId, state: 'paid', dismissedId: '', dismissedState: '' } };
  }
  return { count: 'none', watch: prev };
}
function withTimeout(promise, ms, label) {
  let t;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(label || ('Timed out after ' + Math.round(ms / 1000) + 's'))), ms); })
  ]);
}
function localId() {
  return 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
/** Firestore rejects undefined; strip it before every write. */
function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out[k] = scrub(v);
    }
    return out;
  }
  return value;
}
function mirrorLocal(col, id, data) {
  try {
    const key = 'hisab_' + col;
    const rows = JSON.parse(localStorage.getItem(key) || '[]');
    const i = rows.findIndex(x => x.id === id);
    if (i < 0) rows.push({ id, ...data });
    else rows[i] = { ...rows[i], ...data };
    localStorage.setItem(key, JSON.stringify(rows));
  } catch { /* memory copy in S is enough for this session */ }
}
/** Offline / timed-out cloud writes land here — must be read back on boot (S starts empty). */
function readLocalMirror(col) {
  try {
    const rows = JSON.parse(localStorage.getItem('hisab_' + col) || '[]');
    return Array.isArray(rows) ? rows : [];
  } catch { return []; }
}
function mergeMemAndMirror(col) {
  const byId = new Map();
  for (const r of readLocalMirror(col)) if (r?.id) byId.set(r.id, r);
  for (const r of (S[col] || [])) if (r?.id) byId.set(r.id, r); // in-memory wins
  return [...byId.values()];
}
function itemLogicKey(it) {
  if (!it || it.archived) return null;
  if (it.id === USDT_DUE_ID || isUsdtDue(it)) return 'supplier:usdt-due';
  if (it.externalId === 'dollar-main' || /^dollar$/i.test(String(it.name || ''))) return 'cash:dollar';
  // Cash wallets: match by bank key so ea_* + old l* / random ids collapse (not by externalId alone).
  const ak = accountKey(it.name);
  if (ak && (it.group === 'cash' || !it.group)) return 'cash:key:' + ak;
  if (it.group === 'cash' && it.externalId) return 'cash:ext:' + it.externalId;
  if (it.externalId) return (it.group || 'x') + ':ext:' + it.externalId;
  if (it.group === 'courier' || String(it.name || '').startsWith('Steadfast') || String(it.name || '').startsWith('Pathao')) {
    return 'courier:name:' + String(it.name || '').trim().toLowerCase();
  }
  return (it.group || '') + ':name:' + String(it.name || '').trim().toLowerCase();
}
/** Live Sheet column order: Accounts → Courier → Stock → Ecom metrics → Expenses → Supplier dues → Owner. */
const SHEET_GROUP_ORDER = ['cash', 'courier', 'stock', 'otherAsset', 'metric', 'expense', 'supplier', 'otherLiab', 'owner'];
function cashSheetRank(it) {
  if (it.externalId === 'dollar-main' || /^dollar$/i.test(String(it.name || ''))) return 900;
  const key = accountKey(it.name);
  const order = ['bkash', 'nagad', 'dbbl', 'eps', 'pathao', 'pubali'];
  const i = order.indexOf(key);
  return i >= 0 ? i : 50;
}
function courierSheetRank(name) {
  const steads = [
    'Steadfast · Balance',
    'Steadfast · Awaiting approval',
    'Steadfast · Approval pending COD delivery charge',
    'Steadfast · On the way',
    'Steadfast · Unpaid amount',
    'Steadfast · Last paid amount'
  ];
  const paths = [
    'Pathao · Upcoming payment',
    'Pathao · In review',
    'Pathao · Last processing',
    'Pathao · Last paid'
  ];
  const n = String(name || '');
  let i = steads.indexOf(n); if (i >= 0) return i;
  i = paths.indexOf(n); if (i >= 0) return 100 + i;
  if (n.startsWith('Steadfast')) return 50;
  if (n.startsWith('Pathao')) return 150;
  return 200;
}
function supplierSheetRank(it) {
  if (it.id === USDT_DUE_ID || isUsdtDue(it)) return 900; // after EcomDrive suppliers
  return 0;
}
function metricSheetRank(name) {
  const mOrder = ['Ecomdrive · Shipped', 'Ecomdrive · Pending', 'Ecomdrive · RTS', 'Ecomdrive · Pending Return'];
  const i = mOrder.indexOf(name);
  return i >= 0 ? i : 50;
}
function sheetColumnItems() {
  let items = collapseActiveItemDupes(
    S.items.filter(i => !i.archived && i.include !== false && !ECOM_FEE.has(i.name))
  );
  // Heal missing group so orphans sort with the right block.
  for (const it of items) {
    if (it.group) continue;
    if (it.id === USDT_DUE_ID || isUsdtDue(it)) it.group = 'supplier';
    else if (accountKey(it.name) || it.externalId === 'dollar-main') it.group = 'cash';
    else if (String(it.name || '').startsWith('Steadfast') || String(it.name || '').startsWith('Pathao')) it.group = 'courier';
    else if (ECOM_SALE.has(it.name) || String(it.name || '').startsWith('Ecomdrive')) it.group = 'metric';
    else if (it.name === 'Total Stock Value') it.group = 'stock';
  }
  items.sort((a, b) => {
    const ga = SHEET_GROUP_ORDER.indexOf(a.group);
    const gb = SHEET_GROUP_ORDER.indexOf(b.group);
    const ra = ga < 0 ? 99 : ga, rb = gb < 0 ? 99 : gb;
    if (ra !== rb) return ra - rb;
    if (a.group === 'cash') {
      const ca = cashSheetRank(a), cb = cashSheetRank(b);
      if (ca !== cb) return ca - cb;
    } else if (a.group === 'courier') {
      const ca = courierSheetRank(a.name), cb = courierSheetRank(b.name);
      if (ca !== cb) return ca - cb;
    } else if (a.group === 'supplier') {
      const ca = supplierSheetRank(a), cb = supplierSheetRank(b);
      if (ca !== cb) return ca - cb;
    } else if (a.group === 'metric') {
      const ca = metricSheetRank(a.name), cb = metricSheetRank(b.name);
      if (ca !== cb) return ca - cb;
    }
    const oa = a.order ?? 0, ob = b.order ?? 0;
    if (oa !== ob) return oa - ob;
    return String(uiName(a.name) || '').localeCompare(String(uiName(b.name) || ''), undefined, { sensitivity: 'base' });
  });
  return items;
}
function preferItemRow(a, b) {
  // USDT: never prefer an empty stable id over a local row that still has the due amount.
  if (a.id === USDT_DUE_ID || b.id === USDT_DUE_ID || isUsdtDue(a) || isUsdtDue(b)) {
    const ab = Math.abs(Number(a.balance) || 0), bb = Math.abs(Number(b.balance) || 0);
    if (ab !== bb) return ab > bb ? a : b;
  }
  // Prefer newest Count / balance edit so a Count-off clone is not hidden by an older Count-on copy.
  const tu = String(a.updatedAt || '').localeCompare(String(b.updatedAt || ''));
  if (tu) return tu > 0 ? a : b;
  // Same timestamp: Count-off wins (stale sync clones often leave include:true behind).
  if (a.include === false && b.include !== false) return a;
  if (b.include === false && a.include !== false) return b;
  const al = String(a.id || '').startsWith('l') ? 1 : 0;
  const bl = String(b.id || '').startsWith('l') ? 1 : 0;
  if (al !== bl) return al < bl ? a : b;
  const as = String(a.id || '').startsWith('ea_') || String(a.id || '').startsWith('es_') ? 0 : 1;
  const bs = String(b.id || '').startsWith('ea_') || String(b.id || '').startsWith('es_') ? 0 : 1;
  if (as !== bs) return as < bs ? a : b;
  return a;
}
function preferNewerItem(cloud, local) {
  if (!local) return cloud;
  if (!cloud) return local;
  const lu = String(local.updatedAt || ''), cu = String(cloud.updatedAt || '');
  if (lu > cu) return { ...cloud, ...local, id: cloud.id || local.id };
  // Stale/empty cloud usdt-due must not wipe a local amount (common when FB only has the seed).
  if ((cloud.id === USDT_DUE_ID || isUsdtDue(cloud) || isUsdtDue(local))
    && (Number(cloud.balance) || 0) === 0 && (Number(local.balance) || 0) !== 0) {
    return {
      ...cloud,
      ...local,
      id: USDT_DUE_ID,
      name: 'USDT DUE',
      group: 'supplier',
      source: 'manual',
      status: 'manual',
      externalId: '',
      archived: false
    };
  }
  if (lu && !cu) return { ...cloud, ...local, id: cloud.id || local.id };
  return cloud;
}
/** Cloud timeouts create many l* copies of the same account — collapse for display only (mirror kept). */
function collapseActiveItemDupes(rows) {
  const out = [];
  const best = new Map();
  for (const it of rows) {
    const k = itemLogicKey(it);
    if (!k) { out.push(it); continue; }
    const prev = best.get(k);
    if (!prev) best.set(k, it);
    else best.set(k, preferItemRow(prev, it));
  }
  out.push(...best.values());
  return out;
}
function sheetPurgedAt() {
  try { return Number(localStorage.getItem('hisab_sheet_purged_at') || 0) || 0; } catch { return 0; }
}
function snapAfterPurge(r, cut) {
  const t = Date.parse(r?.ts || '') || 0;
  return t >= cut - 2000;
}
function persistSnapshotMirror(rows) {
  try { localStorage.setItem('hisab_snapshots', JSON.stringify(rows || [])); } catch { /* ignore */ }
}
/** Cloud timeout often saves a local l* copy of the same open row — keep one. */
function collapseDupOpenSnaps(rows) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  const opens = list.filter(s => s?.source === 'open');
  if (opens.length < 2) return list;
  opens.sort((a, b) => {
    const al = String(a.id || '').startsWith('l') ? 1 : 0;
    const bl = String(b.id || '').startsWith('l') ? 1 : 0;
    if (al !== bl) return al - bl;
    return String(b.ts || '').localeCompare(String(a.ts || ''));
  });
  const keep = opens[0];
  const drop = new Set(opens.slice(1).map(s => s.id));
  return list.filter(s => !drop.has(s.id));
}
function keepLocalRows(col, cloudRows) {
  // S is empty on first onSnapshot; without the localStorage mirror, a sparse/empty
  // Firestore reply looks like a full wipe even though hisab_* still has the shop books.
  let local = mergeMemAndMirror(col);
  if (col === 'snapshots' && (window.__purgeSnapshots || sheetPurgedAt())) {
    // After Clear Live Sheet: only keep rows created at/after the purge (fresh start).
    // Union cloud + post-purge local so an empty mid-flight snapshot cannot drop the new open row.
    const cut = sheetPurgedAt() || Date.now();
    local = local.filter(r => snapAfterPurge(r, cut));
    cloudRows = cloudRows.filter(r => snapAfterPurge(r, cut));
    const cloudIds = new Set(cloudRows.map(r => r.id));
    const pending = local.filter(r => r?.id && !cloudIds.has(r.id));
    const merged = collapseDupOpenSnaps(pending.length ? cloudRows.concat(pending) : cloudRows.slice());
    persistSnapshotMirror(merged);
    return merged;
  }
  if (col !== 'items') {
    const cloudIds = new Set(cloudRows.map(r => r.id));
    const cloudEmpty = cloudRows.length === 0;
    const pending = local.filter(r => {
      if (cloudIds.has(r.id)) return false;
      if (String(r.id || '').startsWith('l')) return true;
      // Cloud collection empty/wiped but this browser still has the history — restore it.
      if (cloudEmpty) return true;
      return false;
    });
    return pending.length ? cloudRows.concat(pending) : cloudRows;
  }
  const localById = new Map(local.filter(r => r?.id).map(r => [r.id, r]));
  // Same id: merge so empty/stale cloud usdt-due cannot erase a local balance.
  const base = cloudRows.map(c => preferNewerItem(c, localById.get(c.id)));
  const cloudIds = new Set(base.map(r => r.id));
  const cloudExt = new Set(base.map(r => r.externalId).filter(Boolean));
  const cloudCash = base.filter(r => r.group === 'cash' && !r.archived);
  const cloudSparse = cloudRows.length <= 2; // e.g. only usdt-due left in Firebase
  const cloudHasUsdt = base.some(r => r.id === USDT_DUE_ID || isUsdtDue(r));
  // Keep rows Firebase snapshot dropped — but never a second copy of the same cash account / externalId.
  const pending = local.filter(r => {
    if (cloudIds.has(r.id)) return false;
    if (r.externalId && cloudExt.has(r.externalId)) return false;
    if (r.group === 'cash' && !r.archived) {
      const key = accountKey(r.name);
      if (cloudCash.some(c =>
        sameName(c.name, r.name) ||
        (key && accountKey(c.name) === key && (!r.externalId || !c.externalId || r.externalId === c.externalId))
      )) return false;
    }
    // Extra USDT copies (l*) — still keep so collapse can pick the non-zero balance.
    if (r.id === USDT_DUE_ID || isUsdtDue(r)) return true;
    if (String(r.id || '').startsWith('l')) return true;
    if (r.externalId === 'dollar-main' && !cloudExt.has('dollar-main')) return true;
    if (r.group === 'supplier' && (r.source === 'manual' || !r.externalId)) return true;
    if (r.source === 'manual' && !r.externalId) return true;
    if (r.externalId && !cloudExt.has(r.externalId)) return true;
    // Sparse cloud + non-local ids still on disk (older mirrors / partial uploads)
    if (cloudSparse) return true;
    return false;
  });
  let merged = pending.length ? base.concat(pending) : base;
  if (!cloudHasUsdt) {
    const usdt = pickBestUsdtDue(local);
    if (usdt && !merged.some(r => r.id === USDT_DUE_ID || isUsdtDue(r))) {
      merged = merged.concat([{ ...usdt, id: USDT_DUE_ID, name: 'USDT DUE', source: 'manual', status: 'manual', externalId: '', archived: false }]);
    }
  }
  merged = collapseActiveItemDupes(merged);
  // Canonicalize USDT DUE in the live list + disk mirror (prev baseline if history was wiped).
  const usdtBest = pickBestUsdtDue(merged);
  if (usdtBest) {
    const bal = Number(usdtBest.balance) || 0;
    const prev = (usdtBest.prev != null && Number(usdtBest.prev) !== 0) ? Number(usdtBest.prev) : bal;
    const canon = {
      ...usdtBest,
      id: USDT_DUE_ID,
      name: 'USDT DUE',
      group: 'supplier',
      balance: bal,
      prev,
      source: 'manual',
      status: 'manual',
      externalId: '',
      archived: false
    };
    merged = merged.filter(r => !(r.id === USDT_DUE_ID || isUsdtDue(r))).concat([canon]);
    try {
      const key = 'hisab_items';
      const rows = JSON.parse(localStorage.getItem(key) || '[]')
        .filter(r => !(r.id === USDT_DUE_ID || isUsdtDue(r)));
      rows.push(canon);
      localStorage.setItem(key, JSON.stringify(rows));
    } catch { /* ignore */ }
  }
  return merged;
}
async function cloudSet(col, id, data, ms = 5000) {
  const clean = scrub(data);
  // Always refresh disk mirror so boot hydrate keeps manual balances (USDT DUE, etc.).
  mirrorLocal(col, id, clean);
  // Keep in-memory S in sync when Firebase listeners are dead (cfg()/tick need lastCalcAt).
  const rows = S[col];
  if (Array.isArray(rows)) {
    const i = rows.findIndex(x => x.id === id);
    if (i < 0) rows.push({ id, ...clean });
    else rows[i] = { ...rows[i], ...clean };
  }
  if (window.__cloudDown) return false;
  try {
    await withTimeout(A.set(col, id, clean), ms, 'Cloud save timed out');
    return true;
  } catch (err) {
    window.__cloudErr = err.message || 'Cloud save failed';
    window.__cloudDown = /timed out/i.test(window.__cloudErr);
    mirrorLocal(col, id, clean);
    return false;
  }
}
async function cloudAdd(col, data, ms = 5000) {
  const clean = scrub(data);
  if (window.__cloudDown) {
    const id = localId();
    mirrorLocal(col, id, clean);
    if (Array.isArray(S[col]) && !S[col].some(x => x.id === id)) S[col].push({ id, ...clean });
    return id;
  }
  try {
    return await withTimeout(A.add(col, clean), ms, 'Cloud save timed out');
  } catch (err) {
    window.__cloudErr = err.message || 'Cloud save failed';
    window.__cloudDown = /timed out/i.test(window.__cloudErr);
    const id = localId();
    mirrorLocal(col, id, clean);
    if (Array.isArray(S[col]) && !S[col].some(x => x.id === id)) S[col].push({ id, ...clean });
    return id;
  }
}
async function rememberPayment(key, watch) {
  const paymentWatch = { ...(cfg().paymentWatch || {}), [key]: watch };
  let main = S.settings.find(x => x.id === 'main');
  if (!main) { main = { id: 'main' }; S.settings.push(main); }
  main.paymentWatch = paymentWatch;
  await cloudSet('settings', 'main', { paymentWatch }, 6000);
}
async function settlementInvoices(timeoutMs = 120000) {
  const res = await api('/api/ecomdrive/courier-history', { method: 'POST', timeoutMs });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Courier settlement history did not load');
  return data.invoices || [];
}
function calcStepDetail(name, detail) {
  const step = (window.__calcSteps || []).find(s => s.name === name && s.status === 'run');
  if (!step) return;
  step.detail = detail || '';
  window.__calcMsg = detail ? (name + ' · ' + detail) : ('Checking ' + name + '…');
  paintCalcProgress();
}
function sameMoney(a, b) {
  const n = v => {
    if (v == null || v === '') return null;
    const x = Number(String(v).replace(/[,৳\s]/g, ''));
    return Number.isFinite(x) ? x.toFixed(2) : null;
  };
  const x = n(a), y = n(b);
  return x != null && x === y;
}
/** EcomDrive often stores "Statement SFC-32895395"; Steadfast payments use "SFC-32895395". */
function normalizeSettleId(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return '';
  const sfc = s.match(/sfc-\d+/);
  if (sfc) return sfc[0];
  return s.replace(/^statement\s+/i, '').trim();
}
function countLastPaid(invoices, payment, courier) {
  const id = normalizeSettleId(payment?.id);
  if (!id && (payment?.amount == null || payment?.amount === '')) return false;
  const kind = String(courier || '').toLowerCase();
  const hit = (invoices || []).some(row => {
    const type = String(row.courier || '').toLowerCase();
    if (kind && !type.includes(kind)) return false;
    const rowId = normalizeSettleId(row.id);
    if (id && rowId && (rowId === id || rowId.includes(id) || id.includes(rowId))) return true;
    // Deposited can differ from Steadfast "receive"; also try collected/total.
    return sameMoney(payment?.amount, row.deposited)
      || sameMoney(payment?.amount, row.collected);
  });
  return !hit;
}
function isCountOff(name) {
  return !!(cfg().countOff || {})[String(name || '')];
}
async function rememberCountOff(name, off) {
  const countOff = { ...(cfg().countOff || {}) };
  if (off) countOff[name] = true;
  else delete countOff[name];
  let main = S.settings.find(x => x.id === 'main');
  if (!main) { main = { id: 'main' }; S.settings.push(main); }
  main.countOff = countOff;
  await cloudSet('settings', 'main', { countOff }, 5000);
}
/** Count off is sticky in settings — Steadfast/Pathao sync must not turn the tick back on. */
function courierCounted(name, item, syncDefault) {
  if (isCountOff(name)) return false;
  if (PAYMENT_CYCLE[name]) return !!syncDefault;
  if (item && item.include === false) return false;
  if (item) return item.include !== false;
  return syncDefault !== false;
}
async function saveCourierAmount(name, category, source, raw, note, include, paymentId, paymentState) {
  const m = toMinor(raw);
  if (m === null) throw new Error('Missing ' + name);
  const now = new Date().toISOString();
  // Pull every same-name courier clone from memory + disk (cloud timeouts leave many l* copies).
  const byId = new Map();
  for (const i of S.items) {
    if (!i?.archived && i.group === 'courier' && sameName(i.name, name) && i.id) byId.set(i.id, i);
  }
  for (const i of readLocalMirror('items')) {
    if (!i?.archived && i.group === 'courier' && sameName(i.name, name) && i.id && !byId.has(i.id)) {
      byId.set(i.id, i);
      if (!S.items.some(x => x.id === i.id)) S.items.push(i);
    }
  }
  const clones = [...byId.values()];
  // Prefer a Count-off clone / newest so sync does not revive an old Count-on duplicate.
  let it = clones.slice().sort((a, b) => {
    if (a.include === false && b.include !== false) return -1;
    if (b.include === false && a.include !== false) return 1;
    return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  })[0] || null;
  const counted = courierCounted(name, it, include);
  if (!it) {
    const seed = { name, group: 'courier', category, currency: cfg().base, balance: m, prev: m, opening: m, include: counted, archived: false, order: S.items.length, updatedAt: now, source, status: 'auto', paymentId: paymentId || '', paymentState: paymentState || '' };
    const id = await cloudAdd('items', seed, 6000);
    it = S.items.find(i => i.id === id);
    if (!it) {
      it = { id: id || localId(), ...seed };
      S.items.push(it);
    }
    clones.push(it);
  } else if ((it.balance || 0) !== m) {
    it.prev = it.balance || 0;
    it.balance = m;
  }
  // Write the same Count/balance onto every duplicate row so the UI tick cannot bounce back.
  for (const row of clones) {
    if (row.id !== it.id && (row.balance || 0) !== m) {
      row.prev = row.balance || 0;
      row.balance = m;
    } else if (row.id === it.id) {
      /* balance already set */
    } else {
      row.balance = it.balance;
      row.prev = it.prev;
    }
    row.include = counted;
    row.paymentId = paymentId || '';
    row.paymentState = paymentState || '';
    row.updatedAt = now;
    row.source = source;
    row.category = category;
    row.name = name;
    await cloudSet('items', row.id, {
      name, prev: row.prev, balance: row.balance, include: counted,
      paymentId: paymentId || '', paymentState: paymentState || '',
      updatedAt: now, source, category, group: 'courier'
    }, 6000);
  }
  const sheet = name === AWAITING && codPct() ? ` → sheet ${fmt(afterCod(it.balance))}` : '';
  return `${name.replace(/^[^·]+ · /, '')} ${fmt(it.balance)}${sheet}${note ? ` (${note})` : ''}${counted ? '' : ' (count off)'}`;
}
async function checkSteadfast(quiet) {
  if (window.__sfBusy) return 'busy';
  window.__sfBusy = true;
  window.__sfErr = '';
  window.__sfMsg = 'Checking Steadfast…';
  if (!quiet) render(true);
  try {
    calcStepDetail('Steadfast', 'লগইন ও স্ট্যাটস…');
    const res = await api('/api/steadfast/stats', { method: 'POST', timeoutMs: 75000 });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Steadfast sync is not running. In the worker folder, run: node server.mjs');
    calcStepDetail('Steadfast', 'ক্লাউড সেভ…');
    const nowWatch = (cfg().paymentWatch || {}).steadfast || {};
    const decision = decidePayment(nowWatch, data.openPayment, data.paidPayment);
    await rememberPayment('steadfast', decision.watch);
    const paidRow = S.items.find(i => !i.archived && i.name === 'Steadfast · Last paid amount');
    let paidInclude = decision.count === 'paid';
    let paidNote = paidInclude ? 'counting last paid' : 'last payment not counted';
    try {
      calcStepDetail('Steadfast', 'সেটেলমেন্ট হিস্ট্রি…');
      paidInclude = countLastPaid(await settlementInvoices(quiet ? 45000 : 120000), data.paidPayment, 'steadfast');
      paidNote = paidInclude ? 'last paid is not in the last 30 days of settlement history, counted' : 'last paid is in the last 30 days of settlement history, not counted';
    } catch {
      paidInclude = paidRow ? paidRow.include !== false : paidInclude;
      paidNote = 'settlement history unavailable, last paid count unchanged';
    }
    calcStepDetail('Steadfast', 'সেভ…');
    const rows = [
      ['Steadfast · Balance', data.balance, null, true, '', ''],
      ['Steadfast · Awaiting approval', data.awaitingApproval, data.awaitingCount, true, '', ''],
      ['Steadfast · Approval pending COD delivery charge', data.approvalDeliveryCharge == null ? null : (String(data.approvalDeliveryCharge).startsWith('-') ? String(data.approvalDeliveryCharge) : '-' + String(data.approvalDeliveryCharge)), data.approvalDeliveryCount, true, '', ''],
      ['Steadfast · On the way', data.onTheWay, data.onTheWayCount, true, '', ''],
      ['Steadfast · Unpaid amount', data.unpaidAmount, null, decision.count === 'open', data.openPayment?.id || '', data.openPayment?.state || ''],
      ['Steadfast · Last paid amount', data.lastPaidAmount, data.lastPaidOn || null, paidInclude, data.paidPayment?.id || '', 'paid']
    ].filter(row => row[1] != null);
    const bits = [];
    for (const [name, raw, note, include, paymentId, paymentState] of rows) {
      bits.push(await saveCourierAmount(name, 'Steadfast', 'steadfast', raw, note, include, paymentId, paymentState));
    }
    audit('courier.steadfast', bits.join(', '));
    let sheetNote = 'Live Sheet updated';
    try {
      await snapshot('steadfast');
    } catch (err) {
      sheetNote = 'numbers updated (sheet cloud save failed)';
      window.__cloudErr = err.message || window.__cloudErr;
    }
    const counted = (decision.count === 'open' ? 'counting unpaid' : 'unpaid not counted') + ' · ' + paidNote;
    window.__sfMsg = `${bits.join(' · ')} · ${counted} · ${sheetNote}`;
    if (window.__cloudErr && !quiet) toast('Steadfast ok · cloud slow/failed, kept on this device');
    else if (!quiet) toast('Steadfast updated');
  } catch (err) {
    window.__sfErr = err.message;
    window.__sfMsg = '';
    if (!quiet) toast(err.message);
  } finally {
    window.__sfBusy = false;
    if (!quiet) render(true);
  }
}
async function checkPathao(quiet) {
  if (window.__ptBusy) return 'busy';
  window.__ptBusy = true;
  window.__ptErr = '';
  window.__ptMsg = 'Checking Pathao…';
  if (!quiet) render(true);
  try {
    const res = await api('/api/pathao/courier', { method: 'POST', timeoutMs: 90000 });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Pathao sync is not running. In the worker folder, run: node server.mjs');
    const decision = decidePayment((cfg().paymentWatch || {}).pathao || {}, data.openPayment, data.paidPayment);
    await rememberPayment('pathao', decision.watch);
    const paidRow = S.items.find(i => !i.archived && i.name === 'Pathao · Last paid');
    let paidInclude = decision.count === 'paid';
    let paidNote = paidInclude ? 'counting last paid' : 'last payment not counted';
    try {
      paidInclude = countLastPaid(await settlementInvoices(), data.paidPayment, 'pathao');
      paidNote = paidInclude ? 'last paid is not in the last 30 days of settlement history, counted' : 'last paid is in the last 30 days of settlement history, not counted';
    } catch {
      paidInclude = paidRow ? paidRow.include !== false : paidInclude;
      paidNote = 'settlement history unavailable, last paid count unchanged';
    }
    const rows = [
      ['Pathao · Upcoming payment', data.upcomingPayment, null, true, '', ''],
      ['Pathao · In review', data.inReview, null, true, '', ''],
      ['Pathao · Last processing', data.lastProcessing, null, decision.count === 'open', data.openPayment?.id || '', data.openPayment?.state || ''],
      ['Pathao · Last paid', data.lastPaidAmount, data.lastPaidOn || null, paidInclude, data.paidPayment?.id || '', 'paid']
    ];
    const bits = [];
    for (const [name, raw, note, include, paymentId, paymentState] of rows) {
      bits.push(await saveCourierAmount(name, 'Pathao', 'pathao', raw, note, include, paymentId, paymentState));
    }
    audit('courier.pathao', bits.join(', '));
    if (!window.__holdSnap) await snapshot('pathao');
    const counted = (decision.count === 'open' ? 'counting last processing' : 'last processing not counted') + ' · ' + paidNote;
    window.__ptMsg = `${bits.join(' · ')} · ${counted} · Live Sheet updated`;
    if (!quiet) toast('Pathao updated');
  } catch (err) {
    window.__ptErr = err.message;
    window.__ptMsg = '';
    if (!quiet) toast(err.message);
  } finally {
    window.__ptBusy = false;
    if (!quiet) render(true);
  }
}
async function checkEcomdriveAccounts(quiet) {
  if (window.__acctBusy) return 'busy';
  window.__acctBusy = true;
  window.__acctErr = '';
  window.__acctMsg = 'Syncing EcomDrive accounts…';
  if (!quiet) render(true);
  try {
    const res = await api('/api/ecomdrive/accounts', { method: 'POST', timeoutMs: 90000 });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Account sync is not running. In the worker folder, run: node server.mjs');
    const rows = data.accounts || [];
    const now = new Date().toISOString();
    let order = S.items.length;
    const bits = [];
    for (const s of rows) {
      const m = toMinor(s.balance);
      if (m === null) throw new Error('Invalid balance for ' + s.name);
      const stableId = 'ea_' + String(s.id);
      let it = findCashAccount(s.name, s.id) || S.items.find(i => i.id === stableId && !i.archived) || null;
      const prev = it ? (it.balance || 0) : 0;
      if (!it) {
        // Deterministic doc id → cloudAdd timeout cannot create a second wallet row.
        // prev = m on first create so Previous is not wiped to zero.
        const seed = { name: s.name, group: 'cash', currency: cfg().base, balance: m, prev: m, opening: m, include: true, archived: false, order: order++, externalId: s.id, updatedAt: now, source: 'ecomdrive', status: 'auto' };
        await cloudSet('items', stableId, seed, 6000);
        it = { id: stableId, ...seed };
        if (!S.items.some(x => x.id === it.id)) S.items.push(it);
      } else {
        it.name = s.name;
        if (prev !== m) {
          it.prev = prev;
          it.balance = m;
        }
        it.externalId = s.id;
        it.updatedAt = now;
        it.source = 'ecomdrive';
        it.archived = false;
        await cloudSet('items', it.id, { name: s.name, prev: it.prev, balance: it.balance, externalId: s.id, updatedAt: now, source: 'ecomdrive', archived: false, group: 'cash' }, 6000);
      }
      bits.push(`${s.name} ${fmt(m)}`);
    }
    const dropped = await mergeDuplicateCashAccounts();
    audit('account.sync', bits.join(', ') + (dropped ? ` · merged ${dropped} duplicate` : ''));
    let sheetNote = window.__holdSnap ? 'sheet row after Calculate' : 'Live Sheet updated';
    if (!window.__holdSnap) {
      try { await snapshot('ecomdrive'); }
      catch (err) { sheetNote = 'numbers updated (sheet cloud save failed)'; window.__cloudErr = err.message || window.__cloudErr; }
    }
    window.__acctMsg = `${rows.length} accounts · ${bits.join(' · ')} · ${sheetNote}${dropped ? ` · removed ${dropped} duplicate` : ''}`;
    if (window.__cloudErr && !quiet) toast('EcomDrive accounts ok · cloud slow/failed, kept on this device');
    else if (!quiet) toast(dropped ? `Accounts updated · ${dropped} duplicate removed` : 'Accounts updated — previous kept');
  } catch (err) {
    window.__acctErr = err.message;
    window.__acctMsg = '';
    if (!quiet) toast(err.message);
  } finally {
    window.__acctBusy = false;
    if (!quiet) render(true);
  }
}
async function applySmsBalances(manual) {
  if (window.__smsBusy) return;
  if (!LOADED.items && !S.items.length) return;
  window.__smsBusy = true;
  let changed = false;
  if (manual) {
    window.__smsManual = true;
    window.__smsErr = '';
    window.__smsMsg = 'Checking SMS balances…';
    render(true);
  }
  try {
    const res = await api('/api/sms/balance');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'SMS balance API is not running. In the worker folder, run: node server.mjs');
    const now = new Date().toISOString();
    const bits = [];
    let order = S.items.length;
    for (const row of data.balances || []) {
      if (row.account !== 'bkash' && row.account !== 'nagad') continue;
      const m = toMinor(row.balance);
      if (m === null) continue;
      const label = row.account === 'bkash' ? 'bKash' : 'Nagad';
      let it = findCashAccount(label);
      const smsAt = row.at ? new Date(row.at).getTime() : 0;
      const itemAt = it?.updatedAt ? new Date(it.updatedAt).getTime() : 0;
      if (it && smsAt && itemAt && smsAt <= itemAt) continue;
      const prev = it ? (it.balance || 0) : 0;
      if (!it) {
        const seed = { name: label, group: 'cash', currency: cfg().base, balance: m, prev: 0, opening: m, include: true, archived: false, order: order++, updatedAt: row.at || now, source: 'sms', status: 'auto' };
        const id = await cloudAdd('items', seed, 5000);
        it = S.items.find(i => i.id === id) || { id: id || localId(), ...seed };
        if (!S.items.some(x => x.id === it.id)) S.items.push(it);
        bits.push(`${label} ${fmt(m)}`);
        continue;
      }
      if (it.balance === m && it.source === 'sms') continue;
      it.prev = prev;
      it.balance = m;
      it.updatedAt = row.at || now;
      it.source = 'sms';
      await cloudSet('items', it.id, { prev, balance: m, updatedAt: row.at || now, source: 'sms' }, 5000);
      bits.push(`${it.name} ${fmt(m)}`);
    }
    if (bits.length) {
      changed = true;
      audit('account.sms', bits.join(', '));
      try { await snapshot('sms'); } catch (err) { window.__cloudErr = err.message || window.__cloudErr; }
    }
    if (manual) window.__smsMsg = bits.length ? `${bits.join(' · ')} · Live Sheet updated` : 'No newer SMS balance';
  } catch (err) {
    if (manual) {
      window.__smsErr = err.message;
      window.__smsMsg = '';
      toast(err.message);
    }
  } finally {
    window.__smsBusy = false;
    window.__smsManual = false;
    if (manual || changed) render(true);
  }
}
async function applyDollar(manual) {
  const show = manual === true;
  if (window.__dollarBusy) return 'busy';
  if (!LOADED.items && !S.items.length) return 'busy';
  window.__dollarBusy = true;
  window.__dollarErr = '';
  let changed = false;
  if (show) {
    window.__dollarMsg = 'Checking dollar expenses…';
    render(true);
  }
  try {
    const res = await api('/api/ecomdrive/dollar', { method: 'POST', timeoutMs: 60000 });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Dollar check is not running. In the worker folder, run: node server.mjs');
    const base = Number(cfg().dollarBase || '171');
    const spent = Number(data.spent || 0);
    const left = Math.round((base - spent) * 100) / 100;
    const rate = String(data.rate || cfg().rates?.USD || '128');
    if (String(cfg().rates?.USD || '') !== rate) {
      let main = S.settings.find(x => x.id === 'main');
      if (!main) { main = { id: 'main' }; S.settings.push(main); }
      main.rates = { ...(cfg().rates || {}), USD: rate };
      await cloudSet('settings', 'main', { rates: main.rates }, 5000);
    }
    const m = toMinor(left);
    const openM = toMinor(base);
    if (m === null) throw new Error('Dollar balance could not be calculated');
    const now = new Date().toISOString();
    let it = S.items.find(i => !i.archived && i.group === 'cash' && i.externalId === 'dollar-main');
    const prev = it ? (it.balance || 0) : m;
    if (!it) {
      const seed = { name: 'Dollar', group: 'cash', currency: 'USD', balance: m, prev: m, opening: openM || m, include: true, archived: false, order: S.items.length, updatedAt: now, source: 'ecomdrive', status: 'auto', externalId: 'dollar-main' };
      const id = await cloudAdd('items', seed, 5000);
      it = S.items.find(i => i.id === id) || { id: id || localId(), ...seed };
      if (!S.items.some(x => x.id === it.id)) S.items.push(it);
      changed = true;
    } else if (it.balance !== m || it.currency !== 'USD' || (openM != null && it.opening !== openM)) {
      it.prev = prev;
      it.balance = m;
      it.currency = 'USD';
      if (openM != null) it.opening = openM;
      it.updatedAt = now;
      it.source = 'ecomdrive';
      await cloudSet('items', it.id, { name: 'Dollar', prev, balance: m, currency: 'USD', opening: openM ?? it.opening, updatedAt: now, source: 'ecomdrive' }, 5000);
      changed = true;
    }
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const days = (data.days || []).map(d => `${Number(d.date.slice(8))} ${months[Number(d.date.slice(5, 7)) - 1]} $${d.usd}`).join(', ');
    window.__dollarMsg = `Left $${left.toFixed(2)} · main $${base.toFixed(2)} − ${data.category || 'Meta Ads'} $${Number(data.spent || 0).toFixed(2)}${days ? ` (${days})` : ''} · today $${Number(data.todayUsd || 0).toFixed(2)} · rate ${rate}`;
    if (changed) {
      audit('account.dollar', window.__dollarMsg);
      try { await snapshot('dollar'); } catch (err) { window.__cloudErr = err.message || window.__cloudErr; }
    }
    if (show) toast(window.__cloudErr ? 'Dollar ok · cloud slow/failed' : 'Dollar updated');
  } catch (err) {
    window.__dollarErr = err.message;
    if (show) {
      window.__dollarMsg = '';
      toast(err.message);
    }
  } finally {
    window.__dollarBusy = false;
    if (show || changed) render(true);
  }
}
async function saveExpenseAmount(externalId, name, raw, lines) {
  const m = toMinor(raw);
  if (m === null) throw new Error(name + ' amount was empty');
  let it = S.items.find(i => !i.archived && i.externalId === externalId);
  const prev = it ? (it.balance || 0) : 0;
  const now = new Date().toISOString();
  if (!it) {
    const seed = { name, group: 'expense', currency: cfg().base, balance: m, prev: 0, opening: 0, include: false, archived: false, order: S.items.length, updatedAt: now, source: 'ecomdrive', status: 'auto', externalId, lines: lines || [] };
    const id = await cloudAdd('items', seed, 5000);
    it = S.items.find(i => i.id === id) || { id: id || localId(), ...seed };
    if (!S.items.some(x => x.id === it.id)) S.items.push(it);
    return true;
  }
  const sameLines = JSON.stringify(it.lines || []) === JSON.stringify(lines || []);
  if (it.balance === m && it.name === name && sameLines) return false;
  it.prev = prev;
  it.balance = m;
  it.name = name;
  it.lines = lines || [];
  it.updatedAt = now;
  it.source = 'ecomdrive';
  await cloudSet('items', it.id, { name, prev, balance: m, lines: lines || [], updatedAt: now, source: 'ecomdrive' }, 5000);
  return true;
}
async function applyExpenses(manual) {
  const show = manual === true;
  if (window.__expenseBusy) return 'busy';
  if (!LOADED.items && !S.items.length) return 'busy';
  window.__expenseBusy = true;
  window.__expenseErr = '';
  let changed = false;
  if (show) {
    window.__expenseMsg = 'Checking EcomDrive expenses…';
    render(true);
  }
  try {
    const res = await api('/api/ecomdrive/expenses', { method: 'POST', timeoutMs: 120000 });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Expense check is not running. In the worker folder, run: node server.mjs');
    const metaChanged = await saveExpenseAmount('expense-meta', 'Meta Ads', data.meta || '0', []);
    const otherChanged = await saveExpenseAmount('expense-other', 'Expenses except Meta Ads', data.other || '0', data.categories || []);
    changed = metaChanged || otherChanged;
    const bits = (data.categories || []).map(c => `${c.label} ${c.amount}`).join(', ');
    window.__expenseMsg = `${data.today || ''} · Meta Ads ৳${data.meta || '0.00'} · other ৳${data.other || '0.00'}${bits ? ' · ' + bits : ''}`;
    if (changed) {
      audit('expense.check', window.__expenseMsg);
      const counted = S.items.some(i => !i.archived && (i.externalId === 'expense-meta' || i.externalId === 'expense-other') && i.include !== false);
      if (counted) await snapshot('expense');
    }
    if (show) toast('Expenses updated');
  } catch (err) {
    window.__expenseErr = err.message;
    if (show) {
      window.__expenseMsg = '';
      toast(err.message);
    }
  } finally {
    window.__expenseBusy = false;
    if (show || changed) render(true);
  }
}
function readCalcLock() {
  try { return JSON.parse(localStorage.getItem('hisab_calc_lock') || 'null'); } catch { return null; }
}
function clearCalcLock() {
  try { localStorage.removeItem('hisab_calc_lock'); } catch { /* ignore */ }
}
function forceReleaseCalc() {
  window.__calcBusy = false;
  window.__holdSnap = false;
  window.__sfBusy = false;
  window.__ptBusy = false;
  window.__acctBusy = false;
  window.__stockBusy = false;
  window.__reportBusy = false;
  window.__supBusy = false;
  window.__expenseBusy = false;
  window.__dollarBusy = false;
  clearCalcLock();
}
function calcBusyElsewhere() {
  const lock = readCalcLock();
  if (!lock?.id || !lock.beat) return false;
  const now = Date.now();
  // Heartbeat is every 20s; drop zombies. Absolute cap stops a hung tab forever-pulsing.
  if (now - lock.beat >= 45000 || (lock.started && now - lock.started >= 8 * 60000)) {
    clearCalcLock();
    return false;
  }
  return true;
}
function calcBtnLabel() {
  if (!window.__calcBusy) return 'Calculate now';
  const steps = window.__calcSteps || [];
  const done = steps.filter(s => s.status === 'ok' || s.status === 'fail').length;
  const pct = steps.length ? Math.round((done / steps.length) * 100) : 0;
  return `Calculating ${pct}%`;
}
function paintCalcProgress() {
  const el = $('#calcProgress');
  const steps = window.__calcSteps || [];
  const busy = !!window.__calcBusy;
  const show = busy || !!window.__calcShowDone;
  const label = calcBtnLabel();
  document.querySelectorAll('[data-click="calculateNow"]').forEach(btn => {
    btn.disabled = busy;
    btn.textContent = label;
  });
  if (!el) return;
  if (!show || !steps.length) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  const done = steps.filter(s => s.status === 'ok' || s.status === 'fail').length;
  const pct = Math.round((done / steps.length) * 100);
  const run = steps.find(s => s.status === 'run');
  const title = busy
    ? (run ? `এখন: ${run.name}` : 'হিসাব চলছে')
    : (window.__calcMsg || 'শেষ');
  const mark = s => s.status === 'ok' ? '✓' : s.status === 'fail' ? '!' : s.status === 'run' ? '…' : '';
  el.classList.remove('hidden');
  el.innerHTML = `<h4><span class="calc-pct">${pct}%</span>${esc(title)}</h4>
    <div class="calc-bar" aria-hidden="true"><i style="width:${pct}%"></i></div>
    <ul class="calc-steps">${steps.map(s => `<li class="${esc(s.status)}"><span class="mark">${mark(s)}</span><span class="lab">${esc(s.name)}${s.detail ? `<small>${esc(s.detail)}</small>` : ''}</span></li>`).join('')}</ul>`;
}
async function calculateNow(manual) {
  if (window.__calcBusy) {
    const age = window.__calcStartedAt ? Date.now() - window.__calcStartedAt : 0;
    if (manual && age >= 3 * 60000) {
      forceReleaseCalc();
      toast('Previous check was stuck — starting again');
    } else {
      if (manual) toast('A full check is already running');
      return;
    }
  }
  if (calcBusyElsewhere()) {
    if (manual) {
      // Hung/other tab left a lock; manual click takes over.
      forceReleaseCalc();
    } else {
      return;
    }
  }
  const id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const started = Date.now();
  const writeLock = () => {
    try { localStorage.setItem('hisab_calc_lock', JSON.stringify({ id, beat: Date.now(), started })); } catch { /* this browser can still run one check */ }
  };
  writeLock();
  await new Promise(r => setTimeout(r, 80));
  if (readCalcLock()?.id !== id) {
    if (manual) {
      forceReleaseCalc();
      writeLock();
    } else {
      return;
    }
  }
  const jobs = [
    ['Steadfast', () => checkSteadfast(true), () => window.__sfErr],
    ['Pathao', () => checkPathao(true), () => window.__ptErr],
    ['EcomDrive accounts', () => checkEcomdriveAccounts(true), () => window.__acctErr],
    ['EcomDrive stock', () => checkEcomdriveStock(true), () => window.__stockErr],
    ['EcomDrive report', () => checkEcomdriveReport(true), () => window.__reportErr],
    ['EcomDrive suppliers', () => checkEcomdriveSuppliers(true), () => window.__supErr],
    ['Expenses', () => applyExpenses('quiet'), () => window.__expenseErr],
    ['Dollar', () => applyDollar('quiet'), () => window.__dollarErr],
    ['SMS balances', () => applySmsBalances(false).then(() => ''), () => ''],
    ['Live Sheet', null, () => '']
  ];
  window.__calcBusy = true;
  window.__calcStartedAt = started;
  window.__holdSnap = true;
  window.__calcShowDone = false;
  // Drop stale single-check locks left by a previous hung run.
  window.__sfBusy = false;
  window.__ptBusy = false;
  window.__acctBusy = false;
  window.__stockBusy = false;
  window.__reportBusy = false;
  window.__supBusy = false;
  window.__expenseBusy = false;
  window.__dollarBusy = false;
  window.__smsBusy = false;
  window.__cloudDown = false;
  window.__cloudErr = '';
  window.__calcSteps = jobs.map(([name]) => ({ name, status: 'pending', detail: '' }));
  window.__calcMsg = 'Checking every source…';
  const pulse = setInterval(writeLock, 15000);
  paintCalcProgress();
  if (manual) render(true);
  paintCalcProgress();
  const failed = [];
  const syncErrors = [];
  const at = new Date().toISOString();
  try {
    for (let i = 0; i < jobs.length; i++) {
      const [name, fn, errOf] = jobs[i];
      const step = window.__calcSteps[i];
      step.status = 'run';
      step.detail = '';
      window.__calcMsg = 'Checking ' + name + '…';
      paintCalcProgress();
      if (name === 'Live Sheet') {
        try {
          const signedOut = failed.length > 0 && failed.every(line => line.includes('Sign in required'));
          window.__holdSnap = false;
          if (!signedOut) await snapshot('calculate');
          const calcAt = new Date().toISOString();
          const patch = signedOut ? { syncErrors } : { syncErrors, lastCalcAt: calcAt };
          let main = S.settings.find(x => x.id === 'main');
          if (!main) { main = { id: 'main' }; S.settings.push(main); }
          Object.assign(main, patch);
          await cloudSet('settings', 'main', patch, 8000);
          step.status = 'ok';
          step.detail = signedOut ? 'সাইন-ইন লাগবে' : (window.__cloudErr ? 'লোকাল সেভ' : 'সারি সেভ');
          window.__calcMsg = signedOut
            ? 'Hisab-এ আবার ঢুকতে হবে। কুরিয়ার চেক শুরু হয়নি।'
            : failed.length
              ? 'New sheet row added. Where a check failed, the old number was kept.'
              : (window.__cloudErr
                ? 'Checks finished. Sheet kept on this device (cloud save slow).'
                : 'Fresh data saved and a new sheet row was added.');
        } catch (err) {
          step.status = 'fail';
          step.detail = err.message || 'Save failed';
          window.__calcMsg = err.message || 'Calculate failed';
          // Don't abort the whole calculate UI — show fail on Live Sheet step only.
        }
        paintCalcProgress();
        continue;
      }
      try {
        const skipped = await withTimeout(Promise.resolve().then(() => fn()), 100000, name + ' timed out');
        const message = skipped === 'busy'
          ? 'Already running, skipped'
          : (errOf() || '');
        if (message) {
          syncErrors.push({ name, message, at });
          failed.push(name + ': ' + message);
          step.status = 'fail';
          step.detail = message;
        } else {
          step.status = 'ok';
          step.detail = skipped === '' ? '' : 'ঠিক আছে';
        }
      } catch (err) {
        const message = err.message || 'Check failed';
        syncErrors.push({ name, message, at });
        failed.push(name + ': ' + message);
        step.status = 'fail';
        step.detail = message;
      }
      paintCalcProgress();
    }
    if (manual) toast(window.__calcMsg);
  } catch (err) {
    window.__calcMsg = err.message || 'Calculate failed';
    if (manual) toast(window.__calcMsg);
  } finally {
    clearInterval(pulse);
    window.__holdSnap = false;
    window.__calcBusy = false;
    window.__calcStartedAt = 0;
    window.__calcShowDone = true;
    if (readCalcLock()?.id === id) clearCalcLock();
    paintCalcProgress();
    render(true);
    paintCalcProgress();
    clearTimeout(window.__calcHideT);
    window.__calcHideT = setTimeout(() => {
      window.__calcShowDone = false;
      paintCalcProgress();
    }, 5000);
  }
}
async function setBalance(id, str) {
  const it = S.items.find(i => i.id === id);
  if (!it) return;
  // Editing the Dollar row sets MAIN dollar, then left = main − EcomDrive Meta Ads spend.
  if (it.externalId === 'dollar-main') {
    const dollars = Number(String(str || '').replace(/[,$\s]/g, ''));
    if (!Number.isFinite(dollars) || dollars < 0) { toast('Invalid dollar amount'); render(true); return; }
    const dollarBase = (Math.round(dollars * 100) / 100).toFixed(2);
    let main = S.settings.find(x => x.id === 'main');
    if (!main) { main = { id: 'main' }; S.settings.push(main); }
    main.dollarBase = dollarBase;
    main.dollarReady = true;
    await cloudSet('settings', 'main', { dollarBase, dollarReady: true, dollarStart: cfg().dollarStart || '2026-10-25' }, 6000);
    audit('settings.dollarBase', 'edit row → $' + dollarBase);
    // Optimistic left until EcomDrive responds (keep row visible).
    const openM = toMinor(dollarBase);
    const prev = it.balance || 0;
    const now = new Date().toISOString();
    it.prev = prev;
    it.balance = openM != null ? openM : prev;
    it.opening = openM != null ? openM : it.opening;
    it.currency = 'USD';
    it.updatedAt = now;
    it.name = 'Dollar';
    await cloudSet('items', it.id, { name: 'Dollar', prev, balance: it.balance, opening: it.opening, currency: 'USD', updatedAt: now, externalId: 'dollar-main', group: 'cash' }, 6000);
    toast('Main dollar set to $' + dollarBase);
    applyDollar(true).catch(() => {});
    render(true);
    return;
  }
  let m = toMinor(str);
  if (m === null) { toast('Invalid amount – not saved'); render(true); return; }
  // Delivery-fee rows are stored negative; the input shows the absolute value.
  if (ECOM_FEE.has(it.name) && m > 0) m = -m;
  if (m === it.balance) return;
  const prev = it.balance || 0;
  const now = new Date().toISOString();
  it.prev = prev;
  it.balance = m;
  it.updatedAt = now;
  it.source = 'manual';
  // USDT DUE always lives at stable id so sparse Firebase seed cannot wipe the amount.
  if (it.id === USDT_DUE_ID || isUsdtDue(it)) {
    it.name = 'USDT DUE';
    it.group = 'supplier';
    it.status = 'manual';
    it.externalId = '';
    it.archived = false;
    const saveId = USDT_DUE_ID;
    if (it.id !== saveId) {
      S.items = S.items.filter(x => x.id !== it.id && x.id !== saveId && !isUsdtDue(x));
      it = { ...it, id: saveId };
      S.items.push(it);
    }
    await cloudSet('items', saveId, {
      name: 'USDT DUE', group: 'supplier', currency: it.currency || cfg().base,
      prev, balance: m, opening: it.opening ?? prev, include: it.include !== false,
      archived: false, order: it.order ?? 0, updatedAt: now, source: 'manual', status: 'manual', externalId: ''
    }, 6000);
    audit('balance.edit', `USDT DUE: ${fmt(prev, it.currency)} → ${fmt(m, it.currency)}`);
    scheduleSnap();
    toast('USDT DUE saved' + (window.__cloudDown || window.__cloudErr ? ' on this device' : ''));
    render(true);
    return;
  }
  await cloudSet('items', id, { prev, balance: m, updatedAt: now, source: 'manual' }, 6000);
  audit('balance.edit', `${it.name}: ${fmt(prev, it.currency)} → ${fmt(m, it.currency)}`);
  scheduleSnap();
  toast('Saved' + (cfg().onChange ? ' · Live Sheet row coming' : ''));
  render(true);
}
async function applyDelta(id, amt, cur, dir, c) {
  const it = S.items.find(i => i.id === id); if (!it) return;
  const liab = GROUPS[it.group].kind === 'liability';
  const m = conv(amt, cur, it.currency, c);
  if (m == null) throw new Error('Missing exchange rate for ' + cur + ' / ' + it.currency);
  const delta = (liab ? -dir : dir) * m;
  await A.set('items', id, { prev: it.balance || 0, balance: (it.balance || 0) + delta, updatedAt: new Date().toISOString(), source: 'ledger' });
}
async function postEntry(e, apply) {
  const c = cfg();
  if (apply) {
    if (e.fromId) await applyDelta(e.fromId, e.amount, e.currency, -(e.sign || 1), c);
    if (e.toId) await applyDelta(e.toId, e.amount, e.currency, (e.sign || 1), c);
  }
  const id = await A.add('ledger', { ...e, applied: !!apply, ts: new Date().toISOString(), date: todayStr(), by: user, recon: 'unreconciled' });
  audit('ledger.add', `${e.type} ${fmt(e.amount, e.currency)} ${e.note || ''}`);
  if (apply) scheduleSnap();
  return id;
}
async function seed() {
  await A.set('settings', 'main', DEF);
  const now = new Date().toISOString();
  let i = 0;
  for (const it of SEED_ITEMS) {
    await A.add('items', { ...it, balance: 0, prev: 0, opening: 0, include: true, archived: false, order: i++, updatedAt: now, source: 'manual', status: 'manual' });
  }
  audit('seed', 'Initial configuration created');
}

// ---------- one-time additions for existing data ----------
const RETIRED_METRICS = new Set(['Ecomdrive · Pending Amount', 'Ecomdrive · Ready to Ship Amount', 'Ecomdrive · Total Parcel Amount', 'Ecomdrive · Stock Amount', 'Steadfast · Payment Hold', 'Pathao · Payment Hold']);
const RETIRED_SUPPLIERS = new Set(['SK Packaging', 'Safe Packaging', 'Parcel Packaging BD']);
const RETIRED_CASH = new Set(['Pubali Bank', 'Dutch-Bangla Bank (DBBL)', 'bKash', 'Nagad', 'Pathao Pay', 'TallyPay / TallyKhata', 'EPS (Easy Payment System)', 'My Money', 'Reddot Pay', 'Cash in Hand']);
const REPORT_METRICS = ['Ecomdrive · Shipped', 'Ecomdrive · Shipped delivery', 'Ecomdrive · Pending', 'Ecomdrive · Pending delivery', 'Ecomdrive · RTS', 'Ecomdrive · RTS delivery', 'Ecomdrive · Pending Return', 'Ecomdrive · Pending Return delivery'];
async function migrate() {
  if (!LOADED.items || !S.settings.some(r => r.id === 'main')) return;
  // Local work first — must not wait on a hung Firebase.
  await ensureUsdtDue();
  // Skip non-essential cloud writes when cloud already timed out; tick still needs to proceed.
  if (window.__cloudDown) return;
  const mop = (p, label) => withTimeout(p, 4000, label || 'migrate op timed out');
  try {
    if (!cfg().metricsSeeded) await mop(A.set('settings', 'main', { metricsSeeded: true }), 'migrate metricsSeeded');
    for (const it of S.items.filter(i => i.source === 'demo')) {
      await mop(A.set('items', it.id, { source: 'manual', status: 'manual' }), 'migrate demo item');
    }
    for (const it of S.items.filter(i => i.group === 'metric' && RETIRED_METRICS.has(i.name))) {
      await mop(A.del('items', it.id), 'migrate del metric').catch(() => {});
    }
    const retiredSuppliers = S.items.filter(i => i.group === 'supplier' && RETIRED_SUPPLIERS.has(i.name) && !i.externalId);
    for (const it of retiredSuppliers) await mop(A.del('items', it.id), 'migrate del supplier').catch(() => {});
    const retiredCash = S.items.filter(i => i.group === 'cash' && !i.externalId && ((i.currency === 'BDT' && (i.source === 'demo' || RETIRED_CASH.has(i.name))) || (i.name === 'USDT' && i.source === 'demo')));
    for (const it of retiredCash) await mop(A.del('items', it.id), 'migrate del cash').catch(() => {});
    const retiredCourier = S.items.filter(i => i.group === 'courier' && i.source === 'demo');
    for (const it of retiredCourier) await mop(A.del('items', it.id), 'migrate del courier').catch(() => {});
    if (retiredSuppliers.length || retiredCash.length || retiredCourier.length) await snapshot('change');
    if (!cfg().dollarReady) {
      await mop(A.set('settings', 'main', {
        dollarReady: true,
        dollarBase: '171.00',
        dollarStart: '2026-10-25',
        rates: { ...(cfg().rates || {}), USD: '128.00' }
      }), 'migrate dollarReady');
    }
    if (!cfg().ecomWorth) {
      await mop(A.set('settings', 'main', { ecomWorth: true }), 'migrate ecomWorth');
      await snapshot('change');
    }
    if (!cfg().types?.capital_add || !cfg().types?.capital_withdraw) {
      await mop(A.set('settings', 'main', {
        types: {
          ...cfg().types,
          capital_add: DEF.types.capital_add,
          capital_withdraw: DEF.types.capital_withdraw
        }
      }), 'migrate types');
    }
    let o = S.items.length;
    for (const name of REPORT_METRICS) {
      if (S.items.some(i => i.group === 'metric' && i.name === name)) continue;
      await mop(A.add('items', { name, group: 'metric', currency: cfg().base, balance: 0, prev: 0, opening: 0, include: true, archived: false, order: o++, updatedAt: new Date().toISOString(), source: 'manual', status: 'manual' }), 'migrate report metric');
    }
    await absorbCountFix();
  } catch (e) {
    console.warn('hisab: migrate aborted', e);
    if (/timed out/i.test(e?.message || '')) window.__cloudDown = true;
  }
}

// ---------- connector ingest (same rules as the Cloud Function) ----------
function parseFields(text) {
  const t = String(text || '').trim(), out = {};
  try { const j = JSON.parse(t); for (const [k, v] of Object.entries(j)) out[k] = String(v); return out; } catch { /* not JSON */ }
  for (const line of t.split('\n')) { const i = line.indexOf(':'); if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  return out;
}
async function applyIngest(conn, fields, via) {
  const now = new Date().toISOString(), log = [];
  let ok = 0;
  for (const mp of conn.mappings || []) {
    const raw = fields[mp.field], it = S.items.find(i => i.id === mp.itemId);
    if (!it) { log.push(mp.field + ': target item missing'); continue; }
    if (raw === undefined || raw === null || String(raw).trim() === '') { log.push(mp.field + ': no value received – kept old balance'); continue; }
    const m = toMinor(raw);
    if (m === null) { log.push(mp.field + ': invalid value "' + String(raw).slice(0, 20) + '" – kept old balance'); continue; }
    if (m !== (it.balance || 0)) await A.set('items', it.id, { prev: it.balance || 0, balance: m, updatedAt: now, source: 'connector:' + conn.name });
    else await A.set('items', it.id, { updatedAt: now, source: 'connector:' + conn.name });
    ok++;
  }
  const total = (conn.mappings || []).length;
  const status = !ok ? 'error' : ok < total ? 'partial' : 'ok';
  await A.set('connectors', conn.id, { lastRun: now, ...(ok ? { lastOk: now } : {}), status, lastError: log.join('; ') });
  audit('sync', `${conn.name} via ${via}: ${ok}/${total} fields applied${log.length ? ' · ' + log.join('; ') : ''}`);
  if (ok) scheduleSnap();
  return `${ok}/${total} fields applied` + (log.length ? ' – ' + log[0] : '');
}

// ---------- webhooks (same rules as the Cloud Function; used here for test events) ----------
const getPath = (o, p) => String(p || '').split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
async function applyWebhook(wh, body, via) {
  const now = new Date().toISOString(), log = [], c = cfg();
  const evId = wh.idField ? String(getPath(body, wh.idField) ?? '') : '';
  if (evId && S.ledger.some(e => e.srcId === wh.name + ':' + evId) ) return 'Duplicate event ' + evId + ' – ignored';
  let ok = 0;
  for (const mp of wh.mappings || []) {
    const raw = getPath(body, mp.field), it = S.items.find(i => i.id === mp.itemId);
    if (!it) { log.push(mp.field + ': item missing'); continue; }
    if (raw === undefined || raw === null || String(raw).trim() === '') { log.push(mp.field + ': no value'); continue; }
    const m = toMinor(raw);
    if (m === null) { log.push(mp.field + ': invalid value'); continue; }
    const cur = it.balance || 0, next = mp.mode === 'add' ? cur + m : mp.mode === 'sub' ? cur - m : m;
    await A.set('items', it.id, { prev: cur, balance: next, updatedAt: now, source: 'webhook:' + wh.name });
    ok++;
  }
  let led = false;
  if (wh.ledgerType && wh.amountField) {
    const amt = toMinor(getPath(body, wh.amountField));
    if (amt && amt > 0 && c.types[wh.ledgerType]) {
      await A.add('ledger', { type: wh.ledgerType, amount: amt, currency: wh.currency || c.base, fromId: null, toId: null, note: 'Webhook: ' + wh.name + (evId ? ' #' + evId : ''), srcId: evId ? wh.name + ':' + evId : '', sign: 1, applied: false, ts: now, date: todayStr(), by: 'webhook', recon: 'unreconciled' });
      led = true;
    } else log.push(wh.amountField + ': no valid amount for the ledger entry');
  }
  await A.set('webhooks', wh.id, { lastHit: now, hits: (wh.hits || 0) + 1, lastStatus: log.length ? 'partial' : 'ok', lastError: log.join('; ') });
  audit('webhook', `${wh.name} via ${via}: ${ok} balance(s) changed${led ? ', ledger entry added' : ''}${log.length ? ' · ' + log.join('; ') : ''}`);
  if (wh.snapshot !== false) await snapshot('webhook');
  return `${ok} balance(s) changed${led ? ', ledger entry added' : ''}, row added` + (log.length ? ' – ' + log[0] : '');
}
function webhookSection() {
  const c = cfg(), sel = S.webhooks.find(x => x.id === window.__hid), all = activeItems().filter(i => !i.archived);
  const url = id => `https://asia-south1-${CONFIG.projectId || 'YOUR-PROJECT'}.cloudfunctions.net/webhook?id=${id}`;
  const rows = S.webhooks.map(w => `<tr><td>${esc(w.name)}</td><td>${esc(w.event || '')}</td><td class="n">${w.hits || 0}</td><td>${dt(w.lastHit)}</td><td><span class="pill ${w.active !== false && w.lastStatus === 'ok' ? 'ok' : 'warn'}">${esc(w.active === false ? 'paused' : (w.lastStatus || 'never called'))}</span></td><td><button class="btn sm" data-click="selhook" data-id="${w.id}">Configure</button> <button class="btn sm" data-click="togglehook" data-id="${w.id}">${w.active === false ? 'Resume' : 'Pause'}</button></td></tr>`).join('');
  const detail = sel ? `<div class="card"><h3>${esc(sel.name)} · what happens when it is called</h3>
    <p class="muted">Send a POST with a JSON body to <code>${esc(url(sel.id))}</code> and the secret in the <code>x-webhook-token</code> header. ${DEMO ? 'Live delivery needs the Firebase setup; in demo mode use the test box below.' : ''}</p>
    <div class="tw"><table><tr><th>Field in the request (e.g. order.total)</th><th>Action</th><th>Item</th><th></th></tr>${(sel.mappings || []).map((m, i) => `<tr><td>${esc(m.field)}</td><td>${m.mode === 'add' ? 'add to' : m.mode === 'sub' ? 'subtract from' : 'set'}</td><td>${esc(S.items.find(x => x.id === m.itemId)?.name || '(missing item)')}</td><td><button class="btn sm danger" data-click="delhookmap" data-i="${i}">Remove</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted">No balance changes. The call will only add a row.</td></tr>'}</table></div>
    <form class="form" data-form="addhookmap" style="margin-top:10px"><label>Field<input name="field" required placeholder="order.total"></label>
      <label>Action<select name="mode"><option value="add">add to</option><option value="sub">subtract from</option><option value="set">set to</option></select></label>
      <label>Item<select name="itemId" required>${all.map(i => `<option value="${i.id}">${esc(GROUPS[i.group]?.label || '')} · ${esc(uiName(i.name))}</option>`).join('')}</select></label><button class="btn primary">Add change</button></form>
    <h3 style="margin-top:16px">Options</h3>
    <form class="form" data-form="hookcfg"><label>Event / unique ID field<input name="idField" value="${esc(sel.idField || '')}" placeholder="order.id"></label>
      <label>Also post a ledger entry of type<select name="ledgerType"><option value="">none</option>${Object.entries(c.types).map(([k, t]) => `<option value="${k}" ${sel.ledgerType === k ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select></label>
      <label>Ledger amount field<input name="amountField" value="${esc(sel.amountField || '')}" placeholder="order.total"></label>
      <label style="flex-direction:row;align-items:center;color:inherit"><input type="checkbox" name="snapshot" ${sel.snapshot !== false ? 'checked' : ''}> add a sheet row when called</label><button class="btn primary">Save options</button></form>
    <p class="muted">The ID field makes repeated deliveries of the same event harmless: the second one is ignored. Ledger entries from a webhook do not change balances by themselves (the changes above do), so nothing is counted twice.</p>
    <h3 style="margin-top:16px">Test with a sample request</h3>
    <form data-form="testhook"><textarea name="data" rows="4" style="width:100%" placeholder='{"order": {"id": "1001", "total": "1850.00"}}'></textarea><br><br><button class="btn primary">Run test</button></form></div>` : '';
  return `<h3 style="margin:22px 0 8px">Webhooks</h3>
    <p class="muted">A webhook adds a sheet row the moment something happens, such as a new order, and can change balances or post a ledger entry from the data it receives. You decide what each one does.</p>
    <div class="tw"><table><tr><th>Name</th><th>Event</th><th class="n">Calls</th><th>Last call</th><th>Status</th><th></th></tr>${rows || '<tr><td colspan="6" class="muted">No webhooks yet.</td></tr>'}</table></div>
    <div class="card" style="margin-top:14px"><h3>Add a webhook</h3><form class="form" data-form="newhook"><label>Name<input name="name" required placeholder="New order"></label><label>Event note<input name="event" placeholder="order.created"></label><button class="btn primary">Create</button></form></div>${detail}`;
}

// ---------- rendering ----------
let page = 'overview', tabGroup = null;
function render(force) {
  if (!started) return;
  const a = document.activeElement;
  if (!force && a && a.closest('main') && ['INPUT', 'SELECT', 'TEXTAREA'].includes(a.tagName)) { pendingRender = true; return; }
  pendingRender = false;
  const errCount = (cfg().syncErrors || []).length;
  const link = ([k, l]) => `<a href="#/${k}" class="${k === page ? 'on' : ''}">${esc(l)}${k === 'errors' && errCount ? ` (${errCount})` : ''}</a>`;
  $('#nav').innerHTML = '<div class="logo"><span>H</span>Hisab</div>' + NAV_GROUPS.map(([label, keys]) => `<div class="nav-sec"><div class="nav-label">${esc(label)}</div>${NAV.filter(([k]) => keys.includes(k)).map(link).join('')}</div>`).join('');
  const open = window.__navGroup || '';
  const openKeys = (NAV_GROUPS.find(([label]) => label === open) || [null, []])[1];
  $('#navGroups').innerHTML = `<div class="ng-bar">${NAV_GROUPS.map(([label]) => `<button type="button" class="${open === label ? 'on' : ''}" data-click="navgroup" data-g="${esc(label)}">${label}</button>`).join('')}</div>${openKeys.length ? `<div class="ng-links">${NAV.filter(([k]) => openKeys.includes(k)).map(link).join('')}</div>` : ''}`;
  $('#hdrStats').innerHTML = headerStats();
  $('#pageTitle').textContent = (NAV.find(n => n[0] === page) || [])[1] || '';
  const fn = VIEWS[page] || VIEWS.overview;
  $('#main').innerHTML = fn();
  if (page === 'overview') document.querySelectorAll('.chart-scroll').forEach(el => { el.scrollLeft = el.scrollWidth; });
  if (page === 'sheet') {
    const tw = document.querySelector('#main .tw');
    if (tw) tw.scrollLeft = tw.scrollWidth;
  }
  const last = latestSnap();
  $('#syncState').textContent = last ? 'Last row: ' + dt(last.ts) : 'No rows yet';
  paintCalcProgress();
}
function route() { page = (location.hash.replace('#/', '') || 'overview'); window.__navGroup = ''; tabGroup = null; render(true); }
function headerStats() {
  const t = compute(), last = latestSnap(), profit = last ? profitCalc()(last) : null;
  let expense = null;
  for (const it of S.items) {
    if (it.archived) continue;
    if (it.externalId !== 'expense-meta' && it.externalId !== 'expense-other') continue;
    expense = (expense || 0) + (toBase(it.balance || 0, it.currency) || 0);
  }
  const cell = (label, value, cls) => `<div class="hstat"><span>${label}</span><b class="${cls}">${value}</b></div>`;
  return cell('Net worth', fmt(t.nw), '')
    + cell('Last profit', profit == null ? '—' : sgn(profit), profit > 0 ? 'pos' : profit < 0 ? 'neg' : '')
    + cell('Expense', expense == null ? '—' : fmt(expense), '');
}

// ---------- daily change graph: net worth movement since the 12:00 AM (Dhaka) opening ----------
const minsOfDay = iso => { const [h, m] = hhmm(new Date(iso)).split(':').map(Number); return h * 60 + m; };
const sgn = m => (m > 0 ? '+' : '') + fmt(m);
const EXPENSE_NAMES = new Set(['Meta Ads', 'Expenses except Meta Ads']);
function expenseNow() {
  let s = 0;
  for (const it of S.items) {
    if (it.archived || it.include === false) continue;
    if (it.externalId !== 'expense-meta' && it.externalId !== 'expense-other') continue;
    s += toBase(it.balance || 0, it.currency) || 0;
  }
  return s;
}
function expenseOf(snap) {
  if (!snap?.names) return 0;
  let s = 0;
  for (const [id, name] of Object.entries(snap.names)) {
    if (!EXPENSE_NAMES.has(name)) continue;
    s += Number(snap.values?.[id]) || 0;
  }
  return s;
}
function finUpTo(date, iso) { // money kept out of today's profit: Add +, Withdraw −. Other owner/loan money only while that box is ticked.
  const c = cfg(), ex = !!window.__exFin; let s = 0;
  for (const e of S.ledger) {
    if (e.date !== date || (iso && e.ts > iso)) continue;
    const r = c.types[e.type] || (e.type === 'capital_add' ? DEF.types.capital_add : e.type === 'capital_withdraw' ? DEF.types.capital_withdraw : null);
    if (!r) continue;
    const capital = e.type === 'capital_add' || e.type === 'capital_withdraw';
    if (!capital && !(ex && r.fin)) continue;
    const v = (toBase(e.amount, e.currency, c) || 0) * (e.sign || 1);
    s += r.cash === 'in' ? v : r.cash === 'out' ? -v : 0;
  }
  return s;
}
function todayChange() {
  const date = todayStr(), t = compute(), b = dayBounds(date), open = b.opening?.totals || null;
  const nowIso = new Date().toISOString(), pts = [];
    if (open) {
    pts.push({ m: 0, v: 0, time: '12:00 AM', day: 'শুরু' });
    for (const s of sortedSnaps().filter(s => s.date === date)) pts.push({ m: minsOfDay(s.ts), v: s.totals.nw - open.nw - finUpTo(date, s.ts) + expenseOf(s), ts: s.ts });
    const todayLabel = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short' }).format(new Date());
    pts.push({ m: minsOfDay(nowIso), v: t.nw - open.nw - finUpTo(date, nowIso) + expenseNow(), time: 'এখন', day: todayLabel });
  }
  return { open, t, pts, now: open ? pts[pts.length - 1].v : null, complete: b.openingIsPrev };
}
function dailyChanges(limit = 30) {
  const snaps = sortedSnaps(), dates = [...new Set(snaps.map(s => s.date))].slice(-limit);
  return dates.map(d => {
    const day = snaps.filter(s => s.date === d), prev = [...snaps].reverse().find(s => s.date < d), open = prev || day[0], close = day[day.length - 1];
    let closeNw = close.totals.nw, closeAssets = close.totals.assets, extra = expenseOf(close);
    if (d === todayStr()) { const t = compute(); closeNw = t.nw; closeAssets = t.assets; extra = expenseNow(); }
    return { date: d, open: open.totals.nw, close: closeNw, assets: closeAssets, change: closeNw - open.totals.nw - finUpTo(d, d === todayStr() ? new Date().toISOString() : null) + extra, complete: !!prev };
  });
}
// Profit column for the Live Sheet: net worth of the row minus the net worth at the day's opening (last row of the previous day). Restarts at 0 each Dhaka day.
function profitCalc() {
  const open = {}; let prev = null, cd = null;
  for (const s of sortedSnaps()) { if (s.date !== cd) { open[s.date] = prev !== null ? prev : s.totals.nw; cd = s.date; } prev = s.totals.nw; }
  return s => s.totals.nw - open[s.date] - finUpTo(s.date, s.ts) + expenseOf(s);
}
function fmtChart(m) {
  if (m == null) return '—';
  const neg = m < 0, a = Math.abs(m) / 100;
  let s;
  if (a >= 100000) s = (a / 100000).toFixed(a >= 1000000 ? 1 : 2) + ' লাখ';
  else if (a >= 1000) s = Math.round(a).toLocaleString('en-IN');
  else if (Math.abs(a - Math.round(a)) < 0.005) s = String(Math.round(a));
  else s = a.toFixed(2);
  return (neg ? '-' : '') + s;
}
function chartWhen(p) {
  if (p.time) return { time: p.time, day: p.day || '' };
  const d = new Date(p.ts);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short' }).format(d);
  return { time, day };
}
function labeledChart(points, aria) {
  if (!points || points.length < 2) return '<p class="muted">দুইবারের হিসাব হলে এই গ্রাফ আসবে।</p>';
  const col = 84, bot = 38, plotT = 30, plotB = 10, H = 220;
  const W = 8 + points.length * col + 8;
  const vals = points.map(p => p.v);
  let mn = Math.min(...vals), mx = Math.max(...vals);
  if (mn === mx) { mn -= 100; mx += 100; }
  const pad = (mx - mn) * 0.12 || 100;
  mn -= pad; mx += pad;
  const Y = v => plotT + (mx - v) / (mx - mn) * (H - bot - plotT - plotB);
  const X = i => 8 + i * col + col / 2;
  const poly = points.map((p, i) => `${X(i)},${Y(p.v)}`).join(' ');
  const zero = mn < 0 && mx > 0 ? `<line x1="4" x2="${W - 4}" y1="${Y(0)}" y2="${Y(0)}" stroke="#cbd5e1" stroke-dasharray="3 3"/>` : '';
  const cols = points.map((p, i) => {
    const prev = i ? points[i - 1].v : p.v;
    const fill = p.v > prev ? '#15803d' : p.v < prev ? '#b91c1c' : '#1c2430';
    const when = chartWhen(p);
    const last = i === points.length - 1;
    return `<text x="${X(i)}" y="15" text-anchor="middle" font-size="11" font-weight="700" fill="${fill}">${esc(fmtChart(p.v))}</text>
      <circle cx="${X(i)}" cy="${Y(p.v)}" r="${last ? 5 : 3.5}" fill="${last ? '#0f766e' : fill}"/>
      <text x="${X(i)}" y="${H - 22}" text-anchor="middle" font-size="11" font-weight="600" fill="#1c2430">${esc(when.time)}</text>
      <text x="${X(i)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="#6b7686">${esc(when.day)}</text>`;
  }).join('');
  return `<div class="chart-scroll"><svg class="chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(aria || 'chart')}">${zero}<polyline fill="none" stroke="#0f766e" stroke-width="2" points="${poly}" stroke-linejoin="round"/>${cols}</svg></div>`;
}
function pointsForTotal(key) {
  return sortedSnaps().map(s => ({ ts: s.ts, v: s.totals?.[key] ?? 0 }));
}
function pointsForName(name, abs) {
  const out = [];
  for (const s of sortedSnaps()) {
    let v = null;
    for (const [id, n] of Object.entries(s.names || {})) {
      if (n === name) { v = s.values?.[id]; break; }
    }
    if (v == null) continue;
    v = saleSheetValue(s, name, v);
    out.push({ ts: s.ts, v: abs ? Math.abs(v) : v });
  }
  return out;
}
function chartCard(title, hint, pts) {
  if (!pts || pts.length < 2) return '';
  const first = pts[0].v, last = pts[pts.length - 1].v, d = last - first;
  return `<div class="card"><h3>${esc(title)} <b class="${d > 0 ? 'pos' : d < 0 ? 'neg' : ''}">${fmt(last)}</b></h3>
    <p class="muted">${hint ? esc(hint) + ' · ' : ''}শুরু ${fmt(first)} · এই গ্রাফে ${sgn(d)} · উপরে অঙ্ক, নিচে সময়</p>
    ${labeledChart(pts, title)}</div>`;
}
function historyCharts() {
  const named = [
    ['ইকমড্রাইভ', [
      ['Ecomdrive · Shipped', 'Shipped', 'শিটের অঙ্ক, আগে ডেলিভারি বাদ, তারপর ১% COD'],
      ['Ecomdrive · Pending', 'Pending', 'শিটের অঙ্ক, আগে ডেলিভারি বাদ, তারপর ১% COD'],
      ['Ecomdrive · RTS', 'RTS', 'শিটের অঙ্ক, আগে ডেলিভারি বাদ, তারপর ১% COD'],
      ['Ecomdrive · Pending Return', 'Pending Return', 'শিটের অঙ্ক, আগে ডেলিভারি বাদ, তারপর ১% COD']
    ]],
    ['Steadfast', [
      ['Steadfast · Awaiting approval', 'In review', 'শিটের অঙ্ক, ১% COD কাটা'],
      ['Steadfast · Balance', 'ব্যালেন্স', 'Steadfast যে টাকা জমা করেছে'],
      ['Steadfast · Approval pending COD delivery charge', 'Approval charge', 'approval পাতার Charge, শিট থেকে কাটা']
    ]],
    ['Pathao', [
      ['Pathao · Upcoming payment', 'Balance', ''],
      ['Pathao · In review', 'In review', ''],
      ['Pathao · Last processing', 'Last processing', ''],
      ['Pathao · Last paid', 'Last paid', '']
    ]],
    ['খরচ', [
      ['Meta Ads', 'Meta Ads', 'আজকের মেটা অ্যাডস। Count চালু থাকলে লাভের সাথে যোগ'],
      ['Expenses except Meta Ads', 'Meta বাদে খরচ', 'আজকের বাকি খরচ। Count চালু থাকলে লাভের সাথে যোগ']
    ]]
  ];
  const used = new Set(named.flatMap(([, rows]) => rows.map(r => r[0])));
  const groups = named.map(([title, rows]) => [title, rows.map(([name, label, hint]) => chartCard(label, hint, pointsForName(name, name.endsWith('delivery') || name.endsWith('delivery charge'))))]);
  const cash = [], dues = [];
  for (const s of sortedSnaps()) {
    for (const name of Object.values(s.names || {})) {
      if (used.has(name) || name === 'Owner Adjustment' || ECOM_FEE.has(name)) continue;
      used.add(name);
      const item = S.items.find(i => i.name === name);
      const card = chartCard(shortName(name), item?.group === 'supplier' ? 'বাকি, নেট ওয়ার্থ থেকে কাটা' : '', pointsForName(name, false));
      if (item?.group === 'supplier') dues.push(card);
      else cash.push(card);
    }
  }
  const profitOf = profitCalc();
  const profitPts = sortedSnaps().map(s => ({ ts: s.ts, v: profitOf(s) }));
  const head = [
    chartCard('নেট ওয়ার্থ', 'ক্যাশ + কুরিয়ার + স্টক − সাপ্লায়ার + ইকমড্রাইভ বিক্রি − ডেলিভারি', pointsForTotal('nw')),
    chartCard('আজকের লাভ', 'প্রতিদিন রাত ১২টায় আবার ০ থেকে শুরু', profitPts),
    chartCard('ক্যাশ', 'ব্যাংক, বিকাশ, নগদ, ডলার মিলিয়ে', pointsForTotal('cash')),
    chartCard('কুরিয়ার পাওনা', 'Steadfast আর Pathao, শিটে যা গোনা হয়', pointsForTotal('courier')),
    chartCard('স্টক', '', pointsForTotal('stock')),
    chartCard('সাপ্লায়ার বাকি', 'নেট ওয়ার্থ থেকে কাটা হয়', pointsForTotal('supplier'))
  ].join('');
  const body = groups.map(([title, cards]) => {
    const html = cards.filter(Boolean).join('');
    return html ? `<h2 class="chart-h">${esc(title)}</h2>${html}` : '';
  }).join('');
  const rest = (cash.filter(Boolean).length || dues.filter(Boolean).length)
    ? `<h2 class="chart-h">ক্যাশ, ডলার আর বাকি</h2>${cash.filter(Boolean).join('')}${dues.filter(Boolean).join('')}` : '';
  return `<h2 class="chart-h">মোট</h2>${head}${body}${rest}`;
}
function dailyPanel() {
  const tc = todayChange(), rows = dailyChanges(30), n = tc.now;
  return `<div class="card"><div class="form" style="justify-content:space-between;align-items:center"><h3 style="margin:0">আজকের লাভ/ক্ষতি · Today's change</h3>
    <label style="flex-direction:row;align-items:center;color:inherit"><input type="checkbox" data-act="exfin" ${window.__exFin ? 'checked' : ''}> leave out owner / loan money</label></div>
    <div style="display:flex;gap:24px;flex-wrap:wrap;align-items:baseline;margin:8px 0">
      <div class="v ${n == null ? '' : n > 0 ? 'pos' : n < 0 ? 'neg' : ''}" style="font-size:28px;font-weight:700">${n == null ? 'Incomplete' : sgn(n)}</div>
      <div class="muted">${tc.open ? `Started at ${fmt(tc.open.nw)} net worth (12 AM) → now ${fmt(tc.t.nw)}` : 'No opening snapshot yet'}<br>Total assets now ${fmt(tc.t.assets)}${tc.open ? ' (opening ' + fmt(tc.open.assets) + ')' : ''} · dues ${fmt(tc.t.liab)}</div></div>
    ${labeledChart(tc.pts, 'আজকের লাভ')}
    <p class="muted">প্রতিটি ঘরে উপরে অঙ্ক, নিচে সময়। সবুজ বেড়েছে, লাল কমেছে। রাত ১২টায় ০ থেকে শুরু। ব্যাংক থেকে সাপ্লায়ার দিলে এই লাইন নড়ে না, কারণ ক্যাশ আর বাকি দুটোই কমে। Add বা Withdraw আজকের এই লাইন থেকে বাদ। Expenses-এ Count চালু থাকলে আজকের সেই খরচ এই লাইনে যোগ হয়। রাত ১২টার পর আবার ০।${tc.open && !tc.complete ? ' আগের দিনের সারি নেই, তাই আজকের প্রথম সারি থেকে শুরু।' : ''}</p></div>
  <div class="card"><h3>প্রতিদিনের ফলাফল</h3>${labeledChart(rows.map(r => { const d = new Date(r.date + 'T12:00:00+06:00'); const time = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short' }).format(d); return { v: r.change, time, day: r.complete ? 'পুরো দিন' : 'খোলা' }; }), 'প্রতিদিনের ফলাফল')}
    <div class="tw" style="margin-top:10px;max-height:320px"><table><tr><th>Date</th><th class="n">Opening net worth</th><th class="n">Closing net worth</th><th class="n">Change</th><th class="n">Total assets at close</th><th></th></tr>
    ${[...rows].reverse().map(r => `<tr><td>${r.date}</td><td class="n">${fmt(r.open)}</td><td class="n">${fmt(r.close)}</td><td class="n ${r.change > 0 ? 'pos' : r.change < 0 ? 'neg' : ''}">${sgn(r.change)}</td><td class="n">${fmt(r.assets)}</td><td>${r.complete ? '' : '<span class="pill warn">incomplete opening</span>'}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No rows yet.</td></tr>'}</table></div></div>`;
}

function kpiData() {
  const t = compute(), c = cfg(), d = daily(todayStr()), b = dayBounds(todayStr());
  const pv = b.opening?.totals || null;
  const sync = g => { const xs = S.items.filter(i => !i.archived && g.includes(i.group)).map(i => i.updatedAt).filter(Boolean).sort(); return xs[xs.length - 1]; };
  const cards = [
    { k: 'cash', label: 'Total Liquid Cash', cur: t.cash, prev: pv?.cash, g: ['cash'], sync: sync(['cash']) },
    { k: 'courier', label: 'Total Courier Receivables', cur: t.courier, prev: pv?.courier, g: ['courier'], sync: sync(['courier']) },
    { k: 'stock', label: 'Total Stock Value', cur: t.stock, prev: pv?.stock, g: ['stock'], sync: sync(['stock']) },
    { k: 'supplier', label: 'Total Supplier Dues', cur: t.supplier + t.otherLiab, prev: pv?.supplier, g: ['supplier', 'otherLiab'], sync: sync(['supplier', 'otherLiab']), liab: true },
    { k: 'owner', label: 'Owner Adjustment', cur: t.owner, prev: pv?.owner, g: ['owner'], sync: sync(['owner']) },
    { k: 'nw', label: 'Total Net Worth', cur: t.nw, prev: pv?.nw, g: null, sync: latestSnap()?.ts },
    { k: 'cf', label: 'Daily Cash Flow', cur: d.cf, prev: null, note: 'From ledger entries only · transfers excluded' },
    { k: 'profit', label: 'Daily Net Profit', cur: d.profit, prev: null, note: d.label },
    { k: 'pnw', label: 'Previous Day Net Worth', cur: b.prevDay?.totals?.nw ?? null, prev: null, note: b.prevDay ? 'Closing ' + b.prevDay.date : 'No earlier snapshot – incomplete' },
    { k: 'ach', label: 'Asset Change Today', cur: pv ? t.nw - pv.nw : null, prev: null, note: pv ? 'vs opening snapshot (includes transfers/deposits – not profit)' : 'No opening snapshot – incomplete' }
  ];
  return { cards, t, c, d, b };
}
function breakdown(k) {
  const { t, c, d, b } = kpiData();
  const lines = g => t.parts.filter(p => g.includes(p.it.group)).map(p => `<tr class="${p.inc ? '' : 'dim'}"><td>${esc(uiName(p.it.name))}</td><td class="n">${fmt(p.it.balance, p.it.currency)}</td><td class="n">${p.it.currency !== c.base ? 'rate ' + esc(c.rates?.[p.it.currency] || '?') : ''}</td><td class="n">${fmt(p.v)}</td><td>${p.inc ? 'counted' : 'excluded'}</td></tr>`).join('');
  const tb = h => `<div class="tw"><table><tr><th>Item</th><th class="n">Original</th><th class="n">Rate</th><th class="n">In ${c.base}</th><th>Status</th></tr>${h}</table></div>`;
  if (['cash', 'courier', 'stock', 'supplier', 'owner'].includes(k)) {
    const g = k === 'supplier' ? ['supplier', 'otherLiab'] : k === 'stock' ? ['stock', 'otherAsset'] : [k];
    return `<h3>${esc(kpiData().cards.find(x => x.k === k).label)}</h3>${tb(lines(g))}<p class="muted">Excluded items (e.g. overlapping courier statuses) are not counted. Edit the “Count” box on the item page.</p>`;
  }
  if (k === 'nw') return `<h3>Net worth breakdown</h3><div class="tw"><table>
    <tr><td>Liquid cash</td><td class="n">${fmt(t.cash)}</td></tr><tr><td>Courier receivables${codPct(c) ? ` (In review after ${codPct(c)}% COD)` : ''}</td><td class="n">${fmt(t.courier)}</td></tr>
    <tr><td>Stock value</td><td class="n">${fmt(t.stock + t.otherAsset)}</td></tr><tr class="tot"><td>Total assets</td><td class="n">${fmt(t.assets)}</td></tr>
    <tr><td>Supplier dues + other liabilities</td><td class="n">- ${fmt(t.liab)}</td></tr>
    <tr><td>EcomDrive Shipped, Pending, RTS, Pending Return${codPct(c) ? ` (delivery off, then ${codPct(c)}% COD)` : ' (delivery off)'}</td><td class="n">${fmt(t.ecomSale)}</td></tr>
    <tr><td>Owner adjustment (${c.ownerInNetWorth ? 'added, per setting' : 'NOT added – avoid double count'})</td><td class="n">${c.ownerInNetWorth ? fmt(t.owner) : '—'}</td></tr>
    <tr class="tot"><td>Net worth</td><td class="n">${fmt(t.nw)}</td></tr></table></div>${t.warn.map(w => `<p class="err">${esc(w)}</p>`).join('')}`;
  if (k === 'cf' || k === 'profit') return `<h3>${k === 'cf' ? 'Daily cash flow' : 'Daily net profit'} · ${todayStr()}</h3><div class="tw"><table>
    <tr><td>External inflows (operating)</td><td class="n">${fmt(d.inflow)}</td></tr><tr><td>External outflows (operating)</td><td class="n">- ${fmt(d.outflow)}</td></tr>
    <tr><td>Financing (owner/loans), signed</td><td class="n">${fmt(d.fin)}</td></tr><tr class="tot"><td>Cash flow</td><td class="n">${fmt(d.cf)}</td></tr>
    <tr><td>Recognized revenue</td><td class="n">${fmt(d.rev)}</td></tr><tr><td>Expenses / COGS</td><td class="n">- ${fmt(d.exp)}</td></tr><tr class="tot"><td>Net profit</td><td class="n">${fmt(d.profit)}</td></tr></table></div><p class="muted">Status: ${esc(d.label)}. ${d.E.length} ledger entries today.</p>`;
  if (k === 'pnw') return `<p>Closing net worth of the last snapshot before today: ${b.prevDay ? fmt(b.prevDay.totals.nw) + ' (' + dt(b.prevDay.ts) + ')' : 'not available – no earlier snapshots, shown as incomplete'}.</p>`;
  return `<p>Current net worth ${fmt(t.nw)} minus opening net worth ${b.opening ? fmt(b.opening.totals.nw) : 'n/a'}. This is the change in position and includes deposits, withdrawals and transfers – it is not profit.</p>`;
}

function activeItems(groups) {
  return S.items.filter(i => !groups || groups.includes(i.group)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}
function courierSide(it) {
  const name = String(it.name || '').toLowerCase();
  const category = String(it.category || '').toLowerCase();
  if (category === 'steadfast' || name.startsWith('steadfast')) return 'steadfast';
  if (category === 'pathao' || name.startsWith('pathao')) return 'pathao';
  return 'other';
}
function itemRow(it) {
  const fee = ECOM_FEE.has(it.name);
  const shown = fee ? Math.abs(it.balance || 0) : (it.balance || 0);
  const prevShown = fee ? Math.abs(it.prev || 0) : it.prev;
  const countedUi = isCountOff(it.name) ? false : it.include !== false;
  const codNote = ECOM_SALE.has(it.name) ? `<small>Sheet ${fmt(sheetSaleNow(it))} · delivery ${fmt(deliveryMinor(it.name))} off first${codPct() > 0 ? ` · then COD ${codPct()}%` : ''}</small>` : '';
  return `<tr class="${it.archived ? 'dim' : ''}"><td>${esc(uiName(it.name))}${codNote}${it.category ? `<small>${esc(it.category)}</small>` : ''}</td><td>${esc(it.currency)}</td>
  <td class="n"><input class="amt" data-act="bal" data-id="${it.id}" value="${inputVal(shown)}"></td>
  <td class="n">${fmt(prevShown, it.currency)}</td><td class="n">${chg(shown, prevShown)}</td>
  <td><span class="pill">${esc(it.source || 'manual')}</span></td>
  <td><input type="checkbox" data-act="inc" data-id="${it.id}" ${countedUi ? 'checked' : ''} title="Count in totals / Live Sheet"></td>
  <td><button class="btn sm" data-click="up" data-id="${it.id}">↑</button> <button class="btn sm" data-click="down" data-id="${it.id}">↓</button> <button class="btn sm" data-click="rename" data-id="${it.id}">Rename</button> <button class="btn sm danger" data-click="archive" data-id="${it.id}">${it.archived ? 'Restore' : 'Archive'}</button>${it.group === 'cash' ? ` <button class="btn sm danger" data-click="delitem" data-id="${it.id}">Delete</button>` : ''}</td></tr>`;
}

const UI_NAME = {
  'Pathao · Upcoming payment': 'Pathao · Balance',
  'Steadfast · Awaiting approval': 'Steadfast · In review',
  'Steadfast · Approval pending COD delivery charge': 'Steadfast · Approval charge',
  'Steadfast · Unpaid amount': 'Steadfast · Last unpaid',
  'Steadfast · Last paid amount': 'Steadfast · Last paid'
};
function uiName(name) { return UI_NAME[name] || name || ''; }
function shortName(name) {
  return uiName(name).replace(/^Ecomdrive · /, '').replace(/ delivery$/, ' ডেলিভারি').replace(' · ', ' ');
}
function sheetShown(name, v) {
  if (v == null) return null;
  return ECOM_FEE.has(name) ? Math.abs(v) : v;
}
function moveKind(name, id) {
  if (ECOM_SALE.has(name)) return 'sale';
  if (ECOM_FEE.has(name)) return 'fee';
  if (String(name).startsWith('Steadfast')) return 'steadfast';
  if (String(name).startsWith('Pathao')) return 'pathao';
  if (EXPENSE_NAMES.has(name)) return 'expense';
  const g = S.items.find(i => i.id === id)?.group;
  if (g === 'stock' || name === 'Total Stock Value') return 'stock';
  if (g === 'cash' || g === 'supplier' || g === 'owner' || g === 'courier') return g;
  return 'other';
}
function pipelineRoutes(names) {
  const routes = [];
  for (let dist = 1; dist < names.length; dist++) {
    for (let i = 0; i + dist < names.length; i++) {
      const a = names[i], b = names[i + dist];
      routes.push([a, b, `${shortName(a)} থেকে ${shortName(b)}-এ এগিয়েছে।`, '']);
    }
  }
  for (let dist = 1; dist < names.length; dist++) {
    for (let i = 0; i + dist < names.length; i++) {
      const a = names[i], b = names[i + dist];
      routes.push([b, a, `${shortName(b)} থেকে ${shortName(a)}-এ ফিরে গেছে।`, '']);
    }
  }
  return routes;
}
function sheetWhy(id, prevId) {
  const cur = S.snapshots.find(s => s.id === id);
  const prev = prevId ? S.snapshots.find(s => s.id === prevId) : null;
  if (!cur) return '<p>এই সারি আর খুঁজে পাওয়া যায়নি।</p>';
  if (!prev) return `<h3>তুলনা করার আগের সারি নেই</h3><p class="sheet-id">এই সারির ID <code>${esc(cur.id)}</code></p><p>এটা শিটের প্রথম সারি (${esc(dt(cur.ts))})। নিচে আর সারি নেই, তাই কী বেড়েছে আর কী কমেছে বলা যায় না।</p><p>এই মুহূর্তের নেট ওয়ার্থ <b>${fmt(cur.totals?.nw)}</b>।</p>`;
  const ids = [...new Set([...Object.keys(cur.values || {}), ...Object.keys(prev.values || {})])];
  const pool = [];
  for (const itemId of ids) {
    const name = cur.names?.[itemId] || prev.names?.[itemId] || S.items.find(i => i.id === itemId)?.name || itemId;
    if (ECOM_FEE.has(name)) continue;
    const item = S.items.find(i => i.id === itemId) || { id: itemId, name };
    const curRaw = cur.values?.[itemId], prevRaw = prev.values?.[itemId];
    const curV = curRaw == null ? 0 : (ECOM_SALE.has(name) ? snapCell(cur, item) : sheetShown(name, curRaw));
    const prevV = prevRaw == null ? 0 : (ECOM_SALE.has(name) ? snapCell(prev, item) : sheetShown(name, prevRaw));
    const delta = curV - prevV;
    if (!delta) continue;
    pool.push({ id: itemId, name, kind: moveKind(name, itemId), delta, left: delta, cur: curRaw == null ? null : curV, prev: prevRaw == null ? null : prevV });
  }
  const nw0 = prev.totals?.nw || 0, nw1 = cur.totals?.nw || 0, nwD = nw1 - nw0;
  const head = `<h3>টাকা কোন দিক থেকে কোন দিকে গেছে</h3><p class="sheet-id">এই সারির ID <code>${esc(cur.id)}</code> · আগের সারি <code>${esc(prev.id)}</code></p><p class="muted">${esc(dt(cur.ts))} · আগের সারি ${esc(dt(prev.ts))}</p>
    <div class="move-nw ${nwD > 0 ? 'up' : nwD < 0 ? 'down' : ''}"><span>নেট ওয়ার্থ</span><b>${fmt(nw1)}</b><small>আগে ${fmt(nw0)}${nwD ? ` · ${nwD > 0 ? '▲' : '▼'} ${fmt(Math.abs(nwD))}` : ' · একই আছে'}</small></div>`;
  if (!pool.length) return head + '<p>এই সারি আর আগের সারির অঙ্ক একই। এক জায়গা থেকে অন্য জায়গায় টাকা যায়নি।</p>';
  const stories = [];
  const saleRoutes = [
    ['Ecomdrive · Pending', 'Ecomdrive · Shipped', 'Pending-এর অর্ডার শিপ হয়ে Shipped-এ গেছে।', ''],
    ['Ecomdrive · Shipped', 'Ecomdrive · RTS', 'Shipped অর্ডার ফিরে RTS-এ এসেছে।', ''],
    ['Ecomdrive · Shipped', 'Ecomdrive · Pending Return', 'Shipped অর্ডার Pending Return-এ গেছে।', ''],
    ['Ecomdrive · Pending', 'Ecomdrive · RTS', 'Pending অর্ডার RTS হয়ে গেছে।', ''],
    ['Ecomdrive · Pending', 'Ecomdrive · Pending Return', 'Pending অর্ডার Pending Return-এ গেছে।', ''],
    ['Ecomdrive · RTS', 'Ecomdrive · Pending Return', 'RTS থেকে Pending Return-এ গেছে।', ''],
    ['Ecomdrive · Pending Return', 'Ecomdrive · RTS', 'Pending Return থেকে RTS-এ গেছে।', ''],
    ['Ecomdrive · Shipped', 'Ecomdrive · Pending', 'Shipped থেকে অর্ডার আবার Pending-এ ফিরেছে।', ''],
    ['Ecomdrive · RTS', 'Ecomdrive · Shipped', 'RTS থেকে আবার Shipped-এ উঠেছে।', ''],
    ['Ecomdrive · RTS', 'Ecomdrive · Pending', 'RTS থেকে Pending-এ ফিরেছে।', ''],
    ['Ecomdrive · Pending Return', 'Ecomdrive · Shipped', 'Pending Return থেকে Shipped-এ ফিরেছে।', ''],
    ['Ecomdrive · Pending Return', 'Ecomdrive · Pending', 'Pending Return থেকে Pending-এ ফিরেছে।', '']
  ];
  const routes = saleRoutes.concat(
    [
      ['Ecomdrive · Shipped', 'Steadfast · Awaiting approval', 'Shipped থেকে ডেলিভারি হয়ে Steadfast In review-এ গেছে।', 'shipout'],
      ['Ecomdrive · Shipped', 'Pathao · In review', 'Shipped থেকে ডেলিভারি হয়ে Pathao-এর পেন্ডিংয়ে (In review) গেছে।', 'shipout'],
      ['Ecomdrive · Shipped', 'Pathao · Upcoming payment', 'Shipped থেকে ডেলিভারি হয়ে Pathao Balance-এ গেছে।', 'shipout'],
      ['Steadfast · Awaiting approval', 'Ecomdrive · Shipped', 'Steadfast In review থেকে আবার Shipped-এ ফিরে এসেছে।', 'shipout'],
      ['Pathao · In review', 'Ecomdrive · Shipped', 'Pathao পেন্ডিং থেকে আবার Shipped-এ ফিরে এসেছে।', 'shipout'],
      ['Pathao · Upcoming payment', 'Ecomdrive · Shipped', 'Pathao Balance থেকে আবার Shipped-এ ফিরে এসেছে।', 'shipout']
    ],
    pipelineRoutes(['Steadfast · On the way', 'Steadfast · Awaiting approval', 'Steadfast · Unpaid amount', 'Steadfast · Last paid amount', 'Steadfast · Balance']).map(r => [r[0], r[1], r[2], 'pipe']),
    pipelineRoutes(['Pathao · Upcoming payment', 'Pathao · In review', 'Pathao · Last processing', 'Pathao · Last paid']).map(r => [r[0], r[1], r[2], 'pipe'])
  );
  const findSide = (name, sign) => pool.find(p => p.name === name && (sign < 0 ? p.left < 0 : p.left > 0));
  const pushStockSale = (stockMove, cost, saleMove, sale, label, text) => {
    const profit = sale - cost;
    const from = [{ name: stockMove.name, amt: cost, up: false }];
    let note = '';
    if (profit > 0) {
      from.push({ name: 'লাভ', amt: profit, plain: true });
      const gross = undoAfterCod(sale);
      const full = gross - cost;
      note = `স্টক ${fmt(cost)} + লাভ ${fmt(profit)} = ${label} ${fmt(sale)}।`;
      if (codPct() > 0 && gross !== sale) note += ` COD-এর আগে বিক্রি ${fmt(gross)}, লাভ ${fmt(full)}। শিটের ${label} থেকে ${codPct()}% COD আগেই কাটা।`;
    } else if (profit < 0) note = `স্টক ${fmt(cost)}, ${label} ${fmt(sale)}। ${label} স্টকের চেয়ে ${fmt(-profit)} কম।`;
    else note = `স্টক ${fmt(cost)} = ${label} ${fmt(sale)}।`;
    stories.push({ from, to: [{ name: saleMove.name, amt: sale, up: true }], text, note });
    stockMove.left += cost;
    saleMove.left -= sale;
  };
  let pending = pool.find(p => p.name === 'Ecomdrive · Pending');
  const rtsUp = pool.find(p => p.name === 'Ecomdrive · RTS' && p.left > 0);
  const stockDownEarly = pool.find(p => p.kind === 'stock' && p.left < 0);
  const shippedDownEarly = pool.find(p => p.name === 'Ecomdrive · Shipped' && p.left < 0);
  if (rtsUp && rtsUp.left > 0 && (pending || stockDownEarly || !shippedDownEarly)) {
    const move = rtsUp.left;
    if (!pending) pending = { name: 'Ecomdrive · Pending', kind: 'sale', left: 0, delta: 0 };
    stories.push({
      from: [{ name: pending.name, amt: move, up: false }],
      to: [{ name: rtsUp.name, amt: move, up: true }],
      text: 'RTS-এ পণ্য এলে সেটা Pending থেকে আসে।',
      note: ''
    });
    pending.left += move;
    rtsUp.left = 0;
  }
  const stockMove = pool.find(p => p.kind === 'stock' && p.left < 0);
  if (stockMove && stockMove.left < 0 && pending && pending.left > 0) {
    const sale = pending.left, cost = -stockMove.left, ratio = sale / cost;
    if (ratio >= 0.4 && ratio <= 3) pushStockSale(stockMove, cost, pending, sale, 'Pending', 'নতুন অর্ডার ঢুকেছে। স্টক আগে Pending-এ উঠেছে। মাঝের পার্থক্য লাভ।');
  }
  const rtsLeftOver = pool.find(p => p.name === 'Ecomdrive · RTS' && p.left > 0);
  if (stockMove && stockMove.left < 0 && rtsLeftOver && rtsLeftOver.left > 0) {
    const sale = rtsLeftOver.left, cost = -stockMove.left, ratio = sale / cost;
    if (ratio >= 0.4 && ratio <= 3) pushStockSale(stockMove, cost, rtsLeftOver, sale, 'RTS', 'Pending এই স্টক নেয়নি। বাকি স্টক RTS-এ উঠেছে। মাঝের পার্থক্য লাভ।');
  }
  const rtsDown = pool.find(p => p.name === 'Ecomdrive · RTS' && p.left < 0);
  const shippedUp = pool.find(p => p.name === 'Ecomdrive · Shipped' && p.left > 0);
  if (rtsDown && shippedUp && rtsDown.left < 0 && shippedUp.left > 0) {
    const small = Math.min(-rtsDown.left, shippedUp.left), big = Math.max(-rtsDown.left, shippedUp.left);
    const fitShip = small / big;
    const pendUp = pending && pending.left > 0 ? pending : null;
    const fitBack = pendUp ? Math.min(-rtsDown.left, pendUp.left) / Math.max(-rtsDown.left, pendUp.left) : 0;
    if (fitShip >= 0.5 && fitShip > fitBack) {
      stories.push({
        from: [{ name: rtsDown.name, amt: small, up: false }],
        to: [{ name: shippedUp.name, amt: small, up: true }],
        text: 'RTS থেকে পণ্য Shipped-এ উঠেছে।',
        note: big === small ? '' : `মিলেছে ${fmt(small)}। বাকি ${fmt(big - small)} এই জোড়ায় আসেনি।`
      });
      rtsDown.left += small;
      shippedUp.left -= small;
    }
  }
  const approvalCharge = 'Steadfast · Approval pending COD delivery charge';
  const shippedMove = pool.find(p => p.name === 'Ecomdrive · Shipped' && p.left);
  const courierUps = [
    pool.find(p => p.name === AWAITING && p.left > 0),
    pool.find(p => p.name === 'Pathao · In review' && p.left > 0),
    pool.find(p => p.name === 'Pathao · Upcoming payment' && p.left > 0)
  ].filter(Boolean);
  const onlyAwaitingWithCharge = courierUps.length === 1 && courierUps[0].name === AWAITING && pool.some(p => p.name === approvalCharge && p.left < 0);
  if (shippedMove && shippedMove.left < 0 && courierUps.length >= 1 && !onlyAwaitingWithCharge) {
    const ship = -shippedMove.left;
    const dests = courierUps.map(p => ({ name: p.name, amt: p.left }));
    const sum = dests.reduce((s, p) => s + p.amt, 0);
    const charge = pool.find(p => p.name === approvalCharge && p.left < 0);
    const fee = charge ? -charge.left : 0;
    const together = ship + fee;
    const gap = Math.abs(sum - together), bigger = Math.max(sum, together) || 1;
    if (gap / bigger <= 0.35) {
      const bits = dests.map(p => `${shortName(p.name)} ${fmt(p.amt)}`).join(' + ');
      stories.push({
        from: [{ name: shippedMove.name, amt: ship, up: false }],
        to: [{ name: dests.map(p => shortName(p.name)).join(' + '), amt: sum, up: true }],
        text: courierUps.length >= 2
          ? 'Shipped থেকে ডেলিভারি হয়ে কুরিয়ারে গেছে। Pathao আর Steadfast আলাদা না, দুইটা যোগ করে একসাথে।'
          : 'Shipped থেকে ডেলিভারি হয়ে কুরিয়ারে গেছে।',
        note: `Shipped ${fmt(ship)}। ${bits} = ${fmt(sum)}।${fee ? ` Approval charge ${fmt(fee)}।` : ''}${gap ? ` পার্থক্য ${fmt(gap)}।` : ''}`
      });
      shippedMove.left = 0;
      if (charge) charge.left = 0;
      courierUps.forEach(p => { p.left = 0; });
    }
  }
  const awaitingMove = pool.find(p => p.name === AWAITING && p.left);
  const chargeMove = pool.find(p => p.name === approvalCharge && p.left);
  const shipOutRaw = shippedMove && awaitingMove && chargeMove && shippedMove.left < 0 && awaitingMove.left > 0 && chargeMove.left < 0;
  const saleFitsShipped = shipOutRaw && pool.some(p => p.kind === 'sale' && p !== shippedMove && p.left > 0 && Math.abs(Math.abs(p.left) - Math.abs(shippedMove.left)) + 1 < Math.abs(Math.abs(awaitingMove.left) - (Math.abs(shippedMove.left) + Math.abs(chargeMove.left))));
  const shipOut = shipOutRaw && !saleFitsShipped;
  const shipBack = shippedMove && awaitingMove && chargeMove && shippedMove.left > 0 && awaitingMove.left < 0 && chargeMove.left > 0;
  if (shipOut || shipBack) {
    const ship = Math.abs(shippedMove.left), fee = Math.abs(chargeMove.left), dest = Math.abs(awaitingMove.left);
    const together = ship + fee, gap = Math.abs(dest - together), bigger = Math.max(together, dest) || 1;
    if (gap / bigger <= 0.2) {
      const note = `Shipped ${fmt(ship)} + Approval charge ${fmt(fee)} = ${fmt(together)}। In review ${fmt(dest)}।${gap ? ` পার্থক্য ${fmt(gap)}। শিটে In review থেকে ${codPct()}% COD আগেই কাটা, তাই দুই পাশ হুবহু সমান না।` : ''}`;
      stories.push(shipOut ? {
        from: [{ name: shippedMove.name, amt: ship, up: false }, { name: chargeMove.name, amt: fee, up: false }],
        to: [{ name: awaitingMove.name, amt: dest, up: true }],
        text: 'Shipped থেকে ডেলিভারি হয়ে Steadfast In review-এ গেছে। Approval charge-ও এই পার্সেলের। দুইটা মিলে In review-এ ঢুকেছে।',
        note
      } : {
        from: [{ name: awaitingMove.name, amt: dest, up: false }],
        to: [{ name: shippedMove.name, amt: ship, up: true }, { name: chargeMove.name, amt: fee, up: true }],
        text: 'Steadfast In review থেকে পার্সেল আবার Shipped-এ ফিরেছে। Approval charge-ও সাথে কমেছে।',
        note
      });
      shippedMove.left = 0;
      chargeMove.left = 0;
      awaitingMove.left = 0;
    }
  }
  const balanceMove = pool.find(p => p.name === 'Steadfast · Balance' && p.left);
  const awaitForBal = pool.find(p => p.name === AWAITING && p.left);
  const chargeForBal = pool.find(p => p.name === approvalCharge && p.left);
  const approveOut = awaitForBal && balanceMove && chargeForBal
    && awaitForBal.left < 0 && balanceMove.left > 0 && chargeForBal.left > 0;
  const approveBack = awaitForBal && balanceMove && chargeForBal
    && awaitForBal.left > 0 && balanceMove.left < 0 && chargeForBal.left < 0;
  if (approveOut || approveBack) {
    const review = Math.abs(awaitForBal.left), bal = Math.abs(balanceMove.left), fee = Math.abs(chargeForBal.left);
    const together = bal + fee, gap = Math.abs(review - together), bigger = Math.max(review, together) || 1;
    if (gap / bigger <= 0.35) {
      const note = `In review ${fmt(review)}। Balance ${fmt(bal)} + Approval charge ${fmt(fee)} = ${fmt(together)}।${gap ? ` পার্থক্য ${fmt(gap)}।${codPct() > 0 ? ` শিটে In review থেকে ${codPct()}% COD আগেই কাটা।` : ''}` : ''}`;
      stories.push(approveOut ? {
        from: [{ name: awaitForBal.name, amt: review, up: false }],
        to: [{ name: balanceMove.name, amt: bal, up: true }, { name: chargeForBal.name, amt: fee, up: true }],
        text: 'Steadfast In review থেকে অ্যাপ্রুভ হয়ে Balance-এ গেছে। Approval charge-ও কমেছে। In review = Balance + Approval charge।',
        note
      } : {
        from: [{ name: balanceMove.name, amt: bal, up: false }, { name: chargeForBal.name, amt: fee, up: false }],
        to: [{ name: awaitForBal.name, amt: review, up: true }],
        text: 'Steadfast Balance থেকে আবার In review-এ ফিরেছে। Approval charge-ও বেড়েছে। In review = Balance + Approval charge।',
        note
      });
      awaitForBal.left = 0;
      balanceMove.left = 0;
      chargeForBal.left = 0;
    }
  }
  const prUp = pool.find(p => p.name === 'Ecomdrive · Pending Return' && p.left > 0);
  if (prUp && prUp.left > 0) {
    const fell = [
      pool.find(p => p.name === 'Ecomdrive · Shipped' && p.left < 0),
      pool.find(p => p.name === AWAITING && p.left < 0),
      pool.find(p => p.name === 'Steadfast · On the way' && p.left < 0),
      pool.find(p => p.name === 'Pathao · In review' && p.left < 0),
      pool.find(p => p.name === 'Pathao · Upcoming payment' && p.left < 0)
    ].filter(Boolean);
    if (fell.length) {
      const sum = fell.reduce((s, p) => s + -p.left, 0);
      const gap = Math.abs(sum - prUp.left), bigger = Math.max(sum, prUp.left) || 1;
      if (gap / bigger <= 0.35) {
        stories.push({
          from: fell.map(p => ({ name: p.name, amt: -p.left, up: false })),
          to: [{ name: prUp.name, amt: prUp.left, up: true }],
          text: 'ডেলিভারি বাতিল হয়ে Pending Return-এ এসেছে।',
          note: gap ? `পার্থক্য ${fmt(gap)}।` : ''
        });
        fell.forEach(p => { p.left = 0; });
        prUp.left = 0;
      }
    }
  }
  if (stockMove && stockMove.left < 0 && prUp && prUp.left > 0) {
    const sale = prUp.left, cost = -stockMove.left, ratio = sale / cost;
    if (ratio >= 0.4 && ratio <= 3) pushStockSale(stockMove, cost, prUp, sale, 'Pending Return', 'Pending এই স্টক নেয়নি। স্টক Pending Return-এ উঠেছে। মাঝের পার্থক্য লাভ।');
  }
  const prDown = pool.find(p => p.name === 'Ecomdrive · Pending Return' && p.left < 0);
  const stockBack = pool.find(p => p.kind === 'stock' && p.left > 0);
  const returnBack = [
    pool.find(p => p.name === 'Ecomdrive · Shipped' && p.left > 0),
    pool.find(p => p.name === AWAITING && p.left > 0),
    pool.find(p => p.name === 'Pathao · In review' && p.left > 0),
    pool.find(p => p.name === 'Pathao · Upcoming payment' && p.left > 0)
  ].filter(Boolean);
  let stockFit = Infinity, backFit = Infinity, backSum = 0;
  if (prDown && stockBack && prDown.left < 0 && stockBack.left > 0) {
    const sale = -prDown.left, cost = stockBack.left, ratio = sale / cost;
    if (ratio >= 0.4 && ratio <= 3) stockFit = Math.abs(sale - cost) / (Math.max(sale, cost) || 1);
  }
  if (prDown && prDown.left < 0 && returnBack.length) {
    backSum = returnBack.reduce((s, p) => s + p.left, 0);
    const gap = Math.abs(backSum - -prDown.left), bigger = Math.max(backSum, -prDown.left) || 1;
    if (gap / bigger <= 0.35) backFit = gap / bigger;
  }
  if (prDown && backFit <= 0.35 && backFit < stockFit) {
    const bits = returnBack.map(p => `${shortName(p.name)} ${fmt(p.left)}`).join(' + ');
    const gap = Math.abs(backSum - -prDown.left);
    stories.push({
      from: [{ name: prDown.name, amt: -prDown.left, up: false }],
      to: returnBack.length === 1
        ? [{ name: returnBack[0].name, amt: returnBack[0].left, up: true }]
        : [{ name: returnBack.map(p => shortName(p.name)).join(' + '), amt: backSum, up: true }],
      text: 'Pending Return থেকে আবার ডেলিভারিতে ফিরেছে।',
      note: `${bits} = ${fmt(backSum)}।${gap ? ` পার্থক্য ${fmt(gap)}।` : ''}`
    });
    prDown.left = 0;
    returnBack.forEach(p => { p.left = 0; });
  } else if (prDown && stockBack && prDown.left < 0 && stockBack.left > 0 && stockFit < Infinity) {
    const sale = -prDown.left, cost = stockBack.left, ratio = sale / cost;
    if (ratio >= 0.4 && ratio <= 3) {
      const profit = sale - cost;
      const note = profit > 0
        ? `Pending Return ${fmt(sale)}। স্টকে ফিরেছে ${fmt(cost)}। পার্থক্য ${fmt(profit)}।`
        : profit < 0
          ? `Pending Return ${fmt(sale)}। স্টকে ফিরেছে ${fmt(cost)}। স্টক ${fmt(-profit)} বেশি।`
          : `Pending Return ${fmt(sale)} = স্টক ${fmt(cost)}।`;
      stories.push({
        from: [{ name: prDown.name, amt: sale, up: false }],
        to: [{ name: stockBack.name, amt: cost, up: true }],
        text: 'Pending Return অ্যাপ্রুভ হয়ে স্টকে ফিরেছে।',
        note
      });
      prDown.left = 0;
      stockBack.left = 0;
    }
  }
  const pendDown = pool.find(p => p.name === 'Ecomdrive · Pending' && p.left < 0);
  const stockUpNow = pool.find(p => p.kind === 'stock' && p.left > 0);
  if (pendDown && stockUpNow) {
    const sale = -pendDown.left, cost = stockUpNow.left, ratio = sale / cost;
    if (ratio >= 0.4 && ratio <= 3) {
      const profit = sale - cost;
      const note = profit > 0
        ? `Pending ${fmt(sale)}। স্টকে ফিরেছে ${fmt(cost)}। লাভ ${fmt(profit)} উঠে গেছে।`
        : profit < 0
          ? `Pending ${fmt(sale)}। স্টকে ফিরেছে ${fmt(cost)}। স্টক ${fmt(-profit)} বেশি।`
          : `Pending ${fmt(sale)} = স্টক ${fmt(cost)}।`;
      stories.push({
        from: [{ name: pendDown.name, amt: sale, up: false }],
        to: [{ name: stockUpNow.name, amt: cost, up: true }],
        text: 'অর্ডার উঠে গেছে। Pending কমে স্টকে ফিরেছে।',
        note
      });
      pendDown.left = 0;
      stockUpNow.left = 0;
    }
  }
  const rtsDownNow = pool.find(p => p.name === 'Ecomdrive · RTS' && p.left < 0);
  const pendUpNow = pool.find(p => p.name === 'Ecomdrive · Pending' && p.left > 0);
  if (rtsDownNow && pendUpNow) {
    const small = Math.min(-rtsDownNow.left, pendUpNow.left), big = Math.max(-rtsDownNow.left, pendUpNow.left);
    if (small / big >= 0.5) {
      stories.push({
        from: [{ name: rtsDownNow.name, amt: small, up: false }],
        to: [{ name: pendUpNow.name, amt: small, up: true }],
        text: 'RTS থেকে আবার Pending-এ ফিরেছে।',
        note: big === small ? '' : `মিলেছে ${fmt(small)}। বাকি ${fmt(big - small)} এই জোড়ায় আসেনি।`
      });
      rtsDownNow.left += small;
      pendUpNow.left -= small;
    }
  }
  const shippedDownNow = pool.find(p => p.name === 'Ecomdrive · Shipped' && p.left < 0);
  const rtsUpNow = pool.find(p => p.name === 'Ecomdrive · RTS' && p.left > 0);
  if (shippedDownNow && rtsUpNow) {
    const ship = -shippedDownNow.left, dest = rtsUpNow.left;
    const gap = Math.abs(dest - ship), bigger = Math.max(dest, ship) || 1;
    if (gap / bigger <= 0.35) {
      stories.push({
        from: [{ name: shippedDownNow.name, amt: ship, up: false }],
        to: [{ name: rtsUpNow.name, amt: dest, up: true }],
        text: 'Shipped অর্ডার ফিরে RTS-এ এসেছে।',
        note: gap ? `পার্থক্য ${fmt(gap)}।` : ''
      });
      shippedDownNow.left = 0;
      rtsUpNow.left = 0;
    }
  }
  const courierDowns = [
    pool.find(p => p.name === AWAITING && p.left < 0),
    pool.find(p => p.name === 'Pathao · In review' && p.left < 0),
    pool.find(p => p.name === 'Pathao · Upcoming payment' && p.left < 0)
  ].filter(Boolean);
  const shippedUpNow = pool.find(p => p.name === 'Ecomdrive · Shipped' && p.left > 0);
  if (courierDowns.length && shippedUpNow) {
    const sum = courierDowns.reduce((s, p) => s + -p.left, 0);
    const gap = Math.abs(sum - shippedUpNow.left), bigger = Math.max(sum, shippedUpNow.left) || 1;
    if (gap / bigger <= 0.35) {
      const bits = courierDowns.map(p => `${shortName(p.name)} ${fmt(-p.left)}`).join(' + ');
      stories.push({
        from: courierDowns.length === 1
          ? [{ name: courierDowns[0].name, amt: -courierDowns[0].left, up: false }]
          : [{ name: courierDowns.map(p => shortName(p.name)).join(' + '), amt: sum, up: false }],
        to: [{ name: shippedUpNow.name, amt: shippedUpNow.left, up: true }],
        text: 'কুরিয়ার থেকে পার্সেল আবার Shipped-এ ফিরেছে।',
        note: `${bits} = ${fmt(sum)}।${gap ? ` পার্থক্য ${fmt(gap)}।` : ''}`
      });
      courierDowns.forEach(p => { p.left = 0; });
      shippedUpNow.left = 0;
    }
  }
  let guard = 0;
  while (guard++ < 24) {
    let best = null;
    for (const [from, to, text, kind] of routes) {
      const a = findSide(from, -1), b = findSide(to, 1);
      if (!a || !b) continue;
      const small = Math.min(-a.left, b.left), big = Math.max(-a.left, b.left);
      const fit = small / big;
      const need = kind === 'shipout' ? 0.2 : kind === 'pipe' ? 0.5 : 0.12;
      if (fit + 1e-9 < need) continue;
      if (!best || fit > best.fit) best = { a, b, text, small, big, fit };
    }
    if (!best) break;
    best.a.left += best.small;
    best.b.left -= best.small;
    const gap = best.big - best.small;
    stories.push({
      from: [{ name: best.a.name, amt: best.small, up: false }],
      to: [{ name: best.b.name, amt: best.small, up: true }],
      text: best.text,
      note: gap ? `মিলেছে ${fmt(best.small)}। বাকি ${fmt(gap)} এই জোড়ায় আসেনি।` : ''
    });
  }
  const linkSides = (fromList, toList, text, note) => {
    if (!fromList.length || !toList.length) return;
    stories.push({
      from: fromList.map(p => ({ name: p.name, amt: Math.abs(p.left), up: p.left > 0 })),
      to: toList.map(p => ({ name: p.name, amt: Math.abs(p.left), up: p.left > 0 })),
      text, note
    });
    fromList.forEach(p => { p.left = 0; });
    toList.forEach(p => { p.left = 0; });
  };
  const sumAbs = list => list.reduce((s, p) => s + Math.abs(p.left), 0);
  const costMatches = (saleList, stockList) => {
    const sale = sumAbs(saleList), stock = sumAbs(stockList);
    if (!sale || !stock) return false;
    const ratio = sale / stock;
    return ratio >= 0.4 && ratio <= 3;
  };
  const saleDown = pool.filter(p => p.kind === 'sale' && p.left < 0);
  const stockUp = pool.filter(p => p.kind === 'stock' && p.left > 0);
  const costNote = 'স্টক কস্ট প্রাইস, অর্ডার বিক্রির দাম। দুই পাশের টাকা সমান নাও হতে পারে।' + (codPct() > 0 ? ` শিটের অর্ডার অঙ্ক থেকে ${codPct()}% COD কাটা আছে।` : '');
  if (costMatches(saleDown, stockUp)) linkSides(saleDown, stockUp, 'অর্ডার কমে স্টকে ফিরে এসেছে।', costNote);
  const pairClose = (fromPred, toPred, textOf, noteOf) => {
    let guard = 0;
    while (guard++ < 12) {
      let best = null;
      for (const a of pool) if (fromPred(a) && a.left) {
        for (const b of pool) if (a !== b && toPred(b) && b.left) {
          const gap = Math.abs(Math.abs(a.left) - Math.abs(b.left));
          const bigger = Math.max(Math.abs(a.left), Math.abs(b.left)) || 1;
          const ratio = gap / bigger;
          if (ratio > 0.35) continue;
          if (!best || ratio < best.ratio) best = { a, b, ratio, gap };
        }
      }
      if (!best) break;
      stories.push({
        from: [{ name: best.a.name, amt: Math.abs(best.a.left), up: best.a.left > 0 }],
        to: [{ name: best.b.name, amt: Math.abs(best.b.left), up: best.b.left > 0 }],
        text: textOf(best.a, best.b),
        note: best.gap ? noteOf(best.gap) : ''
      });
      best.a.left = 0; best.b.left = 0;
    }
  };
  const courierKind = p => p.kind === 'steadfast' || p.kind === 'pathao' || p.kind === 'courier';
  pairClose(p => courierKind(p) && p.left < 0, p => p.kind === 'cash' && p.left > 0,
    (a, b) => `${shortName(a.name)} থেকে টাকা ${shortName(b.name)}-এ ঢুকেছে।`,
    gap => `দুই পাশে ${fmt(gap)} পার্থক্য। কুরিয়ার চার্জ কাটলে ব্যাংকে একটু কম জমা হয়।`);
  pairClose(p => p.kind === 'cash' && p.left < 0, p => p.kind === 'supplier' && p.left < 0,
    (a, b) => `${shortName(a.name)} থেকে ${shortName(b.name)}-এর বাকি শোধ হয়েছে। ক্যাশ কমেছে, বাকিও কমেছে।`,
    gap => `দুই পাশে ${fmt(gap)} পার্থক্য আছে।`);
  pairClose(p => p.kind === 'supplier' && p.left > 0, p => p.kind === 'stock' && p.left > 0,
    (a, b) => `${shortName(a.name)}-এর কাছ থেকে মাল এসেছে। স্টক বেড়েছে, বাকিও বেড়েছে।`,
    gap => `দুই পাশে ${fmt(gap)} পার্থক্য আছে। স্টক কস্ট, বাকি চালানের দাম।`);
  pairClose(p => p.kind === 'cash' && p.left < 0, p => p.kind === 'stock' && p.left > 0,
    (a, b) => `${shortName(a.name)} দিয়ে স্টক কেনা হয়েছে।`,
    gap => `দুই পাশে ${fmt(gap)} পার্থক্য আছে।`);
  for (const fee of pool) {
    if (fee.kind !== 'fee' || !fee.left) continue;
    const status = fee.name.replace(/ delivery$/, '');
    const story = stories.find(s => (s.from || []).concat(s.to || []).some(x => x.name === status));
    if (!story) continue;
    story.fees = story.fees || [];
    story.fees.push({ name: fee.name, amt: fee.left });
    fee.left = 0;
  }
  for (const charge of pool) {
    if (charge.name !== 'Steadfast · Approval pending COD delivery charge' || !charge.left) continue;
    const story = stories.find(s => (s.from || []).concat(s.to || []).some(x => x.name === AWAITING));
    if (!story) continue;
    const up = charge.left < 0;
    story.fees = story.fees || [];
    story.fees.push({ name: charge.name, amt: up ? Math.abs(charge.left) : -Math.abs(charge.left) });
    charge.left = 0;
  }
  const joined = [];
  const destAt = new Map();
  for (const s of stories) {
    if (s.to.length !== 1) { joined.push(s); continue; }
    const key = s.to[0].name + '|' + (s.to[0].up ? '1' : '0');
    const at = destAt.get(key);
    if (at == null) { destAt.set(key, joined.length); joined.push(s); continue; }
    const prev = joined[at];
    if (s.from.some(x => x.plain) || prev.from.some(x => x.plain)) { joined.push(s); continue; }
    for (const x of s.from) {
      const hit = prev.from.find(f => f.name === x.name && !!f.up === !!x.up && !!f.plain === !!x.plain);
      if (hit) hit.amt += x.amt;
      else prev.from.push({ name: x.name, amt: x.amt, up: x.up, plain: x.plain });
    }
    prev.to[0].amt += s.to[0].amt;
    if (s.fees?.length) prev.fees = (prev.fees || []).concat(s.fees);
    prev.joined = (prev.joined || 1) + 1;
  }
  for (const s of joined) {
    if ((s.joined || 1) < 2 || s.to.length !== 1) continue;
    const dest = shortName(s.to[0].name);
    const src = s.from.map(x => shortName(x.name)).join(' আর ');
    const srcSum = s.from.reduce((a, x) => a + x.amt, 0);
    const gap = Math.abs(srcSum - s.to[0].amt);
    s.text = `${src} থেকে ${dest}-এ গেছে।`;
    s.note = gap ? `দুই দিকের অঙ্কে ${fmt(gap)} পার্থক্য।` : '';
  }
  stories.length = 0;
  stories.push(...joined);
  const sideHtml = list => list.map(x => `<div><span>${esc(shortName(x.name))}</span><b>${x.up ? '▲' : '▼'} ${fmt(x.amt)}</b></div>`).join('');
  const tone = list => list.length && list.every(x => x.up) ? 'up' : 'down';
  const flowHtml = s => {
    const fees = (s.fees || []).map(f => `<p class="muted">${esc(shortName(f.name))} ${f.amt > 0 ? fmt(f.amt) + ' বেড়েছে। চার্জ বাড়লে নেট ওয়ার্থ কমে।' : fmt(-f.amt) + ' কমেছে। চার্জ কমলে নেট ওয়ার্থ বাড়ে।'}</p>`).join('');
    const tail = `<p>${esc(s.text)}</p>${s.note ? `<p class="muted">${esc(s.note)}</p>` : ''}${fees}`;
    const node = x => `<div class="flow-node ${x.plain ? 'profit' : x.up ? 'up' : 'down'}"><span>${esc(shortName(x.name))}</span><b>${x.plain ? fmt(x.amt) : `${x.up ? '▲' : '▼'} ${fmt(x.amt)}`}</b></div>`;
    if (s.from.length < 2 && s.to.length < 2) {
      return `<article class="flow"><div class="flow-path"><div class="flow-side ${tone(s.from)}">${sideHtml(s.from)}</div><div class="flow-arrow">→</div><div class="flow-side ${tone(s.to)}">${sideHtml(s.to)}</div></div>${tail}</article>`;
    }
    const arrows = Math.max(s.from.length, s.to.length);
    const dest = s.to.length === 1
      ? `<div class="flow-dest ${s.to[0].up ? 'up' : 'down'}"><span>${esc(shortName(s.to[0].name))}</span><b>${s.to[0].up ? '▲' : '▼'} ${fmt(s.to[0].amt)}</b></div>`
      : `<div class="flow-nodes">${s.to.map(node).join('')}</div>`;
    return `<article class="flow"><div class="flow-join"><div class="flow-nodes">${s.from.map(node).join('')}</div><div class="flow-arrows">${Array.from({ length: arrows }, () => '<span>→</span>').join('')}</div>${dest}</div>${tail}</article>`;
  };
  const leftoverText = p => {
    const n = shortName(p.name), down = p.left < 0;
    if (p.kind === 'sale') return down ? `${n} থেকে বিক্রি কমেছে। অন্য অর্ডার ঘরে বা স্টকে এই টাকা ওঠেনি, তাই অর্ডার বাতিল হয়েছে বা শিটের বাইরে চলে গেছে।` : `${n}-এ নতুন বিক্রি এসেছে। স্টক বা অন্য অর্ডার ঘর থেকে জোড়া মেলেনি।`;
    if (p.kind === 'stock') return down ? 'স্টক কমেছে। এই সারিতে Pending বাড়েনি, তাই এটাকে নতুন অর্ডারের জোড়া ধরা হয়নি। স্টক In review-এ যায় না। নতুন অর্ডার হলে Pending বাড়ে।' : 'স্টক বেড়েছে। নতুন মাল ঢুকেছে, অথবা স্টকের হিসাব আপডেট হয়েছে।';
    if (p.kind === 'cash') return down ? `${n} থেকে টাকা বেরিয়েছে। সাপ্লায়ার, স্টক বা কুরিয়ারের সাথে জোড়া মেলেনি।` : `${n}-এ টাকা ঢুকেছে। কুরিয়ারের ঘর থেকে সমান অঙ্ক কমেনি।`;
    if (p.kind === 'supplier') return down ? `${n}-এর বাকি কমেছে। ক্যাশ থেকে সমান শোধ দেখা যায়নি।` : `${n}-এর বাকি বেড়েছে। নতুন মাল বা নতুন ধার।`;
    if (courierKind(p)) return down ? `${n} কমেছে। পরের ঘরে বা ব্যাংকে সমান টাকা ওঠেনি।` : `${n} বেড়েছে। আগের ঘর থেকে সমান টাকা কমেনি। নতুন পার্সেলের টাকা এই ঘরে এসেছে।`;
    if (p.kind === 'fee') return down ? `${n} কমেছে। ডেলিভারি চার্জ কমলে নেট ওয়ার্থ বাড়ে, কারণ চার্জ শিট থেকে কাটা হয়।` : `${n} বেড়েছে। ডেলিভারি চার্জ বাড়লে নেট ওয়ার্থ কমে।`;
    if (p.kind === 'expense') return down ? `${n} কমেছে। Count চালু থাকলে এই কমতি আজকের লাভ থেকেও কমে।` : `${n} বেড়েছে। Count চালু থাকলে এই খরচ আজকের লাভের সাথে যোগ হয়।`;
    if (p.kind === 'owner') return 'Owner adjustment বদলেছে। এটা নেট ওয়ার্থে যোগ হয় না।';
    return down ? `${n} কমেছে।` : `${n} বেড়েছে।`;
  };
  const downs = pool.filter(p => p.delta < 0).sort((a, b) => a.delta - b.delta);
  const ups = pool.filter(p => p.delta > 0).sort((a, b) => b.delta - a.delta);
  const line = p => `<div class="move-line"><span>${esc(shortName(p.name))}<small>${p.prev == null ? 'নতুন' : fmt(p.prev)} → ${p.cur == null ? 'উঠে গেছে' : fmt(p.cur)}</small></span><b>${p.delta > 0 ? '▲' : '▼'} ${fmt(Math.abs(p.delta))}</b></div>`;
  const left = pool.filter(p => p.left);
  const leftHtml = left.map(p => `<div class="flow-one ${p.left > 0 ? 'up' : 'down'}"><b>${p.left > 0 ? '▲' : '▼'} ${fmt(Math.abs(p.left))}</b> ${esc(shortName(p.name))}<p>${esc(leftoverText(p))}</p></div>`).join('');
  const sumBit = x => x.plain ? `${esc(shortName(x.name))} ${fmt(x.amt)}` : `${esc(shortName(x.name))} ${x.up ? '▲' : '▼'} ${fmt(x.amt)}`;
  const sumItem = (s, i) => `<li><b>${i + 1}.</b> ${s.from.map(sumBit).join(' + ')} → ${s.to.map(sumBit).join(' + ')}</li>`;
  return head + (stories.length ? `<ol class="move-sum">${stories.map(sumItem).join('')}</ol>` : '') + `<div class="move-cols"><div class="down"><h4>কমেছে</h4>${downs.map(line).join('') || '<p class="muted">কিছু কমেনি</p>'}</div><div class="up"><h4>বেড়েছে</h4>${ups.map(line).join('') || '<p class="muted">কিছু বাড়েনি</p>'}</div></div>
    ${stories.length ? `<h4>এই জায়গা থেকে এই জায়গায়</h4>${stories.map(flowHtml).join('')}` : ''}
    ${leftHtml ? `<h4>যার জোড়া মেলেনি</h4>${leftHtml}` : ''}
    <p class="muted">লাল মানে কমেছে, সবুজ মানে বেড়েছে। তীর মানে টাকা বা পণ্য ওই দিক থেকে ওই দিকে গেছে।</p>`;
}

const VIEWS = {
  overview() {
    const { cards, t } = kpiData();
    return `${t.warn.map(w => `<div class="card err">${esc(w)} – set it in Settings.</div>`).join('')}
    <div class="grid">${cards.map(k => {
      const v = k.cur;
      const ch = (k.prev != null && v != null) ? chg(v, k.prev) : '';
      return `<div class="kpi" data-click="kpi" data-k="${k.k}"><h4>${k.label}</h4><div class="v ${v != null && ['cf', 'profit', 'ach'].includes(k.k) ? (v > 0 ? 'pos' : v < 0 ? 'neg' : '') : ''}">${v == null ? 'Incomplete' : fmt(v)}</div>
      <div class="s">${k.prev != null ? 'Prev: ' + fmt(k.prev) + '<br>' + ch : (k.note || '')}${k.sync ? '<br>Synced ' + dt(k.sync) : ''}</div></div>`;
    }).join('')}</div>
    ${dailyPanel()}
    <p class="muted">নিচের গ্রাফে শিটের প্রতিটি হিসাব আলাদা। উপরে অঙ্ক, নিচে সময়। সবুজ আগের ঘরের চেয়ে বেড়েছে, লাল কমেছে। ডানে স্ক্রল করলে পুরনো সময়। বড় অঙ্ক লাখে, ছোট অঙ্ক টাকায়।</p>
    ${historyCharts()}
    <p class="muted">উপরের কার্ডে চাপ দিলে হিসাবের ভাঙন খুলবে।</p>`;
  },

  sheet() {
    const items = sheetColumnItems();
    const f = window.__sheetDate || '';
    const profitOf = profitCalc();
    let rows = sortedSnaps().reverse();
    if (f) rows = rows.filter(r => r.date === f);
    const tot = [['cash', 'Liquid Cash'], ['courier', 'Courier'], ['stock', 'Stock'], ['supplier', 'Supplier Dues'], ['owner', 'Owner Adj.'], ['nw', 'Net Worth']];
    const diffCell = (cur, prev, total, show = fmt, extra = '') => {
      const cls = total ? ['n', 't'] : ['n'];
      if (extra) cls.push(extra);
      if (cur === prev) return `<td class="${cls.join(' ')}">${cur != null ? show(cur) : ''}</td>`;
      const d = (cur || 0) - (prev || 0);
      cls.push(d > 0 ? 'up' : 'down');
      const was = prev != null ? show(prev) : 'empty';
      const mark = prev == null ? 'new' : cur == null ? 'cleared' : `${d > 0 ? '▲' : '▼'} ${fmt(Math.abs(d))}`;
      return `<td class="${cls.join(' ')}" title="Was ${esc(was)}">${cur != null ? show(cur) : ''}<small>${mark}</small></td>`;
    };
    const amountKey = r => items.map(i => snapCell(r, i) ?? '').join('|') + '#' + tot.map(([k]) => r.totals?.[k] ?? '').join('|') + '#' + profitOf(r);
    const groups = [];
    for (const r of rows) {
      const key = amountKey(r);
      const g = groups[groups.length - 1];
      if (g && g.key === key) { g.rows.push(r); g.id = r.id; }
      else groups.push({ key, id: r.id, rows: [r] });
    }
    const open = window.__sheetOpen || (window.__sheetOpen = new Set());
    const shown = [];
    groups.forEach((g, gi) => {
      const folded = g.rows.length > 1 && !open.has(g.id);
      const visible = folded ? [g.rows[0]] : g.rows;
      visible.forEach((r, vi) => shown.push({ r, prev: visible[vi + 1] || groups[gi + 1]?.rows[0] || null, fold: g.rows.length > 1 && vi === 0 ? g : null, folded }));
    });
    const rowHtml = s => {
      const r = s.r, prev = s.prev;
      const p = profitOf(r), pp = prev ? profitOf(prev) : p;
      const foldBtn = s.fold ? `<button type="button" class="btn sm fold" data-click="sheetFold" data-id="${esc(s.fold.id)}" title="${s.folded ? s.fold.rows.length + ' checks, same amounts' : 'Fold these matching rows'}">${s.folded ? 'Show ' + s.fold.rows.length : 'Minimize'}</button>` : '';
      const cell = i => {
        const cur = snapCell(r, i);
        const prevV = prev ? snapCell(prev, i) : cur;
        return diffCell(cur, prevV, false, fmt);
      };
      return `<tr><td><div class="sheet-time">${dt(r.ts)}${foldBtn}</div></td>${items.map(cell).join('')}${tot.map(([k]) => diffCell(r.totals?.[k], prev ? prev.totals?.[k] : r.totals?.[k], true)).join('')}${diffCell(p, pp, true, sgn)}<td><span class="pill">${esc(r.source)}</span></td><td class="why"><button type="button" class="why-btn" data-click="sheetWhy" data-id="${esc(r.id)}" data-prev="${esc(prev?.id || '')}" title="কী বেড়েছে, কোথায় গেছে">i</button></td></tr>`;
    };
    return `<div class="card form"><label>Date (Dhaka)<input type="date" data-act="sheetDate" value="${esc(f)}"></label>
      <button class="btn primary" data-click="calculateNow" ${window.__calcBusy ? 'disabled' : ''}>${esc(calcBtnLabel())}</button><button class="btn" data-click="csv">Export CSV</button>
      <button class="btn danger" data-click="clearSheet" ${window.__sheetClearing ? 'disabled' : ''} title="Delete all Live Sheet rows and start fresh">${window.__sheetClearing ? 'Clearing…' : 'Clear Live Sheet'}</button>
      <label style="flex-direction:row;align-items:center;color:inherit"><input type="checkbox" data-act="exfin" ${window.__exFin ? 'checked' : ''}> profit: leave out owner / loan money</label>
      ${window.__calcMsg ? `<p class="muted">${esc(window.__calcMsg)}</p>` : ''}${(cfg().syncErrors || []).length ? `<p class="err">${(cfg().syncErrors || []).length} check(s) failed. Open Errors for the list.</p>` : ''}</div>
    <div class="tw"><table class="sheet"><tr><th>Time (BST)</th>${items.map(i => `<th class="n">${esc(ECOM_SALE.has(i.name) ? shortName(i.name) : uiName(i.name))}</th>`).join('')}${tot.map(([, l]) => `<th class="n">${l}</th>`).join('')}<th class="n">Profit (today)</th><th>Source</th><th class="why"></th></tr>
    ${shown.map(rowHtml).join('') || '<tr><td colspan="99" class="muted">No rows yet.</td></tr>'}</table></div>`;
  },

  errors() {
    const list = cfg().syncErrors || [];
    return `<div class="card"><h3>Check errors</h3>
      <p class="muted">Every ${Math.max(0, Number(cfg().interval) || 0) || '—'} minutes, the time chosen in Settings, Hisab signs in to Steadfast, Pathao and EcomDrive and saves fresh numbers, then adds a Live Sheet row. If one check fails, that number stays as it was and the reason is listed here. The row is removed after the next successful check.</p>
      <p class="muted">Last full check: ${cfg().lastCalcAt ? dt(cfg().lastCalcAt) : 'not yet'}</p>
      <button class="btn primary" data-click="calculateNow" ${window.__calcBusy ? 'disabled' : ''}>${esc(calcBtnLabel())}</button>
      ${window.__calcMsg ? `<p class="muted">${esc(window.__calcMsg)}</p>` : ''}</div>
      <div class="tw"><table><tr><th>Source</th><th>Problem</th><th>When</th></tr>${list.map(e => `<tr><td>${esc(e.name)}</td><td>${esc(e.message)}</td><td>${dt(e.at)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No errors. The last checks completed.</td></tr>'}</table></div>`;
  },

  balance() {
    const t = compute(), c = cfg();
    const sec = (title, gs) => `<div class="card"><h3>${title}</h3><div class="tw"><table><tr><th>Item</th><th class="n">Original</th><th class="n">In ${c.base}</th><th>Status</th></tr>${t.parts.filter(p => gs.includes(p.it.group)).map(p => `<tr class="${p.inc ? '' : 'dim'}"><td>${esc(uiName(p.it.name))}</td><td class="n">${fmt(p.it.balance, p.it.currency)}</td><td class="n">${fmt(p.v)}</td><td>${p.inc ? '' : 'excluded'}</td></tr>`).join('')}</table></div></div>`;
    return `<div class="grid"><div class="kpi"><h4>Total assets</h4><div class="v">${fmt(t.assets)}</div></div><div class="kpi"><h4>Total liabilities / dues</h4><div class="v">${fmt(t.liab)}</div></div><div class="kpi"><h4>Net worth</h4><div class="v">${fmt(t.nw)}</div></div></div>
    <div class="row2"><div>${sec('Cash & Accounts', ['cash'])}${sec('Courier Receivables', ['courier'])}${sec('Inventory & other assets', ['stock', 'otherAsset'])}</div><div>${sec('Supplier dues & other liabilities', ['supplier', 'otherLiab'])}${sec('Owner adjustment (equity)', ['owner'])}</div></div>`;
  },

  ledger() {
    const c = cfg(), items = activeItems().filter(i => !i.archived);
    const opt = items.map(i => `<option value="${i.id}">${esc(uiName(i.name))} (${i.currency})</option>`).join('');
    const cur = [...new Set([c.base, ...Object.keys(c.rates || {})])];
    const q = (window.__lq || '').toLowerCase();
    const rows = [...S.ledger].sort((a, b) => a.ts < b.ts ? 1 : -1).filter(e => !q || JSON.stringify(e).toLowerCase().includes(q));
    const nm = id => S.items.find(i => i.id === id)?.name || '';
    return `<div class="card"><h3>New entry</h3><form class="form" data-form="ledger">
      <label>Type<select name="type">${Object.entries(c.types).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('')}</select></label>
      <label>Amount<input name="amount" required inputmode="decimal"></label><label>Currency<select name="currency">${cur.map(x => `<option>${x}</option>`).join('')}</select></label>
      <label>From account<select name="fromId"><option value="">—</option>${opt}</select></label><label>To account<select name="toId"><option value="">—</option>${opt}</select></label>
      <label>Note / source ref<input name="note"></label><label>Source ID (dup check)<input name="srcId"></label>
      <label style="flex-direction:row;align-items:center;color:inherit"><input type="checkbox" name="apply" checked> update balances</label>
      <button class="btn primary">Post</button></form>
      <p class="muted">“From” decreases an asset (increases a liability); “To” increases an asset (decreases a liability). Entries are never edited – use Reverse for corrections.</p></div>
    <div class="card form"><label>Search<input data-act="lq" value="${esc(window.__lq || '')}"></label></div>
    <div class="tw"><table><tr><th>Time</th><th>Type</th><th class="n">Amount</th><th>From</th><th>To</th><th>Cash flow</th><th>Profit</th><th>Note</th><th>By</th><th>Recon</th><th></th></tr>
    ${rows.map(e => { const r = c.types[e.type] || {}; return `<tr><td>${dt(e.ts)}</td><td>${esc(r.label || e.type)}${e.sign === -1 ? ' <span class="pill warn">reversal</span>' : ''}</td><td class="n">${fmt(e.amount * (e.sign || 1), e.currency)}</td><td>${esc(nm(e.fromId))}</td><td>${esc(nm(e.toId))}</td><td>${r.cash === 'none' ? 'none (internal)' : r.cash + (r.fin ? ' · financing' : '')}</td><td>${r.profit}</td><td>${esc(e.note)}</td><td>${esc(e.by)}</td><td><select data-act="recon" data-id="${e.id}">${['unreconciled', 'reconciled', 'disputed'].map(s => `<option ${e.recon === s ? 'selected' : ''}>${s}</option>`).join('')}</select></td><td>${e.sign === -1 || e.reversed ? '' : `<button class="btn sm" data-click="reverse" data-id="${e.id}">Reverse</button>`}</td></tr>`; }).join('') || '<tr><td colspan="11" class="muted">No entries.</td></tr>'}</table></div>`;
  },

  daily() {
    const date = window.__dd || todayStr(), d = daily(date), b = dayBounds(date), c = cfg();
    const ob = b.opening?.totals, cb = b.closing?.totals;
    const days = [...new Set(S.ledger.map(e => e.date))].sort().reverse().slice(0, 30);
    return `<div class="card form"><label>Day (Dhaka)<input type="date" data-act="dd" value="${date}"></label></div>
    <div class="grid"><div class="kpi"><h4>Cash flow</h4><div class="v ${d.cf >= 0 ? 'pos' : 'neg'}">${fmt(d.cf)}</div><div class="s">Operating ${fmt(d.opCF)} · Financing ${fmt(d.fin)}</div></div>
    <div class="kpi"><h4>Net profit</h4><div class="v ${d.profit >= 0 ? 'pos' : 'neg'}">${d.E.length ? fmt(d.profit) : 'Incomplete'}</div><div class="s">${esc(d.label)}</div></div>
    <div class="kpi"><h4>Opening net worth</h4><div class="v">${ob ? fmt(ob.nw) : 'Incomplete'}</div><div class="s">${b.opening ? dt(b.opening.ts) : 'no snapshot'}</div></div>
    <div class="kpi"><h4>Closing / latest net worth</h4><div class="v">${cb ? fmt(cb.nw) : 'Incomplete'}</div><div class="s">${cb && ob ? 'Change ' + fmt(cb.nw - ob.nw) + ' (not profit)' : ''}</div></div></div>
    <div class="card"><h3>Entries by type</h3><div class="tw"><table><tr><th>Type</th><th class="n">Total</th><th>Cash</th><th>Profit class</th></tr>${Object.entries(d.byType).map(([k, v]) => `<tr><td>${esc(c.types[k]?.label)}</td><td class="n">${fmt(v)}</td><td>${c.types[k]?.cash}${c.types[k]?.fin ? ' (financing)' : ''}</td><td>${c.types[k]?.profit}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No entries for this day.</td></tr>'}</table></div></div>
    <div class="card"><h3>Recent days with entries</h3>${days.map(x => { const q = daily(x); return `<div>${x} — cash flow ${fmt(q.cf)} · profit ${fmt(q.profit)} <span class="muted">(${esc(q.label)})</span></div>`; }).join('') || '<span class="muted">None</span>'}</div>`;
  },

  audit() {
    return `<div class="tw"><table><tr><th>Time</th><th>By</th><th>Action</th><th>Detail</th></tr>${[...S.audit].sort((a, b) => a.ts < b.ts ? 1 : -1).map(a => `<tr><td>${dt(a.ts)}</td><td>${esc(a.by)}</td><td>${esc(a.action)}</td><td>${esc(a.detail)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Empty</td></tr>'}</table></div>`;
  },

  settings() {
    const c = cfg();
    return `<div class="card"><h3>Scheduling &amp; base</h3>
      <div class="tabs"><span class="muted" style="align-self:center">Refresh every:</span>${[1, 2, 5, 10, 15].map(m => `<button class="${c.interval === m ? 'on' : ''}" data-click="preset" data-m="${m}">${m} min</button>`).join('')}</div>
      <form class="form" data-form="settings">
      <label>Base currency<input name="base" value="${esc(c.base)}" size="5"></label>
      <label>Add sheet row every (minutes, 0 = off)<input name="interval" type="number" min="0" value="${c.interval}"></label>
      <label>Fixed hisab times (HH:MM, Dhaka, comma separated)<input name="times" value="${esc((c.times || []).join(', '))}"></label>
      <label style="flex-direction:row;align-items:center;color:inherit"><input type="checkbox" name="onChange" ${c.onChange ? 'checked' : ''}> add a row on every change</label>
      <label style="flex-direction:row;align-items:center;color:inherit"><input type="checkbox" name="skipUnchanged" ${c.skipUnchanged ? 'checked' : ''}> skip timed rows when nothing changed</label>
      <label style="flex-direction:row;align-items:center;color:inherit"><input type="checkbox" name="ownerInNetWorth" ${c.ownerInNetWorth ? 'checked' : ''}> add Owner Adjustment to net worth</label>
      <button class="btn primary">Save</button></form>
      <p class="muted">Rows are added by this page while it is open, and by the Cloud Function (see README) when the browser is closed. A new Dhaka day automatically starts a new opening row; nothing is deleted or reset.</p></div>
    <div class="card"><h3>Exchange rates (1 unit = ? ${esc(c.base)})</h3><form class="form" data-form="rates">${Object.entries(c.rates || {}).map(([k, v]) => `<label>${esc(k)}<input name="r_${esc(k)}" value="${esc(v)}"></label>`).join('')}
      <label>New currency<input name="newCur" size="6" placeholder="USD"></label><label>Rate<input name="newRate" size="8"></label><button class="btn primary">Save rates</button></form></div>
    <div class="card"><h3>Transaction type rules</h3><form data-form="types"><div class="tw"><table><tr><th>Type</th><th>Cash flow</th><th>Financing</th><th>Profit class</th></tr>${Object.entries(c.types).map(([k, v]) => `<tr><td>${esc(v.label)}</td><td><select name="${k}__cash">${['in', 'out', 'none'].map(o => `<option ${v.cash === o ? 'selected' : ''}>${o}</option>`).join('')}</select></td><td><input type="checkbox" name="${k}__fin" ${v.fin ? 'checked' : ''}></td><td><select name="${k}__profit">${['revenue', 'expense', 'none'].map(o => `<option ${v.profit === o ? 'selected' : ''}>${o}</option>`).join('')}</select></td></tr>`).join('')}</table></div><br><button class="btn primary">Save rules</button></form>
      <p class="muted">These rules decide what counts as cash flow, financing, or profit. Transfers are “none” so they never look like income.</p></div>
    <div class="card"><h3>Add item</h3><form class="form" data-form="newitem"><label>Name<input name="name" required></label><label>Group<select name="group">${Object.entries(GROUPS).map(([k, g]) => `<option value="${k}">${g.label}</option>`).join('')}</select></label><label>Currency<input name="currency" value="${esc(c.base)}" size="6"></label><label>Category (optional)<input name="category"></label><button class="btn primary">Add</button></form></div>
    ${DEMO ? '<div class="card"><h3>Demo data</h3><button class="btn danger" data-click="wipe">Erase demo data</button></div>' : ''}`;
  }
};
const optItems = list => list.map(i => `<option value="${i.id}">${esc(uiName(i.name))} · ${fmt(i.balance, i.currency)}</option>`).join('');
VIEWS.actions = () => {
  const accs = activeItems(['cash']).filter(i => !i.archived);
  const sups = activeItems(['supplier', 'otherLiab']).filter(i => !i.archived);
  const cour = activeItems(['courier']).filter(i => !i.archived);
  const today = todayStr();
  const moves = S.ledger.filter(e => e.date === today && (e.type === 'capital_add' || e.type === 'capital_withdraw') && e.sign !== -1 && !e.reversed);
  const sum = type => moves.filter(e => e.type === type).reduce((s, e) => s + (toBase(e.amount, e.currency) || 0), 0);
  const added = sum('capital_add'), withdrawn = sum('capital_withdraw');
  const rows = moves.sort((a, b) => a.ts < b.ts ? 1 : -1).map(e => `<tr><td>${e.type === 'capital_add' ? 'Add' : 'Withdraw'}</td><td class="n">${fmt(e.amount, e.currency)}</td><td>${esc(e.note || '')}</td><td>${dt(e.ts)}</td><td><button class="btn sm" data-click="reverse" data-id="${e.id}">Undo</button></td></tr>`).join('');
  return `<div class="card"><h3>Add / Withdraw</h3>
    <p class="muted">ব্যাংকে টাকা ঢুকলে নেট ওয়ার্থ বাড়ে, তাই আজকের লাভও বেড়ে যায়। <b>Add</b> দিলে সেই অঙ্ক আজকের লাভ থেকে বাদ যায়। টাকা তুললে লাভ কমে যায়। <b>Withdraw</b> দিলে সেই কমতি আজকের লাভ থেকে বাদ যায়। ব্যালেন্স বদলায় না, সিঙ্ক যেমন এনেছে তেমন থাকে। রাত ১২টার পর নতুন দিন শূন্য থেকে শুরু, এই বাদ আর বসে না।</p>
    <p>আজ Add বাদ <b>${fmt(added)}</b> · Withdraw বাদ <b>${fmt(withdrawn)}</b></p>
    <div class="row2">
    <form class="form" data-form="capital">
      <input type="hidden" name="move" value="add">
      <label>Add amount<input name="amount" required inputmode="decimal" placeholder="100000"></label>
      <label>Account<select name="acc"><option value="">—</option>${optItems(accs)}</select></label>
      <label>Note<input name="note" placeholder="Bank e capital"></label>
      <button class="btn primary">Add</button>
    </form>
    <form class="form" data-form="capital">
      <input type="hidden" name="move" value="withdraw">
      <label>Withdraw amount<input name="amount" required inputmode="decimal" placeholder="50000"></label>
      <label>Account<select name="acc"><option value="">—</option>${optItems(accs)}</select></label>
      <label>Note<input name="note" placeholder="Nijer kache tulsi"></label>
      <button class="btn primary">Withdraw</button>
    </form>
    </div>
    ${rows ? `<div class="tw" style="margin-top:12px"><table><tr><th></th><th class="n">Amount</th><th>Note</th><th>Time</th><th></th></tr>${rows}</table></div>` : ''}</div>
  <div class="row2">
  <div class="card"><h3>Pay a supplier</h3>
    <p class="muted">Takes the amount out of the account you pick and reduces the supplier's due. It is not counted as an expense, because the cost was recorded when you bought. Amount is in the account's currency.</p>
    <form class="form" data-form="paysupplier">
      <label>Supplier · current due<select name="sup" required>${optItems(sups)}</select></label>
      <label>Pay from · balance<select name="acc" required>${optItems(accs)}</select></label>
      <label>Amount<input name="amount" required inputmode="decimal"></label>
      <label>Reference<input name="note" placeholder="Bank ref / invoice no."></label>
      <button class="btn primary">Pay supplier</button></form></div>
  <div class="card"><h3>Transfer between accounts</h3>
    <p class="muted">Moves money from one of your accounts to another. It changes no income, profit or net worth. A fee, if any, is booked as an expense.</p>
    <form class="form" data-form="xfer">
      <label>From<select name="from" required>${optItems(accs)}</select></label>
      <label>To<select name="to" required>${optItems(accs)}</select></label>
      <label>Amount<input name="amount" required inputmode="decimal"></label>
      <label>Fee (optional)<input name="fee" inputmode="decimal" placeholder="0.00"></label>
      <label>Note<input name="note"></label>
      <button class="btn primary">Transfer</button></form></div>
  <div class="card"><h3>Courier settlement received</h3>
    <p class="muted">Use when a courier pays you. It reduces that receivable and adds the money to the account that received it.</p>
    <form class="form" data-form="courierset">
      <label>Courier balance paid<select name="from" required>${optItems(cour)}</select></label>
      <label>Received in<select name="to" required>${optItems(accs)}</select></label>
      <label>Amount<input name="amount" required inputmode="decimal"></label>
      <label>Reference<input name="note" placeholder="Settlement / invoice no."></label>
      <button class="btn primary">Record settlement</button></form></div>
  </div><p class="muted">Customer payments, expenses, owner contributions and other entries are on the Ledger page. Every action there and here is recorded and can be reversed, never edited.</p>`;
};
VIEWS.integrations = () => {
  const now = Date.now(), sel = S.connectors.find(x => x.id === window.__cid);
  const rows = S.connectors.map(k => {
    const stale = k.lastOk && now - new Date(k.lastOk).getTime() > Math.max(1, k.refresh || 5) * 3 * 60000;
    const st = !k.active ? 'paused' : !k.lastOk ? 'never synced' : stale ? 'stale' : (k.status || 'ok');
    return `<tr><td>${esc(k.name)}</td><td>${esc(k.kind)}</td><td>${esc(k.method)}</td><td class="n">${k.refresh || '—'} min</td><td><span class="pill ${st === 'ok' ? 'ok' : 'warn'}">${esc(st)}</span></td><td>${dt(k.lastOk)}</td><td style="white-space:normal;max-width:260px">${esc(k.lastError || '')}</td><td><button class="btn sm" data-click="selconn" data-id="${k.id}">Configure</button> <button class="btn sm" data-click="toggleconn" data-id="${k.id}">${k.active ? 'Pause' : 'Resume'}</button></td></tr>`;
  }).join('');
  const allItems = activeItems().filter(i => !i.archived);
  const detail = sel ? `<div class="card"><h3>${esc(sel.name)} · field mapping</h3>
    <p class="muted">Connector ID for the worker or API: <b>${esc(sel.id)}</b>. The source sends named fields (for example <code>balance</code>); each one below writes to the item you choose. Empty or invalid values are rejected and the old balance is kept.</p>
    <div class="tw"><table><tr><th>Source field</th><th>Writes to</th><th></th></tr>${(sel.mappings || []).map((m, i) => `<tr><td>${esc(m.field)}</td><td>${esc(S.items.find(x => x.id === m.itemId)?.name || '(missing item)')}</td><td><button class="btn sm danger" data-click="delmap" data-i="${i}">Remove</button></td></tr>`).join('') || '<tr><td colspan="3" class="muted">No fields mapped yet.</td></tr>'}</table></div>
    <form class="form" data-form="addmap" style="margin-top:10px"><label>Source field name<input name="field" required placeholder="balance"></label><label>Writes to<select name="itemId" required>${allItems.map(i => `<option value="${i.id}">${esc(GROUPS[i.group]?.label || '')} · ${esc(uiName(i.name))}</option>`).join('')}</select></label><button class="btn primary">Add mapping</button></form>
    <h3 style="margin-top:16px">Test with sample data</h3>
    <form data-form="testingest"><textarea name="data" rows="4" style="width:100%" placeholder="balance: 12500&#10;payment_hold: 3000"></textarea><br><br><button class="btn primary">Apply test values</button></form>
    <p class="muted">Paste <code>name: value</code> lines or JSON. This uses the same checks as live data, so use it to confirm your mapping before turning a real source on.</p></div>` : '';
  return `<div class="card"><h3>How data gets in</h3>
    <p><b>Manual / CSV</b> works for every account today. <b>Official API</b> is best where a provider offers one. <b>Browser worker</b> reads a dashboard you log in to yourself (see <code>worker/</code> in the project); it keeps the session on your machine, never stores passwords in Firebase, and stops with “re-login needed” when an OTP, CAPTCHA or expired session appears.</p>
    <p class="muted">Banks and mobile banking apps usually forbid automated logins and need OTP. Use statement downloads or manual entry for those, and connect couriers and Ecomdrive first.</p></div>
  <div class="tw"><table><tr><th>Source</th><th>Type</th><th>Method</th><th class="n">Refresh</th><th>Status</th><th>Last OK</th><th>Last error</th><th></th></tr>${rows || '<tr><td colspan="8" class="muted">No connectors yet. Add one below.</td></tr>'}</table></div>
  <div class="card" style="margin-top:14px"><h3>Add a source</h3><form class="form" data-form="newconn">
    <label>Name<input name="name" required placeholder="Ecomdrive"></label>
    <label>Type<select name="kind">${['courier', 'stock', 'bank', 'mobile banking', 'gateway', 'other'].map(x => `<option>${x}</option>`).join('')}</select></label>
    <label>Method<select name="method"><option value="worker">browser worker</option><option value="api">official API</option><option value="csv">CSV / statement</option><option value="manual">manual</option></select></label>
    <label>Dashboard URL<input name="url" placeholder="https://"></label>
    <label>Refresh (minutes)<input name="refresh" type="number" min="1" value="5" style="width:90px"></label>
    <button class="btn primary">Add source</button></form></div>${detail}${webhookSection()}`;
};
VIEWS.expenses = () => {
  const meta = S.items.find(i => !i.archived && i.externalId === 'expense-meta');
  const other = S.items.find(i => !i.archived && i.externalId === 'expense-other');
  const box = (it, title, text) => {
    const on = it && it.include !== false;
    const lines = (it?.lines || []).map(c => `<tr><td>${esc(c.label)}</td><td class="n">${fmt(toMinor(c.amount) || 0)}</td></tr>`).join('');
    return `<div class="card"><h3>${title}</h3>
      <p class="muted">${text}</p>
      <p><b>${it ? fmt(it.balance) : '—'}</b> <span class="muted">আজকের অঙ্ক${it?.updatedAt ? ' · ' + dt(it.updatedAt) : ''}</span></p>
      ${it ? `<label style="flex-direction:row;align-items:center;color:inherit"><input type="checkbox" data-act="inc" data-id="${esc(it.id)}" ${on ? 'checked' : ''}> Count</label>` : '<p class="muted">প্রথম চেকের পর Count আসবে।</p>'}
      ${lines ? `<div class="tw" style="margin-top:10px"><table><tr><th>Category</th><th class="n">Today</th></tr>${lines}</table></div>` : ''}
    </div>`;
  };
  return `<div class="card"><h3>EcomDrive expenses</h3>
    <p class="muted">আজকের খরচ <a href="https://my.ecomdrivebd.com/finance/income-expense">income-expense</a> থেকে আসে। দুই ভাগ: Meta Ads, আর Meta Ads ছাড়া বাকি সব। Count চালু করলে সেই অঙ্ক আজকের লাভের সাথে যোগ হয় এবং লাইভ শিটে যায়। Count বন্ধ থাকলে যোগ হয় না। নতুন খরচ প্রথমে Count বন্ধ থাকে। নেট ওয়ার্থ বদলায় না। রাত ১২টার পর নতুন দিনের খরচ আবার শূন্য থেকে।</p>
    <button class="btn primary" data-click="checkExpenses" ${window.__expenseBusy ? 'disabled' : ''}>${window.__expenseBusy ? 'Checking…' : 'Check expenses'}</button>
    ${window.__expenseMsg ? `<p class="muted">${esc(window.__expenseMsg)}</p>` : ''}${window.__expenseErr ? `<p class="err">${esc(window.__expenseErr)}</p>` : ''}</div>
    <div class="row2">
      ${box(meta, 'Meta Ads', 'শুধু Meta Ads। Count চালু থাকলে আজকের এই খরচ লাভের সাথে যোগ হবে।')}
      ${box(other, 'Meta Ads ছাড়া সব খরচ', 'COD charge, Uncategorized, বাকি ক্যাটাগরি। একটা Count এই পুরো ভাগের জন্য।')}
    </div>`;
};
for (const [pg, groups] of Object.entries(PAGES)) {
  VIEWS[pg] = () => {
    const g = tabGroup && groups.includes(tabGroup) ? tabGroup : groups[0];
    // Courier/accounts: collapse duplicate Steadfast rows so Count off is not undone by a clone still ticked.
    const list = (pg === 'courier' || pg === 'accounts')
      ? collapseActiveItemDupes(activeItems([g]))
      : activeItems([g]);
    const t = compute();
    const gt = t.parts.filter(p => p.it.group === g && p.inc && !ECOM_FEE.has(p.it.name)).reduce((s, p) => s + p.v, 0);
    const stockBtn = pg === 'stock' && g === 'stock' ? `<div class="card"><h3>Total stock value</h3>
      <p class="muted">Calls the EcomDrive Products API, writes that cost value into <b>Total Stock Value</b>, and adds a Live Sheet row. No browser window opens. Login stays on this computer.</p>
      <button class="btn primary" data-click="checkStock" ${window.__stockBusy ? 'disabled' : ''}>${window.__stockBusy ? 'Checking…' : 'Check total stock value'}</button>
      ${window.__stockMsg ? `<p class="muted">${esc(window.__stockMsg)}</p>` : ''}${window.__stockErr ? `<p class="err">${esc(window.__stockErr)}</p>` : ''}</div>` : '';
    const reportBtn = pg === 'metrics' ? `<div class="card"><h3>Business report</h3>
      <p class="muted">Shipped, Pending, RTS and Pending Return stay on this page, each with its own delivery charge. Before the Live Sheet, the delivery charge is subtracted first. Then the COD percent is taken off that remainder, because the percent applies to the sale and the delivery. Those four delivery lines are not columns on the Live Sheet. A row is left out when Count is off.</p>
      <button class="btn primary" data-click="checkReport" ${window.__reportBusy ? 'disabled' : ''}>${window.__reportBusy ? 'Checking…' : 'Check report'}</button>
      ${window.__reportMsg ? `<p class="muted">${esc(window.__reportMsg)}</p>` : ''}${window.__reportErr ? `<p class="err">${esc(window.__reportErr)}</p>` : ''}</div>
      <div class="card"><h3>COD charge</h3>
      <p class="muted">Steadfast and Pathao keep a COD charge on the sale and on the delivery. On this page the full amounts stay. On the Live Sheet, each delivery charge is subtracted from Shipped, Pending, RTS or Pending Return first, and then the COD percent is taken off what remains. Steadfast In review still has the percent taken off its own amount. The other Steadfast amounts are not changed.</p>
      <form class="form" data-form="cod">
        <label style="flex-direction:row;align-items:center;color:inherit"><input type="checkbox" name="codOn" ${cfg().codOn !== false ? 'checked' : ''}> Subtract COD charge on the sheet</label>
        <label>Percent<input name="codPct" value="${esc(cfg().codPct || '1')}" inputmode="decimal" style="width:80px"></label>
        <button class="btn primary">Save</button>
      </form></div>` : '';
    const supBtn = pg === 'suppliers' && g === 'supplier' ? `<div class="card"><h3>EcomDrive suppliers</h3>
      <p class="muted">Sync updates each supplier’s <b>Balance</b> and keeps <b>Previous</b> as the last amount (never wipes to zero). Inactive / missing suppliers keep their last due. Adds a new Live Sheet row. <b>USDT DUE</b> stays manual — sync does not create or change it.</p>
      <button class="btn primary" data-click="checkSuppliers" ${window.__supBusy ? 'disabled' : ''}>${window.__supBusy ? 'Syncing…' : 'Sync supplier dues'}</button>
      ${window.__supMsg ? `<p class="muted">${esc(window.__supMsg)}</p>` : ''}${window.__supErr ? `<p class="err">${esc(window.__supErr)}</p>` : ''}</div>` : '';
    const head = `<th>Name</th><th>Cur</th><th class="n">Balance</th><th class="n">Previous</th><th class="n">Change</th><th>Source</th><th>Count</th><th></th>`;
    const tableOf = rows => `<div class="tw" style="margin-bottom:18px"><table><tr>${head}</tr>${rows.map(itemRow).join('') || '<tr><td colspan="8" class="muted">Nothing here yet.</td></tr>'}</table></div>`;
    const counted = rows => {
      const ids = new Set(rows.map(i => i.id));
      return t.parts.filter(p => ids.has(p.it.id) && p.inc).reduce((s, p) => s + p.v, 0);
    };
    const smsUrl = stockApiBase() + '/api/sms/balance';
    const acctBtn = pg === 'accounts' && g === 'cash' ? `<div class="card"><h3>EcomDrive accounts</h3>
      <p class="muted">Pulls the active accounts from EcomDrive Accounts, including bKash and Nagad, into this list and adds a Live Sheet row.</p>
      <button class="btn primary" data-click="checkAccounts" ${window.__acctBusy ? 'disabled' : ''}>${window.__acctBusy ? 'Syncing…' : 'Sync accounts'}</button>
      ${window.__acctMsg ? `<p class="muted">${esc(window.__acctMsg)}</p>` : ''}${window.__acctErr ? `<p class="err">${esc(window.__acctErr)}</p>` : ''}</div>
      <div class="card"><h3>SMS balance</h3>
      <p class="muted">Separate from EcomDrive. An SMS forwarder can POST bKash or Nagad balances to <code>${esc(smsUrl)}</code>. Send <code>{"account":"bkash","balance":"1500.00"}</code>, or the SMS itself as <code>{"text":"... Balance Tk 1500.00"}</code>. This computer must be running the Hisab server.</p>
      <button class="btn" data-click="checkSms" ${window.__smsManual ? 'disabled' : ''}>${window.__smsManual ? 'Checking…' : 'Check SMS balances'}</button>
      ${window.__smsMsg ? `<p class="muted">${esc(window.__smsMsg)}</p>` : ''}${window.__smsErr ? `<p class="err">${esc(window.__smsErr)}</p>` : ''}</div>` : '';
    const dollarCard = pg === 'accounts' && g === 'cash' ? `<div class="card" id="dollarCard"><h3>Dollar (main − Meta Ads)</h3>
      <p class="muted">Main dollar সেট করো, বা টেবিলে <b>Dollar</b> সারির Balance এডিট করো (ওটাই main)। Meta Ads খরচ মাইনাস: <code>left = main − spent</code>। রেট ${esc(cfg().rates?.USD || '128')}।</p>
      <form class="form" data-form="dollarBase" style="margin-bottom:10px">
        <label>Main dollar ($)<input name="base" value="${esc(cfg().dollarBase || '171.00')}" inputmode="decimal" required></label>
        <button class="btn primary" name="mode" value="set" type="submit">Save main</button>
      </form>
      <form class="form" data-form="dollarBase" style="margin-bottom:10px">
        <label>Add to main ($)<input name="add" placeholder="e.g. 50" inputmode="decimal" required></label>
        <button class="btn" name="mode" value="add" type="submit">Add dollar</button>
      </form>
      <button type="button" class="btn primary" data-click="checkDollar" ${window.__dollarBusy ? 'disabled' : ''}>${window.__dollarBusy ? 'Checking…' : 'Update from EcomDrive'}</button>
      ${(() => {
        const dollarIt = S.items.find(i => !i.archived && i.externalId === 'dollar-main');
        return `<p><b>Main: $${esc(cfg().dollarBase || '171.00')}</b>${dollarIt ? ` · <b>Left: ${fmt(dollarIt.balance, 'USD')}</b>` : ' · Left: Update চাপো'}</p>`;
      })()}
      ${window.__dollarMsg ? `<p class="muted">${esc(window.__dollarMsg)}</p>` : ''}${window.__dollarErr ? `<p class="err">${esc(window.__dollarErr)}</p>` : ''}</div>` : '';
    const addForm = `<div class="card" style="margin-top:14px"><h3>Add to ${GROUPS[g].label}</h3><form class="form" data-form="newitem"><input type="hidden" name="group" value="${g}"><label>Name<input name="name" required></label><label>Currency<input name="currency" value="${esc(cfg().base)}" size="6"></label><label>Category<input name="category"></label><button class="btn primary" type="submit">Add</button></form></div>`;
    if (pg === 'courier') {
      const steadfast = list.filter(i => courierSide(i) === 'steadfast');
      const pathao = list.filter(i => courierSide(i) === 'pathao');
      const other = list.filter(i => courierSide(i) === 'other');
      return `<div class="card"><h3>Steadfast</h3>
      <p class="muted">Balance, In review and On the way come from Steadfast stats. In review is sent to the Live Sheet after the COD percent is taken off. Approval charge is the sum of the Charge column on the approval parcels page, and it is added on the Live Sheet as a minus. Last unpaid still follows the payment cycle. Last paid Count looks at the last 30 days of EcomDrive settlement history. If that invoice is there, or the same deposited amount for Steadfast is there, Count stays off. If it is not there, Count stays on.</p>
      <button class="btn primary" data-click="checkSteadfast" ${window.__sfBusy ? 'disabled' : ''}>${window.__sfBusy ? 'Checking…' : 'Sync Steadfast'}</button>
      <p><b>Steadfast total: ${fmt(counted(steadfast))}</b></p>
      ${window.__sfMsg ? `<p class="muted">${esc(window.__sfMsg)}</p>` : ''}${window.__sfErr ? `<p class="err">${esc(window.__sfErr)}</p>` : ''}</div>
      ${tableOf(steadfast)}
      <div class="card"><h3>Pathao</h3>
      <p class="muted">Balance and In review come from the Pathao dashboard. Last processing still follows the payment cycle. Last paid Count looks at the last 30 days of EcomDrive settlement history. If that invoice is there, or the same deposited amount for Pathao is there, Count stays off. If it is not there, Count stays on.</p>
      <button class="btn primary" data-click="checkPathao" ${window.__ptBusy ? 'disabled' : ''}>${window.__ptBusy ? 'Checking…' : 'Sync Pathao'}</button>
      <p><b>Pathao total: ${fmt(counted(pathao))}</b></p>
      ${window.__ptMsg ? `<p class="muted">${esc(window.__ptMsg)}</p>` : ''}${window.__ptErr ? `<p class="err">${esc(window.__ptErr)}</p>` : ''}</div>
      ${tableOf(pathao)}
      ${other.length ? `<div class="card"><b>Other courier total: ${fmt(counted(other))}</b></div>${tableOf(other)}` : ''}
      ${addForm}`;
    }
    return `${groups.length > 1 ? `<div class="tabs">${groups.map(x => `<button class="${x === g ? 'on' : ''}" data-click="tab" data-g="${x}">${GROUPS[x].label}</button>`).join('')}</div>` : ''}
    ${stockBtn}${reportBtn}${supBtn}${acctBtn}
    <div class="card"><b>${GROUPS[g].label} total: ${fmt(gt)}</b> <span class="muted">· edit a balance and press Enter / click away. Dollar row = main $.</span></div>
    ${tableOf(list)}
    ${dollarCard}
    ${addForm}`;
  };
}

// ---------- events ----------
document.addEventListener('change', async e => {
  const t = e.target, act = t.dataset.act; if (!act) return;
  try {
    if (act === 'bal') await setBalance(t.dataset.id, t.value);
    else if (act === 'inc') {
      const it = S.items.find(i => i.id === t.dataset.id);
      if (!it) return;
      const checked = !!t.checked;
      const logic = itemLogicKey({ ...it, archived: false });
      // Same logical row may exist as several ids (old cloud timeouts) — flip Count on all of them.
      const targets = S.items.filter(i => !i.archived && (
        i.id === it.id
        || (logic && itemLogicKey(i) === logic)
        || (i.group === it.group && sameName(i.name, it.name))
      ));
      const now = new Date().toISOString();
      for (const row of targets) {
        row.include = checked;
        row.updatedAt = now;
        await cloudSet('items', row.id, { include: checked, updatedAt: now }, 5000);
      }
      // Sticky preference so the next Steadfast/Pathao sync cannot turn Count back on.
      await rememberCountOff(it.name, !checked);
      const cycle = PAYMENT_CYCLE[it.name];
      if (cycle && it.paymentId) {
        const paymentWatch = { ...(cfg().paymentWatch || {}) };
        paymentWatch[cycle.key] = checked
          ? { id: it.paymentId, state: it.paymentState || (cycle.role === 'paid' ? 'paid' : 'unpaid'), dismissedId: '', dismissedState: '' }
          : { id: it.paymentId, state: it.paymentState || (cycle.role === 'paid' ? 'paid' : 'unpaid'), dismissedId: it.paymentId, dismissedState: it.paymentState || (cycle.role === 'paid' ? 'paid' : 'unpaid') };
        await cloudSet('settings', 'main', { paymentWatch }, 5000);
      }
      audit('item.include', `${it.name} counted=${checked}`);
      // Count change must always add a Live Sheet row without On-the-way (etc.) if turned off.
      try {
        await snapshot('change');
        const last = latestSnap();
        if (last) {
          const open = window.__sheetOpen || (window.__sheetOpen = new Set());
          open.add(last.id);
        }
        toast(checked ? 'Count on · new Live Sheet row' : 'Count off · removed from sheet row');
      } catch (err) {
        toast(err.message || 'Live Sheet row was not saved');
      }
      render(true);
    }
    else if (act === 'due') { await A.set('items', t.dataset.id, { dueDate: t.value }); audit('item.due', t.value); }
    else if (act === 'recon') { await A.set('ledger', t.dataset.id, { recon: t.value }); audit('ledger.recon', t.dataset.id + ' ' + t.value); }
    else if (act === 'exfin') { window.__exFin = t.checked; render(true); }
    else if (act === 'sheetDate') { window.__sheetDate = t.value; render(true); }
    else if (act === 'dd') { window.__dd = t.value; render(true); }
    else if (act === 'lq') { window.__lq = t.value; render(true); }
  } catch (err) { toast(err.message); }
});
document.addEventListener('focusout', () => setTimeout(() => { if (pendingRender) render(); }, 150));
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-click]'); if (!b) return;
  const id = b.dataset.id, a = b.dataset.click;
  try {
    if (a === 'navgroup') { window.__navGroup = window.__navGroup === b.dataset.g ? '' : b.dataset.g; render(true); }
    else if (a === 'kpi') { $('#modalBody').innerHTML = breakdown(b.dataset.k); $('#modal').classList.remove('hidden'); }
    else if (a === 'closeModal') $('#modal').classList.add('hidden');
    else if (a === 'snapNow' || a === 'calculateNow') await calculateNow(true);
    else if (a === 'checkStock') await checkEcomdriveStock();
    else if (a === 'checkReport') await checkEcomdriveReport();
    else if (a === 'checkSuppliers') await checkEcomdriveSuppliers();
    else if (a === 'checkAccounts') await checkEcomdriveAccounts();
    else if (a === 'checkSteadfast') await checkSteadfast();
    else if (a === 'checkPathao') await checkPathao();
    else if (a === 'checkSms') await applySmsBalances(true);
    else if (a === 'checkDollar') await applyDollar(true);
    else if (a === 'checkExpenses') await applyExpenses(true);
    else if (a === 'tab') { tabGroup = b.dataset.g; render(true); }
    else if (a === 'archive') { const it = S.items.find(i => i.id === id); await A.set('items', id, { archived: !it.archived }); audit('item.archive', it.name + ' → ' + !it.archived); scheduleSnap(); }
    else if (a === 'delitem') {
      const it = S.items.find(i => i.id === id);
      if (!it || it.group !== 'cash') return;
      if (!confirm('Delete ' + it.name + '?')) return;
      await A.del('items', id);
      audit('item.delete', it.name);
      await snapshot('change');
      toast('Deleted ' + it.name);
    }
    else if (a === 'rename') { const it = S.items.find(i => i.id === id); $('#modalBody').innerHTML = `<h3>Rename</h3><form class="form" data-form="rename"><input type="hidden" name="id" value="${esc(id)}"><label>Name<input name="name" value="${esc(it.name)}" required></label><button class="btn primary">Save</button></form>`; $('#modal').classList.remove('hidden'); }
    else if (a === 'up' || a === 'down') {
      const it = S.items.find(i => i.id === id);
      let list = activeItems([it.group]);
      if (it.group === 'courier') list = list.filter(x => courierSide(x) === courierSide(it));
      const i = list.findIndex(x => x.id === id), j = a === 'up' ? i - 1 : i + 1;
      if (j >= 0 && j < list.length) { const o = list.map((x, k) => ({ id: x.id, order: k })); [o[i].order, o[j].order] = [o[j].order, o[i].order]; for (const x of o) await A.set('items', x.id, { order: x.order }); }
    }
    else if (a === 'reverse') {
      const e0 = S.ledger.find(x => x.id === id); if (!e0 || e0.reversed) return;
      await postEntry({ type: e0.type, amount: e0.amount, currency: e0.currency, fromId: e0.fromId, toId: e0.toId, note: 'Reversal of ' + id, sign: -1, reverses: id }, !!e0.applied);
      await A.set('ledger', id, { reversed: true });
    }
    else if (a === 'preset') { const m = parseInt(b.dataset.m, 10); await A.set('settings', 'main', { interval: m }); audit('settings.interval', m + ' min'); toast('Rows will be added every ' + m + ' min'); }
    else if (a === 'selhook') { window.__hid = id; render(true); }
    else if (a === 'togglehook') { const w = S.webhooks.find(x => x.id === id); await A.set('webhooks', id, { active: w.active === false }); audit('webhook.toggle', w.name + ' active=' + (w.active === false)); }
    else if (a === 'delhookmap') { const w = S.webhooks.find(x => x.id === window.__hid), i = parseInt(b.dataset.i, 10); if (w) { await A.set('webhooks', w.id, { mappings: (w.mappings || []).filter((_, j) => j !== i) }); audit('webhook.map.remove', w.name); } }
    else if (a === 'selconn') { window.__cid = id; render(true); }
    else if (a === 'toggleconn') { const k = S.connectors.find(x => x.id === id); await A.set('connectors', id, { active: !k.active }); audit('connector.toggle', k.name + ' active=' + !k.active); }
    else if (a === 'delmap') { const k = S.connectors.find(x => x.id === window.__cid), i = parseInt(b.dataset.i, 10); if (k) { await A.set('connectors', k.id, { mappings: (k.mappings || []).filter((_, j) => j !== i) }); audit('connector.map.remove', k.name); } }
    else if (a === 'sheetWhy') {
      $('#modalBody').innerHTML = sheetWhy(id, b.dataset.prev || '');
      const box = document.querySelector('.modal-box'); if (box) box.scrollTop = 0;
      $('#modal').classList.remove('hidden');
    }
    else if (a === 'sheetFold') {
      const open = window.__sheetOpen || (window.__sheetOpen = new Set());
      if (open.has(id)) open.delete(id); else open.add(id);
      render(true);
    }
    else if (a === 'csv') exportCsv();
    else if (a === 'clearSheet') {
      if (window.__sheetClearing) return;
      if (!confirm('Clear the entire Live Sheet and start fresh? Accounts and balances stay. Old sheet rows will be deleted.')) return;
      window.__sheetClearing = true;
      render(true);
      try { await clearLiveSheet(); }
      finally { window.__sheetClearing = false; render(true); }
    }
    else if (a === 'logout') {
      if (DEMO) { await api('/api/logout', { method: 'POST' }); location.reload(); }
      else A.auth?.logout();
    }
    else if (a === 'wipe') { await A.wipe(); location.reload(); }
  } catch (err) { toast(err.message); }
});
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') e.target.classList.add('hidden'); });
window.addEventListener('hashchange', route);

document.addEventListener('submit', async e => {
  const f = e.target.closest('[data-form]'); if (!f) return; e.preventDefault();
  const fd = new FormData(f), v = n => fd.get(n), kind = f.dataset.form, c = cfg();
  try {
    if (kind === 'ledger') {
      const amt = toMinor(v('amount'));
      if (!amt || amt <= 0) return toast('Enter a positive amount');
      const srcId = (v('srcId') || '').trim();
      if (srcId && S.ledger.some(x => x.srcId === srcId)) return toast('Duplicate source ID – entry rejected');
      await postEntry({ type: v('type'), amount: amt, currency: v('currency'), fromId: v('fromId') || null, toId: v('toId') || null, note: v('note') || '', srcId, sign: 1 }, !!v('apply'));
      toast('Entry posted');
    } else if (kind === 'settings') {
      const times = (v('times') || '').split(',').map(s => s.trim()).filter(s => /^\d\d:\d\d$/.test(s));
      await A.set('settings', 'main', { base: (v('base') || 'BDT').toUpperCase(), interval: Math.max(0, parseInt(v('interval'), 10) || 0), times, onChange: !!v('onChange'), skipUnchanged: !!v('skipUnchanged'), ownerInNetWorth: !!v('ownerInNetWorth') });
      audit('settings.save', 'scheduling/base'); toast('Saved');
    } else if (kind === 'cod') {
      const pct = String(v('codPct') || '1').trim().replace('%', '');
      const n = parseFloat(pct);
      if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error('COD percent must be between 0 and 100');
      await A.set('settings', 'main', { codOn: !!v('codOn'), codPct: String(n) });
      audit('settings.cod', v('codOn') ? n + '%' : 'off');
      await snapshot('change');
      toast(v('codOn') ? `COD ${n}% is off the EcomDrive sales and Steadfast In review on the sheet` : 'COD charge is no longer taken off');
    } else if (kind === 'dollarBase') {
      const mode = (v('mode') || f.querySelector('[name=mode]')?.value || 'set');
      const cur = Number(cfg().dollarBase || '0');
      let next;
      if (mode === 'add') {
        const add = Number(String(v('add') || '').replace(/[,$\s]/g, ''));
        if (!Number.isFinite(add) || add === 0) throw new Error('Enter a dollar amount to add');
        next = Math.round((cur + add) * 100) / 100;
      } else {
        const base = Number(String(v('base') || '').replace(/[,$\s]/g, ''));
        if (!Number.isFinite(base) || base < 0) throw new Error('Enter a valid main dollar amount');
        next = Math.round(base * 100) / 100;
      }
      const dollarBase = next.toFixed(2);
      let main = S.settings.find(x => x.id === 'main');
      if (!main) { main = { id: 'main' }; S.settings.push(main); }
      main.dollarBase = dollarBase;
      main.dollarReady = true;
      await cloudSet('settings', 'main', { dollarBase, dollarReady: true, dollarStart: cfg().dollarStart || '2026-10-25' }, 6000);
      audit('settings.dollarBase', mode === 'add' ? `add → $${dollarBase}` : `set $${dollarBase}`);
      toast(mode === 'add' ? `Main dollar is now $${dollarBase}` : `Main dollar saved: $${dollarBase}`);
      await applyDollar(true);
    } else if (kind === 'rates') {
      const rates = { ...(c.rates || {}) };
      for (const k of Object.keys(rates)) { const x = v('r_' + k); if (x && parseFloat(x) > 0) rates[k] = x.trim(); }
      if (v('newCur') && parseFloat(v('newRate')) > 0) rates[v('newCur').trim().toUpperCase()] = v('newRate').trim();
      await A.set('settings', 'main', { rates }); audit('settings.rates', JSON.stringify(rates)); toast('Saved'); scheduleSnap();
    } else if (kind === 'types') {
      const types = JSON.parse(JSON.stringify(c.types));
      for (const k of Object.keys(types)) { types[k].cash = v(k + '__cash'); types[k].fin = !!v(k + '__fin'); types[k].profit = v(k + '__profit'); }
      await A.set('settings', 'main', { types }); audit('rules.save', 'transaction type rules'); toast('Rules saved');
    } else if (kind === 'capital') {
      const amt = toMinor(v('amount'));
      if (!amt || amt <= 0) throw new Error('Enter a positive amount');
      const move = v('move') === 'withdraw' ? 'withdraw' : 'add';
      const acc = v('acc') ? S.items.find(i => i.id === v('acc')) : null;
      const note = (v('note') || '').trim();
      await postEntry({
        type: move === 'add' ? 'capital_add' : 'capital_withdraw',
        amount: amt, currency: acc?.currency || c.base,
        fromId: move === 'withdraw' ? (acc?.id || null) : null,
        toId: move === 'add' ? (acc?.id || null) : null,
        note: [acc?.name, note].filter(Boolean).join(' · ') || (move === 'add' ? 'Add' : 'Withdraw'),
        sign: 1
      }, false);
      await snapshot('change');
      toast(move === 'add' ? 'আজকের লাভ থেকে বাদ হয়েছে' : 'আজকের লাভের কমতি থেকে বাদ হয়েছে');
      f.reset();
    } else if (kind === 'paysupplier' || kind === 'xfer' || kind === 'courierset') {
      const get = id => S.items.find(i => i.id === id);
      const amt = toMinor(v('amount'));
      if (!amt || amt <= 0) throw new Error('Enter a positive amount');
      const note = (v('note') || '').trim();
      if (kind === 'paysupplier') {
        const acc = get(v('acc')), sup = get(v('sup'));
        if (!acc || !sup) throw new Error('Choose a supplier and an account');
        if ((acc.balance || 0) < amt) throw new Error('Not enough balance in ' + acc.name);
        const inSup = conv(amt, acc.currency, sup.currency, c);
        if (inSup == null) throw new Error('Set the ' + acc.currency + '/' + sup.currency + ' exchange rate in Settings first');
        if (inSup > (sup.balance || 0)) throw new Error('More than the current due (' + fmt(sup.balance, sup.currency) + '). Record the purchase or adjustment first.');
        await postEntry({ type: 'supplier_payment', amount: amt, currency: acc.currency, fromId: acc.id, toId: sup.id, note: note || 'Supplier payment', sign: 1 }, true);
        toast('Paid ' + fmt(amt, acc.currency) + ' to ' + sup.name);
      } else if (kind === 'xfer') {
        const from = get(v('from')), to = get(v('to'));
        if (!from || !to) throw new Error('Choose both accounts');
        if (from.id === to.id) throw new Error('Choose two different accounts');
        const fee = toMinor(v('fee') || '0');
        if (fee === null || fee < 0) throw new Error('Fee is not a valid amount');
        if ((from.balance || 0) < amt + fee) throw new Error('Not enough balance in ' + from.name);
        await postEntry({ type: 'transfer', amount: amt, currency: from.currency, fromId: from.id, toId: to.id, note: note || 'Transfer to ' + to.name, sign: 1 }, true);
        if (fee > 0) await postEntry({ type: 'expense', amount: fee, currency: from.currency, fromId: from.id, toId: null, note: 'Transfer fee: ' + from.name + ' → ' + to.name, sign: 1 }, true);
        toast('Moved ' + fmt(amt, from.currency) + ' to ' + to.name);
      } else {
        const from = get(v('from')), to = get(v('to'));
        if (!from || !to) throw new Error('Choose a courier balance and an account');
        const inCour = conv(amt, to.currency, from.currency, c);
        if (inCour == null) throw new Error('Missing exchange rate for ' + to.currency);
        if (inCour > (from.balance || 0)) throw new Error('More than the ' + from.name + ' balance (' + fmt(from.balance, from.currency) + ')');
        await postEntry({ type: 'courier_settlement', amount: amt, currency: to.currency, fromId: from.id, toId: to.id, note: note || 'Courier settlement', sign: 1 }, true);
        const cycle = PAYMENT_CYCLE[from.name];
        if (cycle && from.paymentId) {
          const paymentWatch = { ...(cfg().paymentWatch || {}) };
          paymentWatch[cycle.key] = { id: from.paymentId, state: from.paymentState || (cycle.role === 'paid' ? 'paid' : 'unpaid'), dismissedId: from.paymentId, dismissedState: from.paymentState || (cycle.role === 'paid' ? 'paid' : 'unpaid') };
          await A.set('settings', 'main', { paymentWatch });
          await A.set('items', from.id, { include: false });
        }
        toast('Settlement of ' + fmt(amt, to.currency) + ' recorded');
      }
      f.reset();
    } else if (kind === 'newconn') {
      const name = (v('name') || '').trim(); if (!name) return;
      const id = await A.add('connectors', { name, kind: v('kind'), method: v('method'), url: (v('url') || '').trim(), refresh: Math.max(1, parseInt(v('refresh'), 10) || 5), active: true, mappings: [], status: 'new', createdAt: new Date().toISOString() });
      window.__cid = id; audit('connector.add', name); toast('Source added – now map its fields'); render(true);
    } else if (kind === 'addmap') {
      const k = S.connectors.find(x => x.id === window.__cid), field = (v('field') || '').trim();
      if (!k || !field || !v('itemId')) return;
      await A.set('connectors', k.id, { mappings: (k.mappings || []).filter(m => m.field !== field).concat([{ field, itemId: v('itemId') }]) });
      audit('connector.map.add', k.name + ': ' + field); f.reset();
    } else if (kind === 'testingest') {
      const k = S.connectors.find(x => x.id === window.__cid); if (!k) return;
      const fields = parseFields(v('data'));
      if (!Object.keys(fields).length) throw new Error('Paste at least one name: value line');
      toast(await applyIngest(k, fields, 'manual test'));
    } else if (kind === 'newhook') {
      const name = (v('name') || '').trim(); if (!name) return;
      const token = [...crypto.getRandomValues(new Uint8Array(24))].map(b => b.toString(16).padStart(2, '0')).join('');
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))].map(b => b.toString(16).padStart(2, '0')).join('');
      const id = await A.add('webhooks', { name, event: (v('event') || '').trim(), tokenHash: hash, active: true, mappings: [], snapshot: true, idField: '', ledgerType: '', amountField: '', hits: 0, createdAt: new Date().toISOString() });
      window.__hid = id; audit('webhook.add', name);
      $('#modalBody').innerHTML = `<h3>Webhook created</h3><p>Copy this secret now. It is shown only once; only a hash is stored. Send it in the <code>x-webhook-token</code> header.</p><p><code style="word-break:break-all;user-select:all">${token}</code></p><p class="muted">If you lose it, delete the webhook and create a new one.</p>`;
      $('#modal').classList.remove('hidden'); render(true);
    } else if (kind === 'addhookmap') {
      const w = S.webhooks.find(x => x.id === window.__hid), field = (v('field') || '').trim();
      if (!w || !field || !v('itemId')) return;
      await A.set('webhooks', w.id, { mappings: (w.mappings || []).filter(m => !(m.field === field && m.itemId === v('itemId'))).concat([{ field, itemId: v('itemId'), mode: v('mode') }]) });
      audit('webhook.map.add', w.name + ': ' + v('mode') + ' ' + field); f.reset();
    } else if (kind === 'hookcfg') {
      const w = S.webhooks.find(x => x.id === window.__hid); if (!w) return;
      await A.set('webhooks', w.id, { idField: (v('idField') || '').trim(), ledgerType: v('ledgerType') || '', amountField: (v('amountField') || '').trim(), snapshot: !!v('snapshot') });
      audit('webhook.options', w.name); toast('Saved');
    } else if (kind === 'testhook') {
      const w = S.webhooks.find(x => x.id === window.__hid); if (!w) return;
      let body; try { body = JSON.parse(v('data')); } catch { throw new Error('The sample must be valid JSON'); }
      toast(await applyWebhook(w, body, 'test'));
    } else if (kind === 'rename') {
      const it = S.items.find(i => i.id === v('id')), n = (v('name') || '').trim();
      if (it && n) { await A.set('items', it.id, { name: n }); audit('item.rename', it.name + ' → ' + n); }
      $('#modal').classList.add('hidden');
    } else if (kind === 'newitem') {
      const n = (v('name') || '').trim(); if (!n) return;
      const group = v('group');
      const order = S.items.length;
      const seed = { name: n, group, currency: (v('currency') || c.base).toUpperCase(), category: v('category') || '', balance: 0, prev: 0, opening: 0, include: true, archived: false, order, updatedAt: new Date().toISOString(), source: 'manual', status: 'manual', externalId: '' };
      if (group === 'supplier' && isUsdtDue({ name: n })) {
        seed.name = 'USDT DUE';
        const existing = S.items.find(i => i.id === USDT_DUE_ID || isUsdtDue(i));
        if (existing) {
          Object.assign(existing, { name: 'USDT DUE', group: 'supplier', source: 'manual', status: 'manual', externalId: '', archived: false });
          await cloudSet('items', existing.id, { name: 'USDT DUE', group: 'supplier', source: 'manual', status: 'manual', externalId: '', archived: false, updatedAt: seed.updatedAt }, 6000);
          toast('USDT DUE already there — kept');
        } else {
          await cloudSet('items', USDT_DUE_ID, seed, 6000);
          if (!S.items.some(x => x.id === USDT_DUE_ID)) S.items.push({ id: USDT_DUE_ID, ...seed });
          toast('USDT DUE added');
        }
        audit('item.add', 'USDT DUE');
      } else {
        const id = await cloudAdd('items', seed, 6000);
        if (!S.items.some(x => x.id === id)) S.items.push({ id, ...seed });
        audit('item.add', n);
        toast(window.__cloudErr ? 'Added on this device (cloud slow)' : 'Added');
      }
      f.reset();
      render(true);
    }
  } catch (err) { toast(err.message); }
});

function loginMessage(status, data) {
  if (status === 429) return 'অনেকবার ভুল হয়েছে। ১৫ মিনিট পর আবার চেষ্টা করুন।';
  if (data.error === 'Wrong password') return 'ইমেইল বা পাসওয়ার্ড মিলেনি।';
  if (data.error === 'wrong email') return 'এই ইমেইল দিয়ে অ্যাকাউন্ট খোলা যাবে না।';
  if (data.error === 'at least 10') return 'কমপক্ষে ১০ অক্ষর দিন।';
  if (data.error === 'already set') return 'পাসওয়ার্ড আগেই আছে। ইমেইল আর পাসওয়ার্ড দিয়ে ঢুকুন।';
  return 'ঢোকা যায়নি।';
}
function showLogin(setup, offline) {
  window.__loginSetup = !!setup;
  $('#login').classList.remove('hidden');
  $('#app').classList.add('hidden');
  $('#email').classList.remove('hidden');
  $('#email').required = true;
  $('#email').value = '';
  $('#password2').classList.toggle('hidden', !setup);
  $('#password2').required = !!setup;
  $('#password').autocomplete = setup ? 'new-password' : 'current-password';
  $('#loginHint').textContent = setup
    ? 'ইমেইল আর একটি পাসওয়ার্ড দিন। পাসওয়ার্ড কমপক্ষে ১০ অক্ষর। এটা EcomDrive বা কুরিয়ারের পাসওয়ার্ড না।'
    : 'ইমেইল আর পাসওয়ার্ড দিয়ে ঢুকুন।';
  $('#loginBtn').textContent = setup ? 'পাসওয়ার্ড সেভ করুন' : 'ঢুকুন';
  $('#loginErr').textContent = offline ? 'সার্ভার বন্ধ। worker ফোল্ডারে node server.mjs চালু আছে কিনা দেখুন।' : '';
}

document.addEventListener('submit', async e => {
  if (e.target.id !== 'loginForm') return; e.preventDefault();
  $('#loginErr').textContent = '';
    const email = $('#email').value.trim();
    const password = $('#password').value;
    try {
      if (!DEMO) { await A.auth.login(email, password); return; }
      if (!email.includes('@')) { $('#loginErr').textContent = 'ইমেইল দিন।'; return; }
      if (window.__loginSetup) {
        if (password.length < 10) { $('#loginErr').textContent = 'কমপক্ষে ১০ অক্ষর দিন।'; return; }
        if (password !== $('#password2').value) { $('#loginErr').textContent = 'দুইবার একই পাসওয়ার্ড দিন।'; return; }
      }
      const res = await api(window.__loginSetup ? '/api/setup' : '/api/login', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password })
      });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { $('#loginErr').textContent = loginMessage(res.status, data); return; }
    user = email;
    $('#password').value = '';
    $('#password2').value = '';
    start();
  } catch (err) {
    $('#loginErr').textContent = DEMO ? 'সার্ভার বন্ধ। node server.mjs চালু আছে কিনা দেখুন।' : 'Sign-in failed: ' + err.message;
  }
});

function exportCsv() {
  const items = sheetColumnItems();
  const head = ['Time', ...items.map(i => ECOM_SALE.has(i.name) ? shortName(i.name) : uiName(i.name)), 'Cash', 'Courier', 'Stock', 'Supplier Dues', 'Owner', 'Net Worth', 'Profit (today)', 'Source'];
  const m = x => x == null ? '' : (x / 100).toFixed(2), profitOf = profitCalc();
  const rows = sortedSnaps().map(r => [r.ts, ...items.map(i => m(snapCell(r, i))), ...['cash', 'courier', 'stock', 'supplier', 'owner', 'nw'].map(k => m(r.totals?.[k])), m(profitOf(r)), r.source]);
  const csv = [head, ...rows].map(r => r.map(x => '"' + String(x).replace(/"/g, '""') + '"').join(',')).join('\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = 'hisab-sheet.csv'; a.click();
}

// ---------- boot ----------
function start() {
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  const out = $('#logoutBtn'); if (out) out.classList.add('hidden');
  window.__signedOut = false;
  calcBusyElsewhere(); // drops stale lock from a hung prior tab
  if (started) return;
  started = true;
  forceReleaseCalc();
  for (const col of Object.keys(S)) {
    // Disk mirror first — Firebase onSnapshot is async; without this, Live Sheet paints empty
    // even when hisab_snapshots / hisab_items still hold the full books.
    let mirrored = readLocalMirror(col);
    if (col === 'snapshots' && sheetPurgedAt()) {
      const cut = sheetPurgedAt();
      mirrored = mirrored.filter(r => snapAfterPurge(r, cut));
      persistSnapshotMirror(mirrored);
    }
    if (mirrored.length) {
      S[col] = col === 'items' ? collapseActiveItemDupes(mirrored) : mirrored;
      LOADED[col] = true;
    }
    A.listen(col, rows => {
      S[col] = keepLocalRows(col, rows);
      const first = !LOADED[col]; LOADED[col] = true;
      if (col === 'settings' && first && !S.settings.some(r => r.id === 'main') && !rows.some(r => r.id === 'main')) {
        // wait for items listener too, then seed once (skip if mirror already has a shop)
        setTimeout(() => { if (!S.settings.some(r => r.id === 'main') && !S.items.length) seed().catch(e => toast(e.message)); }, 1200);
      }
      if (col === 'items') {
        if (first) mergeDuplicateCashAccounts().then(n => { if (n) render(true); }).catch(() => {});
        // Re-run when cloud is sparse/empty so USDT amount is never replaced by a zero seed.
        if (first || rows.length <= 2) ensureUsdtDue().then(() => render(true)).catch(() => {});
      }
      render();
    });
  }
  route();
  setInterval(tick, 15000);
  setTimeout(tick, 3000);
  // One-shot: ?clearSheet=1 clears Live Sheet after data listeners attach.
  if (/[?&]clearSheet=1\b/.test(location.search)) {
    const u = new URL(location.href);
    u.searchParams.delete('clearSheet');
    history.replaceState({}, '', u.pathname + u.search + u.hash);
    setTimeout(() => {
      clearLiveSheet().catch(err => toast(err.message || 'Could not clear Live Sheet'));
    }, 1200);
  }
}
(async function boot() {
  A = DEMO ? localAdapter() : await fsAdapter();
  if (!DEMO) {
    try {
      const u = await A.auth.open();
      if (u) user = u.email || u.uid || 'shop';
      else {
        A = localAdapter();
        toast('Firebase Auth off — shop calc runs here without login. Enable Anonymous or Email auth in Firebase to store in the cloud.');
      }
    } catch (err) {
      console.error(err);
      A = localAdapter();
      toast('Firebase unavailable — shop calc runs here without login.');
    }
  }
  start();
})();
