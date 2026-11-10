/**
 * Full shop calculate on the server: pull couriers/EcomDrive → update Firestore items → Live Sheet row.
 * Runs without any browser open (scheduler + POST /api/calculate).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { checkAccounts, checkCourierHistory, checkDollar, checkExpenses, checkReport, checkStock, checkSuppliers } from './ecomdrive.mjs';
import { checkSteadfast } from './steadfast.mjs';
import { checkPathao } from './pathao.mjs';
import { addDocRow, firestoreConfigured, getMainSettings, listDocs, setDocMerge } from './firestore.mjs';

const TZ = 'Asia/Dhaka';
const USDT_DUE_ID = 'usdt-due';
const ECOM_SALE = new Set(['Ecomdrive · Shipped', 'Ecomdrive · Pending', 'Ecomdrive · RTS', 'Ecomdrive · Pending Return']);
const ECOM_FEE = new Set([]);
const AWAITING = 'Steadfast · Awaiting approval';

const workerDir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.HISAB_DATA_DIR || workerDir;
const smsPath = process.env.HISAB_SMS_FILE || path.join(dataDir, 'sms-balances.json');

let busy = false;
let lastRun = null;

export function calculateStatus() {
  return { busy, lastRun, firestore: firestoreConfigured() };
}

function dkDate(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
}
function hhmm(d) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}

function toMinor(v) {
  let s = String(v ?? '').replace(/[,৳\s]/g, '');
  if (!s || isNaN(Number(s))) return null;
  const neg = s.startsWith('-');
  s = s.replace(/^[-+]/, '');
  const [i, f = ''] = s.split('.');
  const m = parseInt(i || '0', 10) * 100 + parseInt((f + '00').slice(0, 2), 10);
  return neg ? -m : m;
}

function toBase(minor, currency, settings) {
  const cur = String(currency || settings.base || 'BDT').toUpperCase();
  const base = String(settings.base || 'BDT').toUpperCase();
  if (cur === base) return minor || 0;
  const rate = parseFloat(String((settings.rates || {})[cur] ?? '').replace(/,/g, ''));
  if (!Number.isFinite(rate) || rate <= 0) return minor || 0;
  return Math.round((minor || 0) * rate);
}

function codPct(settings) {
  if (settings.codOn === false) return 0;
  const n = parseFloat(String(settings.codPct ?? '1').replace('%', ''));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, 100);
}

function afterCod(v, settings) {
  const pct = codPct(settings);
  if (!pct || v == null) return v;
  const cut = Math.round(Math.abs(v) * pct / 100);
  return v < 0 ? v + cut : v - cut;
}

function isCountOff(settings, name) {
  return !!(settings.countOff || {})[String(name || '')];
}

function isUsdtDue(it) {
  return it?.id === USDT_DUE_ID || /^usdt\s*due$/i.test(String(it?.name || ''));
}

function itemKey(it) {
  if (!it || it.archived) return null;
  if (it.id === USDT_DUE_ID || isUsdtDue(it)) return 'supplier:usdt-due';
  if (it.externalId === 'dollar-main' || /^dollar$/i.test(String(it.name || ''))) return 'cash:dollar';
  if (it.group === 'courier' || String(it.name || '').startsWith('Steadfast') || String(it.name || '').startsWith('Pathao')) {
    return 'courier:name:' + String(it.name || '').trim().toLowerCase();
  }
  if (it.externalId) return (it.group || 'x') + ':ext:' + it.externalId;
  if (it.group === 'stock' || /total stock/i.test(String(it.name || ''))) return 'stock:total';
  return (it.group || '') + ':name:' + String(it.name || '').trim().toLowerCase();
}

function collapse(items) {
  const best = new Map();
  const out = [];
  for (const it of items) {
    if (it.archived) continue;
    const k = itemKey(it);
    if (!k) { out.push(it); continue; }
    const prev = best.get(k);
    if (!prev) best.set(k, it);
    else {
      const pa = Date.parse(prev.updatedAt || '') || 0;
      const pb = Date.parse(it.updatedAt || '') || 0;
      best.set(k, pb >= pa ? it : prev);
    }
  }
  out.push(...best.values());
  return out;
}

function deliveryMinor(name, list) {
  return 0;
}

function compute(items, settings) {
  const T = { cash: 0, courier: 0, stock: 0, otherAsset: 0, supplier: 0, otherLiab: 0, owner: 0, ecomSale: 0, ecomFee: 0 };
  const parts = [];
  const list = collapse(items);
  for (const it of list) {
    let v = toBase(it.balance || 0, it.currency, settings);
    if (ECOM_SALE.has(it.name)) v = afterCod(v - deliveryMinor(it.name, list), settings);
    else if (it.name === AWAITING) v = afterCod(v, settings);
    const inc = isCountOff(settings, it.name) ? false : it.include !== false;
    parts.push({ it, v, inc });
    if (!inc) continue;
    if (T[it.group] !== undefined) T[it.group] += v;
    else if (ECOM_SALE.has(it.name)) T.ecomSale += v;
    else if (ECOM_FEE.has(it.name)) T.ecomFee += Math.abs(v);
  }
  const assets = T.cash + T.courier + T.stock + T.otherAsset;
  const liab = T.supplier + T.otherLiab;
  const nw = assets - liab + T.ecomSale + (settings.ownerInNetWorth ? T.owner : 0);
  return { ...T, assets, liab, nw, parts };
}

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

function normalizeSettleId(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return '';
  const sfc = s.match(/sfc-\d+/);
  if (sfc) return sfc[0];
  return s.replace(/^statement\s+/i, '').trim();
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

function countLastPaid(invoices, payment, courier) {
  const id = normalizeSettleId(payment?.id);
  if (!id && (payment?.amount == null || payment?.amount === '')) return false;
  const kind = String(courier || '').toLowerCase();
  const hit = (invoices || []).some(row => {
    const type = String(row.courier || '').toLowerCase();
    if (kind && !type.includes(kind)) return false;
    const rowId = normalizeSettleId(row.id);
    if (id && rowId && (rowId === id || rowId.includes(id) || id.includes(rowId))) return true;
    return sameMoney(payment?.amount, row.deposited) || sameMoney(payment?.amount, row.collected);
  });
  return !hit;
}

function findByName(items, name) {
  return items.find(i => !i.archived && i.name === name);
}

function findByExt(items, externalId) {
  return items.find(i => !i.archived && i.externalId === externalId);
}

async function upsertItem(items, patch) {
  const now = new Date().toISOString();
  let it = null;
  if (patch.id) it = items.find(i => i.id === patch.id);
  if (!it && patch.externalId) it = findByExt(items, patch.externalId);
  if (!it && patch.name) it = findByName(items, patch.name);
  const body = {
    ...patch,
    updatedAt: now,
    prev: it ? (it.balance || 0) : (patch.balance || 0)
  };
  if (it) {
    Object.assign(it, body);
    await setDocMerge('items', it.id, body);
    return it;
  }
  const id = patch.id || ('srv_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
  const row = { id, include: true, archived: false, currency: 'BDT', ...body };
  items.push(row);
  await setDocMerge('items', id, row);
  return row;
}

async function saveCourier(items, name, category, source, raw, include, paymentId, paymentState) {
  const m = toMinor(raw);
  if (m == null) return;
  const it = findByName(items, name);
  await upsertItem(items, {
    id: it?.id,
    name,
    group: 'courier',
    category,
    source,
    balance: m,
    include: include !== false,
    paymentId: paymentId || '',
    paymentState: paymentState || '',
    archived: false
  });
}

function loadSms() {
  try { return JSON.parse(fs.readFileSync(smsPath, 'utf8')); } catch { return {}; }
}

async function step(name, fn, steps) {
  const row = { name, status: 'run', detail: '' };
  steps.push(row);
  try {
    const detail = await fn();
    row.status = 'ok';
    row.detail = detail || '';
  } catch (err) {
    row.status = 'fail';
    row.detail = err.message || String(err);
  }
  return row;
}

export async function runCalculate({ source = 'calculate', by = 'server' } = {}) {
  if (busy) {
    return { ok: false, busy: true, error: 'Calculate already running', lastRun };
  }
  if (!firestoreConfigured()) {
    throw new Error('Firestore not configured on server (FIREBASE_AUTH_EMAIL / FIREBASE_AUTH_PASSWORD + FIREBASE_*)');
  }
  busy = true;
  const startedAt = new Date().toISOString();
  const steps = [];
  try {
    let settings = await getMainSettings();
    let items = await listDocs('items');
    let paymentWatch = { ...(settings.paymentWatch || {}) };
    let invoices = [];

    await step('Steadfast', async () => {
      const data = await checkSteadfast();
      const decision = decidePayment(paymentWatch.steadfast || {}, data.openPayment, data.paidPayment);
      paymentWatch.steadfast = decision.watch;
      let paidInclude = decision.count === 'paid';
      try {
        if (!invoices.length) invoices = (await checkCourierHistory()).invoices || [];
        paidInclude = countLastPaid(invoices, data.paidPayment, 'steadfast');
      } catch { /* keep decision */ }
      const rows = [
        ['Steadfast · Balance', data.balance, true, '', ''],
        ['Steadfast · Awaiting approval', data.awaitingApproval, true, '', ''],
        ['Steadfast · Approval pending COD delivery charge', data.approvalDeliveryCharge == null ? null : (String(data.approvalDeliveryCharge).startsWith('-') ? String(data.approvalDeliveryCharge) : '-' + String(data.approvalDeliveryCharge)), true, '', ''],
        ['Steadfast · On the way', data.onTheWay, true, '', ''],
        ['Steadfast · Unpaid amount', data.unpaidAmount, decision.count === 'open', data.openPayment?.id || '', data.openPayment?.state || ''],
        ['Steadfast · Last paid amount', data.lastPaidAmount, paidInclude, data.paidPayment?.id || '', 'paid']
      ];
      for (const [name, raw, include, paymentId, paymentState] of rows) {
        if (raw == null) continue;
        await saveCourier(items, name, 'Steadfast', 'steadfast', raw, include, paymentId, paymentState);
      }
      return 'ok';
    }, steps);

    await step('Pathao', async () => {
      const data = await checkPathao();
      const decision = decidePayment(paymentWatch.pathao || {}, data.openPayment, data.paidPayment);
      paymentWatch.pathao = decision.watch;
      let paidInclude = decision.count === 'paid';
      try {
        if (!invoices.length) invoices = (await checkCourierHistory()).invoices || [];
        paidInclude = countLastPaid(invoices, data.paidPayment, 'pathao');
      } catch { /* keep */ }
      const rows = [
        ['Pathao · Upcoming payment', data.upcomingPayment, true, '', ''],
        ['Pathao · In review', data.inReview, true, '', ''],
        ['Pathao · Last processing', data.lastProcessing, decision.count === 'open', data.openPayment?.id || '', data.openPayment?.state || ''],
        ['Pathao · Last paid', data.lastPaidAmount, paidInclude, data.paidPayment?.id || '', 'paid']
      ];
      for (const [name, raw, include, paymentId, paymentState] of rows) {
        if (raw == null) continue;
        await saveCourier(items, name, 'Pathao', 'pathao', raw, include, paymentId, paymentState);
      }
      return 'ok';
    }, steps);

    await step('EcomDrive accounts', async () => {
      const data = await checkAccounts();
      const accounts = data.accounts || data.wallets || data.list || [];
      for (const a of accounts) {
        const name = a.name || a.title || a.accountName;
        const bal = a.balance ?? a.amount ?? a.available;
        const ext = a.id || a.externalId || a.accountId;
        if (!name || bal == null) continue;
        const m = toMinor(bal);
        if (m == null) continue;
        const existing = ext ? findByExt(items, String(ext)) : findByName(items, name);
        await upsertItem(items, {
          id: existing?.id || (ext ? 'ea_' + String(ext) : undefined),
          name,
          group: 'cash',
          externalId: ext ? String(ext) : undefined,
          balance: m,
          source: 'ecomdrive',
          archived: false
        });
      }
      return String(accounts.length || 0) + ' accounts';
    }, steps);

    await step('EcomDrive stock', async () => {
      const data = await checkStock({ headless: true });
      const cost = data.totals?.costValue;
      if (cost == null) throw new Error('No stock cost value');
      const m = toMinor(cost);
      const existing = items.find(i => !i.archived && (i.group === 'stock' || /total stock/i.test(i.name || '')));
      await upsertItem(items, {
        id: existing?.id,
        name: 'Total Stock Value',
        group: 'stock',
        balance: m,
        source: 'ecomdrive',
        archived: false
      });
      return String(cost);
    }, steps);

    await step('EcomDrive report', async () => {
      const data = await checkReport();
      const metrics = data.metrics;
      if (!metrics || typeof metrics !== 'object') throw new Error('Report metrics missing');
      const fields = [
        ['Shipped', 'Ecomdrive · Shipped'],
        ['Pending', 'Ecomdrive · Pending'],
        ['RTS', 'Ecomdrive · RTS'],
        ['Pending Return', 'Ecomdrive · Pending Return']
      ];
      const delivery = [
        ['Shipped', 'Ecomdrive · Shipped delivery'],
        ['Pending', 'Ecomdrive · Pending delivery'],
        ['RTS', 'Ecomdrive · RTS delivery'],
        ['Pending Return', 'Ecomdrive · Pending Return delivery']
      ];
      let n = 0;
      for (const [label, name] of fields) {
        const m = toMinor(metrics[label]?.revenue);
        if (m == null) continue;
        const existing = findByName(items, name);
        await upsertItem(items, { id: existing?.id, name, group: 'metric', balance: m, source: 'ecomdrive', archived: false });
        n += 1;
      }
      for (const [label, name] of delivery) {
        const m = toMinor(metrics[label]?.delivery);
        if (m == null) continue;
        const neg = m === 0 ? 0 : -Math.abs(m);
        const existing = findByName(items, name);
        await upsertItem(items, { id: existing?.id, name, group: 'metric', balance: neg, source: 'ecomdrive', archived: false });
        n += 1;
      }
      if (!n) throw new Error('Report fields empty');
      return n + ' metrics';
    }, steps);

    await step('EcomDrive suppliers', async () => {
      const data = await checkSuppliers();
      const list = data.suppliers || data.list || [];
      for (const s of list) {
        const name = s.name || s.title;
        const due = s.due ?? s.balance ?? s.amount;
        const ext = s.id || s.externalId;
        if (!name || due == null) continue;
        const m = toMinor(due);
        if (m == null) continue;
        const existing = ext ? findByExt(items, String(ext)) : findByName(items, name);
        if (isUsdtDue(existing) || /^usdt/i.test(name)) continue;
        await upsertItem(items, {
          id: existing?.id || (ext ? 'es_' + String(ext) : undefined),
          name,
          group: 'supplier',
          externalId: ext ? String(ext) : undefined,
          balance: m,
          source: 'ecomdrive',
          archived: false
        });
      }
      return String(list.length || 0) + ' suppliers';
    }, steps);

    await step('Expenses', async () => {
      const data = await checkExpenses();
      const pairs = [
        ['expense-meta', 'Meta Ads', data.meta || '0'],
        ['expense-other', 'Expenses except Meta Ads', data.other || '0']
      ];
      for (const [ext, name, raw] of pairs) {
        const m = toMinor(raw);
        if (m == null) continue;
        const existing = findByExt(items, ext) || findByName(items, name);
        await upsertItem(items, {
          id: existing?.id,
          name,
          group: 'expense',
          externalId: ext,
          balance: m,
          source: 'ecomdrive',
          archived: false,
          include: existing ? existing.include !== false : false
        });
      }
      return `meta ${data.meta || 0} · other ${data.other || 0}`;
    }, steps);

    await step('Dollar', async () => {
      const data = await checkDollar();
      const base = Number(settings.dollarBase || '171');
      const spent = Number(data.spent || 0);
      const left = Math.round((base - spent) * 100) / 100;
      const rate = String(data.rate || settings.rates?.USD || '128');
      if (String(settings.rates?.USD || '') !== rate) {
        settings.rates = { ...(settings.rates || {}), USD: rate };
        await setDocMerge('settings', 'main', { rates: settings.rates });
      }
      const m = toMinor(left);
      if (m == null) throw new Error('Dollar balance could not be calculated');
      const existing = items.find(i => !i.archived && (i.externalId === 'dollar-main' || /^dollar$/i.test(i.name || '')));
      await upsertItem(items, {
        id: existing?.id,
        name: 'Dollar',
        group: 'cash',
        currency: 'USD',
        externalId: 'dollar-main',
        balance: m,
        opening: toMinor(base) ?? existing?.opening,
        source: 'ecomdrive',
        archived: false
      });
      return `left $${left.toFixed(2)}`;
    }, steps);

    await step('SMS balances', async () => {
      const saved = loadSms();
      let n = 0;
      for (const [account, row] of Object.entries(saved)) {
        const m = toMinor(row.balance);
        if (m == null) continue;
        const names = account === 'bkash'
          ? items.filter(i => !i.archived && /bkash/i.test(i.name || ''))
          : items.filter(i => !i.archived && /nagad/i.test(i.name || ''));
        for (const it of names) {
          await upsertItem(items, { id: it.id, name: it.name, group: 'cash', balance: m, source: 'sms', archived: false });
          n += 1;
        }
      }
      return n ? n + ' updated' : 'none';
    }, steps);

    await step('Live Sheet', async () => {
      items = await listDocs('items');
      settings = { ...settings, paymentWatch };
      const t = compute(items, settings);
      const now = new Date();
      const values = {}, names = {};
      for (const p of t.parts) {
        if (!p.inc || !p.it?.id || p.it.name == null) continue;
        if (ECOM_FEE.has(p.it.name)) continue;
        names[p.it.id] = p.it.name;
        values[p.it.id] = p.v;
      }
      const row = {
        ts: now.toISOString(),
        date: dkDate(now),
        source,
        by,
        values,
        names,
        ecomNet: 2,
        codApplied: codPct(settings) > 0 ? 1 : 0,
        totals: {
          cash: t.cash,
          courier: t.courier,
          stock: t.stock,
          supplier: t.supplier + t.otherLiab,
          owner: t.owner,
          assets: t.assets,
          liab: t.liab,
          nw: t.nw
        }
      };
      const id = await addDocRow('snapshots', row);
      const calcAt = now.toISOString();
      await setDocMerge('settings', 'main', {
        paymentWatch,
        lastCalcAt: calcAt,
        interval: Math.max(0, Number(settings.interval) || 0),
        syncErrors: steps.filter(s => s.status === 'fail').map(s => ({ name: s.name, message: s.detail, at: calcAt })),
        updatedAt: calcAt
      });
      return id + ' · nw=' + (t.nw / 100).toFixed(2);
    }, steps);

    lastRun = {
      at: startedAt,
      finishedAt: new Date().toISOString(),
      steps,
      ok: steps.every(s => s.status === 'ok')
    };
    return { ok: lastRun.ok, busy: false, steps, lastRun };
  } finally {
    busy = false;
  }
}

/** Interval / clock schedule — call from server timer. */
export async function tickSchedule() {
  if (busy || !firestoreConfigured()) return null;
  const settings = await getMainSettings();
  const every = Math.max(0, Number(settings.interval) || 0);
  if (every <= 0) return null;
  const last = settings.lastCalcAt ? Date.parse(settings.lastCalcAt) : 0;
  if (Date.now() - last < every * 60000) {
    // Still allow Dhaka clock rows without a full pull when due.
    const now = new Date();
    const hm = hhmm(now);
    if (Array.isArray(settings.times) && settings.times.includes(hm)) {
      // Full calculate covers sched; skip duplicate spam within the same minute window.
    }
    return null;
  }
  return runCalculate({ source: 'calculate', by: 'scheduler' });
}
