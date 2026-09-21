import {
  EufySecurity,
  EufySecurityConfig,
  Device,
  Station,
  LoginOptions,
  DatabaseReturnCode,
  DatabaseQueryLocal,
  DatabaseQueryByDate,
  DatabaseCountByDate,
  DatabaseQueryLatestInfo,
  FilterStorageType,
} from "eufy-security-client";
import { Readable } from "stream";
import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import pino from "pino";

const logger = pino({ name: "eufy-service" });

export interface SimpleDevice {
  serialNumber: string;
  name: string;
  model: string;
  type: number;
  stationSerialNumber: string;
  isCamera: boolean;
}

export interface SimpleStation {
  serialNumber: string;
  name: string;
  model: string;
}

export interface EventRecord {
  id: string;
  deviceSerialNumber: string;
  deviceName: string;
  stationSerialNumber: string;
  storagePath: string;
  hevcStoragePath: string;
  cipherId: number;
  startTime: number;
  endTime: number;
  thumbPath: string;
  hasHuman: boolean;
  videoType: number;
}

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "tfa_required"
  | "captcha_required"
  | "error";

export interface CaptchaInfo {
  id: string;
  imageBase64: string;
}

const LOCAL_QUERY_TIMEOUT_MS = 60_000;
const P2P_SETTLE_DELAY_MS = 2_000;

export class EufyService {
  private client: EufySecurity | null = null;
  private _status: ConnectionStatus = "disconnected";
  private _captchaInfo: CaptchaInfo | null = null;
  private _errorMessage: string | null = null;

  private activeDownloads = new Map<
    string,
    {
      resolve: () => void;
      reject: (err: Error) => void;
      ffmpeg: ChildProcess | null;
      videoTempPath: string;
      audioTempPath: string;
      outputPath: string;
    }
  >();

  get status(): ConnectionStatus {
    return this._status;
  }

  get captchaInfo(): CaptchaInfo | null {
    return this._captchaInfo;
  }

  get errorMessage(): string | null {
    return this._errorMessage;
  }

  async initialize(): Promise<void> {
    const email = process.env.EUFY_EMAIL;
    const password = process.env.EUFY_PASSWORD;

    if (!email || !password) {
      throw new Error(
        "EUFY_EMAIL and EUFY_PASSWORD must be set in environment variables"
      );
    }

    const persistentDir = path.resolve(__dirname, "..", "persistent");
    if (!fs.existsSync(persistentDir)) {
      fs.mkdirSync(persistentDir, { recursive: true });
    }

    const config: EufySecurityConfig = {
      username: email,
      password: password,
      country: process.env.EUFY_COUNTRY || "US",
      language: "en",
      persistentDir,
      p2pConnectionSetup: parseInt(
        process.env.P2P_CONNECTION_SETUP || "0",
        10
      ),
      pollingIntervalMinutes: 10,
      eventDurationSeconds: 10,
    };

    const sessionPath = path.join(persistentDir, "session.json");
    if (fs.existsSync(sessionPath)) {
      try {
        config.persistentData = fs.readFileSync(sessionPath, "utf-8");
        logger.info("Restored persistent session data");
      } catch {
        logger.warn("Failed to read persistent session data, starting fresh");
      }
    }

    this._status = "connecting";
    this.client = await EufySecurity.initialize(config);
    this.setupEventListeners();

    try {
      await this.client.connect();
      if (this._status === "connecting") {
        this._status = "connected";
        this.savePersistentData();
        logger.info("Connected to Eufy Security");
      }
    } catch (err) {
      // Event listeners may have changed _status to tfa_required/captcha_required
      // during connect() — only treat as error if they didn't.
      const s = this._status as string;
      if (s !== "tfa_required" && s !== "captcha_required") {
        this._status = "error";
        this._errorMessage =
          err instanceof Error ? err.message : "Unknown connection error";
        logger.error({ err }, "Failed to connect to Eufy Security");
      }
    }
  }

  async submitTfaCode(code: string): Promise<void> {
    if (!this.client) throw new Error("Client not initialized");

    this._status = "connecting";
    try {
      await this.client.connect({ verifyCode: code } as LoginOptions);
      this._status = "connected";
      this.savePersistentData();
      logger.info("Connected after 2FA verification");
    } catch (err) {
      this._status = "error";
      this._errorMessage =
        err instanceof Error ? err.message : "2FA verification failed";
      throw err;
    }
  }

