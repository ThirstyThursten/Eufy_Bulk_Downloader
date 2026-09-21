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
  StorageType,
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

    // ── Test 6: raw P2P CMD_DATABASE_QUERY (10000) — might be a simpler query ──
    log("TEST", "--- 6. raw P2P CMD_DATABASE_QUERY (10000, 30s) ---");
    try {
      const p2pSession = (station as any).p2pSession;
      const rawStation = (station as any).rawStation;

      const startStr = fmtDate(dayStart);
      const endStr = fmtDate(dayEnd);

      // Listen for ANY database event (the response cmd might differ)
      const p = new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => {
          (client as any).removeListener("station database query by date", h1);
          (client as any).removeListener("station database query local", h2);
          reject(new Error("CMD 10000 timed out after 30s"));
        }, QUERY_TIMEOUT);

        const h1 = (s: Station, rc: number, data: any) => {
          if (s.getSerial() !== sn) return;
          clearTimeout(timer);
          (client as any).removeListener("station database query by date", h1);
          (client as any).removeListener("station database query local", h2);
          resolve({ event: "query by date", returnCode: rc, count: Array.isArray(data) ? data.length : "?", data });
        };
        const h2 = (s: Station, rc: number, data: any) => {
          if (s.getSerial() !== sn) return;
          clearTimeout(timer);
          (client as any).removeListener("station database query by date", h1);
          (client as any).removeListener("station database query local", h2);
          resolve({ event: "query local", returnCode: rc, count: Array.isArray(data) ? data.length : "?", data });
        };
        (client as any).on("station database query by date", h1);
        (client as any).on("station database query local", h2);
      });

      p2pSession.sendCommandWithStringPayload({
        commandType: 1350,
        value: JSON.stringify({
          account_id: rawStation.member.admin_user_id,
          cmd: 1306,
          mChannel: 0,
          mValue3: 0,
          payload: {
            cmd: 10000,
            payload: {
              count: 100,
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
      log("TEST", "  Result:", JSON.stringify(result).slice(0, 1000));
    } catch (err) {
      log("TEST", `  FAILED: ${err instanceof Error ? err.message : err}`);
    }

    cleanupLogger();
  }

  // ── Cloud API probe (expanded) ──────────────────────────────────
  log("CLOUD", "\n━━━ Cloud API (expanded) ━━━");
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const api = client.getApi();

  for (const d of devices) {
    if (!d.isCamera()) continue;
    const dSN = d.getSerial();
    const stationSN = d.getStationSerial();
    log("CLOUD", `Camera: ${d.getName()} (${dSN})`);

    // Standard calls
    try {
      const events = await api.getVideoEvents(yesterday, now, { deviceSN: dSN });
      log("CLOUD", `  getVideoEvents(device filter): ${events.length} events`);
    } catch (err) {
      log("CLOUD", `  getVideoEvents FAILED: ${err instanceof Error ? err.message : err}`);
    }

    try {
      const events = await api.getHistoryEvents(yesterday, now, { deviceSN: dSN });
      log("CLOUD", `  getHistoryEvents(device filter): ${events.length} events`);
    } catch (err) {
      log("CLOUD", `  getHistoryEvents FAILED: ${err instanceof Error ? err.message : err}`);
    }

    // NEW: getAlarmEvents
    try {
      const events = await api.getAlarmEvents(yesterday, now, { deviceSN: dSN });
      log("CLOUD", `  getAlarmEvents(device filter): ${events.length} events`);
      if (events.length > 0) log("CLOUD", "  First alarm:", JSON.stringify(events[0]).slice(0, 500));
    } catch (err) {
      log("CLOUD", `  getAlarmEvents FAILED: ${err instanceof Error ? err.message : err}`);
    }

    // NEW: filter by storageType LOCAL
    try {
      const events = await api.getVideoEvents(yesterday, now, { deviceSN: dSN, storageType: StorageType.LOCAL });
      log("CLOUD", `  getVideoEvents(LOCAL storage): ${events.length} events`);
      if (events.length > 0) log("CLOUD", "  First event:", JSON.stringify(events[0]).slice(0, 500));
    } catch (err) {
      log("CLOUD", `  getVideoEvents(LOCAL) FAILED: ${err instanceof Error ? err.message : err}`);
    }

    // NEW: filter by station instead of device
    try {
      const events = await api.getVideoEvents(yesterday, now, { stationSN });
      log("CLOUD", `  getVideoEvents(station filter): ${events.length} events`);
      if (events.length > 0) log("CLOUD", "  First event:", JSON.stringify(events[0]).slice(0, 500));
    } catch (err) {
      log("CLOUD", `  getVideoEvents(station) FAILED: ${err instanceof Error ? err.message : err}`);
    }

    // NEW: no filter at all
    try {
      const events = await api.getVideoEvents(yesterday, now);
      log("CLOUD", `  getVideoEvents(no filter): ${events.length} events`);
      if (events.length > 0) log("CLOUD", "  First event:", JSON.stringify(events[0]).slice(0, 500));
    } catch (err) {
      log("CLOUD", `  getVideoEvents(no filter) FAILED: ${err instanceof Error ? err.message : err}`);
    }

    // NEW: getAllVideoEvents (15-year range, no date filter)
    try {
      const events = await api.getAllVideoEvents({ deviceSN: dSN });
      log("CLOUD", `  getAllVideoEvents: ${events.length} events`);
      if (events.length > 0) log("CLOUD", "  First event:", JSON.stringify(events[0]).slice(0, 500));
    } catch (err) {
      log("CLOUD", `  getAllVideoEvents FAILED: ${err instanceof Error ? err.message : err}`);
    }

    // NEW: getAllHistoryEvents
    try {
      const events = await api.getAllHistoryEvents({ deviceSN: dSN });
      log("CLOUD", `  getAllHistoryEvents: ${events.length} events`);
      if (events.length > 0) log("CLOUD", "  First event:", JSON.stringify(events[0]).slice(0, 500));
    } catch (err) {
      log("CLOUD", `  getAllHistoryEvents FAILED: ${err instanceof Error ? err.message : err}`);
    }

    break; // Only test the first camera for cloud API
  }

  // ── Push notification probe (30s listener) ───────────────────────
  log("PUSH", "\n━━━ Push Notification Listener (30s) ━━━");
  log("PUSH", "Listening for push messages for 30 seconds...");
  log("PUSH", "Trigger a motion event on your camera NOW if possible.");
  let pushCount = 0;
  const pushHandler = (...args: unknown[]) => {
    pushCount++;
    log("PUSH", `  Push message #${pushCount}:`, JSON.stringify(args).slice(0, 1000));
  };
  (client as any).on("push message", pushHandler);
  await new Promise((r) => setTimeout(r, 30_000));
  (client as any).removeListener("push message", pushHandler);
  log("PUSH", `Received ${pushCount} push messages in 30 seconds`);

  log("DONE", "Diagnostic complete. Closing connection...");
  client.close();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
