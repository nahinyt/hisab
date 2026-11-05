#!/bin/sh
set -eu
cd "$(dirname "$0")"
exec docker compose --env-file .env up -d --build
