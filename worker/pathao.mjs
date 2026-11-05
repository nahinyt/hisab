import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(root, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    const k = t.slice(0, i).trim();
    if (!process.env[k]) process.env[k] = t.slice(i + 1).trim();
  }
}

const EMAIL = process.env.PATHAO_EMAIL || '';
const PASSWORD = process.env.PATHAO_PASSWORD || '';
const BASE = 'https://merchant.pathao.com';

function money(n) {
  if (n == null || Number.isNaN(Number(n))) return null;
  return (Math.round(Number(n) * 100) / 100).toFixed(2);
}

async function login() {
  if (!EMAIL || !PASSWORD) throw new Error('Set PATHAO_EMAIL and PATHAO_PASSWORD in worker/.env');
  const res = await fetch(BASE + '/api/v1/login', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      origin: BASE,
      referer: BASE + '/login'
    },
    body: JSON.stringify({ username: EMAIL.trim().toLowerCase(), password: PASSWORD.trim() })
  });
  const json = await res.json().catch(() => null);
  const token = json?.data?.access_token || json?.access_token;
  if (!res.ok || !token) throw new Error(json?.message || 'Pathao did not accept the sign-in');
  return token;
}

async function api(token, pathname) {
  const res = await fetch(BASE + pathname, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      origin: BASE,
      referer: BASE + '/courier/dashboard'
    }
  });
  const json = await res.json().catch(() => null);
  if (res.status === 401 || res.status === 403) throw new Error('Pathao asked to sign in again');
  if (!res.ok) throw new Error('Pathao request failed');
  return json;
}

function rowsOf(json) {
  const found = [];
  const walk = (v, d) => {
    if (!v || d > 5) return;
    if (Array.isArray(v)) {
      if (v.some(x => x && typeof x === 'object' && ('status' in x || 'payment_status' in x || 'invoice_id' in x))) found.push(v);
      return;
    }
    if (typeof v === 'object') for (const x of Object.values(v)) walk(x, d + 1);
  };
  walk(json, 0);
  return found[0] || [];
}

function rowAmount(r) {
  return money(r.net_payable ?? r.payable_amount ?? r.merchant_payable ?? r.amount ?? r.total_amount ?? r.collected_amount);
}

function rowState(r) {
  const s = String(r.status || r.payment_status || '').toLowerCase();
  if (/unpaid|processing|pending/.test(s) && !/^paid$/.test(s)) return /processing/.test(s) ? 'processing' : 'unpaid';
  if (/paid|complete|processed/.test(s)) return 'paid';
  return '';
}

let savedToken = '';

async function token() {
  if (savedToken) return savedToken;
  console.log('signing in to Pathao');
  savedToken = await login();
  return savedToken;
}

async function call(pathname) {
  try {
    return await api(await token(), pathname);
  } catch (err) {
    if (err.message !== 'Pathao asked to sign in again') throw err;
    savedToken = '';
    return await api(await token(), pathname);
  }
}

async function runPathao() {
  console.log('checking Pathao courier');
  if (savedToken) console.log('Pathao session reused');
  const summaryJson = await call('/api/v1/monetary/merchant/invoice-summary');
  const summary = summaryJson?.data || {};
  const upcoming = money(Math.max(Number(summary.payment_preparing_for_invoice) || 0, 0));
  const inReview = money(summary.payment_in_review || 0);
  if (upcoming == null || inReview == null) throw new Error('Pathao did not return the invoice summary');

  const list = rowsOf(await call('/api/v1/monetary/invoices/list?page=1&per_page=20')).map(r => ({
    id: String(r.invoice_id || r.id || ''),
    amount: rowAmount(r),
    state: rowState(r),
    note: String(r.paid_at || r.created_at || '').slice(0, 10)
  })).filter(r => r.id && r.amount != null);
  const open = list.find(r => r.state === 'processing' || r.state === 'unpaid') || null;
  const paid = list.find(r => r.state === 'paid' && r.id !== open?.id) || null;

  return {
    source: BASE + '/courier/invoices/list',
    pulledAt: new Date().toISOString(),
    upcomingPayment: upcoming,
    inReview,
    lastProcessing: open?.amount || '0.00',
    lastPaidAmount: paid?.amount || '0.00',
    lastPaidOn: paid?.note || '',
    openPayment: open && open.id ? open : null,
    paidPayment: paid && paid.id ? paid : null
  };
}

let inflight = null;
function once(fn) {
  if (inflight) return inflight;
  inflight = fn().finally(() => { inflight = null; });
  return inflight;
}

export function checkPathao() {
  return once(runPathao);
}
