import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { checkAccounts, checkCourierHistory, checkDollar, checkExpenses, checkReport, checkStock, checkSuppliers } from './ecomdrive.mjs';
import { checkSteadfast } from './steadfast.mjs';
import { checkPathao } from './pathao.mjs';
import { checkPassword, clearFails, createPassword, endSession, hasPassword, markFail, sessionOk, startSession, tooManyFails } from './auth.mjs';
import { calculateStatus, startCalculate, tickSchedule } from './calculate.mjs';
import { firestoreConfigured } from './firestore.mjs';
import { attemptLog, forwarderStatus, previewRequest, retry as retryForwarder, runSync, saveSettings as saveForwarderSettings, testConnection, tickForwarder } from './forwarder.mjs';

const workerDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(workerDir, '..');
const envPath = path.join(workerDir, '.env');
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
const dataDir = process.env.HISAB_DATA_DIR || workerDir;
if (dataDir !== workerDir) fs.mkdirSync(dataDir, { recursive: true });
const smsPath = process.env.HISAB_SMS_FILE || path.join(dataDir, 'sms-balances.json');
if (process.env.HISAB_DATA_DIR && !process.env.HISAB_AUTH_FILE) {
  process.env.HISAB_AUTH_FILE = path.join(dataDir, 'auth.json');
}
const PORT = Number(process.env.PORT || 8787);
const TRUST_PROXY = process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true';
const FILES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/app.js', 'app.js'],
  ['/style.css', 'style.css']
]);
function firebaseConfigJs() {
  const cfg = {
    apiKey: process.env.FIREBASE_API_KEY || '',
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || '',
    projectId: process.env.FIREBASE_PROJECT_ID || '',
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || '',
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
    appId: process.env.FIREBASE_APP_ID || ''
  };
  if (process.env.FIREBASE_MEASUREMENT_ID) cfg.measurementId = process.env.FIREBASE_MEASUREMENT_ID;
  return 'export const CONFIG = ' + JSON.stringify(cfg, null, 2) + ';\n';
}
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
};
const ALLOWED = new Set([
  'http://127.0.0.1:8787',
  'http://localhost:8787',
  'http://127.0.0.1:5500', // legacy dual-port static (optional)
  'http://localhost:5500'
]);
if (process.env.PUBLIC_ORIGIN) ALLOWED.add(String(process.env.PUBLIC_ORIGIN).replace(/\/$/, ''));