  async submitCaptcha(captchaId: string, captchaCode: string): Promise<void> {
    if (!this.client) throw new Error("Client not initialized");

    this._status = "connecting";
    try {
      await this.client.connect({
        captcha: { captchaId, captchaCode },
      } as LoginOptions);
      this._status = "connected";
      this.savePersistentData();
      logger.info("Connected after captcha verification");
    } catch (err) {
      this._status = "error";
      this._errorMessage =
        err instanceof Error ? err.message : "Captcha verification failed";
      throw err;
    }
  }

  async getDevices(): Promise<SimpleDevice[]> {
    this.ensureConnected();
    const devices: Device[] = await this.client!.getDevices();

    return devices
      .filter((d) => d.isCamera())
      .map((d) => ({
        serialNumber: d.getSerial(),
        name: d.getName(),
        model: d.getModel(),
        type: d.getDeviceType(),
        stationSerialNumber: d.getStationSerial(),
        isCamera: d.isCamera(),
      }));
  }

  async getStations(): Promise<SimpleStation[]> {
    this.ensureConnected();
    const stations: Station[] = await this.client!.getStations();

    return stations.map((s) => ({
      serialNumber: s.getSerial(),
      name: s.getName(),
      model: s.getModel(),
    }));
  }

  /**
   * Fetch video events for a device within a time range.
   *
   * Strategy: try the cloud API first (fast), then fall back to querying
   * the HomeBase's local database via P2P, which is where most users'
   * events actually live.
   */
  async getEvents(
    deviceSerialNumber: string,
    from: Date,
    to: Date
  ): Promise<EventRecord[]> {
    this.ensureConnected();

    logger.info(
      { deviceSN: deviceSerialNumber, from: from.toISOString(), to: to.toISOString() },
      "Fetching events"
    );

    // --- Try cloud API first (quick HTTP calls) ---
    const cloudEvents = await this.getCloudEvents(deviceSerialNumber, from, to);
    if (cloudEvents.length > 0) {
      logger.info({ count: cloudEvents.length }, "Found events via cloud API");
      return cloudEvents;
    }

    // --- Fall back to local HomeBase query via P2P ---
    logger.info("Cloud returned zero events, querying HomeBase local storage via P2P");
    try {
      const localEvents = await this.getLocalEvents(deviceSerialNumber, from, to);
      if (localEvents.length > 0) {
        logger.info({ count: localEvents.length }, "Found events on HomeBase local storage");
      } else {
        logger.warn({ deviceSN: deviceSerialNumber }, "No events found via cloud or local query");
      }
      return localEvents;
    } catch (err) {
      logger.error({ err }, "Local HomeBase query failed");
      return [];
    }
  }

  private async getCloudEvents(
    deviceSerialNumber: string,
    from: Date,
    to: Date
  ): Promise<EventRecord[]> {
    const api = this.client!.getApi();
    const filter = { deviceSN: deviceSerialNumber };

    let events = await api.getVideoEvents(from, to, filter);
    logger.info({ count: events.length }, "getVideoEvents result");

    if (events.length === 0) {
      events = await api.getHistoryEvents(from, to, filter);
      logger.info({ count: events.length }, "getHistoryEvents result");
    }

    return events.map((e) => ({
      id: `${e.device_sn}_${e.start_time}`,
      deviceSerialNumber: e.device_sn,
      deviceName: e.device_name,
      stationSerialNumber: e.station_sn,
      storagePath: e.storage_path,
      hevcStoragePath: e.hevc_storage_path ?? "",
      cipherId: e.cipher_id,
      startTime: e.start_time,
      endTime: e.end_time,
      thumbPath: e.thumb_path,
      hasHuman: e.has_human === 1,
      videoType: e.video_type,
    }));
  }

