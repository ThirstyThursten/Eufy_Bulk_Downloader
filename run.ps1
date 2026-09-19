#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Push-Location $PSScriptRoot

# ── Colours ───────────────────────────────────────────────────────
function Write-Ok    { param($msg) Write-Host "[OK]   " -ForegroundColor Green  -NoNewline; Write-Host " $msg" }
function Write-Info  { param($msg) Write-Host "[INFO] " -ForegroundColor Cyan   -NoNewline; Write-Host " $msg" }
function Write-Warn  { param($msg) Write-Host "[WARN] " -ForegroundColor Yellow -NoNewline; Write-Host " $msg" }
function Write-Err   { param($msg) Write-Host "[ERROR]" -ForegroundColor Red    -NoNewline; Write-Host " $msg" }

Write-Host ""
Write-Host "======================================" -ForegroundColor Cyan
Write-Host "   Eufy Bulk Downloader Launcher"      -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""

# ── Check Node.js ─────────────────────────────────────────────────
$needNode   = $false
$needFFmpeg = $false

Write-Info "Checking Node.js..."
$nodePath = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodePath) {
    $needNode = $true
    Write-Err "Node.js is not installed"
} else {
    $nodeVersion = & node -v
    $nodeMajor   = [int]($nodeVersion -replace '^v' -split '\.')[0]
    if ($nodeMajor -lt 20) {
        $needNode = $true
        Write-Err "Node.js $nodeVersion found, but version 20+ is required"
    } else {
        Write-Ok "Node.js $nodeVersion"
    }
}

# ── Check npm ─────────────────────────────────────────────────────
Write-Info "Checking npm..."
$npmPath = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npmPath) {
    Write-Err "npm is not installed"
} else {
    $npmVersion = & npm -v
    Write-Ok "npm $npmVersion"
}

# ── Check FFmpeg ──────────────────────────────────────────────────
Write-Info "Checking FFmpeg..."
$ffmpegPath = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $ffmpegPath) {
    $needFFmpeg = $true
    Write-Err "FFmpeg is not installed"
} else {
    Write-Ok "FFmpeg found"
}

# ── Offer to install missing dependencies ─────────────────────────
if ($needNode -or $needFFmpeg) {
    Write-Host ""
    Write-Warn "Some dependencies are missing."
    Write-Host "        This script can automatically install them for you:"
    Write-Host ""
    if ($needNode)   { Write-Host "  - Node.js 20+  (JavaScript runtime + npm)" }
    if ($needFFmpeg) { Write-Host "  - FFmpeg       (video muxer for downloads)" }
    Write-Host ""

    $hasWinget = [bool](Get-Command winget -ErrorAction SilentlyContinue)
    if (-not $hasWinget) {
        Write-Err "winget is not available on this system."
        Write-Host "         winget comes with Windows 10 (1709+) and Windows 11."
        Write-Host ""
        Write-Host "         Install the missing dependencies manually:"
        if ($needNode)   { Write-Host "           Node.js: https://nodejs.org/" }
        if ($needFFmpeg) { Write-Host "           FFmpeg:  https://www.gyan.dev/ffmpeg/builds/" }
        Write-Host ""
        Write-Host "         After installing, close this window and run again."
        Read-Host "Press Enter to exit"
        Pop-Location; exit 1
    }

    Write-Host "  Installer: winget (Windows Package Manager)"
    Write-Host ""
    $answer = Read-Host "Install missing dependencies automatically? [Y/n]"
    if ($answer -eq 'n' -or $answer -eq 'N') {
        Write-Host ""
        Write-Err "Cannot continue without required dependencies."
        Write-Host "         Install them manually and re-run this script."
        Read-Host "Press Enter to exit"
        Pop-Location; exit 1
    }

    Write-Host ""

    if ($needNode) {
        Write-Info "Installing Node.js 22 LTS via winget..."
        Write-Host "         This may take a minute..."
        & winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
        if ($LASTEXITCODE -ne 0) {
            Write-Err "Node.js installation failed."
            Write-Host "         Please install manually: https://nodejs.org/"
            Read-Host "Press Enter to exit"
            Pop-Location; exit 1
        }
        Write-Ok "Node.js installed"
    }

    if ($needFFmpeg) {
        Write-Info "Installing FFmpeg via winget..."
        Write-Host "         This may take a minute..."
        & winget install Gyan.FFmpeg --accept-source-agreements --accept-package-agreements
        if ($LASTEXITCODE -ne 0) {
            Write-Warn "First FFmpeg package failed, trying alternative..."
            & winget install FFmpeg.FFmpeg --accept-source-agreements --accept-package-agreements
            if ($LASTEXITCODE -ne 0) {
                Write-Warn "FFmpeg auto-install failed."
                Write-Warn "Downloads will not work without FFmpeg."
                Write-Host "         Install manually: https://www.gyan.dev/ffmpeg/builds/"
            } else {
                Write-Ok "FFmpeg installed"
            }
        } else {
            Write-Ok "FFmpeg installed"
        }
    }

    # Refresh PATH from registry so newly installed tools are visible
    Write-Info "Refreshing PATH..."
    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath    = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path    = "$machinePath;$userPath"
    Write-Host ""
}

