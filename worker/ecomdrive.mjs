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

function trpcInput(json, meta) {
  return encodeURIComponent(JSON.stringify({ 0: { json, ...(meta ? { meta } : {}) } }));
}

const clerkState = { jar: new Map(), sessionId: '', jwt: '', exp: 0 };
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

async function ecom(procedure, json, meta) {
  try {
    return await trpc(await getJwt(), procedure, json, meta);
  } catch (err) {
    if (err.message !== 'AUTH') throw err;
    clerkState.jwt = '';
    clerkState.exp = 0;
    return await trpc(await getJwt(), procedure, json, meta);
  }
}

async function trpc(jwt, procedure, json, meta) {
  const url = `${BASE}/api/trpc/${procedure}?batch=1&input=${trpcInput(json, meta)}`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${jwt}`, origin: BASE } });
  const body = await res.json().catch(() => null);
  if (res.status === 401 || res.status === 403) throw new Error('AUTH');
  if (!res.ok) throw new Error(procedure + ' HTTP ' + res.status);
  const err = body?.[0]?.error;
  if (err) throw new Error(err?.json?.message || err?.message || procedure + ' failed');
  return body?.[0]?.result?.data?.json;
}

async function pull(status) {
  const products = [];
  let pageIndex = 0;
  let pageCount = 1;
  const undefinedMeta = { values: { sortBy: ['undefined'], sortDirection: ['undefined'], tagIds: ['undefined'], untagged: ['undefined'], manageStock: ['undefined'] }, v: 1 };
  while (pageIndex < pageCount && pageIndex < 200) {
    const data = await ecom('product.getAllProducts', {
      pageIndex, pageSize: 100, search: '', collapseStockLinks: true,
      sortBy: null, sortDirection: null, categoryId: [], brandId: [],
      status, tagIds: null, untagged: null, manageStock: null
    }, undefinedMeta) || {};
    const rows = data.rows || [];
    pageCount = data.pageCount || 1;
    for (const p of rows) {
      products.push({
        sku: p.sku || '',
        name: p.name || '',
        costPrice: p.costPrice,
        sellingPrice: p.price,
        stockQty: p.stockQty,
        comboQty: p.comboStock,
        active: p.isActive
      });
    }
    if (!rows.length) break;
    pageIndex += 1;
  }
  const stats = await ecom('product.getProductStats', {
    search: '', collapseStockLinks: true, categoryId: [], brandId: [],
    status, tagIds: null, untagged: null, manageStock: null
  }, { values: { tagIds: ['undefined'], untagged: ['undefined'], manageStock: ['undefined'] }, v: 1 }) || {};
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
function dhakaStart(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) - 6 * 60 * 60 * 1000);
}
async function runDollar() {
  console.log('checking EcomDrive dollar expenses');
  const today = dkDay(new Date().toISOString());
  const start = dhakaStart(DOLLAR_START);
  const end = new Date(dhakaStart(today).getTime() + 24 * 60 * 60 * 1000 - 1);
  const meta = { values: { startDate: ['Date'], endDate: ['Date'], subCategoryIds: ['undefined'] }, v: 1 };
  const byDay = new Map();
  let label = 'Meta Ads';
  let rate = '128';
  let page = 0;
  let pageCount = 1;
  while (page < pageCount && page < 30) {
    const data = await ecom('incomeExpense.getExpenseMatrix', {
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      categoryIds: [META_ADS_CATEGORY],
      subCategoryIds: null,
      page,
      sortKey: 'date',
      sortDir: 'desc'
    }, meta) || {};
    pageCount = Number(data.pageCount) || 1;
    const column = (data.columns || []).find(c => c.id === META_ADS_CATEGORY);
    if (column?.label) label = column.label;
    for (const row of data.rows || []) {
      if (!row.day || row.day < DOLLAR_START || row.day > today) continue;
      const cellRate = row.cells?.[META_ADS_CATEGORY]?.find(c => c.usdRate)?.usdRate;
      if (cellRate) rate = String(cellRate);
      byDay.set(row.day, { date: row.day, usd: money(row.usdTotal || 0), bdt: money(row.total || 0) });
    }
    page += 1;
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
    rate,
    spent: money(spent),
    todayUsd: todayRow?.usd || '0.00',
    days,
    pulledAt: new Date().toISOString()
  };
}
async function runExpenses() {
  console.log('checking EcomDrive expenses');
  const today = dkDay(new Date().toISOString());
  const start = dhakaStart(today);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
  const meta = { values: { startDate: ['Date'], endDate: ['Date'], subCategoryIds: ['undefined'] }, v: 1 };
  const sums = {};
  const labels = {};
  let page = 0;
  let pageCount = 1;
  while (page < pageCount && page < 10) {
    const data = await ecom('incomeExpense.getExpenseMatrix', {
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      categoryIds: [],
      subCategoryIds: null,
      page,
      sortKey: 'date',
      sortDir: 'desc'
    }, meta) || {};
    pageCount = Number(data.pageCount) || 1;
    for (const col of data.columns || []) labels[col.id] = col.label || col.id;
    for (const row of data.rows || []) {
      if (row.day !== today) continue;
      for (const [id, cells] of Object.entries(row.cells || {})) {
        const amount = (Array.isArray(cells) ? cells : []).reduce((s, c) => s + Number(c.amount || 0), 0);
        sums[id] = (sums[id] || 0) + amount;
      }
    }
    page += 1;
  }
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

function dkDay(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(d);
}

async function runSuppliers() {
  console.log('checking EcomDrive active suppliers');
  const list = await ecom('supplier.getSuppliers', { status: 'all' }) || [];
  const dueRows = await ecom('supplier.getSupplierDueReport', null, { values: ['undefined'], v: 1 }) || [];
  const dueById = Object.fromEntries((Array.isArray(dueRows) ? dueRows : []).map(r => [r.supplierId, r]));
  const suppliers = (Array.isArray(list) ? list : [])
    .filter(s => s.isActive && Number(s.totalDue) > 0)
    .map(s => ({
      id: s.id,
      name: s.name,
      due: money(s.totalDue),
      dueDate: dkDay(dueById[s.id]?.oldestDueDate)
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { source: BASE + '/purchase/suppliers', pulledAt: new Date().toISOString(), suppliers };
}

async function runAccounts() {
  console.log('checking EcomDrive accounts');
  const accounts = [];
  let page = 1;
  let pages = 1;
  while (page <= pages && page < 20) {
    const data = await ecom('account.getAccounts', { page, limit: 50, searchTerm: null }, { values: { searchTerm: ['undefined'] }, v: 1 }) || {};
    const rows = Array.isArray(data.accounts) ? data.accounts : [];
    pages = Number(data.pages) || 1;
    for (const a of rows) {
      if (a.isActive === false || !a.name) continue;
      accounts.push({ id: a.id, name: a.name, balance: money(a.balance || 0) });
    }
    if (!rows.length) break;
    page += 1;
  }
  accounts.sort((a, b) => a.name.localeCompare(b.name));
  return { source: BASE + '/accounts', pulledAt: new Date().toISOString(), accounts };
}

async function runReport() {
  console.log('checking EcomDrive report All');
  const end = new Date().toISOString();
  const range = {
    startDate: '2015-12-31T18:00:00.000Z',
    endDate: end
  };
  const meta = { values: { startDate: ['Date'], endDate: ['Date'] }, v: 1 };
  const data = await ecom('orderManagementReport.getMonthlySalesSummary', range, meta);
  const sales = await ecom('orderManagementReport.getNetProductSalesSummary', range, meta);
  const norm = row => String(row?.status || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const by = Object.fromEntries((data?.rows || []).map(r => [norm(r), r]));
  const chargeBy = Object.fromEntries((sales?.rows || []).map(r => [norm(r), r]));
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
  return { range: 'all', source: BASE + '/reports/business-reports?report=net-product-sales', pulledAt: end, metrics };
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
  let page = 1;
  let total = Infinity;
  while (page <= 20) {
    const data = await ecom('finance.getCourierPaymentInvoices', {
      page, limit: 50, courierType: null, dateRange: null, preserveTime: false
    }, { values: { courierType: ['undefined'], dateRange: ['undefined'] }, v: 1 }) || {};
    const rows = data.invoices || [];
    total = Number(data.totalCount) || rows.length;
    for (const row of rows) {
      const rawId = String(row.courierInvoiceId || '').trim();
      // UI label is often "Statement SFC-…"; Steadfast payment id is plain "SFC-…".
      const id = rawId.replace(/^Statement\s+/i, '').trim() || rawId;
      const when = row.paymentDate || row.settledAt || row.updatedAt || '';
      if (!id || !recentSettlement(when)) continue;
      invoices.push({
        id,
        rawId,
        courier: String(row.deliveryMethodType || ''),
        status: String(row.status || ''),
        deposited: money(row.depositedAmount),
        collected: money(row.totalAmount),
        paidOn: when ? String(when).slice(0, 10) : ''
      });
    }
    if (!rows.length || page * 50 >= total) break;
    page += 1;
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
