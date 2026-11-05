import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(fileURLToPath(import.meta.url));
const WEEK = 7 * 24 * 60 * 60 * 1000;
const WINDOW = 15 * 60 * 1000;
const sessions = new Map();
const fails = new Map();

function authPath() {
  return process.env.HISAB_AUTH_FILE || path.join(root, 'auth.json');
}

function readAuth() {
  try { return JSON.parse(fs.readFileSync(authPath(), 'utf8')); } catch { return null; }
}

function key(password, salt, n = 16384) {
  return crypto.scryptSync(String(password), salt, 32, { N: n, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

function normEmail(v) {
  return String(v || '').trim().toLowerCase();
}

export function accountEmail() {
  return normEmail(process.env.HISAB_EMAIL || '');
}

export function hasPassword() {
  const row = readAuth();
  return !!(row && row.salt && row.hash);
}

export function createPassword(email, password) {
  if (hasPassword()) throw new Error('already set');
  const want = accountEmail();
  if (!want || !want.includes('@')) throw new Error('no email');
  if (normEmail(email) !== want) throw new Error('wrong email');
  const text = String(password || '');
  if (text.length < 10 || text.length > 200) throw new Error('at least 10');
  const salt = crypto.randomBytes(16).toString('base64url');
  const hash = key(text, salt).toString('base64url');
  fs.writeFileSync(authPath(), JSON.stringify({ email: want, salt, hash, n: 16384, createdAt: new Date().toISOString() }));
}

export function checkPassword(email, password) {
  const row = readAuth();
  if (!row || !row.salt || !row.hash) return false;
  const got = key(password, row.salt, row.n || 16384);
  const expect = Buffer.from(row.hash, 'base64url');
  const passOk = got.length === expect.length && crypto.timingSafeEqual(got, expect);
  const want = normEmail(row.email || accountEmail());
  const emailOk = !!want && normEmail(email) === want;
  return emailOk && passOk;
}

export function tooManyFails(ip) {
  const row = fails.get(ip);
  if (!row) return false;
  if (Date.now() - row.start > WINDOW) { fails.delete(ip); return false; }
  return row.n >= 8;
}

export function markFail(ip) {
  const now = Date.now();
  const row = fails.get(ip);
  if (!row || now - row.start > WINDOW) fails.set(ip, { n: 1, start: now });
  else row.n += 1;
}

export function clearFails(ip) { fails.delete(ip); }

export function startSession() {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, Date.now() + WEEK);
  return token;
}

export function sessionOk(token) {
  if (!token) return false;
  const exp = sessions.get(token);
  if (!exp || exp < Date.now()) { sessions.delete(token); return false; }
  return true;
}

export function endSession(token) { sessions.delete(token); }
