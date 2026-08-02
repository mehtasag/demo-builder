#!/usr/bin/env bash
#
# dev.sh - start Demo Builder locally (Postgres + API + frontend).
#
# Idempotent: safe to run repeatedly. Handles one-time setup (pnpm, Postgres,
# deps, schema) and then runs the API server + Vite frontend together.
#
# Usage:
#   ./dev.sh            # set up everything and run both servers
#   ./dev.sh --setup    # only do setup (pnpm, DB, install, schema); don't run servers
#   SKIP_INSTALL=1 ./dev.sh   # skip `pnpm install` (faster restarts)
#
set -euo pipefail

# ---- Config (override via env) ---------------------------------------------
PNPM_VERSION="${PNPM_VERSION:-9.15.9}"      # 9.x is stable on Node 20
PG_CONTAINER="${PG_CONTAINER:-demobuilder-pg}"
PG_PORT="${PG_PORT:-5432}"
PG_DB="${PG_DB:-demobuilder}"
API_PORT="${API_PORT:-8080}"
WEB_PORT="${WEB_PORT:-5173}"
export DATABASE_URL="${DATABASE_URL:-postgres://postgres:postgres@localhost:${PG_PORT}/${PG_DB}}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# Load .env before the defaults below, so a DATABASE_URL or DROPBOX_* set there
# wins over the fallbacks. Copy .env.example to .env to get started.
if [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a
fi

log()  { printf '\033[1;36m▶ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ---- pnpm ------------------------------------------------------------------
ensure_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    log "pnpm $(pnpm -v) present"
    return
  fi
  command -v corepack >/dev/null 2>&1 || die "corepack not found (comes with Node >=16). Install Node, then retry."
  log "Enabling pnpm ${PNPM_VERSION} via corepack..."
  corepack enable
  corepack prepare "pnpm@${PNPM_VERSION}" --activate
}

# ---- Postgres (Docker) -----------------------------------------------------
ensure_postgres() {
  command -v docker >/dev/null 2>&1 || die "docker not found. Install Docker Desktop, or point DATABASE_URL at your own Postgres and rerun."
  if ! docker info >/dev/null 2>&1; then
    log "Starting Docker Desktop..."
    open -a Docker 2>/dev/null || die "Docker daemon not running and could not launch it."
    for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 1; done
    docker info >/dev/null 2>&1 || die "Docker daemon did not become ready."
  fi

  if docker ps --format '{{.Names}}' | grep -qx "$PG_CONTAINER"; then
    log "Postgres container '${PG_CONTAINER}' already running"
  elif docker ps -a --format '{{.Names}}' | grep -qx "$PG_CONTAINER"; then
    log "Starting existing Postgres container '${PG_CONTAINER}'..."
    docker start "$PG_CONTAINER" >/dev/null
  else
    log "Creating Postgres container '${PG_CONTAINER}'..."
    docker run -d --name "$PG_CONTAINER" \
      -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB="$PG_DB" \
      -p "${PG_PORT}:5432" postgres:16 >/dev/null
  fi

  log "Waiting for Postgres..."
  for _ in $(seq 1 30); do
    docker exec "$PG_CONTAINER" pg_isready -U postgres >/dev/null 2>&1 && { log "Postgres ready"; return; }
    sleep 1
  done
  die "Postgres did not become ready."
}

# ---- Deps + schema ---------------------------------------------------------
setup_workspace() {
  if [ "${SKIP_INSTALL:-0}" != "1" ]; then
    log "Installing dependencies..."
    pnpm install --config.confirmModulesPurge=false
  fi
  log "Pushing DB schema..."
  pnpm --filter @workspace/db run push
}

# ---- Run servers -----------------------------------------------------------
run_servers() {
  local api_pid web_pid
  cleanup() { log "Shutting down..."; kill "$api_pid" "$web_pid" 2>/dev/null || true; }
  trap cleanup EXIT INT TERM

  log "Starting API server on :${API_PORT}..."
  PORT="$API_PORT" NODE_ENV=development \
    pnpm --filter @workspace/api-server run dev &
  api_pid=$!

  for _ in $(seq 1 40); do
    curl -sf "http://localhost:${API_PORT}/api/healthz" >/dev/null 2>&1 && break
    sleep 1
  done

  log "Starting frontend on :${WEB_PORT}..."
  PORT="$WEB_PORT" BASE_PATH=/ NODE_ENV=development \
    API_PROXY_TARGET="http://localhost:${API_PORT}" \
    pnpm --filter @workspace/web run dev &
  web_pid=$!

  printf '\n\033[1;32m✓ App running ->  http://localhost:%s\033[0m  (Ctrl-C to stop)\n\n' "$WEB_PORT"
  wait
}

# ---- Main ------------------------------------------------------------------
ensure_pnpm
ensure_postgres
setup_workspace

if [ "${1:-}" = "--setup" ]; then
  log "Setup complete. Run ./dev.sh to start the servers."
  exit 0
fi

run_servers
