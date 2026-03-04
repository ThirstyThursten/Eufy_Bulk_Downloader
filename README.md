# Eufy Bulk Downloader

A local web application to bulk-download video clips from your own Eufy Security cameras. Built with Node.js + TypeScript (backend) and React + Vite (frontend).

## Architecture

```
backend/         Node.js + TypeScript + Express server
  src/
    index.ts       Application entry point
    server.ts      Express routes (REST API)
    eufyClient.ts  Wrapper around eufy-security-client
    downloader.ts  Bulk download job orchestration
frontend/        React + Vite SPA
  src/
    api.ts         API client module
    App.tsx        Main application component
    components/    UI components
```

## Prerequisites

- **Node.js 20+** (required by eufy-security-client)
- **FFmpeg** installed and available in PATH (used to mux raw H.264/AAC streams into MP4 files)
- A **Eufy Security account** with cameras set up

### Installing FFmpeg

- **macOS:** `brew install ffmpeg`
- **Ubuntu/Debian:** `sudo apt install ffmpeg`
- **Windows:** Download from https://ffmpeg.org/download.html and add to PATH

## Setup

### 1. Configure credentials

```bash
cd backend
cp .env.example .env
```

Edit `backend/.env` with your Eufy account credentials:

```env
EUFY_EMAIL=your-email@example.com
EUFY_PASSWORD=your-password
EUFY_COUNTRY=US
DOWNLOAD_DIR=./downloads
PORT=3001
MAX_CONCURRENT_DOWNLOADS=2
P2P_CONNECTION_SETUP=0
```

> **Important:** It is recommended to create a **secondary/guest Eufy account** and share your devices with it. Using the same account simultaneously with the Eufy app and this tool can cause session conflicts.

### 2. Start the backend

```bash
cd backend
npm install
npm run dev
```

The backend starts on `http://localhost:3001`.

### 3. Start the frontend

```bash
cd frontend
npm install
npm run dev
```

The frontend starts on `http://localhost:5173`. Open this URL in your browser.

The Vite dev server proxies all `/api/*` requests to the backend at port 3001.

## Usage

1. **Connection:** When the backend starts, it connects to Eufy Security. If 2FA is required, the web UI will show an input field for the verification code sent to your email/SMS.

2. **Select a camera** from the dropdown (populated from your Eufy account).

3. **Pick a date/time range** using the date-time pickers.

4. **Click "Load Events"** to fetch available video clips for that camera and time range.

5. **Select events** using checkboxes (all are selected by default), then click **"Download Selected"**.

6. **Monitor progress** in the Jobs panel at the bottom. It shows per-event download status and a progress bar.

### Downloaded files

Files are saved to the `backend/downloads/` directory (configurable via `DOWNLOAD_DIR` in `.env`):

```
downloads/
  <Camera Name>/
    2024-01-15/
      20240115_143022_<eventId>.mp4
      20240115_150510_<eventId>.mp4
    2024-01-16/
      ...
```

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/status` | Connection status (connected, tfa_required, etc.) |
| `POST` | `/api/auth/tfa` | Submit 2FA code `{ code: "123456" }` |
| `POST` | `/api/auth/captcha` | Submit captcha solution |
| `GET` | `/api/devices` | List cameras and stations |
| `GET` | `/api/events?deviceId=...&from=...&to=...` | List video events |
| `POST` | `/api/download` | Start bulk download job |
| `GET` | `/api/jobs` | List all download jobs |
| `POST` | `/api/jobs/:jobId/cancel` | Cancel a running job |

## Production build

```bash
# Build backend
cd backend
npm run build
npm start          # runs compiled JS from dist/

# Build frontend
cd frontend
npm run build      # outputs to frontend/dist/
# Serve frontend/dist/ with any static file server
```

## Limitations

- **Unofficial API:** This uses the community `eufy-security-client` library which reverse-engineers Eufy's protocols. It may break if Eufy updates their servers or app.
- **Local use only:** This application is designed for use on your local network. Do not expose it to the internet — there is no authentication on the API.
- **Session conflicts:** Using the same Eufy account on both the mobile app and this tool simultaneously may cause one to disconnect. Use a secondary guest account.
- **P2P downloads:** Downloads happen via P2P connection to your Eufy station/hub. Download speed depends on your local network and the station's capabilities.
- **FFmpeg required:** Raw video streams from the station need FFmpeg to be muxed into playable MP4 files.

## Security Notes

- **Credentials:** Your Eufy email/password are stored in `backend/.env` which is in `.gitignore`. Never commit this file.
- **No logging of secrets:** The application does not log credentials. Pino logger is configured to only log operational events.
- **Isolation:** All `eufy-security-client` calls are contained in `backend/src/eufyClient.ts`. If the library API changes, only that file needs updating.
- **Persistent sessions:** After initial login (including 2FA), the session token is saved to `backend/persistent/session.json` so you don't need to re-authenticate on every restart. This directory is also in `.gitignore`.

## License

MIT
