/**
 * Server Firestore via Auth + REST (no WebChannel).
 * The Firebase web SDK often stays "offline" inside Docker/Node and breaks calculate.
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
    const v = t.slice(i + 1).trim();
    if (!process.env[k]) process.env[k] = v;
  }
}

const AUTH_URL = 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword';
const TOKEN_URL = 'https://securetoken.googleapis.com/v1/token';

let token = { idToken: '', refreshToken: '', exp: 0 };

function cfg() {
  return {
    apiKey: process.env.FIREBASE_API_KEY || '',
    projectId: process.env.FIREBASE_PROJECT_ID || '',
    email: process.env.FIREBASE_AUTH_EMAIL || '',
    password: process.env.FIREBASE_AUTH_PASSWORD || ''
  };
}

export function firestoreConfigured() {
  const c = cfg();
  return !!(c.apiKey && c.projectId && c.email && c.password);
}

function docsBase() {
  const { projectId } = cfg();
  return `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
}

function toFirestoreValue(v) {
  if (v === null) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return { integerValue: String(v) };
    return { doubleValue: v };
  }
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFirestoreValue) } };
  if (v && typeof v === 'object') {
    const fields = {};
    for (const [k, val] of Object.entries(v)) {
      if (val === undefined) continue;
      fields[k] = toFirestoreValue(val);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

function fromFirestoreValue(cell) {
  if (!cell || typeof cell !== 'object') return null;
  if ('nullValue' in cell) return null;
  if ('booleanValue' in cell) return cell.booleanValue;
  if ('integerValue' in cell) return Number(cell.integerValue);
  if ('doubleValue' in cell) return cell.doubleValue;
  if ('stringValue' in cell) return cell.stringValue;
  if ('timestampValue' in cell) return cell.timestampValue;
  if ('arrayValue' in cell) return (cell.arrayValue.values || []).map(fromFirestoreValue);
  if ('mapValue' in cell) {
    const out = {};
    for (const [k, val] of Object.entries(cell.mapValue.fields || {})) out[k] = fromFirestoreValue(val);
    return out;
  }
  return null;
}

function docToRow(doc) {
  if (!doc || !doc.name) return null;
  const id = doc.name.split('/').pop();
  const data = {};
  for (const [k, val] of Object.entries(doc.fields || {})) data[k] = fromFirestoreValue(val);
  return { id, ...data };
}

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

async function ensureToken() {
  if (!firestoreConfigured()) {
    throw new Error('Set FIREBASE_* and FIREBASE_AUTH_EMAIL / FIREBASE_AUTH_PASSWORD on the server for shared Live Sheet');
  }
  const now = Date.now();
  if (token.idToken && token.exp > now + 60_000) return token.idToken;
  const { apiKey, email, password } = cfg();
  if (token.refreshToken) {
    const res = await fetch(`${TOKEN_URL}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: token.refreshToken
      })
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok && json.id_token) {
      token = {
        idToken: json.id_token,
        refreshToken: json.refresh_token || token.refreshToken,
        exp: now + Number(json.expires_in || 3600) * 1000
      };
      return token.idToken;
    }
  }
  const res = await fetch(`${AUTH_URL}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.error?.message || ('Firebase auth failed HTTP ' + res.status));
  }
  token = {
    idToken: json.idToken,
    refreshToken: json.refreshToken,
    exp: now + Number(json.expiresIn || 3600) * 1000
  };
  return token.idToken;
}

async function fsFetch(pathname, { method = 'GET', body, query = '' } = {}) {
  const idToken = await ensureToken();
  const url = docsBase() + pathname + (query || '');
  const res = await fetch(url, {
    method,
    headers: {
      authorization: 'Bearer ' + idToken,
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json.error?.message || ('Firestore HTTP ' + res.status);
    // Auth expired mid-run — clear and retry once.
    if (res.status === 401) {
      token = { idToken: '', refreshToken: token.refreshToken, exp: 0 };
      const idToken2 = await ensureToken();
      const res2 = await fetch(url, {
        method,
        headers: {
          authorization: 'Bearer ' + idToken2,
          ...(body ? { 'content-type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined
      });
      const json2 = await res2.json().catch(() => ({}));
      if (!res2.ok) throw new Error(json2.error?.message || ('Firestore HTTP ' + res2.status));
      return json2;
    }
    throw new Error(msg);
  }
  return json;
}

export async function listDocs(colName) {
  const rows = [];
  let pageToken = '';
  do {
    const q = pageToken
      ? `?pageSize=300&pageToken=${encodeURIComponent(pageToken)}`
      : '?pageSize=300';
    const json = await fsFetch(`/${encodeURIComponent(colName)}`, { query: q });
    for (const doc of json.documents || []) {
      const row = docToRow(doc);
      if (row) rows.push(row);
    }
    pageToken = json.nextPageToken || '';
  } while (pageToken);
  return rows;
}

export async function listSnapshots(max = 500) {
  // Prefer ordered query; fall back to full list + sort if composite index missing.
  try {
    const { projectId } = cfg();
    const idToken = await ensureToken();
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + idToken,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: 'snapshots' }],
          orderBy: [{ field: { fieldPath: 'ts' }, direction: 'DESCENDING' }],
          limit: max
        }
      })
    });
    const json = await res.json().catch(() => ([]));
    if (!res.ok) throw new Error(json.error?.message || 'runQuery failed');
    return (Array.isArray(json) ? json : [])
      .map(row => docToRow(row.document))
      .filter(Boolean);
  } catch {
    const all = await listDocs('snapshots');
    return all.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || ''))).slice(0, max);
  }
}

export async function getMainSettings() {
  try {
    const json = await fsFetch('/settings/main');
    return docToRow(json) || { id: 'main' };
  } catch (err) {
    if (/not found/i.test(err.message || '')) return { id: 'main' };
    throw err;
  }
}

export async function setDocMerge(colName, id, data) {
  const clean = scrub(data);
  const fields = {};
  const masks = [];
  for (const [k, v] of Object.entries(clean)) {
    fields[k] = toFirestoreValue(v);
    masks.push(`updateMask.fieldPaths=${encodeURIComponent(k)}`);
  }
  if (!masks.length) return;
  // PATCH + updateMask merges fields; creates the doc when missing.
  await fsFetch(`/${encodeURIComponent(colName)}/${encodeURIComponent(id)}?${masks.join('&')}`, {
    method: 'PATCH',
    body: { fields }
  });
}

export async function addDocRow(colName, data) {
  const clean = scrub(data);
  const fields = {};
  for (const [k, v] of Object.entries(clean)) fields[k] = toFirestoreValue(v);
  const json = await fsFetch(`/${encodeURIComponent(colName)}`, {
    method: 'POST',
    body: { fields }
  });
  const row = docToRow(json);
  if (!row?.id) throw new Error('Firestore add returned no id');
  return row.id;
}
