import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const root = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(root, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim();
    if (!process.env[k]) process.env[k] = v;
  }
}

const EMAIL = process.env.ECOMDRIVE_EMAIL || '';
const PASSWORD = process.env.ECOMDRIVE_PASSWORD || '';
const SECTION = process.env.ECOMDRIVE_SECTION || 'active';
const BASE = 'https://my.ecomdrivebd.com';
const FAPI = 'https://clerk.app.ecomdrivebd.com';
const outDir = path.join(root, 'out');
const listUrl = section => section && section !== 'active'
  ? `${BASE}/product/product-list?section=${encodeURIComponent(section)}`
  : `${BASE}/product/product-list`;

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function money(n) {
  if (n == null || Number.isNaN(Number(n))) return null;
  return (Math.round(Number(n) * 100) / 100).toFixed(2);
}

const clerkState = { jar: new Map(), sessionId: '', jwt: '', exp: 0, businessId: '' };
let signingIn = null;

function readExp(jwt) {
  try {
    const json = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
    return Number(json.exp) ? Number(json.exp) * 1000 : 0;
  } catch { return 0; }
}

function rememberJwt(jwt) {
  clerkState.jwt = jwt;
  clerkState.exp = readExp(jwt) || Date.now() + 50 * 1000;
}

function takeCookies(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const c of list) {
    const pair = c.split(';')[0];
    const i = pair.indexOf('=');
    if (i > 0) clerkState.jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}

