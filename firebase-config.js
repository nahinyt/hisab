// Values come from worker/.env (FIREBASE_*). Injected by worker/server.mjs at /firebase-config.js.
// This on-disk file stays empty so nothing secret is committed. Empty apiKey = DEMO MODE.
export const CONFIG = {
  apiKey: "",
  authDomain: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: ""
};
