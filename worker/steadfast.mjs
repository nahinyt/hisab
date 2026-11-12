import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { sub, done, note, hint } from './progress.mjs';

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

const EMAIL = process.env.STEADFAST_EMAIL || '';
const PASSWORD = process.env.STEADFAST_PASSWORD || '';
const BASE = 'https://steadfast.com.bd';
const STEP_MS = 25000;
const TOTAL_MS = 100000;
const SESSION_FILE = path.join(root, '.steadfast-session.json');
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function money(n) {
  if (n == null || Number.isNaN(Number(n))) return null;
  return (Math.round(Number(n) * 100) / 100).toFixed(2);
}

function dkDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(d);
}

function sessionFromJar(jar) {
  const take = res => {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const c of list) {
      const pair = c.split(';')[0];
      const i = pair.indexOf('=');
      if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  };
  const headers = extra => ({
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    accept: 'text/html,application/xhtml+xml',
    origin: BASE,
    ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
    ...extra
  });
  return { take, headers, jar };
}

function session() {
  return sessionFromJar(new Map());
}

function saveSession(jar) {
  if (!jar?.size) return;
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify({
      savedAt: Date.now(),
      cookies: Object.fromEntries(jar)
    }));
  } catch { /* ignore disk errors */ }
}

function clearSavedSession() {
  try { fs.unlinkSync(SESSION_FILE); } catch { /* ignore */ }
}

function loadSavedJar() {
  try {
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    if (!data?.cookies || Date.now() - Number(data.savedAt || 0) > SESSION_MAX_AGE_MS) {
      clearSavedSession();
      return null;
    }
    const jar = new Map(Object.entries(data.cookies));
    return jar.size ? jar : null;
  } catch {
    return null;
  }
}

/** Steadfast is sometimes slow for one request; retry a timed-out read once while the overall budget lasts. */
async function fetchText(url, opts = {}, ms = STEP_MS, label = 'Steadfast') {
  try {
    return await fetchTextOnce(url, opts, ms, label);
  } catch (err) {
    if (!/ timed out$/.test(err?.message || '') || opts.signal?.aborted) throw err;
    console.warn(label + ' slow — retrying once');
    hint('ধীর উত্তর দিচ্ছে — আবার চেষ্টা করছি…');
    return fetchTextOnce(url, opts, ms, label);
  }
}

