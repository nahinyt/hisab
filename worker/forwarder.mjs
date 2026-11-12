// Ecom Drive Pending Orders → PackKoro Ecom Drive Invoice API.
//
// Every invoice ID is one row in SQLite (PRIMARY KEY = invoice_id). Before a send, the row is
// claimed with a single UPDATE that only succeeds from a sendable state; a row that reached
// 'forwarded' or 'exists' can never be claimed again, so it is never sent twice — across
// rescans, page refreshes, restarts and overlapping runs.
//
// Destination contract (HTTP status, Authorization: Bearer <key>):
//   2xx → forwarded (done)   409 → exists (done)   404 → no_match (controlled retry)
//   401/403 → failed (auth)  408/429/5xx/network/timeout → failed (backoff retry)
//   other 4xx → failed (rejected; manual retry)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DatabaseSync } from 'node:sqlite';
import { ecomGet } from './ecomdrive.mjs';

const workerDir = path.dirname(fileURLToPath(import.meta.url));
const DONE = new Set(['forwarded', 'exists']);
const PAGE = 50;
const SEND_TIMEOUT_MS = 15000;
const IN_RUN_TRIES = 3;           // network/5xx retries inside one run: 1s, 2s
const STALE_SENDING_MS = 10 * 60000;

let db = null;
let dbPath = '';
let fetchPendingImpl = fetchPendingFromEcomDrive;
let fetchImpl = (...a) => fetch(...a);
let running = null;
let lastRunError = '';

