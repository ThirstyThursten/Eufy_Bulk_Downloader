#!/usr/bin/env bash
set -euo pipefail

# ── Colors ──────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

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

# ── Detect package manager ────────────────────────────────────────
detect_pkg_manager() {
    if [[ "$(uname)" == "Darwin" ]]; then
        if command -v brew &>/dev/null; then
            echo "brew"
        else
            echo "none"
        fi
    elif command -v apt-get &>/dev/null; then
        echo "apt"
    elif command -v dnf &>/dev/null; then
        echo "dnf"
    elif command -v pacman &>/dev/null; then
        echo "pacman"
    elif command -v zypper &>/dev/null; then
        echo "zypper"
    else
        echo "none"
    fi
}

PKG_MANAGER=$(detect_pkg_manager)

# ── Check what needs installing ───────────────────────────────────
NEED_NODE=false
NEED_FFMPEG=false
NODE_TOO_OLD=false

if ! command -v node &>/dev/null; then
    NEED_NODE=true
elif [ "$(node -v | sed 's/v//' | cut -d. -f1)" -lt 20 ]; then
    NEED_NODE=true
    NODE_TOO_OLD=true
fi

if ! command -v ffmpeg &>/dev/null; then
    NEED_FFMPEG=true
fi

# ── Prompt to auto-install if anything is missing ─────────────────
if $NEED_NODE || $NEED_FFMPEG; then
    echo -e "${YELLOW}${BOLD}Some dependencies are missing.${NC}"
    echo -e "${YELLOW}This script can automatically install them for you:${NC}"
    echo ""

    if $NEED_NODE; then
        if $NODE_TOO_OLD; then
            echo -e "  ${RED}•${NC} ${BOLD}Node.js 20+${NC}  (current version is too old: $(node -v))"
        else
            echo -e "  ${RED}•${NC} ${BOLD}Node.js 20+${NC}  (JavaScript runtime — required)"
        fi
        echo -e "    └─ includes ${BOLD}npm${NC} (package manager)"
    fi

    if $NEED_FFMPEG; then
        echo -e "  ${RED}•${NC} ${BOLD}FFmpeg${NC}       (video muxer — required for downloads)"
    fi

    echo ""

    if [[ "$PKG_MANAGER" == "none" ]]; then
        error "No supported package manager found."
        if [[ "$(uname)" == "Darwin" ]]; then
            echo -e "  Install Homebrew first: ${CYAN}https://brew.sh${NC}"
        fi
        echo -e "  Then re-run this script, or install manually:"
        echo -e "    Node.js: ${CYAN}https://nodejs.org/${NC}"
        echo -e "    FFmpeg:  ${CYAN}https://ffmpeg.org/download.html${NC}"
        exit 1
    fi

    echo -e "  Package manager detected: ${CYAN}${PKG_MANAGER}${NC}"
    if [[ "$PKG_MANAGER" == "apt" || "$PKG_MANAGER" == "dnf" || "$PKG_MANAGER" == "pacman" || "$PKG_MANAGER" == "zypper" ]]; then
        echo -e "  ${YELLOW}Note: This may require your sudo password.${NC}"
    fi
    echo ""
    read -rp "Install missing dependencies automatically? [Y/n] " answer
    if [[ "$answer" =~ ^[Nn]$ ]]; then
        error "Cannot continue without required dependencies."
        echo -e "  Install them manually and re-run this script."
        exit 1
    fi

    echo ""

    # ── Install Node.js ───────────────────────────────────────────
    if $NEED_NODE; then
        info "Installing Node.js 22 LTS..."
        case "$PKG_MANAGER" in
            brew)
                brew install node@22
                brew link --overwrite node@22 2>/dev/null || true
                ;;
            apt)
                info "Adding NodeSource repository for Node.js 22..."
                curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
                sudo apt-get install -y nodejs
                ;;
            dnf)
                info "Adding NodeSource repository for Node.js 22..."
                curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
                sudo dnf install -y nodejs
                ;;
            pacman)
                sudo pacman -Sy --noconfirm nodejs npm
                ;;
            zypper)
                sudo zypper install -y nodejs22 npm22
                ;;
        esac

        # Verify installation
        if command -v node &>/dev/null; then
            ok "Node.js $(node -v) installed"
        else
            error "Node.js installation failed. Please install manually."
            echo -e "  ${CYAN}https://nodejs.org/${NC}"
            exit 1
        fi
    fi

    # ── Install FFmpeg ────────────────────────────────────────────
    if $NEED_FFMPEG; then
        info "Installing FFmpeg..."
        case "$PKG_MANAGER" in
            brew)
                brew install ffmpeg
                ;;
            apt)
                sudo apt-get install -y ffmpeg
                ;;
            dnf)
                sudo dnf install -y ffmpeg-free || sudo dnf install -y ffmpeg
                ;;
            pacman)
                sudo pacman -Sy --noconfirm ffmpeg
                ;;
            zypper)
                sudo zypper install -y ffmpeg
                ;;
        esac

        if command -v ffmpeg &>/dev/null; then
            ok "FFmpeg installed"
        else
            warn "FFmpeg installation may have failed."
            warn "Downloads will not work without FFmpeg."
            read -rp "Continue anyway? [y/N] " answer
            if [[ ! "$answer" =~ ^[Yy]$ ]]; then
                exit 1
            fi
        fi
    fi

    echo ""
fi

# ── Verify all dependencies ──────────────────────────────────────
info "Verifying dependencies..."

if ! command -v node &>/dev/null; then
    error "Node.js is still not available."
    exit 1
fi
NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 20 ]; then
    error "Node.js 20+ is required (found $(node -v))"
    exit 1
fi
ok "Node.js $(node -v)"

if ! command -v npm &>/dev/null; then
    error "npm is not available."
    exit 1
fi
ok "npm $(npm -v)"

if command -v ffmpeg &>/dev/null; then
    ok "FFmpeg $(ffmpeg -version 2>&1 | head -1 | awk '{print $3}')"
else
    warn "FFmpeg not found — downloads will fail without it."
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
echo ""
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