async function clerkCall(pathname, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch(FAPI + pathname, {
      method: body ? 'POST' : 'GET',
      headers: {
        origin: BASE,
        referer: BASE + '/sign-in',
        ...(clerkState.jar.size ? { cookie: [...clerkState.jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
        ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {})
      },
      body: body ? new URLSearchParams(body) : undefined,
      signal: ctrl.signal
    });
    takeCookies(res);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = json?.errors?.[0]?.long_message || json?.errors?.[0]?.message || ('Clerk HTTP ' + res.status);
      throw new Error(msg);
    }
    return json;
  } catch (err) {
    if (err?.name === 'AbortError' || ctrl.signal.aborted) throw new Error('EcomDrive sign-in timed out');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function passwordLogin() {
  if (!EMAIL || !PASSWORD) throw new Error('Set ECOMDRIVE_EMAIL and ECOMDRIVE_PASSWORD in worker/.env');
  console.log('signing in to EcomDrive');
  const html = await fetch(BASE + '/sign-in').then(r => r.text());
  if (!/pk_(?:live|test)_/.test(html)) throw new Error('EcomDrive sign-in page did not load');
  clerkState.jar = new Map();
  clerkState.sessionId = '';
  clerkState.jwt = '';
  clerkState.exp = 0;
  clerkState.businessId = '';
  await clerkCall('/v1/client');
  const started = await clerkCall('/v1/client/sign_ins', { identifier: EMAIL });
  const signInId = started?.response?.id;
  if (!signInId) throw new Error('EcomDrive did not start a sign-in');
  const attempt = await clerkCall(`/v1/client/sign_ins/${signInId}/attempt_first_factor`, {
    strategy: 'password',
    password: PASSWORD
  });
  if (attempt?.response?.status !== 'complete') {
    throw new Error('EcomDrive asked for an extra code. Sign in once in a browser, then try the check again.');
  }
  const session = (attempt?.client?.sessions || []).find(s => s.last_active_token?.jwt);
  const jwt = session?.last_active_token?.jwt;
  if (!jwt) throw new Error('EcomDrive did not return a session');
  clerkState.sessionId = session.id || attempt?.response?.created_session_id || '';
  rememberJwt(jwt);
  return clerkState.jwt;
}

async function refreshJwt() {
  if (!clerkState.sessionId || !clerkState.jar.size) return '';
  try {
    const json = await clerkCall(`/v1/client/sessions/${clerkState.sessionId}/tokens`, {});
    const jwt = json?.jwt;
    if (!jwt) return '';
    rememberJwt(jwt);
    console.log('EcomDrive session reused');
    return clerkState.jwt;
  } catch (err) {
    const msg = String(err?.message || '');
    console.log(msg.startsWith('Clerk HTTP') ? 'EcomDrive session refresh failed: ' + msg : 'EcomDrive session refresh failed');
    return '';
  }
}

async function getJwt() {
  if (clerkState.jwt && clerkState.exp - 15000 > Date.now()) return clerkState.jwt;
  if (!signingIn) {
    signingIn = (async () => {
      const refreshed = await refreshJwt();
      if (refreshed) return refreshed;
      return passwordLogin();
    })().finally(() => { signingIn = null; });
  }
  return signingIn;
}

function authHeaders(jwt) {
  return {
    authorization: 'Bearer ' + jwt,
    origin: BASE,
    accept: 'application/json',
    ...(clerkState.jar.size ? { cookie: [...clerkState.jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {})
  };
}

async function ensureBusinessId(jwt) {
  if (clerkState.businessId) return clerkState.businessId;
  const res = await fetch(BASE + '/api/app/v1/me/businesses', { headers: authHeaders(jwt) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message || ('businesses HTTP ' + res.status));
  const item = (json.items || []).find(b => b.isDefault) || (json.items || [])[0];
  if (!item?.id) throw new Error('EcomDrive business not found');
  clerkState.businessId = item.id;
  return clerkState.businessId;
}

/** EcomDrive retired Node tRPC; shop data is now Go REST under /api/app/v1/businesses/{id}/… */
async function api(pathname, query) {
  const jwt = await getJwt();
  const businessId = await ensureBusinessId(jwt);
  const qs = query && Object.keys(query).length
    ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v != null && v !== '')).toString()
    : '';
  const url = `${BASE}/api/app/v1/businesses/${businessId}${pathname}${qs}`;
  let res = await fetch(url, { headers: authHeaders(jwt) });
  if (res.status === 401 || res.status === 403) {
    clerkState.jwt = '';
    clerkState.exp = 0;
    clerkState.businessId = '';
    const jwt2 = await getJwt();
    const businessId2 = await ensureBusinessId(jwt2);
    res = await fetch(`${BASE}/api/app/v1/businesses/${businessId2}${pathname}${qs}`, { headers: authHeaders(jwt2) });
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json?.error?.message || (pathname + ' HTTP ' + res.status));
  }
  return json;
}

async function collectCursor(pathname, mapItem, query = {}, maxPages = 40) {
  const out = [];
  let cursor = '';
  for (let page = 0; page < maxPages; page++) {
    const data = await api(pathname, { ...query, ...(cursor ? { cursor } : {}) }) || {};
    const rows = data.items || data.rows || [];
    for (const row of rows) {
      const mapped = mapItem(row);
      if (mapped) out.push(mapped);
    }
    cursor = data.nextCursor || '';
    if (!cursor || !rows.length) break;
  }
  return out;
}

async function pull(status) {
  const products = [];
  // New Go API rejects legacy status filters; pull the catalog and filter locally.
  const rows = await collectCursor('/products', p => p, {}, 80);
  for (const p of rows) {
    const active = p.isActive !== false && p.active !== false;
    if (status === 'active' && !active) continue;
    if (status === 'inactive' && active) continue;
    products.push({
      sku: p.businessSku || p.sku || '',
      name: p.name || '',
      costPrice: p.costPrice ?? p.avgCostPrice,
      sellingPrice: p.price ?? p.sellingPrice,
      stockQty: p.stockQty ?? p.stock,
      comboQty: p.comboStock ?? p.comboQty,
      active
    });
  }
  const stats = await api('/products/stats') || {};
  return { products, stats };
}

const REPORT_STATUSES = [
  ['Shipped', 'Shipped'],
  ['Pending', 'Pending'],
  ['RTS', 'RTS'],
  ['Pending_Return', 'Pending Return']
];

const inflight = new Map();
function once(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const job = Promise.resolve().then(fn).finally(() => {
    if (inflight.get(key) === job) inflight.delete(key);
  });
  inflight.set(key, job);
  return job;
}

export function checkStock(options = {}) {
  return once('stock', () => runCheck(options));
}

export function checkReport() {
  return once('report', runReport);
}

export function checkSuppliers() {
  return once('suppliers', runSuppliers);
}

export function checkAccounts() {
  return once('accounts', runAccounts);
}

export function checkCourierHistory() {
  return once('courier-history', runCourierHistory);
}

const META_ADS_CATEGORY = 'cmed57p6oe4aonv0kuq2oinhx';
const DOLLAR_START = '2026-10-25';

function dkDay(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(d);
}

async function expenseMatrixPages(query = {}, maxPages = 60) {
  const columns = [];
  const dayRows = [];
  let cursor = '';
  for (let page = 0; page < maxPages; page++) {
    const data = await api('/finance/expense-matrix', { ...query, ...(cursor ? { cursor } : {}) }) || {};
    if (page === 0 && Array.isArray(data.columns)) columns.push(...data.columns);
    const days = data.days?.items || data.days || data.rows || [];
    const list = Array.isArray(days) ? days : [];
    for (const row of list) dayRows.push(row);
    cursor = data.days?.nextCursor || data.nextCursor || '';
    if (!cursor || !list.length) break;
  }
  return { columns, dayRows };
}

async function runDollar() {
  console.log('checking EcomDrive dollar expenses');
  const today = dkDay(new Date().toISOString());
  const { columns, dayRows } = await expenseMatrixPages({ categoryIds: META_ADS_CATEGORY });
  const column = columns.find(c => c.id === META_ADS_CATEGORY);
  const label = column?.label || 'Meta Ads';
  const byDay = new Map();
  for (const row of dayRows) {
    const date = row.date || row.day || '';
    if (!date || date < DOLLAR_START || date > today) continue;
    const cells = Array.isArray(row.cells) ? row.cells : [];
    const cell = cells.find(c => c.categoryId === META_ADS_CATEGORY) || cells[0];
    byDay.set(date, {
      date,
      usd: money(cell?.usd ?? row.usd ?? row.usdTotal ?? 0),
      bdt: money(cell?.amount ?? row.total ?? row.amount ?? 0)
    });
  }
  const days = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
  const spent = days.reduce((s, d) => s + Number(d.usd || 0), 0);
  const todayRow = days.find(d => d.date === today);
  return {
    source: BASE + '/finance/income-expense',
    category: label,
    categoryId: META_ADS_CATEGORY,
    start: DOLLAR_START,
    today,
    rate: '128',
    spent: money(spent),
    todayUsd: todayRow?.usd || '0.00',
    days,
    pulledAt: new Date().toISOString()
  };
}

async function runExpenses() {
  console.log('checking EcomDrive expenses');
  const today = dkDay(new Date().toISOString());
  const { columns, dayRows } = await expenseMatrixPages();
  const labels = Object.fromEntries((columns || []).map(c => [c.id, c.label || c.id]));
  const sums = {};
  for (const row of dayRows) {
    const date = row.date || row.day || '';
    if (date !== today) continue;
    const cells = Array.isArray(row.cells) ? row.cells : [];
    for (const cell of cells) {
      const id = cell.categoryId;
      if (!id) continue;
      sums[id] = (sums[id] || 0) + Number(cell.amount || 0);
    }
  }
  // If today has no day rows yet, fall back to column totals only for zero-safe UI.
  let metaTotal = 0;
  const categories = [];
  for (const [id, label] of Object.entries(labels)) {
    const amount = sums[id] || 0;
    if (id === META_ADS_CATEGORY || label === 'Meta Ads') metaTotal += amount;
    else categories.push({ label, amount: money(amount) });
  }
  categories.sort((a, b) => Number(b.amount) - Number(a.amount));
  const otherTotal = categories.reduce((s, c) => s + Number(c.amount || 0), 0);
  return {
    source: BASE + '/finance/income-expense',
    today,
    meta: money(metaTotal),
    other: money(otherTotal),
    categories,
    pulledAt: new Date().toISOString()
  };
}

export function checkExpenses() {
  return once('expenses', runExpenses);
}

let dollarFlight = null;
export function checkDollar() {
  if (dollarFlight) return dollarFlight;
  const hardMs = 55000;
  dollarFlight = Promise.race([
    runDollar(),
    new Promise((_, rej) => setTimeout(() => rej(new Error('EcomDrive dollar check timed out after ' + Math.round(hardMs / 1000) + 's')), hardMs))
  ]).finally(() => { dollarFlight = null; });
  return dollarFlight;
}

async function runSuppliers() {
  console.log('checking EcomDrive active suppliers');
  const suppliers = (await collectCursor('/suppliers', s => {
    const due = Number(s.summary?.totalDue ?? s.totalDue ?? 0);
    if (s.isActive === false || !(due > 0)) return null;
    return {
      id: s.id,
      name: s.name,
      due: money(due),
      dueDate: dkDay(s.summary?.oldestDueDate || s.oldestDueDate || '')
    };
  })).sort((a, b) => a.name.localeCompare(b.name));
  return { source: BASE + '/purchase/suppliers', pulledAt: new Date().toISOString(), suppliers };
}

async function runAccounts() {
  console.log('checking EcomDrive accounts');
  const accounts = (await collectCursor('/payment-accounts', a => {
    if (a.isActive === false || !a.name) return null;
    return { id: a.id, name: a.name, balance: money(a.balance || 0) };
  })).sort((a, b) => a.name.localeCompare(b.name));
  return { source: BASE + '/accounts', pulledAt: new Date().toISOString(), accounts };
}

async function runReport() {
  console.log('checking EcomDrive report All');
  const endDay = dkDay(new Date().toISOString()) || new Date().toISOString().slice(0, 10);
  const range = { startDate: '2015-12-31', endDate: endDay };
  const data = await api('/reports/order-management/monthly-sales', range);
  const sales = await api('/reports/order-management/net-product-sales', range);
  const norm = row => String(row?.status || row?.statusText || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const by = Object.fromEntries((data?.rows || []).map(r => [norm(r), r]));
  const chargeBy = Object.fromEntries((sales?.rows || []).map(r => [norm(r), r]));
  // New API uses DELIVERED; Hisab sheet still labels the live pipeline as Shipped/Pending/…
  if (by.delivered && !by.shipped) by.shipped = by.delivered;
  if (chargeBy.delivered && !chargeBy.shipped) chargeBy.shipped = chargeBy.delivered;
  const amount = row => {
    if (!row) return null;
    const n = row.totalRevenue ?? row.finalAmount ?? row.grossSale ?? row.productAmount;
    return n == null || n === '' ? null : n;
  };
  const metrics = {};
  for (const [status, label] of REPORT_STATUSES) {
    const key = status.toLowerCase();
    const row = by[key] || null;
    const charge = chargeBy[key] || null;
    metrics[label] = {
      orders: row?.orderCount || charge?.orderCount || 0,
      revenue: money(amount(row) ?? amount(charge) ?? 0),
      delivery: money(charge?.deliveryCharge || 0)
    };
  }
  return {
    range: 'all',
    source: BASE + '/reports/business-reports?report=net-product-sales',
    pulledAt: new Date().toISOString(),
    metrics
  };
}

let historyCache = { at: 0, data: null };
function recentSettlement(iso) {
  if (!iso) return true;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return true;
  const age = Date.now() - t;
  return age <= 30 * 24 * 60 * 60 * 1000 && age > -36 * 60 * 60 * 1000;
}

async function runCourierHistory() {
  if (historyCache.data && Date.now() - historyCache.at < 60 * 1000) return historyCache.data;
  console.log('checking EcomDrive courier settlement history');
  const invoices = [];
  const rows = await collectCursor('/finance/courier-invoices', r => r, {}, 30);
  for (const row of rows) {
    const rawId = String(row.courierInvoiceId || '').trim();
    const id = rawId.replace(/^Statement\s+/i, '').trim() || rawId;
    const when = row.paymentAt || row.paymentDate || row.settledAt || row.updatedAt || '';
    if (!id || !recentSettlement(when)) continue;
    invoices.push({
      id,
      rawId,
      courier: String(row.deliveryMethodType || row.deliveryMethodName || ''),
      status: String(row.status || ''),
      deposited: money(row.depositedAmount),
      collected: money(row.totalAmount),
      paidOn: when ? String(when).slice(0, 10) : ''
    });
  }
  const payload = {
    source: BASE + '/courier-report?tab=history',
    pulledAt: new Date().toISOString(),
    invoices
  };
  historyCache = { at: Date.now(), data: payload };
  return payload;
}

async function runCheck(options = {}) {
  const section = options.section || SECTION || 'active';
  console.log('checking EcomDrive API', listUrl(section));
  const { products, stats } = await pull(section);
  const payload = {
    source: listUrl(section),
    section,
    pulledAt: new Date().toISOString(),
    totals: {
      products: stats.totalProducts ?? products.length,
      stockQty: stats.totalStock ?? null,
      costValue: money(stats.totalCostPrice),
      sellValue: money(stats.totalSellPrice)
    },
    products
  };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${section}-products.json`), JSON.stringify(payload, null, 2));
  const header = ['sku', 'name', 'costPrice', 'sellingPrice', 'stockQty', 'comboQty'];
  const lines = [header.join(',')];
  for (const p of products) lines.push(header.map(k => csvCell(p[k])).join(','));
  fs.writeFileSync(path.join(outDir, `${section}-products.csv`), lines.join('\n'));
  return payload;
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) {
  checkStock().then(payload => {
    console.log(JSON.stringify({ ok: true, totals: payload.totals, count: payload.products.length }, null, 2));
  }).catch(err => {
    console.error(err.message || err);
    process.exit(1);
  });
}
