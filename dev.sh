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
# The database: set DATABASE_URL (in .env or the environment) to use a Postgres
# you already run, and this script will use exactly that and create nothing.
# Leave it unset and the script runs its own container, moving to a free port if
# the default one is taken. Ports in use for the API/frontend shift up too, so
# nothing here fails just because something else is already listening.
#
set -euo pipefail

# ---- Config (override via env) ---------------------------------------------
PNPM_VERSION="${PNPM_VERSION:-9.15.9}"      # 9.x is stable on Node 20
PG_CONTAINER="${PG_CONTAINER:-demobuilder-pg}"
PG_PORT="${PG_PORT:-5432}"
PG_DB="${PG_DB:-demobuilder}"
API_PORT="${API_PORT:-8080}"
WEB_PORT="${WEB_PORT:-5173}"

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

# An explicit DATABASE_URL (shell or .env) means you chose where the database
# lives, so we may adopt a server that is already running there. Without one we
# manage our own container and never touch a Postgres this script didn't create
# — someone else's database on :5432 is not ours to write into.
if [ -n "${DATABASE_URL:-}" ]; then
  DB_URL_EXPLICIT=1
else
  DB_URL_EXPLICIT=0
  DATABASE_URL="postgres://postgres:postgres@localhost:${PG_PORT}/${PG_DB}"
fi
export DATABASE_URL

log()  { printf '\033[1;36m▶ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# DATABASE_URL is the single source of truth for where the DB lives — .env may
# point it at an existing server, so parse it instead of assuming PG_PORT/PG_DB.
parse_database_url() {
  if [[ "$DATABASE_URL" =~ ^[a-zA-Z0-9+]+://(([^:/@]+)(:([^@/]*))?@)?([^:/?@]+)(:([0-9]+))?(/([^?]*))? ]]; then
    DB_USER="${BASH_REMATCH[2]:-postgres}"
    DB_PASS="${BASH_REMATCH[4]:-postgres}"
    DB_HOST="${BASH_REMATCH[5]}"
    DB_PORT="${BASH_REMATCH[7]:-5432}"
    DB_NAME="${BASH_REMATCH[9]:-postgres}"
  else
    die "Could not parse DATABASE_URL. Expected postgres://user:pass@host:port/dbname"
  fi
}

port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1; }

port_holder() {
  command -v lsof >/dev/null 2>&1 || { printf 'another process'; return; }
  printf 'PID %s' "$(lsof -nP -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -1)"
}

# A port left behind by an earlier run would otherwise surface as an EADDRINUSE
# stack trace from deep inside Node. Shift to the next free one and say so.
claim_port() {
  local label="$1" want="$2" p="$2" limit=$(( $2 + 20 ))
  while port_open "$p"; do
    p=$((p + 1))
    [ "$p" -le "$limit" ] || die "No free ${label} port between ${want} and ${limit}."
  done
  [ "$p" = "$want" ] || warn "${label} port ${want} is held by $(port_holder "$want"); using ${p} instead."
  printf '%s' "$p"
}

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
  # A remote DATABASE_URL is somebody else's server; never manage it from here.
  case "$DB_HOST" in
    localhost|127.0.0.1|::1|0.0.0.0) ;;
    *) log "Using Postgres at ${DB_HOST}:${DB_PORT} (not managed by this script)"; return ;;
  esac

  ensure_docker
  if [ "$DB_URL_EXPLICIT" = "1" ]; then
    use_postgres_at_url
  else
    ensure_managed_container
  fi
  wait_for_postgres
}

ensure_docker() {
  command -v docker >/dev/null 2>&1 || die "docker not found. Install Docker, or point DATABASE_URL at your own Postgres and rerun."
  docker info >/dev/null 2>&1 && return
  [ "$(uname -s)" = "Darwin" ] || die "The Docker daemon is not running. Start it and rerun."
  log "Starting Docker Desktop..."
  open -a Docker 2>/dev/null || die "Docker daemon not running and could not launch it."
  for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 1; done
  docker info >/dev/null 2>&1 || die "Docker daemon did not become ready."
}

