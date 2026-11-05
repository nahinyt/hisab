# Hisab

Shop hisab (accounts) dashboard: one **Node.js** process serves the static UI and the sync API. **Caddy** reverse-proxies it. Deploy with **Docker Compose** — only **one host port** is published.

This is **not** a static-only site. Browser files (`index.html`, `app.js`, `style.css`) are static, but live syncs (EcomDrive, Steadfast, Pathao, SMS, session auth) go through `worker/server.mjs`.

## Architecture

```
Internet ──► Caddy (:8080 published) ──► Node app (:8787, internal only)
                                          ├─ GET /            UI
                                          ├─ GET /app.js …
                                          ├─ GET /firebase-config.js  (from env)
                                          └─ /api/*           sync + auth
```

| Layer | Role | Port |
| --- | --- | --- |
| Caddy | gzip + reverse proxy | **published** `${HISAB_PORT:-8080}` |
| Node (`worker/server.mjs`) | UI + API | **internal** `8787` (Compose network) |

## Quick start (Docker — recommended)

```bash
cp worker/.env.example worker/.env   # set at least HISAB_EMAIL
cp .env.example .env                 # set PORT to the host port you want published
docker compose up -d --build
# site: http://127.0.0.1:$PORT
```

Only **one** host port is published (Caddy → app). Set it in project-root `.env` as `PORT=…` (Compose reads that for port mapping). Do not rely on `PORT` inside `worker/.env` for publishing — that file is for app secrets; Compose forces the app to listen on **8787** internally.

Persistent data (`auth.json`, SMS balances) lives in the `hisab-data` volume.

```bash
docker compose logs -f app
docker compose down
```

## Local Node (no Docker)

```bash
cd worker
cp .env.example .env
npm start              # → http://127.0.0.1:8787
npm run check
npm test               # smoke: 6 checks
```

## Bare-metal Caddy

If you run Node on the host instead of Compose, keep `HOST=127.0.0.1` and use the root `Caddyfile` / `Caddyfile.local` (see comments there). Prefer Compose for the packaged one-port setup (`docker/Caddyfile`).

## Scripts (`worker/`)

| Command | What it does |
| --- | --- |
| `npm start` | Run UI+API server |
| `npm run check` | Syntax-check all worker modules |
| `npm test` | Smoke test: boot server, hit UI + `/api/session` |
| `npm run sync` | CLI EcomDrive stock pull |

## Environment (`worker/.env`)

See `worker/.env.example`. Compose loads this file when present.

| Variable | Purpose |
| --- | --- |
| `HOST` / `PORT` | Bind address (Compose forces `0.0.0.0:8787` inside the container) |
| `TRUST_PROXY` | `1` in Docker so client IP comes from `X-Forwarded-For` |
| `HISAB_DATA_DIR` | Durable dir for auth + SMS files (Compose: `/data`) |
| `PUBLIC_ORIGIN` | Browser origin / CORS / `Secure` cookies when `https:` |
| `HISAB_EMAIL` | Email required for first-time password setup |
| `ECOMDRIVE_*` | EcomDrive login for stock/accounts/expenses sync |
| `FIREBASE_*` | Real Firebase; empty `FIREBASE_API_KEY` → DEMO mode |

## API surface (high level)

Same origin via Caddy:

- `GET /api/session` — session / setup state  
- `POST /api/setup` — create password (first time; then login only)  
- `POST /api/login` · `POST /api/logout`  
- `POST /api/ecomdrive/*` — stock, suppliers, accounts, expenses, dollar, courier-history, report  
- `POST /api/steadfast/stats` · `POST /api/pathao/courier`  
- `GET|POST /api/sms/balance` — bKash / Nagad balance from SMS text  

Non-loopback API calls require a valid `hisab_session` cookie.

## Layout

```
hisab/
├── Dockerfile
├── docker-compose.yml      # app + caddy (one published port)
├── docker/Caddyfile
├── Caddyfile               # optional bare-metal
├── Caddyfile.local
├── index.html
├── app.js
├── style.css
├── firebase-config.js
└── worker/
    ├── server.mjs
    ├── auth.mjs
    ├── ecomdrive.mjs
    ├── steadfast.mjs
    ├── pathao.mjs
    ├── smoke.mjs
    ├── .env.example
    └── package.json
```

## Verify

```bash
cd worker && npm run check && npm test
docker compose up -d --build
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/
```
