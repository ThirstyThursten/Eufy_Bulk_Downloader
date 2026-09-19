#!/usr/bin/env bash
set -euo pipefail

# ── Colors ──────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

info()  { echo -e "${BLUE}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; }

# ── Navigate to project root ───────────────────────────────────────
cd "$(dirname "$0")"
PROJECT_DIR="$(pwd)"

echo -e "\n${BOLD}${CYAN}╔══════════════════════════════════════╗${NC}"
echo -e "${BOLD}${CYAN}║     Eufy Bulk Downloader Launcher    ║${NC}"
echo -e "${BOLD}${CYAN}╚══════════════════════════════════════╝${NC}\n"

# ── Check Node.js ──────────────────────────────────────────────────
info "Checking Node.js..."
if ! command -v node &>/dev/null; then
    error "Node.js is not installed. Please install Node.js 20 or later."
    error "Download from: https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
    error "Node.js 20+ is required (found v$(node -v | sed 's/v//'))"
    exit 1
fi
ok "Node.js $(node -v)"

# ── Check npm ──────────────────────────────────────────────────────
info "Checking npm..."
if ! command -v npm &>/dev/null; then
    error "npm is not installed."
    exit 1
fi
ok "npm $(npm -v)"

# ── Check FFmpeg ───────────────────────────────────────────────────
info "Checking FFmpeg..."
if ! command -v ffmpeg &>/dev/null; then
    warn "FFmpeg not found in PATH."
    warn "Downloads will fail without FFmpeg. Install it:"
    echo -e "  macOS:        ${CYAN}brew install ffmpeg${NC}"
    echo -e "  Ubuntu/Debian:${CYAN} sudo apt install ffmpeg${NC}"
    echo -e "  Fedora:       ${CYAN}sudo dnf install ffmpeg${NC}"
    echo ""
    read -rp "Continue without FFmpeg? [y/N] " answer
    if [[ ! "$answer" =~ ^[Yy]$ ]]; then
        exit 1
    fi
else
    ok "FFmpeg $(ffmpeg -version 2>&1 | head -1 | awk '{print $3}')"
fi

# ── Environment file ──────────────────────────────────────────────
ENV_FILE="$PROJECT_DIR/backend/.env"
ENV_EXAMPLE="$PROJECT_DIR/backend/.env.example"

if [ ! -f "$ENV_FILE" ]; then
    info "No backend/.env file found."
    if [ -f "$ENV_EXAMPLE" ]; then
        cp "$ENV_EXAMPLE" "$ENV_FILE"
        ok "Created backend/.env from .env.example"
    else
        warn "No .env.example found — creating a minimal .env"
        cat > "$ENV_FILE" <<'ENVEOF'
EUFY_EMAIL=your-email@example.com
EUFY_PASSWORD=your-password
EUFY_COUNTRY=US
DOWNLOAD_DIR=./downloads
PORT=3001
MAX_CONCURRENT_DOWNLOADS=2
P2P_CONNECTION_SETUP=0
ENVEOF
        ok "Created backend/.env with defaults"
    fi

    warn "Please edit backend/.env with your Eufy credentials."
    echo ""
    if command -v xdg-open &>/dev/null; then
        EDITOR_CMD="${EDITOR:-nano}"
    else
        EDITOR_CMD="${EDITOR:-vi}"
    fi

    read -rp "Open backend/.env in $EDITOR_CMD now? [Y/n] " answer
    if [[ ! "$answer" =~ ^[Nn]$ ]]; then
        "$EDITOR_CMD" "$ENV_FILE"
    fi
else
    ok "backend/.env exists"
fi

# ── Install dependencies ──────────────────────────────────────────
info "Installing root dependencies..."
npm install --silent 2>&1 | tail -1
ok "Root dependencies installed"

info "Installing backend dependencies..."
(cd "$PROJECT_DIR/backend" && npm install --silent 2>&1 | tail -1)
ok "Backend dependencies installed"

info "Installing frontend dependencies..."
(cd "$PROJECT_DIR/frontend" && npm install --silent 2>&1 | tail -1)
ok "Frontend dependencies installed"

# ── Start servers ─────────────────────────────────────────────────
echo ""
info "Starting backend and frontend..."
echo -e "${GREEN}${BOLD}Backend${NC}  → http://localhost:3001"
echo -e "${GREEN}${BOLD}Frontend${NC} → http://localhost:5173"
echo ""

# Open browser after a short delay
(sleep 3 && {
    URL="http://localhost:5173"
    if command -v xdg-open &>/dev/null; then
        xdg-open "$URL" 2>/dev/null
    elif command -v open &>/dev/null; then
        open "$URL"
    fi
}) &

npm run dev