/** Fetch + body with a hard deadline (AbortSignal alone does not cover stalled body reads). */
async function fetchTextOnce(url, opts = {}, ms = STEP_MS, label = 'Steadfast') {
  const ctrl = new AbortController();
  const parent = opts.signal;
  const onParent = () => ctrl.abort();
  if (parent) {
    if (parent.aborted) throw new Error(label + ' timed out');
    parent.addEventListener('abort', onParent, { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    return { res, text };
  } catch (err) {
    if (err?.name === 'AbortError' || ctrl.signal.aborted || parent?.aborted) {
      throw new Error(label + ' timed out');
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (parent) parent.removeEventListener('abort', onParent);
  }
}

async function fetchJson(url, opts = {}, ms = STEP_MS, label = 'Steadfast') {
  const { res, text } = await fetchText(url, opts, ms, label);
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { res, json };
}

async function login(signal) {
  if (!EMAIL || !PASSWORD) throw new Error('Set STEADFAST_EMAIL and STEADFAST_PASSWORD in worker/.env');
  const t0 = Date.now();
  const { take, headers, jar } = session();
  const loginPage = await fetchText(BASE + '/login', { headers: headers(), redirect: 'manual', signal }, STEP_MS, 'Steadfast login page');
  take(loginPage.res);
  const token = loginPage.text.match(/name="_token"\s+value="([^"]+)"/)?.[1];
  if (!token) throw new Error('Steadfast sign-in page did not load');
  const posted = await fetchText(BASE + '/login', {
    method: 'POST',
    headers: headers({
      'content-type': 'application/x-www-form-urlencoded',
      referer: BASE + '/login'
    }),
    body: new URLSearchParams({ _token: token, email: EMAIL, password: PASSWORD, remember: '1' }),
    redirect: 'manual',
    signal
  }, STEP_MS, 'Steadfast sign-in');
  take(posted.res);
  const loc = posted.res.headers.get('location') || '';
  if (posted.res.status !== 302 || !loc || loc.includes('/login')) {
    throw new Error('Steadfast did not accept the sign-in (check STEADFAST_EMAIL / STEADFAST_PASSWORD in worker/.env)');
  }
  const mustChangePassword = /password\/change/i.test(loc);
  if (mustChangePassword) {
    console.log('Steadfast redirected to password change; stats check will confirm access');
  } else {
    console.log('Steadfast login redirect', loc.replace(BASE, '') || loc);
  }
  // Do NOT probe /user/stats here — pullStats loads it once next (was double-fetching before).
  console.log('Steadfast password login done in', Date.now() - t0, 'ms');
  return { take, headers, jar, mustChangePassword };
}

let active = null;

function gone(res) {
  if (res.status === 401 || res.status === 403) return true;
  const loc = res.headers.get('location') || '';
  return res.status >= 300 && res.status < 400 && loc.includes('/login');
}

function dropSession() {
  active = null;
  clearSavedSession();
}

function ensure(res, reused, message) {
  if (!gone(res)) return;
  if (reused) {
    dropSession();
    throw new Error('SESSION');
  }
  throw new Error(message);
}

function restoreActive() {
  if (active?.jar?.size) return active;
  const jar = loadSavedJar();
  if (!jar) return null;
  active = sessionFromJar(jar);
  console.log('Steadfast session restored from disk');
  return active;
}

async function signIn(signal) {
  console.log('signing in to Steadfast (password — no reusable session)');
  active = await login(signal);
  saveSession(active.jar);
  console.log('Steadfast signed in');
  return active;
}

async function pullStats(force, signal) {
  if (!force) restoreActive();
  const reused = !force && !!active;
  if (reused) {
    console.log('Steadfast session reused (skip password login)');
    note('আগের লগইন সেশন আছে — আবার লগইন লাগেনি');
  } else if (!force) console.log('Steadfast has no saved session — logging in');
  if (!reused) sub('Steadfast-এ লগইন করছি (ইমেইল + পাসওয়ার্ড)');
  const { take, headers, jar } = reused ? active : await signIn(signal);
  if (!reused) done('লগইন সফল');
  sub('Stats পেজ খুলছি');
  const stats = await fetchText(BASE + '/user/stats', {
    headers: headers({ referer: BASE + '/login' }),
    redirect: 'manual',
    signal
  }, STEP_MS, 'Steadfast stats');
  take(stats.res);
  const statsLoc = stats.res.headers.get('location') || '';
  if (gone(stats.res) || stats.res.status !== 200 || !/name="csrf-token"\s+content=/.test(stats.text)) {
    if (/password\/change/i.test(statsLoc + stats.text)) {
      dropSession();
      throw new Error('Steadfast is forcing a password change. Open steadfast.com.bd in a browser, sign in, change the password, update worker/.env, then retry');
    }
    ensure(stats.res, reused, 'Steadfast stats page did not load');
    if (reused) { dropSession(); throw new Error('SESSION'); }
    throw new Error('Steadfast stats page did not load');
  }
  const csrf = stats.text.match(/name="csrf-token"\s+content="([^"]+)"/)?.[1];
  if (!csrf) {
    if (reused) { dropSession(); throw new Error('SESSION'); }
    throw new Error('Steadfast stats page did not load');
  }
  saveSession(jar);
  done();

  sub('Balance দেখছি');
  const bal = await fetchJson(BASE + '/user/check-balance', {
    headers: headers({
      accept: 'application/json',
      'x-requested-with': 'XMLHttpRequest',
      referer: BASE + '/user/stats'
    }),
    redirect: 'manual',
    signal
  }, STEP_MS, 'Steadfast balance');
  ensure(bal.res, reused, 'Steadfast did not return a balance');
  const balance = money(bal.json?.data);
  if (!bal.res.ok || balance == null) {
    if (reused) { dropSession(); throw new Error('SESSION'); }
    throw new Error('Steadfast did not return a balance');
  }
  done('৳' + balance);

  sub('পার্সেল সামারি (In review, On the way)');
  const today = dkDate();
  const body = new FormData();
  body.append('from_date', '2015-01-01 00:00:00');
  body.append('to_date', `${today} 23:59:59`);
  const sum = await fetchJson(BASE + '/user/stats/get-summary', {
    method: 'POST',
    headers: headers({
      accept: 'application/json',
      'x-requested-with': 'XMLHttpRequest',
      'x-csrf-token': csrf,
      referer: BASE + '/user/stats'
    }),
    body,
    redirect: 'manual',
    signal
  }, STEP_MS, 'Steadfast summary');
  ensure(sum.res, reused, 'Steadfast did not return the parcel summary');
  const awaiting = money(sum.json?.data?.approvalAmount);
  const onTheWay = money(sum.json?.data?.pendingAmount);
  if (!sum.res.ok || awaiting == null || onTheWay == null) {
    if (reused) { dropSession(); throw new Error('SESSION'); }
    throw new Error('Steadfast did not return the parcel summary');
  }
  done(`In review ৳${awaiting} · On the way ৳${onTheWay}`);

  sub('Payments পেজ (শেষ পেমেন্ট)');
  const pay = await fetchText(BASE + '/user/payments', {
    headers: headers({ referer: BASE + '/user/stats' }),
    redirect: 'manual',
    signal
  }, STEP_MS, 'Steadfast payments');
  take(pay.res);
  ensure(pay.res, reused, 'Steadfast payments page did not load');
  if (pay.res.status !== 200) {
    if (reused) { dropSession(); throw new Error('SESSION'); }
    throw new Error('Steadfast payments page did not load');
  }
  const rows = paymentRows(pay.text);
  const openRow = rows.find(r => /unpaid|processing/i.test(r.status));
  const paidRow = rows.find(r => /^paid$/i.test(r.status));
  if (!paidRow && !openRow) throw new Error('Steadfast did not return the last payment');
  done([paidRow ? `Last paid ৳${paidRow.receive}` : '', openRow ? `Unpaid ৳${openRow.receive}` : ''].filter(Boolean).join(' · '));
  // Approval charge is a side figure across many slow pages. If it fails, keep balance/summary/payments
  // from this run; null charge = calculate keeps the previous charge instead of dropping all of Steadfast.
  let delivery = { approvalDeliveryCharge: null, approvalDeliveryCount: null };
  try {
    delivery = await approvalDelivery(headers, take, reused, signal);
  } catch (err) {
    if (err?.message === 'SESSION') throw err;
    console.warn('Steadfast approval charge skipped this run:', err?.message || err);
    done(err?.message || 'ব্যর্থ', 'warn');
    note('Approval charge এবার বাদ — আগের মান থাকবে, বাকি সব আপডেট হবে', 'warn');
  }
  saveSession(jar);

  return {
    source: BASE + '/user/payments',
    pulledAt: new Date().toISOString(),
    balance,
    awaitingApproval: awaiting,
    awaitingCount: Number(sum.json.data.approval) || 0,
    onTheWay,
    onTheWayCount: Number(sum.json.data.pending) || 0,
    unpaidAmount: openRow ? openRow.receive : '0.00',
    lastPaidAmount: paidRow ? paidRow.receive : '0.00',
    lastPaidOn: paidRow?.paidOn || '',
    openPayment: openRow ? { id: openRow.id, amount: openRow.receive, state: /processing/i.test(openRow.status) ? 'processing' : 'unpaid' } : null,
    paidPayment: paidRow ? { id: paidRow.id, amount: paidRow.receive, state: 'paid', note: paidRow.paidOn } : null,
    approvalDeliveryCharge: delivery.approvalDeliveryCharge,
    approvalDeliveryCount: delivery.approvalDeliveryCount
  };
}

function plain(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

async function approvalDelivery(headers, take, reused, signal) {
  let page = 1;
  let minor = 0;
  let count = 0;
  const seen = new Set();
  while (page <= 40) {
    if (signal?.aborted) throw new Error('Steadfast timed out');
    const url = BASE + '/user/consignment/status/approval' + (page === 1 ? '' : '?page=' + page);
    sub(`Approval পেজ ${page} (ডেলিভারি চার্জ)`);
    const got = await fetchText(url, {
      headers: headers({ referer: BASE + '/user/consignment/status/approval' }),
      redirect: 'manual',
      signal
    }, STEP_MS, 'Steadfast approval page');
    take(got.res);
    ensure(got.res, reused, 'Steadfast approval page did not load');
    if (got.res.status !== 200) {
      if (reused) { dropSession(); throw new Error('SESSION'); }
      throw new Error('Steadfast approval page did not load');
    }
    const html = got.text;
    const head = html.split('<thead>')[1]?.split('</thead>')[0] || '';
    const heads = [...head.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map(m => plain(m[1]).toLowerCase());
    const idx = heads.indexOf('charge');
    if (idx < 0) break;
    const body = html.split('<tbody>')[1]?.split('</tbody>')[0] || '';
    let added = 0;
    for (const row of body.matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
      const cells = [...row[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => plain(m[1]));
      const id = cells[1] || '';
      const charge = taka(cells[idx]);
      if (charge == null || (id && seen.has(id))) continue;
      if (id) seen.add(id);
      minor += Math.round(Number(charge) * 100);
      count += 1;
      added += 1;
    }
    done(added ? `${added}টা পার্সেল` : 'আর পার্সেল নেই');
    if (!added) break;
    const next = html.includes('rel="next"') || html.includes('page=' + (page + 1));
    if (!next) break;
    page += 1;
  }
  done();
  note(`মোট approval চার্জ ৳${money(minor / 100)} · ${count}টা পার্সেল`);
  return { approvalDeliveryCharge: money(minor / 100), approvalDeliveryCount: count };
}

async function runStats(signal) {
  const t0 = Date.now();
  console.log('checking Steadfast stats');
  try {
    const out = await pullStats(false, signal);
    console.log('Steadfast stats ok in', Date.now() - t0, 'ms');
    return out;
  } catch (err) {
    if (err.message !== 'SESSION') throw err;
    console.log('Steadfast session expired — password login once, then continue');
    done('সেশনের মেয়াদ শেষ', 'warn');
    note('আগের সেশন আর কাজ করছে না — নতুন করে লগইন করছি', 'warn');
    const out = await pullStats(true, signal);
    console.log('Steadfast stats ok after re-login in', Date.now() - t0, 'ms');
    return out;
  }
}

function taka(text) {
  const n = String(text || '').replace(/[৳,\s]/g, '');
  return n ? money(n) : null;
}

function paymentRows(html) {
  const table = html.split('<tbody>')[1]?.split('</tbody>')[0] || '';
  return [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(m => {
    const row = m[1];
    const status = (row.match(/sf-badge__dot" aria-hidden="true"><\/span>([^<]+)/)?.[1] || '').trim();
    return {
      id: row.match(/SFC-\d+/)?.[0] || '',
      receive: taka(row.match(/sf-pay__receive">([^<]+)/)?.[1]),
      status,
      paidOn: (row.match(/Paid\s+([^<]+)/)?.[1] || '').trim()
    };
  }).filter(r => r.id && r.receive != null);
}

let inflight = null;
function once(fn) {
  if (inflight) return inflight;
  inflight = fn().finally(() => { inflight = null; });
  return inflight;
}

export function checkSteadfast() {
  return once(async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TOTAL_MS);
    try {
      return await runStats(ctrl.signal);
    } catch (err) {
      if (err?.name === 'AbortError' || ctrl.signal.aborted) {
        throw new Error('Steadfast check timed out after ' + Math.round(TOTAL_MS / 1000) + 's');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  });
}