// ---------- storage ----------
export function openForwarder(file) {
  if (db && (!file || file === dbPath)) return db;
  if (db) db.close();
  dbPath = file || path.join(process.env.HISAB_DATA_DIR || workerDir, 'forwarder.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS invoices (
      invoice_id      TEXT PRIMARY KEY NOT NULL,
      phone           TEXT NOT NULL DEFAULT '',
      name            TEXT NOT NULL DEFAULT '',
      address         TEXT NOT NULL DEFAULT '',
      cod_amount      REAL NOT NULL DEFAULT 0,
      courier         TEXT NOT NULL DEFAULT '',
      status          TEXT NOT NULL DEFAULT 'new'
                      CHECK (status IN ('new','sending','forwarded','exists','no_match','failed','invalid')),
      attempts        INTEGER NOT NULL DEFAULT 0,
      first_seen_at   TEXT NOT NULL,
      last_seen_at    TEXT NOT NULL,
      seen_count      INTEGER NOT NULL DEFAULT 1,
      last_attempt_at TEXT,
      next_retry_at   TEXT,
      claimed_at      TEXT,
      last_http       INTEGER,
      last_message    TEXT NOT NULL DEFAULT '',
      forwarded_at    TEXT
    );
    CREATE INDEX IF NOT EXISTS invoices_status ON invoices(status);
    CREATE TABLE IF NOT EXISTS attempts (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id   TEXT NOT NULL,
      at           TEXT NOT NULL,
      http_status  INTEGER,
      result       TEXT NOT NULL,
      response     TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS attempts_invoice ON attempts(invoice_id, id);
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  `);
  return db;
}

function d() { return db || openForwarder(); }
function now() { return new Date().toISOString(); }
function kvGet(k, def = '') { return d().prepare('SELECT v FROM kv WHERE k = ?').get(k)?.v ?? def; }
function kvSet(k, v) { d().prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v)); }
function kvAdd(k, n) { kvSet(k, Number(kvGet(k, '0')) + n); }

/** Test hooks: swap the Ecom Drive source / HTTP client. */
export function _setSources({ fetchPending, fetchFn } = {}) {
  if (fetchPending) fetchPendingImpl = fetchPending;
  if (fetchFn) fetchImpl = fetchFn;
}

// ---------- settings (API key stays server-side; only a mask leaves this module) ----------
export function getSettings({ withKey = false } = {}) {
  const key = kvGet('api_key');
  return {
    apiUrl: kvGet('api_url'),
    enabled: kvGet('enabled', '0') === '1',
    intervalMin: Math.max(1, Number(kvGet('interval_min', '5')) || 5),
    noMatchRetryMin: Math.max(5, Number(kvGet('no_match_retry_min', '30')) || 30),
    hasKey: !!key,
    keyMask: key ? '••••' + key.slice(-4) : '',
    ...(withKey ? { apiKey: key } : {})
  };
}

export function saveSettings(patch = {}) {
  if (patch.apiUrl != null) {
    const u = String(patch.apiUrl).trim();
    if (u) {
      let parsed;
      try { parsed = new URL(u); } catch { throw new Error('API URL is not a valid URL'); }
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
      if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) throw new Error('API URL must use https://');
    }
    kvSet('api_url', u);
  }
  if (patch.apiKey != null && String(patch.apiKey).trim()) kvSet('api_key', String(patch.apiKey).trim());
  if (patch.clearKey) kvSet('api_key', '');
  if (patch.enabled != null) kvSet('enabled', patch.enabled ? '1' : '0');
  if (patch.intervalMin != null) {
    const n = Math.round(Number(patch.intervalMin));
    if (!(n >= 1 && n <= 1440)) throw new Error('Polling interval must be 1–1440 minutes');
    kvSet('interval_min', n);
  }
  if (patch.noMatchRetryMin != null) {
    const n = Math.round(Number(patch.noMatchRetryMin));
    if (!(n >= 5 && n <= 10080)) throw new Error('No-match retry must be 5–10080 minutes');
    kvSet('no_match_retry_min', n);
  }
  return getSettings();
}

// ---------- validation / mapping ----------
export function normalizePhone(raw) {
  let p = String(raw || '').replace(/[\s\-()]/g, '');
  if (p.startsWith('+880')) p = p.slice(3);
  else if (p.startsWith('880')) p = p.slice(2);
  return /^01[3-9]\d{8}$/.test(p) ? p : '';
}
export function validInvoiceId(id) {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{1,39}$/.test(String(id || ''));
}
function money(v) {
  const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** One Ecom Drive queue document → our record. Invoice ID is order.invoiceNumber exactly as given. */
export function mapEcomOrder(doc) {
  const o = doc?.order || doc || {};
  const rec = o.record || {};
  const c = o.customer || {};
  const parts = [c.address ?? rec.address, rec.thana, rec.district].map(x => String(x || '').trim()).filter(Boolean);
  const address = parts.filter((p, i) => !parts.slice(0, i).some(q => q.toLowerCase().includes(p.toLowerCase()))).join(', ');
  const total = money(o.grandTotal ?? rec.grandTotal);
  const advance = money(o.advance ?? rec.advance) || 0;
  const cod = total == null ? null : Math.max(0, Math.round((total - advance) * 100) / 100);
  return {
    invoice_id: String(o.invoiceNumber ?? rec.invoiceNumber ?? ''),
    phone_raw: String(c.mobileNumber ?? rec.mobileNumber ?? ''),
    name: String(c.name ?? rec.name ?? '').trim(),
    address,
    cod_amount: cod,
    courier: String(o.deliveryMethod?.name || o.deliveryMethod?.type || ''),
    status: String(o.status || rec.currentStatus || '').toUpperCase()
  };
}

/** Exact destination body — these five fields, nothing else. */
export function payloadOf(row) {
  return { phone: row.phone, name: row.name, address: row.address, cod_amount: row.cod_amount, invoice_id: row.invoice_id };
}

// ---------- source: Ecom Drive (read-only) ----------
export async function fetchPendingFromEcomDrive() {
  const methods = await ecomGet('/order-badges/delivery-methods', { status: 'PENDING' });
  const list = (methods?.items || []).filter(m => m.deliveryMethodId && Number(m.count) > 0);
  const out = [];
  for (const m of list) {
    for (let skip = 0; skip < 5000; skip += PAGE) {
      const q = await ecomGet('/approved-orders/queue', { status: 'PENDING', deliveryMethodId: m.deliveryMethodId, skip, take: PAGE });
      const docs = (q?.items?.length ? q.items : q?.documents) || [];
      out.push(...docs);
      if (docs.length < PAGE) break;
    }
  }
  return out;
}

// ---------- discovery ----------
function upsertSeen(order, at) {
  const phone = normalizePhone(order.phone_raw);
  const invalid = !validInvoiceId(order.invoice_id) ? 'Invalid invoice ID'
    : !phone ? 'Invalid phone number'
      : !order.name ? 'Missing customer name'
        : !order.address ? 'Missing address'
          : order.cod_amount == null ? 'Missing COD amount' : '';
  const existing = d().prepare('SELECT status FROM invoices WHERE invoice_id = ?').get(order.invoice_id);
  if (!existing) {
    d().prepare(`INSERT INTO invoices (invoice_id, phone, name, address, cod_amount, courier, status, first_seen_at, last_seen_at, last_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(invoice_id) DO NOTHING`)
      .run(order.invoice_id, phone, order.name, order.address, order.cod_amount ?? 0, order.courier, invalid ? 'invalid' : 'new', at, at, invalid);
    return { isNew: true, done: false };
  }
  if (DONE.has(existing.status)) {
    // Finished rows are frozen: only note that we saw it again.
    d().prepare('UPDATE invoices SET last_seen_at = ?, seen_count = seen_count + 1 WHERE invoice_id = ?').run(at, order.invoice_id);
    return { isNew: false, done: true };
  }
  // Not finished yet: refresh customer data from the latest scan (an edit in Ecom Drive should be sent).
  d().prepare(`UPDATE invoices SET phone = ?, name = ?, address = ?, cod_amount = ?, courier = ?, last_seen_at = ?, seen_count = seen_count + 1,
      status = CASE WHEN ? != '' THEN 'invalid' WHEN status = 'invalid' THEN 'new' ELSE status END,
      last_message = CASE WHEN ? != '' THEN ? WHEN status = 'invalid' THEN '' ELSE last_message END
    WHERE invoice_id = ? AND status NOT IN ('forwarded','exists','sending')`)
    .run(phone, order.name, order.address, order.cod_amount ?? 0, order.courier, at, invalid, invalid, invalid, order.invoice_id);
  return { isNew: false, done: false };
}

// ---------- sending ----------
function claim(invoiceId, at) {
  // Only one caller can move a row into 'sending'; finished rows can never be claimed.
  const r = d().prepare(`UPDATE invoices SET status = 'sending', claimed_at = ?
    WHERE invoice_id = ? AND status IN ('new','failed','no_match')`).run(at, invoiceId);
  return r.changes === 1;
}

function scrub(text, key) {
  let t = String(text || '').slice(0, 2000);
  if (key && key.length >= 4) t = t.split(key).join('[redacted]');
  return t.replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]');
}

function classify(status) {
  if (status >= 200 && status < 300) return { state: 'forwarded', why: 'Assigned on PackKoro' };
  if (status === 409) return { state: 'exists', why: 'Already exists on PackKoro' };
  if (status === 404) return { state: 'no_match', why: 'PackKoro found no matching order' };
  if (status === 401 || status === 403) return { state: 'failed', why: 'API key rejected (HTTP ' + status + ')', transient: false };
  if (status === 408 || status === 429 || status >= 500) return { state: 'failed', why: 'Destination error (HTTP ' + status + ')', transient: true };
  return { state: 'failed', why: 'Rejected by destination (HTTP ' + status + ')', transient: false, rejected: true };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function postOnce(url, key, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    const text = await res.text().catch(() => '');
    return { status: res.status, text };
  } catch (err) {
    return { status: null, text: ctrl.signal.aborted ? 'Timed out after ' + SEND_TIMEOUT_MS / 1000 + 's' : 'Network error: ' + (err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

function backoffMin(attempts) {
  return Math.min(60, 2 ** Math.max(0, attempts - 1)); // 1, 2, 4 … 60 minutes
}

async function sendOne(row, settings) {
  const at = now();
  if (!claim(row.invoice_id, at)) return 'skipped';
  const body = payloadOf(row);
  let got = null, cls = null;
  for (let i = 0; i < IN_RUN_TRIES; i++) {
    got = await postOnce(settings.apiUrl, settings.apiKey, body);
    cls = got.status == null ? { state: 'failed', why: got.text, transient: true } : classify(got.status);
    d().prepare('INSERT INTO attempts (invoice_id, at, http_status, result, response) VALUES (?, ?, ?, ?, ?)')
      .run(row.invoice_id, now(), got.status, cls.state, scrub(got.text, settings.apiKey));
    if (!(cls.state === 'failed' && cls.transient) || i === IN_RUN_TRIES - 1) break;
    await sleep(1000 * 2 ** i);
  }
  const fin = now();
  const attempts = (d().prepare('SELECT attempts FROM invoices WHERE invoice_id = ?').get(row.invoice_id)?.attempts || 0) + 1;
  const msg = cls.why + (got.text && got.status != null ? ' — ' + scrub(got.text, settings.apiKey).slice(0, 200) : '');
  let next = null;
  if (cls.state === 'no_match') next = new Date(Date.now() + settings.noMatchRetryMin * 60000).toISOString();
  else if (cls.state === 'failed' && !cls.rejected) next = new Date(Date.now() + backoffMin(attempts) * 60000).toISOString();
  d().prepare(`UPDATE invoices SET status = ?, attempts = ?, last_attempt_at = ?, last_http = ?, last_message = ?, next_retry_at = ?,
      forwarded_at = CASE WHEN ? IN ('forwarded','exists') THEN ? ELSE forwarded_at END, claimed_at = NULL
    WHERE invoice_id = ? AND status = 'sending'`)
    .run(cls.state, attempts, fin, got.status, msg, next, cls.state, fin, row.invoice_id);
  if (DONE.has(cls.state)) kvSet('last_success_at', fin);
  return cls.state;
}

// ---------- one sync ----------
export async function runSync({ trigger = 'auto' } = {}) {
  if (running) return running;
  running = (async () => {
    const started = now();
    const summary = { trigger, started, fetched: 0, newIds: 0, skippedDone: 0, sent: {}, error: '' };
    try {
      // A crash mid-send leaves 'sending'; after a while it is retryable (destination answers 409 if it got it).
      d().prepare(`UPDATE invoices SET status = 'failed', last_message = 'Interrupted while sending — will retry', claimed_at = NULL,
          next_retry_at = ? WHERE status = 'sending' AND claimed_at < ?`)
        .run(now(), new Date(Date.now() - STALE_SENDING_MS).toISOString());

      const docs = await fetchPendingImpl();
      const at = now();
      const seen = new Set();
      for (const doc of docs) {
        const o = mapEcomOrder(doc);
        if (o.status && o.status !== 'PENDING') continue;
        if (!o.invoice_id) continue;
        summary.fetched++;
        if (seen.has(o.invoice_id)) { summary.skippedDone++; continue; } // same invoice twice in one scan
        seen.add(o.invoice_id);
        const r = upsertSeen(o, at);
        if (r.isNew) summary.newIds++;
        if (r.done) summary.skippedDone++;
      }
      kvAdd('orders_discovered', summary.fetched);
      kvAdd('duplicates_skipped', summary.skippedDone);
      kvSet('last_sync_at', now());

      const settings = getSettings({ withKey: true });
      if (!settings.apiUrl || !settings.apiKey) {
        summary.error = 'Set the API URL and API key to start forwarding';
      } else {
        const due = d().prepare(`SELECT * FROM invoices WHERE status IN ('new','failed','no_match')
            AND (next_retry_at IS NULL OR next_retry_at <= ?) ORDER BY first_seen_at LIMIT 200`).all(now());
        for (const row of due) {
          const st = await sendOne(row, settings);
          summary.sent[st] = (summary.sent[st] || 0) + 1;
        }
      }
      lastRunError = summary.error;
    } catch (err) {
      summary.error = err?.message || String(err);
      lastRunError = summary.error;
    }
    summary.finished = now();
    kvSet('last_run', JSON.stringify(summary));
    return summary;
  })().finally(() => { running = null; });
  return running;
}

/** Retry: make failed / no-match rows due now. Never touches finished rows. */
export function retry({ invoiceId, which = 'failed' } = {}) {
  const at = now();
  if (invoiceId) {
    return d().prepare(`UPDATE invoices SET next_retry_at = ?, status = CASE WHEN status = 'invalid' THEN 'new' ELSE status END
      WHERE invoice_id = ? AND status IN ('failed','no_match','invalid','new')`).run(at, invoiceId).changes;
  }
  const states = which === 'all' ? ['failed', 'no_match'] : [which === 'no_match' ? 'no_match' : 'failed'];
  return d().prepare(`UPDATE invoices SET next_retry_at = ? WHERE status IN (${states.map(() => '?').join(',')})`).run(at, ...states).changes;
}

// ---------- scheduler ----------
export function tickForwarder() {
  const s = getSettings();
  if (!s.enabled || running) return null;
  const last = Date.parse(kvGet('last_sync_at')) || 0;
  if (Date.now() - last < s.intervalMin * 60000) return null;
  return runSync({ trigger: 'auto' });
}

// ---------- dashboard data ----------
export function forwarderStatus({ filter = '', search = '', limit = 200 } = {}) {
  const count = sql => d().prepare(sql).get()?.n || 0;
  const stats = {
    ordersDiscovered: Number(kvGet('orders_discovered', '0')),
    uniqueInvoices: count('SELECT COUNT(*) n FROM invoices'),
    forwarded: count("SELECT COUNT(*) n FROM invoices WHERE status IN ('forwarded','exists')"),
    pending: count("SELECT COUNT(*) n FROM invoices WHERE status IN ('new','sending')"),
    noMatch: count("SELECT COUNT(*) n FROM invoices WHERE status = 'no_match'"),
    failed: count("SELECT COUNT(*) n FROM invoices WHERE status = 'failed'"),
    invalid: count("SELECT COUNT(*) n FROM invoices WHERE status = 'invalid'"),
    failedAttempts: count("SELECT COUNT(*) n FROM attempts WHERE result = 'failed'"),
    duplicatesSkipped: Number(kvGet('duplicates_skipped', '0')),
    lastSyncAt: kvGet('last_sync_at') || null,
    lastSuccessAt: kvGet('last_success_at') || null
  };
  const where = [];
  const args = [];
  if (filter === 'done') where.push("status IN ('forwarded','exists')");
  else if (filter) { where.push('status = ?'); args.push(filter); }
  if (search) { where.push('(invoice_id LIKE ? OR phone LIKE ? OR name LIKE ?)'); args.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  const rows = d().prepare(`SELECT invoice_id, phone, name, courier, cod_amount, status, attempts, last_attempt_at, last_http, last_message,
      first_seen_at, last_seen_at, next_retry_at, forwarded_at FROM invoices ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY COALESCE(last_attempt_at, first_seen_at) DESC LIMIT ?`).all(...args, Math.min(500, limit));
  let lastRun = null;
  try { lastRun = JSON.parse(kvGet('last_run') || 'null'); } catch { /* ignore */ }
  const s = getSettings();
  const lastAttempt = d().prepare('SELECT http_status, result, at FROM attempts ORDER BY id DESC LIMIT 1').get();
  const connection = !s.apiUrl || !s.hasKey ? { state: 'not_configured', text: 'Not configured' }
    : !lastAttempt ? { state: 'unknown', text: 'No requests yet' }
      : lastAttempt.http_status == null ? { state: 'down', text: 'Unreachable', at: lastAttempt.at }
        : [401, 403].includes(lastAttempt.http_status) ? { state: 'auth', text: 'API key rejected', at: lastAttempt.at }
          : lastAttempt.http_status >= 500 ? { state: 'down', text: 'Destination error ' + lastAttempt.http_status, at: lastAttempt.at }
            : { state: 'ok', text: 'Connected (HTTP ' + lastAttempt.http_status + ')', at: lastAttempt.at };
  return { settings: s, stats, rows, lastRun, running: !!running, lastError: lastRunError, connection };
}

export function attemptLog(invoiceId) {
  return d().prepare('SELECT at, http_status, result, response FROM attempts WHERE invoice_id = ? ORDER BY id DESC LIMIT 50').all(invoiceId);
}

/** Connection check without creating anything: unauthenticated-vs-authenticated GET to the API URL. */
export async function testConnection() {
  const s = getSettings({ withKey: true });
  if (!s.apiUrl) throw new Error('Set the API URL first');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetchImpl(s.apiUrl, { method: 'GET', headers: { accept: 'application/json', ...(s.apiKey ? { authorization: 'Bearer ' + s.apiKey } : {}) }, signal: ctrl.signal });
    const ok = res.status !== 401 && res.status !== 403 && res.status < 500;
    return { reachable: true, status: res.status, ok, text: ok ? `Reachable (HTTP ${res.status})` : res.status >= 500 ? `Server error (HTTP ${res.status})` : `API key rejected (HTTP ${res.status})` };
  } catch (err) {
    return { reachable: false, status: null, ok: false, text: ctrl.signal.aborted ? 'Timed out' : 'Unreachable: ' + (err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}
