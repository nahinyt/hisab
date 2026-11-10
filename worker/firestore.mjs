/**
 * Server-side Firestore via the Firebase web SDK + shop email/password.
 * Live Sheet / items / settings are the shared source of truth across browsers.
 */
import { initializeApp, getApps } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  limit,
  orderBy,
  query,
  setDoc
} from 'firebase/firestore';

function firebaseWebConfig() {
  return {
    apiKey: process.env.FIREBASE_API_KEY || '',
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || '',
    projectId: process.env.FIREBASE_PROJECT_ID || '',
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || '',
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
    appId: process.env.FIREBASE_APP_ID || ''
  };
}

let ready = null;

export function firestoreConfigured() {
  const cfg = firebaseWebConfig();
  const email = process.env.FIREBASE_AUTH_EMAIL || '';
  const password = process.env.FIREBASE_AUTH_PASSWORD || '';
  return !!(cfg.apiKey && cfg.projectId && email && password);
}

async function ensure() {
  if (ready) return ready;
  if (!firestoreConfigured()) {
    throw new Error('Set FIREBASE_* and FIREBASE_AUTH_EMAIL / FIREBASE_AUTH_PASSWORD on the server for shared Live Sheet');
  }
  const cfg = firebaseWebConfig();
  const app = getApps().length ? getApps()[0] : initializeApp(cfg);
  const auth = getAuth(app);
  const db = getFirestore(app);
  if (!auth.currentUser) {
    await signInWithEmailAndPassword(auth, process.env.FIREBASE_AUTH_EMAIL, process.env.FIREBASE_AUTH_PASSWORD);
  }
  ready = { app, auth, db };
  return ready;
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

export async function listDocs(colName) {
  const { db } = await ensure();
  const snap = await getDocs(collection(db, colName));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function listSnapshots(max = 500) {
  const { db } = await ensure();
  const q = query(collection(db, 'snapshots'), orderBy('ts', 'desc'), limit(max));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function getMainSettings() {
  const { db } = await ensure();
  const snap = await getDoc(doc(db, 'settings', 'main'));
  return snap.exists() ? { id: 'main', ...snap.data() } : { id: 'main' };
}

export async function setDocMerge(colName, id, data) {
  const { db } = await ensure();
  await setDoc(doc(db, colName, id), scrub(data), { merge: true });
}

export async function addDocRow(colName, data) {
  const { db } = await ensure();
  const ref = await addDoc(collection(db, colName), scrub(data));
  return ref.id;
}