# ── Verify all dependencies ───────────────────────────────────────
Write-Info "Verifying dependencies..."

$nodePath = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodePath) {
    Write-Host ""
    Write-Err "Node.js is still not available."
    Write-Host "         If you just installed it, close this window and run again"
    Write-Host "         so the new PATH takes effect."
    Read-Host "Press Enter to exit"
    Pop-Location; exit 1
}

$nodeVersion = & node -v
$nodeMajor   = [int]($nodeVersion -replace '^v' -split '\.')[0]
if ($nodeMajor -lt 20) {
    Write-Host ""
    Write-Err "Node.js 20+ is required (found $nodeVersion)"
    Write-Host "         If you just installed a newer version, close this window"
    Write-Host "         and run again so the new PATH takes effect."
    Read-Host "Press Enter to exit"
    Pop-Location; exit 1
}
Write-Ok "Node.js $nodeVersion"

$npmPath = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npmPath) {
    Write-Host ""
    Write-Err "npm is not available."
    Write-Host "         If you just installed Node.js, close this window and run again."
    Read-Host "Press Enter to exit"
    Pop-Location; exit 1
}
$npmVersion = & npm -v
Write-Ok "npm $npmVersion"

$ffmpegPath = Get-Command ffmpeg -ErrorAction SilentlyContinue
if ($ffmpegPath) {
    Write-Ok "FFmpeg found"
} else {
    Write-Warn "FFmpeg not found - downloads will fail without it."
}

# ── Environment file ──────────────────────────────────────────────
$envFile    = Join-Path $PSScriptRoot 'backend\.env'
$envExample = Join-Path $PSScriptRoot 'backend\.env.example'

if (-not (Test-Path $envFile)) {
    Write-Host ""
    Write-Info "No backend\.env file found."

    if (Test-Path $envExample) {
        Copy-Item $envExample $envFile
        Write-Ok "Created backend\.env from .env.example"
    } else {
        Write-Warn "No .env.example found - creating a minimal .env"
        @"
EUFY_EMAIL=your-email@example.com
EUFY_PASSWORD=your-password
EUFY_COUNTRY=US
DOWNLOAD_DIR=./downloads
PORT=3001
MAX_CONCURRENT_DOWNLOADS=2
P2P_CONNECTION_SETUP=0
"@ | Set-Content -Path $envFile -Encoding UTF8
        Write-Ok "Created backend\.env with defaults"
    }

    Write-Host ""
    Write-Warn "Please edit backend\.env with your Eufy credentials."
    Write-Host "         At minimum, set EUFY_EMAIL and EUFY_PASSWORD."
    Write-Host ""
    $openNow = Read-Host "Open backend\.env in Notepad now? [Y/n]"
    if ($openNow -ne 'n' -and $openNow -ne 'N') {
        Start-Process notepad.exe -ArgumentList $envFile -Wait
        Write-Host "         Saved. Continuing..."
    }
} else {
    Write-Ok "backend\.env exists"
}

# ── Install npm dependencies ─────────────────────────────────────
Write-Host ""
Write-Info "Installing root dependencies..."
& npm install --silent 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Err "Root npm install failed."
    Read-Host "Press Enter to exit"
    Pop-Location; exit 1
}
Write-Ok "Root dependencies installed"

Write-Info "Installing backend dependencies..."
Push-Location backend
& npm install --silent 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Pop-Location
    Write-Err "Backend npm install failed."
    Read-Host "Press Enter to exit"
    Pop-Location; exit 1
}
Pop-Location
Write-Ok "Backend dependencies installed"

Write-Info "Installing frontend dependencies..."
Push-Location frontend
& npm install --silent 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Pop-Location
    Write-Err "Frontend npm install failed."
    Read-Host "Press Enter to exit"
    Pop-Location; exit 1
}
Pop-Location
Write-Ok "Frontend dependencies installed"

# ── Start servers ─────────────────────────────────────────────────
Write-Host ""
Write-Host "======================================" -ForegroundColor Green
Write-Host "   All ready! Starting servers..."     -ForegroundColor Green
Write-Host "======================================" -ForegroundColor Green
Write-Host ""
Write-Host "   Backend  --> http://localhost:3001"
Write-Host "   Frontend --> http://localhost:5173"
Write-Host ""
Write-Host "   Press Ctrl+C to stop."
Write-Host ""

# Open browser after a short delay
Start-Job -ScriptBlock {
    Start-Sleep -Seconds 3
    Start-Process 'http://localhost:5173'
} | Out-Null

& npm run dev

Write-Host ""
Write-Info "Servers have stopped."
Pop-Location
Read-Host "Press Enter to exit"
