/**
 * Steadfast Packzy REST API (portal.packzy.com).
 * No login / token refresh — send Api-Key + Secret-Key on every request.
 */
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

const DEFAULT_BASE = 'https://portal.packzy.com/api/v1';

export function packzyConfigured() {
  return !!(process.env.STEADFAST_API_KEY && process.env.STEADFAST_SECRET_KEY);
}

function cfg() {
  return {
    base: String(process.env.STEADFAST_API_BASE || DEFAULT_BASE).replace(/\/+$/, ''),
    apiKey: process.env.STEADFAST_API_KEY || '',
    secretKey: process.env.STEADFAST_SECRET_KEY || ''
  };
}

function headers() {
  const { apiKey, secretKey } = cfg();
  return {
    'Api-Key': apiKey,
    'Secret-Key': secretKey,
    'Content-Type': 'application/json',
    Accept: 'application/json'
  };
}

/** Newest tracking step by created_at (falls back to last array item). */
export function latestTrackingStep(tracking) {
  const list = Array.isArray(tracking) ? tracking.filter(Boolean) : [];
  if (!list.length) return null;
  return list.slice().sort((a, b) => {
    const ta = Date.parse(a.created_at || '') || 0;
    const tb = Date.parse(b.created_at || '') || 0;
    return ta - tb;
  }).pop();
}

/**
 * GET /trackings_by_invoice/{invoice}
 * @returns {{ status: number, tracking: object[], latest: object|null, text: string }}
 */
export async function trackingsByInvoice(invoiceId) {
  if (!packzyConfigured()) throw new Error('Set STEADFAST_API_KEY and STEADFAST_SECRET_KEY in worker/.env');
  const id = String(invoiceId || '').trim();
  if (!id) throw new Error('Invoice ID required');
  const { base } = cfg();
  const url = `${base}/trackings_by_invoice/${encodeURIComponent(id)}`;
  const res = await fetch(url, { method: 'GET', headers: headers() });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.message || json?.error || ('Packzy HTTP ' + res.status);
    throw new Error(typeof msg === 'string' ? msg : 'Packzy tracking failed');
  }
  const tracking = Array.isArray(json.tracking) ? json.tracking : [];
  const latest = latestTrackingStep(tracking);
  return {
    status: json.status ?? res.status,
    tracking,
    latest,
    text: latest?.text ? String(latest.text) : ''
  };
}
