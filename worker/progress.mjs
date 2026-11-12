// Sub-step log for the Calculate popup. calculate.mjs runs each step inside withProgress(row, fn);
// any module called from that step (Steadfast, Pathao, EcomDrive) can add lines with sub()/done()
// without passing callbacks around. Outside a step every call is a no-op.
import { AsyncLocalStorage } from 'async_hooks';

const als = new AsyncLocalStorage();
const MAX_SUBS = 60;

export function withProgress(row, fn) {
  row.subs = row.subs || [];
  return als.run(row, fn);
}

function current() {
  return als.getStore() || null;
}

/** The step row this code is running under (null outside a calculate step). */
export function progressRow() {
  return current();
}

function last(row) {
  return row.subs[row.subs.length - 1] || null;
}

/** Close the running line (if any). status: ok | warn | fail. */
export function done(note, status = 'ok') {
  const row = current();
  const s = row && last(row);
  if (!s || s.status !== 'run') return;
  s.status = status;
  s.ms = Date.now() - s.at;
  if (note != null && note !== '') s.note = String(note);
  else if (s.hint && status === 'ok') s.note = 'ধীর ছিল — দ্বিতীয় চেষ্টায় হয়েছে';
  delete s.hint;
}

/** Start a new running line; closes the previous one as ok. Same label again → "×N" on that line. */
export function sub(label) {
  const row = current();
  if (!row) return;
  done();
  const prev = last(row);
  if (prev && prev.label === label && prev.status === 'ok') {
    prev.count = (prev.count || 1) + 1;
    prev.status = 'run';
    prev.at = Date.now();
    return;
  }
  row.subs.push({ label, status: 'run', at: Date.now() });
  if (row.subs.length > MAX_SUBS) row.subs.splice(1, row.subs.length - MAX_SUBS);
}

/** A finished one-line fact (e.g. "session already signed in"). kind: info | warn. */
export function note(label, kind = 'info') {
  const row = current();
  if (!row) return;
  done();
  row.subs.push({ label, status: kind, at: Date.now() });
}

/** Extra text on the running line without closing it (e.g. "slow — retrying"). */
export function hint(text) {
  const row = current();
  const s = row && last(row);
  if (s && s.status === 'run') s.hint = String(text);
}
