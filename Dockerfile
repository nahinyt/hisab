# Hisab — Node UI+API (private). Caddy in Compose is the only published port.
FROM node:22-alpine

WORKDIR /app

COPY index.html app.js style.css firebase-config.js ./
COPY worker/package.json worker/package-lock.json ./worker/
COPY worker/*.mjs ./worker/

WORKDIR /app/worker

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    TRUST_PROXY=1 \
    HISAB_DATA_DIR=/data

RUN npm ci --omit=dev && mkdir -p /data && chown -R node:node /app /data

USER node
EXPOSE 8787
CMD ["node", "server.mjs"]