# DATABASE_URL was given, so that address is the target: adopt whatever already
# serves it, and only create a container when nothing does.
use_postgres_at_url() {
  local holder
  holder="$(docker ps --format '{{.Names}}' --filter "publish=${DB_PORT}" | head -1)"

  if [ -n "$holder" ] && [ "$holder" != "$PG_CONTAINER" ]; then
    docker exec "$holder" pg_isready -U "$DB_USER" >/dev/null 2>&1 \
      || die "Port ${DB_PORT} is held by container '${holder}', which is not a Postgres server.
  Stop it (docker stop ${holder}), or point DATABASE_URL at a different port."
    log "Reusing Postgres container '${holder}' already serving :${DB_PORT}"
    PG_CONTAINER="$holder"
  elif [ -n "$holder" ]; then
    log "Postgres container '${PG_CONTAINER}' already running"
  elif port_open "$DB_PORT"; then
    # A non-Docker server (Homebrew, Postgres.app, an SSH tunnel). Trust the URL;
    # we cannot create databases or roles in a server we do not control.
    log "Using the Postgres already serving :${DB_PORT} (not managed by this script)"
    PG_CONTAINER=""
  elif docker ps -a --format '{{.Names}}' | grep -qx "$PG_CONTAINER"; then
    start_or_recreate_container
  else
    create_pg_container
  fi
}

# No DATABASE_URL, so this project's own container is the database. Keep off any
# port we did not take ourselves and follow the URL to wherever it lands.
ensure_managed_container() {
  local bound
  if docker ps -a --format '{{.Names}}' | grep -qx "$PG_CONTAINER"; then
    bound="$(container_host_port "$PG_CONTAINER")"
    if docker ps --format '{{.Names}}' | grep -qx "$PG_CONTAINER"; then
      log "Postgres container '${PG_CONTAINER}' already running"
    else
      start_or_recreate_container
      bound="$(container_host_port "$PG_CONTAINER")"
    fi
    if [ -n "$bound" ] && [ "$bound" != "$DB_PORT" ]; then
      log "Container '${PG_CONTAINER}' publishes :${bound}; using that."
      DB_PORT="$bound"
    fi
  else
    if port_open "$DB_PORT"; then
      local free
      free="$(find_free_port "$DB_PORT")"
      warn "Port ${DB_PORT} is already in use, so this project's Postgres will use :${free}.
  Set DATABASE_URL in .env if you meant to use the server already running there."
      DB_PORT="$free"
    fi
    create_pg_container
  fi
  export DATABASE_URL="postgres://${DB_USER}:${DB_PASS}@localhost:${DB_PORT}/${DB_NAME}"
}

start_or_recreate_container() {
  log "Starting existing Postgres container '${PG_CONTAINER}'..."
  docker start "$PG_CONTAINER" >/dev/null 2>&1 && return
  # A container that never ran holds no data, so recreating it loses nothing.
  [ "$(docker inspect "$PG_CONTAINER" --format '{{.State.StartedAt}}')" = "0001-01-01T00:00:00Z" ] \
    || die "Could not start container '${PG_CONTAINER}'. Inspect it with: docker start ${PG_CONTAINER}"
  warn "Container '${PG_CONTAINER}' was never started and cannot bind :${DB_PORT}; recreating it."
  docker rm "$PG_CONTAINER" >/dev/null
  [ "$DB_URL_EXPLICIT" = "1" ] || DB_PORT="$(find_free_port "$DB_PORT")"
  create_pg_container
}

create_pg_container() {
  log "Creating Postgres container '${PG_CONTAINER}' on :${DB_PORT}..."
  docker run -d --name "$PG_CONTAINER" \
    -e POSTGRES_USER="$DB_USER" -e POSTGRES_PASSWORD="$DB_PASS" -e POSTGRES_DB="$DB_NAME" \
    -p "${DB_PORT}:5432" postgres:16 >/dev/null
}