function readBody(req, limit = 8000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', c => {
      n += c.length;
      if (n > limit) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function loadSms() {
  try { return JSON.parse(fs.readFileSync(smsPath, 'utf8')); } catch { return {}; }
}

function smsBalance(v) {
  const n = Number(String(v ?? '').replace(/[,৳\s]/g, '').replace(/tk\.?/ig, ''));
  if (!Number.isFinite(n) || n < 0) return null;
  return (Math.round(n * 100) / 100).toFixed(2);
}

function parseSms(raw, contentType) {
  let data = {};
  const textIn = String(raw || '').trim();
  if (!textIn) throw new Error('Empty request');
  if ((contentType || '').includes('application/x-www-form-urlencoded')) data = Object.fromEntries(new URLSearchParams(textIn));
  else if (textIn.startsWith('{')) data = JSON.parse(textIn);
  else data = { text: textIn };
  const text = String(data.text || data.message || data.sms || data.body || '');
  const from = String(data.from || data.sender || data.number || '');
  let account = String(data.account || data.wallet || '').trim().toLowerCase();
  if (account === 'b-kash' || account === 'bkash personal') account = 'bkash';
  if (!account) {
    const blob = `${from} ${text}`;
    if (/nagad/i.test(blob)) account = 'nagad';
    else if (/bkash|b-kash/i.test(blob)) account = 'bkash';
  }
  if (account !== 'bkash' && account !== 'nagad') throw new Error('Say which account: bkash or nagad');
  let balance = data.balance ?? data.amount;
  if (balance == null || String(balance).trim() === '') {
    const m = text.match(/(?:available balance|current balance|balance|avail\.?\s*bal)\s*[:\-]?\s*(?:tk\.?|bdt)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
    if (!m) throw new Error('No balance found in the SMS');
    balance = m[1];
  }
  const normalized = smsBalance(balance);
  if (normalized == null) throw new Error('Invalid balance');
  return { account, balance: normalized, at: new Date().toISOString() };
}

function send(res, status, body, type = 'application/json; charset=utf-8', origin, extra) {
  const headers = { 'content-type': type, 'cache-control': 'no-store', ...(extra || {}) };
  if (origin) {
    headers['access-control-allow-origin'] = origin;
    headers['access-control-allow-credentials'] = 'true';
    headers.vary = 'Origin';
  }
  res.writeHead(status, headers);
  res.end(body);
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

function sessionCookie(token, maxAge) {
  const secure = String(process.env.PUBLIC_ORIGIN || '').startsWith('https:') ? '; Secure' : '';
  return `hisab_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

function clientIp(req) {
  let ip = req.socket.remoteAddress || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  // Local reverse proxy, or Docker Caddy (TRUST_PROXY=1): use the real client.
  if (TRUST_PROXY || ip === '127.0.0.1' || ip === '::1') {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff.replace(/^::ffff:/, '');
  }
  return ip;
}

function loopback(req) {
  const ip = clientIp(req);
  return ip === '127.0.0.1' || ip === '::1';
}

const server = http.createServer(async (req, res) => {
  const origin = ALLOWED.has(req.headers.origin) ? req.headers.origin : '';
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (req.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
    res.writeHead(204, {
      'access-control-allow-origin': origin || `http://127.0.0.1:${PORT}`,
      'access-control-allow-credentials': 'true',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      vary: 'Origin'
    });
    res.end();
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    const ip = clientIp(req);
    if (req.method === 'GET' && url.pathname === '/api/session') {
      const ok = sessionOk(readCookie(req, 'hisab_session'));
      send(res, ok ? 200 : 401, JSON.stringify({ ok, setup: !hasPassword() }), 'application/json; charset=utf-8', origin);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/firebase-auth') {
      if (!loopback(req)) {
        send(res, 403, JSON.stringify({ error: 'Only on this computer' }), 'application/json; charset=utf-8', origin);
        return;
      }
      const email = process.env.FIREBASE_AUTH_EMAIL || '';
      const password = process.env.FIREBASE_AUTH_PASSWORD || '';
      if (!email || !password) {
        send(res, 204, '', 'application/json; charset=utf-8', origin);
        return;
      }
      send(res, 200, JSON.stringify({ email, password }), 'application/json; charset=utf-8', origin);
      return;
    }
    if (req.method === 'POST' && (url.pathname === '/api/login' || url.pathname === '/api/setup')) {
      if (tooManyFails(ip)) {
        send(res, 429, JSON.stringify({ error: 'Too many tries' }), 'application/json; charset=utf-8', origin);
        return;
      }
      try {
        const body = JSON.parse(await readBody(req) || '{}');
        const password = String(body.password || '');
        const email = String(body.email || '');
        if (url.pathname === '/api/setup') {
          // First-time only (createPassword rejects if already set). Needed behind Docker/Caddy.
          if (hasPassword() && !loopback(req)) {
            send(res, 403, JSON.stringify({ error: 'Setup is only allowed on this computer' }), 'application/json; charset=utf-8', origin);
            return;
          }
          createPassword(email, password);
        } else if (!checkPassword(email, password)) {
          markFail(ip);
          send(res, 401, JSON.stringify({ error: 'Wrong password' }), 'application/json; charset=utf-8', origin);
          return;
        }
        clearFails(ip);
        const token = startSession();
        send(res, 200, JSON.stringify({ ok: true }), 'application/json; charset=utf-8', origin, { 'set-cookie': sessionCookie(token, 7 * 24 * 60 * 60) });
      } catch (err) {
        const known = ['already set', 'at least 10', 'wrong email', 'no email'];
        const msg = known.includes(err.message) ? err.message : 'Could not sign in';
        send(res, 400, JSON.stringify({ error: msg }), 'application/json; charset=utf-8', origin);
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/logout') {
      endSession(readCookie(req, 'hisab_session'));
      send(res, 200, JSON.stringify({ ok: true }), 'application/json; charset=utf-8', origin, { 'set-cookie': sessionCookie('', 0) });
      return;
    }
    if (!loopback(req) && !sessionOk(readCookie(req, 'hisab_session'))) {
      send(res, 401, JSON.stringify({ error: 'Sign in required', setup: !hasPassword() }), 'application/json; charset=utf-8', origin);
      return;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/ecomdrive/stock-value') {
    try {
      const payload = await checkStock({ headless: true });
      const totals = payload.totals || {};
      if (totals.costValue == null) throw new Error('EcomDrive did not return a cost value');
      send(res, 200, JSON.stringify({
        section: payload.section,
        pulledAt: payload.pulledAt,
        costValue: totals.costValue,
        sellValue: totals.sellValue,
        stockQty: totals.stockQty,
        products: totals.products
      }), 'application/json; charset=utf-8', origin);
    } catch (err) {
      send(res, 502, JSON.stringify({ error: err.message || 'Stock check failed' }), 'application/json; charset=utf-8', origin);
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/ecomdrive/suppliers') {
    try {
      const payload = await checkSuppliers();
      send(res, 200, JSON.stringify(payload), 'application/json; charset=utf-8', origin);
    } catch (err) {
      send(res, 502, JSON.stringify({ error: err.message || 'Supplier sync failed' }), 'application/json; charset=utf-8', origin);
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/ecomdrive/accounts') {
    try {
      const payload = await checkAccounts();
      send(res, 200, JSON.stringify(payload), 'application/json; charset=utf-8', origin);
    } catch (err) {
      send(res, 502, JSON.stringify({ error: err.message || 'Account sync failed' }), 'application/json; charset=utf-8', origin);
    }
    return;
  }

  if (url.pathname === '/api/sms/balance' && (req.method === 'GET' || req.method === 'POST')) {
    try {
      if (req.method === 'GET') {
        const saved = loadSms();
        const balances = Object.entries(saved).map(([account, row]) => ({ account, balance: row.balance, at: row.at }));
        send(res, 200, JSON.stringify({ balances }), 'application/json; charset=utf-8', origin);
        return;
      }
      const row = parseSms(await readBody(req), req.headers['content-type']);
      const saved = loadSms();
      saved[row.account] = { balance: row.balance, at: row.at };
      fs.writeFileSync(smsPath, JSON.stringify(saved, null, 2));
      console.log('sms balance', row.account);
      send(res, 200, JSON.stringify(row), 'application/json; charset=utf-8', origin);
    } catch (err) {
      send(res, 400, JSON.stringify({ error: err.message || 'SMS balance failed' }), 'application/json; charset=utf-8', origin);
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/steadfast/stats') {
    try {
      const payload = await checkSteadfast();
      send(res, 200, JSON.stringify(payload), 'application/json; charset=utf-8', origin);
    } catch (err) {
      send(res, 502, JSON.stringify({ error: err.message || 'Steadfast sync failed' }), 'application/json; charset=utf-8', origin);
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/pathao/courier') {
    try {
      const payload = await checkPathao();
      send(res, 200, JSON.stringify(payload), 'application/json; charset=utf-8', origin);
    } catch (err) {
      send(res, 502, JSON.stringify({ error: err.message || 'Pathao sync failed' }), 'application/json; charset=utf-8', origin);
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/ecomdrive/expenses') {
    try {
      const payload = await checkExpenses();
      send(res, 200, JSON.stringify(payload), 'application/json; charset=utf-8', origin);
    } catch (err) {
      send(res, 502, JSON.stringify({ error: err.message || 'Expense check failed' }), 'application/json; charset=utf-8', origin);
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/ecomdrive/dollar') {
    try {
      const payload = await checkDollar();
      send(res, 200, JSON.stringify(payload), 'application/json; charset=utf-8', origin);
    } catch (err) {
      send(res, 502, JSON.stringify({ error: err.message || 'Dollar check failed' }), 'application/json; charset=utf-8', origin);
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/ecomdrive/courier-history') {
    try {
      const payload = await checkCourierHistory();
      send(res, 200, JSON.stringify(payload), 'application/json; charset=utf-8', origin);
    } catch (err) {
      send(res, 502, JSON.stringify({ error: err.message || 'Courier history failed' }), 'application/json; charset=utf-8', origin);
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/ecomdrive/report') {
    try {
      const payload = await checkReport();
      send(res, 200, JSON.stringify(payload), 'application/json; charset=utf-8', origin);
    } catch (err) {
      send(res, 502, JSON.stringify({ error: err.message || 'Report check failed' }), 'application/json; charset=utf-8', origin);
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/calculate/status') {
    send(res, 200, JSON.stringify({ ...calculateStatus(), firestoreConfigured: firestoreConfigured() }), 'application/json; charset=utf-8', origin);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/calculate') {
    try {
      const body = JSON.parse(await readBody(req, 4000) || '{}');
      const payload = startCalculate({
        source: body.source === 'manual' ? 'calculate' : (body.source || 'calculate'),
        by: body.by || 'server'
      });
      // 202 = accepted; Cloudflare must not wait for Steadfast/EcomDrive (that caused 504).
      send(res, payload.started ? 202 : 409, JSON.stringify(payload), 'application/json; charset=utf-8', origin);
    } catch (err) {
      send(res, 502, JSON.stringify({ error: err.message || 'Calculate failed', steps: [] }), 'application/json; charset=utf-8', origin);
    }
    return;
  }

  // ---------- Ecom Drive → PackKoro invoice forwarder (session-gated above) ----------
  if (url.pathname.startsWith('/api/forwarder/')) {
    const json = (code, body) => send(res, code, JSON.stringify(body), 'application/json; charset=utf-8', origin);
    try {
      if (req.method === 'GET' && url.pathname === '/api/forwarder/status') {
        json(200, forwarderStatus({ filter: url.searchParams.get('filter') || '', search: url.searchParams.get('q') || '' }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/forwarder/preview') {
        json(200, previewRequest(url.searchParams.get('invoice') || ''));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/forwarder/log') {
        json(200, { attempts: attemptLog(url.searchParams.get('invoice') || '') });
        return;
      }
      if (req.method === 'POST') {
        const body = JSON.parse(await readBody(req, 4000) || '{}');
        if (url.pathname === '/api/forwarder/settings') { json(200, { settings: saveForwarderSettings(body) }); return; }
        if (url.pathname === '/api/forwarder/sync') {
          runSync({ trigger: 'manual' }).catch(err => console.error('forwarder sync', err.message || err));
          json(202, { started: true });
          return;
        }
        if (url.pathname === '/api/forwarder/retry') {
          const n = retryForwarder({ invoiceId: body.invoiceId || '', which: body.which || 'failed' });
          runSync({ trigger: 'retry' }).catch(err => console.error('forwarder retry', err.message || err));
          json(202, { queued: n });
          return;
        }
        if (url.pathname === '/api/forwarder/test') { json(200, await testConnection()); return; }
      }
      json(404, { error: 'Not found' });
    } catch (err) {
      json(400, { error: err.message || 'Forwarder error' });
    }
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, JSON.stringify({ error: 'Method not allowed' }));
    return;
  }
  if (url.pathname === '/firebase-config.js') {
    send(res, 200, req.method === 'HEAD' ? '' : firebaseConfigJs(), TYPES['.js'], origin);
    return;
  }
  const name = FILES.get(url.pathname);
  if (!name) {
    send(res, 404, JSON.stringify({ error: 'Not found' }));
    return;
  }
  const file = path.join(root, name);
  const body = fs.readFileSync(file);
  send(res, 200, req.method === 'HEAD' ? '' : body, TYPES[path.extname(name)] || 'application/octet-stream');
});

const HOST = process.env.HOST || '127.0.0.1';
server.listen(PORT, HOST, () => {
  console.log(`Hisab UI+API http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`);
  if (firestoreConfigured()) {
    console.log('Server calculate: Firestore OK — interval scheduler on');
  } else {
    console.log('Server calculate: set FIREBASE_AUTH_EMAIL/PASSWORD (+ FIREBASE_*) for shared Live Sheet + background calc');
  }
});

// Invoice forwarder: checks every 20s whether it is enabled and its polling interval has passed.
setInterval(() => {
  try { tickForwarder()?.catch(err => console.error('forwarder', err.message || err)); }
  catch (err) { console.error('forwarder', err.message || err); }
}, 20000);

// Browser-independent schedule: Settings.interval minutes → full calculate on this host.
setInterval(() => {
  tickSchedule().catch(err => console.error('schedule calculate', err.message || err));
}, 30000);
