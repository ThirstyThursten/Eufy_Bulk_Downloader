/**
 * Diagnostic script — run while the app is NOT running (they share the Eufy session).
 *
 *   cd backend
 *   npx ts-node diagnostic.ts
 *
 * It connects to Eufy, lists your devices/stations, checks P2P connectivity,
 * and tries every database query method against each station. Paste the full
 * output when reporting issues.
 */
import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";
import {
  EufySecurity,
  EufySecurityConfig,
  Station,
  DatabaseReturnCode,
  LoginOptions,
  FilterStorageType,
} from "eufy-security-client";

dotenv.config();

const QUERY_TIMEOUT = 30_000;
const LONG_TIMEOUT = 120_000;

function log(label: string, ...args: unknown[]) {
  const ts = new Date().toLocaleString();
  console.log(`[${ts}] [${label}]`, ...args);
}

async function waitForEvent<T>(
  client: EufySecurity,
  eventName: string,
  stationSN: string,
  timeoutMs: number
): Promise<{ returnCode: number; data: T }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      (client as any).removeListener(eventName, handler);
      reject(new Error(`Event "${eventName}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const handler = (station: Station, returnCode: number, data: T) => {
      if (station.getSerial() !== stationSN) return;
      clearTimeout(timer);
      (client as any).removeListener(eventName, handler);
      resolve({ returnCode, data });
    };

    (client as any).on(eventName, handler);
  });
}

function pad2(n: number) { return String(n).padStart(2, "0"); }
function fmtDate(d: Date) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}

/**
 * Install a temporary monkey-patch on the P2P session to log the raw JSON
 * payload that the HomeBase sends back for CMD_DATABASE responses.
 * Returns a cleanup function.
 */
function installRawDatabaseLogger(station: Station): () => void {
  const p2p = (station as any).p2pSession;
  if (!p2p) return () => {};

  const origEmit = p2p.emit.bind(p2p);
  const events = [
    "database query latest",
    "database count by date",
    "database query by date",
    "database query local",
  ];

  p2p.emit = function (event: string, ...args: unknown[]) {
    if (events.includes(event)) {
      log("RAW-P2P", `Event "${event}" emitted with returnCode=${args[0]}, data=`, JSON.stringify(args[1]).slice(0, 2000));
    }
    return origEmit(event, ...args);
  };

  return () => { p2p.emit = origEmit; };
}

async function main() {
  const email = process.env.EUFY_EMAIL;
  const password = process.env.EUFY_PASSWORD;
  if (!email || !password) {
    console.error("Set EUFY_EMAIL and EUFY_PASSWORD in backend/.env");
    process.exit(1);
  }

  const persistentDir = path.resolve(__dirname, "persistent");
  if (!fs.existsSync(persistentDir)) fs.mkdirSync(persistentDir, { recursive: true });

  const config: EufySecurityConfig = {
    username: email,
    password: password,
    country: process.env.EUFY_COUNTRY || "US",
    language: "en",
    persistentDir,
    p2pConnectionSetup: parseInt(process.env.P2P_CONNECTION_SETUP || "0", 10),
    pollingIntervalMinutes: 10,
    eventDurationSeconds: 10,
  };

  const sessionPath = path.join(persistentDir, "session.json");
  if (fs.existsSync(sessionPath)) {
    config.persistentData = fs.readFileSync(sessionPath, "utf-8");
  }

  log("INIT", "Connecting to Eufy Security...");

  const client = await EufySecurity.initialize(config);

  let needTfa = false;
  client.on("tfa request", () => {
    needTfa = true;
    log("AUTH", "2FA code required — enter it in the Eufy app or re-run after the main app handles 2FA");
  });

  try {
    await client.connect();
  } catch {
    if (needTfa) {
      log("AUTH", "Cannot continue without 2FA. Run the main app first to complete login, then re-run this script.");
      client.close();
      process.exit(1);
    }
    throw new Error("Connection failed");
  }

  log("AUTH", "Connected successfully");

  // ── Devices ──────────────────────────────────────────────────────
  log("DEVICES", "=== Cameras ===");
  const devices = await client.getDevices();
  for (const d of devices) {
    if (!d.isCamera()) continue;
    log("DEVICES", {
      name: d.getName(),
      serial: d.getSerial(),
      model: d.getModel(),
      type: d.getDeviceType(),
      stationSN: d.getStationSerial(),
      firmware: d.getSoftwareVersion(),
    });
  }

  // ── Stations ─────────────────────────────────────────────────────
  log("STATIONS", "=== Stations / HomeBases ===");
  const stations = await client.getStations();
  for (const s of stations) {
    log("STATIONS", {
      name: s.getName(),
      serial: s.getSerial(),
      model: s.getModel(),
      type: s.getDeviceType(),
      firmware: s.getSoftwareVersion(),
      connected: s.isConnected(),
    });
  }

  // ── P2P probe per station ────────────────────────────────────────
  for (const station of stations) {
    const sn = station.getSerial();
    log("P2P", `\n━━━ Station: ${station.getName()} (${sn}) ━━━`);

    // Connect P2P
    const alreadyConnected = station.isConnected();
    if (!alreadyConnected) {
      log("P2P", "Connecting via P2P...");
      try {
        await client.connectToStation(sn);
        await new Promise((r) => setTimeout(r, 3000));
        log("P2P", "P2P connected");
      } catch (err) {
        log("P2P", "P2P connection FAILED:", err instanceof Error ? err.message : err);
        continue;
      }
    } else {
      log("P2P", "Already P2P connected");
    }

    // Install raw P2P logger
    const cleanupLogger = installRawDatabaseLogger(station);

    // Get camera serial numbers for this station
    const stationDevices = devices
      .filter((d) => d.isCamera() && d.getStationSerial() === sn)
      .map((d) => d.getSerial());

    log("P2P", `Cameras on this station: ${stationDevices.join(", ") || "(none)"}`);

    // Date ranges
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
    const dayStart = new Date(dayEnd.getTime() - 24 * 60 * 60 * 1000);

    // Wide range: entire month
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

    log("P2P", `Narrow date range: ${dayStart.toLocaleString()} → ${dayEnd.toLocaleString()}`);
    log("P2P", `Wide date range: ${monthStart.toLocaleString()} → ${monthEnd.toLocaleString()}`);
    log("P2P", `Formatted narrow: ${fmtDate(dayStart)} → ${fmtDate(dayEnd)}`);
    log("P2P", `Formatted wide: ${fmtDate(monthStart)} → ${fmtDate(monthEnd)}`);

    // ── Test 1: databaseQueryLatestInfo ─────────────────────────
    log("TEST", "--- 1. databaseQueryLatestInfo ---");
    try {
      const p = waitForEvent(client, "station database query latest", sn, QUERY_TIMEOUT);
      station.databaseQueryLatestInfo();
      const result = await p;
      log("TEST", `  code=${result.returnCode}, records=${Array.isArray(result.data) ? result.data.length : "?"}`);
      if (Array.isArray(result.data)) {
        for (const entry of result.data) {
          log("TEST", "  ", entry);
        }
      }
    } catch (err) {
      log("TEST", `  FAILED: ${err instanceof Error ? err.message : err}`);
    }

    if (stationDevices.length === 0) {
      log("TEST", "Skipping query tests — no cameras on this station");
      cleanupLogger();
      continue;
    }

    // ── Test 2: databaseCountByDate (narrow range) ──────────────
    log("TEST", "--- 2. databaseCountByDate (24h) ---");
    try {
      const p = waitForEvent(client, "station database count by date", sn, QUERY_TIMEOUT);
      station.databaseCountByDate(dayStart, dayEnd);
      const result = await p;
      log("TEST", `  code=${result.returnCode}, records=${Array.isArray(result.data) ? result.data.length : "?"}`);
      if (Array.isArray(result.data)) {
        for (const entry of result.data) log("TEST", "  ", entry);
      }
    } catch (err) {
      log("TEST", `  FAILED: ${err instanceof Error ? err.message : err}`);
    }

    // ── Test 3: databaseCountByDate (wide range — full month) ───
    log("TEST", "--- 3. databaseCountByDate (full month) ---");
    try {
      const p = waitForEvent(client, "station database count by date", sn, QUERY_TIMEOUT);
      station.databaseCountByDate(monthStart, monthEnd);
      const result = await p;
      log("TEST", `  code=${result.returnCode}, records=${Array.isArray(result.data) ? result.data.length : "?"}`);
      if (Array.isArray(result.data)) {
        for (const entry of result.data) log("TEST", "  ", entry);
      }
    } catch (err) {
      log("TEST", `  FAILED: ${err instanceof Error ? err.message : err}`);
    }

    // ── Test 4: databaseQueryByDate — LOCAL, full month ─────────
    log("TEST", "--- 4. databaseQueryByDate (LOCAL, full month) ---");
    try {
      const p = waitForEvent(client, "station database query by date", sn, QUERY_TIMEOUT);
      station.databaseQueryByDate(stationDevices, monthStart, monthEnd, 0, 0, FilterStorageType.LOCAL);
      const result = await p;
      log("TEST", `  code=${result.returnCode}, records=${Array.isArray(result.data) ? result.data.length : "?"}`);
      if (Array.isArray(result.data) && result.data.length > 0) {
        log("TEST", "  First record:", result.data[0]);
      }
    } catch (err) {
      log("TEST", `  FAILED: ${err instanceof Error ? err.message : err}`);
    }

    // ── Test 5: databaseQueryByDate — default, full month ───────
    log("TEST", "--- 5. databaseQueryByDate (default, full month) ---");
    try {
      const p = waitForEvent(client, "station database query by date", sn, QUERY_TIMEOUT);
      station.databaseQueryByDate(stationDevices, monthStart, monthEnd);
      const result = await p;
      log("TEST", `  code=${result.returnCode}, records=${Array.isArray(result.data) ? result.data.length : "?"}`);
      if (Array.isArray(result.data) && result.data.length > 0) {
        log("TEST", "  First record:", result.data[0]);
      }
    } catch (err) {
      log("TEST", `  FAILED: ${err instanceof Error ? err.message : err}`);
    }

    // ── Test 6: databaseQueryLocal — full month, LONG timeout (120s) ──
    log("TEST", "--- 6. databaseQueryLocal (full month, 120s timeout) ---");
    log("TEST", "  This test takes up to 2 minutes, please wait...");
    try {
      const p = waitForEvent(client, "station database query local", sn, LONG_TIMEOUT);
      station.databaseQueryLocal(stationDevices, monthStart, monthEnd);
      const result = await p;
      log("TEST", `  code=${result.returnCode}, records=${Array.isArray(result.data) ? result.data.length : "?"}`);
      if (Array.isArray(result.data) && result.data.length > 0) {
        log("TEST", "  First record:", JSON.stringify(result.data[0]).slice(0, 500));
      }
    } catch (err) {
      log("TEST", `  FAILED: ${err instanceof Error ? err.message : err}`);
    }

    // ── Test 7: databaseQueryLocal — 24h range, LONG timeout ────
    log("TEST", "--- 7. databaseQueryLocal (24h, 120s timeout) ---");
    log("TEST", "  This test takes up to 2 minutes, please wait...");
    try {
      const p = waitForEvent(client, "station database query local", sn, LONG_TIMEOUT);
      station.databaseQueryLocal(stationDevices, dayStart, dayEnd);
      const result = await p;
      log("TEST", `  code=${result.returnCode}, records=${Array.isArray(result.data) ? result.data.length : "?"}`);
      if (Array.isArray(result.data) && result.data.length > 0) {
        log("TEST", "  First record:", JSON.stringify(result.data[0]).slice(0, 500));
      }
    } catch (err) {
      log("TEST", `  FAILED: ${err instanceof Error ? err.message : err}`);
    }

    // ── Test 8: databaseQueryLocal — LOCAL storage type, 24h, LONG timeout ──
    log("TEST", "--- 8. databaseQueryLocal (LOCAL, 24h, 120s timeout) ---");
    log("TEST", "  This test takes up to 2 minutes, please wait...");
    try {
      const p = waitForEvent(client, "station database query local", sn, LONG_TIMEOUT);
      station.databaseQueryLocal(stationDevices, dayStart, dayEnd, 0, 0, FilterStorageType.LOCAL);
      const result = await p;
      log("TEST", `  code=${result.returnCode}, records=${Array.isArray(result.data) ? result.data.length : "?"}`);
      if (Array.isArray(result.data) && result.data.length > 0) {
        log("TEST", "  First record:", JSON.stringify(result.data[0]).slice(0, 500));
      }
    } catch (err) {
      log("TEST", `  FAILED: ${err instanceof Error ? err.message : err}`);
    }

    // ── Test 9: raw P2P CMD_DATABASE_QUERY_LOCAL (10017) with custom params ──
    log("TEST", "--- 9. raw P2P CMD_DATABASE_QUERY_LOCAL (count=50, 120s timeout) ---");
    log("TEST", "  This test takes up to 2 minutes, please wait...");
    try {
      const p2pSession = (station as any).p2pSession;
      const rawStation = (station as any).rawStation;

      const startStr = fmtDate(dayStart);
      const endStr = fmtDate(dayEnd);

      const p = waitForEvent(client, "station database query local", sn, LONG_TIMEOUT);
      p2pSession.sendCommandWithStringPayload({
        commandType: 1350,
        value: JSON.stringify({
          account_id: rawStation.member.admin_user_id,
          cmd: 1306,
          mChannel: 0,
          mValue3: 0,
          payload: {
            cmd: 10017,
            payload: {
              count: 50,
              detection_type: 0,
              device_info: stationDevices.map((s: string) => ({ device_sn: s })),
              end_date: endStr,
              event_type: 0,
              flag: 0,
              res_unzip: 1,
              start_date: startStr,
              start_time: `${startStr}000000`,
              storage_cloud: 1,
              ai_type: 0,
            },
            table: "history_record_info",
            transaction: `${Date.now()}`,
          },
        }),
        channel: 0,
      });
      const result = await p;
      log("TEST", `  code=${result.returnCode}, records=${Array.isArray(result.data) ? result.data.length : "?"}`);
      if (Array.isArray(result.data) && result.data.length > 0) {
        log("TEST", "  First record:", JSON.stringify(result.data[0]).slice(0, 500));
      }
    } catch (err) {
      log("TEST", `  FAILED: ${err instanceof Error ? err.message : err}`);
    }

    cleanupLogger();
  }

  // ── Cloud API probe ──────────────────────────────────────────────
  log("CLOUD", "\n━━━ Cloud API ━━━");
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  for (const d of devices) {
    if (!d.isCamera()) continue;
    const dSN = d.getSerial();
    log("CLOUD", `Camera: ${d.getName()} (${dSN})`);

    try {
      const videoEvents = await client.getApi().getVideoEvents(yesterday, now, { deviceSN: dSN });
      log("CLOUD", `  getVideoEvents: ${videoEvents.length} events`);
    } catch (err) {
      log("CLOUD", `  getVideoEvents FAILED: ${err instanceof Error ? err.message : err}`);
    }

    try {
      const historyEvents = await client.getApi().getHistoryEvents(yesterday, now, { deviceSN: dSN });
      log("CLOUD", `  getHistoryEvents: ${historyEvents.length} events`);
    } catch (err) {
      log("CLOUD", `  getHistoryEvents FAILED: ${err instanceof Error ? err.message : err}`);
    }
  }

  log("DONE", "Diagnostic complete. Closing connection...");
  client.close();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