  private async getLocalEvents(
    deviceSerialNumber: string,
    from: Date,
    to: Date
  ): Promise<EventRecord[]> {
    const devices = await this.client!.getDevices();
    const device = devices.find((d) => d.getSerial() === deviceSerialNumber);
    if (!device) {
      logger.error({ deviceSN: deviceSerialNumber }, "Device not found");
      return [];
    }

    const stationSN = device.getStationSerial();
    const deviceName = device.getName();

    // Ensure the station is connected via P2P
    try {
      await this.ensureStationP2P(stationSN);
    } catch (err) {
      logger.error({ err, stationSN }, "Cannot establish P2P connection to station");
      return [];
    }

    const station = await this.client!.getStation(stationSN);

    // Get all camera serial numbers on this station for broader queries
    const allCameraSNs = devices
      .filter((d) => d.isCamera() && d.getStationSerial() === stationSN)
      .map((d) => d.getSerial());

    // Strategy: try databaseQueryByDate with several parameter variations,
    // then fall back to databaseQueryLocal.
    // Some HomeBase firmware (e.g. S380/HB3) returns 0 records with default
    // parameters but works with explicit LOCAL storage type.

    // Attempt 1: explicit LOCAL storage type with target device
    let events = await this.tryDatabaseQueryByDate(
      station, stationSN, [deviceSerialNumber], deviceName, from, to,
      FilterStorageType.LOCAL
    );
    if (events.length > 0) return events.filter((e) => e.deviceSerialNumber === deviceSerialNumber);

    // Attempt 2: default storage type (storage_cloud: -1) with target device
    events = await this.tryDatabaseQueryByDate(
      station, stationSN, [deviceSerialNumber], deviceName, from, to,
      FilterStorageType.NONE
    );
    if (events.length > 0) return events.filter((e) => e.deviceSerialNumber === deviceSerialNumber);

    // Attempt 3: LOCAL storage with ALL cameras on the station
    if (allCameraSNs.length > 1) {
      logger.info({ stationSN, cameras: allCameraSNs }, "Trying with all station cameras");
      events = await this.tryDatabaseQueryByDate(
        station, stationSN, allCameraSNs, deviceName, from, to,
        FilterStorageType.LOCAL
      );
      if (events.length > 0) return events.filter((e) => e.deviceSerialNumber === deviceSerialNumber);
    }

    // Attempt 4: raw P2P command with no device filtering and storage_cloud=1
    events = await this.tryRawDatabaseQuery(
      station, stationSN, allCameraSNs, deviceName, from, to
    );
    if (events.length > 0) return events.filter((e) => e.deviceSerialNumber === deviceSerialNumber);

    // Attempt 5: databaseQueryLocal with LOCAL storage type
    events = await this.tryDatabaseQueryLocal(
      station, stationSN, deviceSerialNumber, deviceName, from, to,
      FilterStorageType.LOCAL
    );
    if (events.length > 0) return events;

    // Attempt 6: databaseQueryLocal with default storage type
    events = await this.tryDatabaseQueryLocal(
      station, stationSN, deviceSerialNumber, deviceName, from, to
    );
    return events;
  }

  private async ensureStationP2P(stationSN: string): Promise<void> {
    const connected = await this.client!.isStationConnected(stationSN);
    if (connected) {
      logger.info({ stationSN }, "Station already P2P connected");
      return;
    }

    logger.info({ stationSN }, "Connecting to station via P2P...");
    await this.client!.connectToStation(stationSN);

    // Give the P2P session time to fully stabilize
    await new Promise((r) => setTimeout(r, P2P_SETTLE_DELAY_MS));
    logger.info({ stationSN }, "P2P connection established");
  }

  private async tryDatabaseQueryByDate(
    station: Station,
    stationSN: string,
    deviceSNs: string[],
    deviceName: string,
    from: Date,
    to: Date,
    storageType: FilterStorageType = FilterStorageType.NONE
  ): Promise<EventRecord[]> {
    try {
      logger.info(
        { stationSN, deviceSNs, storageType, from: from.toISOString(), to: to.toISOString() },
        "Trying databaseQueryByDate (P2P)"
      );
      const records = await new Promise<DatabaseQueryByDate[]>((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.client!.removeListener("station database query by date", handler);
          reject(new Error("databaseQueryByDate timed out"));
        }, LOCAL_QUERY_TIMEOUT_MS);

        const handler = (
          eventStation: Station,
          returnCode: DatabaseReturnCode,
          data: DatabaseQueryByDate[]
        ) => {
          if (eventStation.getSerial() !== stationSN) return;
          clearTimeout(timeout);
          this.client!.removeListener("station database query by date", handler);

          if (returnCode !== DatabaseReturnCode.SUCCESSFUL) {
            reject(new Error(`databaseQueryByDate failed (code: ${returnCode})`));
            return;
          }
          resolve(data);
        };

        this.client!.on("station database query by date", handler);
        station.databaseQueryByDate(deviceSNs, from, to, 0, 0, storageType);
      });

