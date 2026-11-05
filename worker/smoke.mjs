#!/usr/bin/env node
/**
 * Local smoke test: boots server.mjs, hits UI + API, exits non-zero on failure.
 * No external credentials required.
 */
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const workerDir = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.SMOKE_PORT || 18787);
const HOST = '127.0.0.1';
const base = `http://${HOST}:${PORT}`;
const child = spawn(process.execPath, ['server.mjs'], {
  cwd: workerDir,
  env: { ...process.env, PORT: String(PORT), HOST, PUBLIC_ORIGIN: base },
  stdio: ['ignore', 'pipe', 'pipe']
});

let ready = false;
const buf = { out: '', err: '' };
child.stdout.on('data', d => {
  buf.out += d;
  if (String(d).includes(`http://${HOST}:${PORT}`)) ready = true;
});
child.stderr.on('data', d => { buf.err += d; });

function kill() {
  if (!child.killed) child.kill('SIGTERM');
}

async function waitReady(ms = 8000) {
  const t0 = Date.now();
  while (!ready) {
    if (child.exitCode != null) throw new Error(`server exited early: ${buf.err || buf.out}`);
    if (Date.now() - t0 > ms) throw new Error(`server did not start\n${buf.out}\n${buf.err}`);
    await new Promise(r => setTimeout(r, 50));
  }
}

async function get(pathname) {
  const res = await fetch(base + pathname, { redirect: 'manual' });
  const text = await res.text();
  return { status: res.status, text, type: res.headers.get('content-type') || '' };
}

const checks = [];
function ok(name, pass, detail = '') {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

try {
  await waitReady();

  const root = await get('/');
  ok('GET /', root.status === 200 && root.text.includes('Hisab') && root.type.includes('text/html'), `status=${root.status}`);

  const app = await get('/app.js');
  ok('GET /app.js', app.status === 200 && app.type.includes('javascript'), `status=${app.status}`);

  const css = await get('/style.css');
  ok('GET /style.css', css.status === 200 && css.type.includes('text/css'), `status=${css.status}`);

  const fb = await get('/firebase-config.js');
  ok('GET /firebase-config.js', fb.status === 200 && fb.text.includes('export const CONFIG'), `status=${fb.status}`);

  const session = await get('/api/session');
  ok('GET /api/session', (session.status === 200 || session.status === 401) && session.text.includes('setup'), `status=${session.status}`);

  const missing = await get('/nope');
  ok('GET /nope → 404', missing.status === 404, `status=${missing.status}`);
} catch (err) {
  console.error('smoke failed:', err.message || err);
  kill();
  process.exit(1);
}

kill();
await new Promise(r => child.on('exit', r));
const failed = checks.filter(c => !c.pass);
if (failed.length) {
  console.error(`\n${failed.length} check(s) failed`);
  process.exit(1);
}
console.log(`\n${checks.length} checks passed`);