# The host port a container publishes for Postgres, empty if it publishes none.
container_host_port() {
  docker inspect "$1" \
    --format '{{with index .HostConfig.PortBindings "5432/tcp"}}{{(index . 0).HostPort}}{{end}}' 2>/dev/null || true
}

find_free_port() {
  local p="$1" limit=$(( $1 + 20 ))
  while port_open "$p" || [ -n "$(docker ps -a --format '{{.Names}}' --filter "publish=${p}")" ]; do
    p=$((p + 1))
    [ "$p" -le "$limit" ] || die "No free port between $1 and ${limit}."
  done
  printf '%s' "$p"
}

wait_for_postgres() {
  log "Waiting for Postgres..."
  for _ in $(seq 1 30); do
    if [ -n "$PG_CONTAINER" ]; then
      docker exec "$PG_CONTAINER" pg_isready -U "$DB_USER" >/dev/null 2>&1 && { log "Postgres ready"; ensure_database; return; }
    else
      port_open "$DB_PORT" && { log "Postgres ready"; return; }
    fi
    sleep 1
  done
  die "Postgres did not become ready."
}

# An adopted container may not have the database DATABASE_URL names.
ensure_database() {
  [ -n "$PG_CONTAINER" ] || return 0
  docker exec "$PG_CONTAINER" psql -U "$DB_USER" -tAc \
    "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'" 2>/dev/null | grep -q 1 && return 0
  log "Creating database '${DB_NAME}'..."
  docker exec "$PG_CONTAINER" createdb -U "$DB_USER" "$DB_NAME"
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
  # pnpm spawns the real server as a grandchild, so killing only the job we
  # started orphans a node process still holding the port. Walk the tree down.
  kill_tree() {
    local pid="$1" child
    for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child"; done
    kill "$pid" 2>/dev/null || true
  }
  cleanup() { log "Shutting down..."; kill_tree "$api_pid"; kill_tree "$web_pid"; }
  trap cleanup EXIT INT TERM

  API_PORT="$(claim_port API "$API_PORT")"
  WEB_PORT="$(claim_port Web "$WEB_PORT")"

  log "Starting API server on :${API_PORT}..."
  PORT="$API_PORT" NODE_ENV=development \
    pnpm --filter @workspace/api-server run dev &
  api_pid=$!

  local api_up=0
  for _ in $(seq 1 40); do
    curl -sf "http://localhost:${API_PORT}/api/healthz" >/dev/null 2>&1 && { api_up=1; break; }
    kill -0 "$api_pid" 2>/dev/null || break   # it exited; stop waiting on a dead process
    sleep 1
  done
  [ "$api_up" = "1" ] || warn "API server never answered /api/healthz on :${API_PORT} — see its output above."

  log "Starting frontend on :${WEB_PORT}..."
  PORT="$WEB_PORT" BASE_PATH=/ NODE_ENV=development \
    API_PROXY_TARGET="http://localhost:${API_PORT}" \
    pnpm --filter @workspace/web run dev &
  web_pid=$!

  # Don't advertise the URL until it actually accepts connections.
  for _ in $(seq 1 40); do
    port_open "$WEB_PORT" && break
    kill -0 "$web_pid" 2>/dev/null || break
    sleep 1
  done

  printf '\n\033[1;32m✓ App running ->  http://localhost:%s\033[0m  (Ctrl-C to stop)\n\n' "$WEB_PORT"
  wait
}

# ---- Main ------------------------------------------------------------------
ensure_pnpm
parse_database_url
ensure_postgres
setup_workspace

if [ "${1:-}" = "--setup" ]; then
  log "Setup complete. Run ./dev.sh to start the servers."
  exit 0
fi

run_servers