      logger.info(
        { count: records.length, storageType },
        "databaseQueryByDate returned records"
      );

      return records.map((r) => ({
        id: `local_${r.record_id}`,
        deviceSerialNumber: r.device_sn,
        deviceName,
        stationSerialNumber: r.station_sn,
        storagePath: r.storage_path,
        hevcStoragePath: "",
        cipherId: r.cipher_id,
        startTime: Math.trunc(r.start_time.getTime() / 1000),
        endTime: Math.trunc(r.end_time.getTime() / 1000),
        thumbPath: r.thumb_path,
        hasHuman: false,
        videoType: r.video_type as number,
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not implemented") || msg.includes("not supported")) {
        logger.warn({ stationSN }, "databaseQueryByDate not supported by this station");
      } else {
        logger.warn({ err, stationSN, storageType }, "databaseQueryByDate failed");
      }
      return [];
    }
  }

  private formatDateYYYYMMDD(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}${m}${d}`;
  }

  private async tryRawDatabaseQuery(
    station: Station,
    stationSN: string,
    deviceSNs: string[],
    deviceName: string,
    from: Date,
    to: Date
  ): Promise<EventRecord[]> {
    try {
      logger.info({ stationSN, deviceSNs }, "Trying raw P2P databaseQueryByDate with modified params");

      const p2pSession = (station as any).p2pSession;
      const rawStation = (station as any).rawStation;
      if (!p2pSession || !rawStation) {
        logger.warn({ stationSN }, "Cannot access P2P session internals");
        return [];
      }

      const startDateStr = this.formatDateYYYYMMDD(from);
      const endDateStr = this.formatDateYYYYMMDD(to);

      const records = await new Promise<DatabaseQueryByDate[]>((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.client!.removeListener("station database query by date", handler);
          reject(new Error("raw databaseQueryByDate timed out"));
        }, LOCAL_QUERY_TIMEOUT_MS);

        const handler = (
          eventStation: Station,
          returnCode: DatabaseReturnCode,
          data: DatabaseQueryByDate[]
        ) => {
          if (eventStation.getSerial() !== stationSN) return;
          clearTimeout(timeout);
          this.client!.removeListener("station database query by date", handler);
          if (returnCode !== DatabaseReturnCode.SUCCESSFUL) {
            reject(new Error(`raw databaseQueryByDate failed (code: ${returnCode})`));
            return;
          }
          resolve(data);
        };

        this.client!.on("station database query by date", handler);

        const devices = deviceSNs.map((sn) => ({ device_sn: sn }));
        p2pSession.sendCommandWithStringPayload({
          commandType: 1350,
          value: JSON.stringify({
            account_id: rawStation.member.admin_user_id,
            cmd: 1306,
            mChannel: 0,
            mValue3: 0,
            payload: {
              cmd: 10006,
              payload: {
                count: 500,
                detection_type: 0,
                device_info: devices,
                end_date: endDateStr,
                event_type: 0,
                flag: 0,
                res_unzip: 1,
                start_date: startDateStr,
                start_time: `${startDateStr}000000`,
                storage_cloud: 1,
                ai_type: -1,
              },
              table: "history_record_info",
              transaction: `${Date.now()}`,
            },
          }),
          channel: 0,
        });
      });

      logger.info({ count: records.length }, "raw databaseQueryByDate returned records");

      return records.map((r) => ({
        id: `local_${r.record_id}`,
        deviceSerialNumber: r.device_sn,
        deviceName,
        stationSerialNumber: r.station_sn,
        storagePath: r.storage_path,
        hevcStoragePath: "",
        cipherId: r.cipher_id,
        startTime: Math.trunc(r.start_time.getTime() / 1000),
        endTime: Math.trunc(r.end_time.getTime() / 1000),
        thumbPath: r.thumb_path,
        hasHuman: false,
        videoType: r.video_type as number,
      }));
    } catch (err) {
      logger.warn({ err, stationSN }, "raw databaseQueryByDate failed");
      return [];
    }
  }

  private async tryDatabaseQueryLocal(
    station: Station,
    stationSN: string,
    deviceSN: string,
    deviceName: string,
    from: Date,
    to: Date,
    storageType: FilterStorageType = FilterStorageType.NONE
  ): Promise<EventRecord[]> {
    try {
      logger.info({ stationSN, deviceSN, storageType }, "Trying databaseQueryLocal (P2P)");
      const records = await new Promise<DatabaseQueryLocal[]>((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.client!.removeListener("station database query local", handler);
          reject(new Error("databaseQueryLocal timed out"));
        }, LOCAL_QUERY_TIMEOUT_MS);

        const handler = (
          eventStation: Station,
          returnCode: DatabaseReturnCode,
          data: DatabaseQueryLocal[]
        ) => {
          if (eventStation.getSerial() !== stationSN) return;
          clearTimeout(timeout);
          this.client!.removeListener("station database query local", handler);

          if (returnCode !== DatabaseReturnCode.SUCCESSFUL) {
            reject(new Error(`databaseQueryLocal failed (code: ${returnCode})`));
            return;
          }
          resolve(data);
        };

        this.client!.on("station database query local", handler);
        station.databaseQueryLocal([deviceSN], from, to, 0, 0, storageType);
      });

      logger.info({ count: records.length }, "databaseQueryLocal returned records");

      return records
        .filter((r) => r.device_sn === deviceSN || !r.device_sn)
        .map((r) => {
          const h = r.history;
          return {
            id: `local_${r.record_id}`,
            deviceSerialNumber: r.device_sn ?? deviceSN,
            deviceName,
            stationSerialNumber: r.station_sn,
            storagePath: h.storage_path,
            hevcStoragePath: "",
            cipherId: h.cipher_id,
            startTime: Math.trunc(h.start_time.getTime() / 1000),
            endTime: Math.trunc(h.end_time.getTime() / 1000),
            thumbPath: h.thumb_path,
            hasHuman: false,
            videoType: h.video_type as number,
          };
        });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not implemented") || msg.includes("not supported")) {
        logger.warn({ stationSN }, "databaseQueryLocal not supported by this station");
      } else {
        logger.warn({ err, stationSN }, "databaseQueryLocal failed");
      }
      return [];
    }
  }

  async downloadEvent(event: EventRecord, outputPath: string): Promise<void> {
    this.ensureConnected();

    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const tempDir = path.join(dir, ".tmp");
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const timestamp = Date.now();
    const videoTempPath = path.join(tempDir, `video_${timestamp}.h264`);
    const audioTempPath = path.join(tempDir, `audio_${timestamp}.aac`);

    return new Promise<void>((resolve, reject) => {
      this.activeDownloads.set(event.deviceSerialNumber, {
        resolve,
        reject,
        ffmpeg: null,
        videoTempPath,
        audioTempPath,
        outputPath,
      });

      this.client!.startStationDownload(
        event.deviceSerialNumber,
        event.storagePath,
        event.cipherId
      ).catch((err) => {
        this.activeDownloads.delete(event.deviceSerialNumber);
        this.cleanupTempFiles(videoTempPath, audioTempPath);
        reject(err);
      });

      setTimeout(() => {
        if (this.activeDownloads.has(event.deviceSerialNumber)) {
          this.activeDownloads.delete(event.deviceSerialNumber);
          this.cleanupTempFiles(videoTempPath, audioTempPath);
          reject(new Error("Download timed out after 5 minutes"));
        }
      }, 5 * 60 * 1000);
    });
  }

  async close(): Promise<void> {
    if (this.client) {
      this.savePersistentData();
      this.client.close();
      this.client = null;
      this._status = "disconnected";
      logger.info("Eufy client closed");
    }
  }

  private setupEventListeners(): void {
    if (!this.client) return;

    this.client.on("tfa request", () => {
      this._status = "tfa_required";
      logger.info("2FA verification code required - check your email/SMS");
    });

    this.client.on(
      "captcha request",
      (captchaId: string, captchaImageBase64: string) => {
        this._status = "captcha_required";
        this._captchaInfo = { id: captchaId, imageBase64: captchaImageBase64 };
        logger.info("Captcha verification required");
      }
    );

    this.client.on("connect", () => {
      this._status = "connected";
      this.savePersistentData();
      logger.info("Eufy client connected");
    });

    this.client.on("close", () => {
      if (this._status === "connected") {
        this._status = "disconnected";
        logger.info("Eufy client disconnected");
      }
    });

    this.client.on("connection error", (error: Error) => {
      this._status = "error";
      this._errorMessage = error.message;
      logger.error({ error }, "Eufy connection error");
    });

    this.client.on(
      "station download start",
      (
        _station: Station,
        device: Device,
        metadata: { videoCodec: number; videoFPS: number; videoWidth: number; videoHeight: number },
        videoStream: Readable,
        audioStream: Readable
      ) => {
        const deviceSN = device.getSerial();
        const download = this.activeDownloads.get(deviceSN);
        if (!download) {
          logger.warn(
            { deviceSN },
            "Received download start for unknown device"
          );
          return;
        }

        logger.info(
          {
            deviceSN,
            codec: metadata.videoCodec === 0 ? "H.264" : "H.265",
            resolution: `${metadata.videoWidth}x${metadata.videoHeight}`,
            fps: metadata.videoFPS,
          },
          "Download stream started"
        );

        const videoOut = fs.createWriteStream(download.videoTempPath);
        const audioOut = fs.createWriteStream(download.audioTempPath);

        videoStream.pipe(videoOut);
        audioStream.pipe(audioOut);

        videoStream.on("error", (err) => {
          logger.error({ err, deviceSN }, "Video stream error");
        });
        audioStream.on("error", (err) => {
          logger.error({ err, deviceSN }, "Audio stream error");
        });
      }
    );

    this.client.on(
      "station download finish",
      (_station: Station, device: Device) => {
        const deviceSN = device.getSerial();
        const download = this.activeDownloads.get(deviceSN);
        if (!download) return;

        logger.info({ deviceSN }, "Download stream finished, muxing with FFmpeg");

        setTimeout(() => {
          this.muxWithFfmpeg(download);
        }, 500);
      }
    );
  }

  private muxWithFfmpeg(download: {
    resolve: () => void;
    reject: (err: Error) => void;
    ffmpeg: ChildProcess | null;
    videoTempPath: string;
    audioTempPath: string;
    outputPath: string;
  }): void {
    const videoExists =
      fs.existsSync(download.videoTempPath) &&
      fs.statSync(download.videoTempPath).size > 0;
    const audioExists =
      fs.existsSync(download.audioTempPath) &&
      fs.statSync(download.audioTempPath).size > 0;

    if (!videoExists) {
      this.cleanupTempFiles(download.videoTempPath, download.audioTempPath);
      download.reject(new Error("No video data received"));
      return;
    }

    const args: string[] = ["-y"];

    args.push("-f", "h264", "-i", download.videoTempPath);

    if (audioExists) {
      args.push("-f", "aac", "-i", download.audioTempPath);
      args.push("-map", "0:v", "-map", "1:a");
    }

    args.push("-c:v", "copy");
    if (audioExists) {
      args.push("-c:a", "copy");
    }
    args.push("-movflags", "+faststart", download.outputPath);

    const ffmpeg = spawn("ffmpeg", args);
    download.ffmpeg = ffmpeg;

    let stderrOutput = "";
    ffmpeg.stderr?.on("data", (data: Buffer) => {
      stderrOutput += data.toString();
    });

    ffmpeg.on("close", (code) => {
      this.cleanupTempFiles(download.videoTempPath, download.audioTempPath);

      if (code === 0) {
        logger.info({ outputPath: download.outputPath }, "MP4 file saved");
        download.resolve();
      } else {
        logger.error(
          { code, stderr: stderrOutput.slice(-500) },
          "FFmpeg failed"
        );
        download.reject(new Error(`FFmpeg exited with code ${code}`));
      }
    });

    ffmpeg.on("error", (err) => {
      this.cleanupTempFiles(download.videoTempPath, download.audioTempPath);
      download.reject(
        new Error(`FFmpeg process error: ${err.message}. Is FFmpeg installed?`)
      );
    });
  }

  private cleanupTempFiles(...files: string[]): void {
    for (const f of files) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  private savePersistentData(): void {
    if (!this.client) return;
    try {
      const persistentDir = path.resolve(__dirname, "..", "persistent");
      const sessionPath = path.join(persistentDir, "session.json");
      const data = (this.client as any).getPersistentData?.();
      if (data) {
        fs.writeFileSync(sessionPath, JSON.stringify(data));
      }
    } catch (err) {
      logger.warn({ err }, "Failed to save persistent session data");
    }
  }

  private ensureConnected(): void {
    if (!this.client || this._status !== "connected") {
      throw new Error(
        `Eufy client is not connected (status: ${this._status})`
      );
    }
  }
}
