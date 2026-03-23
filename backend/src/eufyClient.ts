import {
  EufySecurity,
  EufySecurityConfig,
  Device,
  Station,
  LoginOptions,
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

/**
 * Wrapper around eufy-security-client that isolates all Eufy API calls.
 * If the library or protocol changes, only this file needs updating.
 */
export class EufyService {
  private client: EufySecurity | null = null;
  private _status: ConnectionStatus = "disconnected";
  private _captchaInfo: CaptchaInfo | null = null;
  private _errorMessage: string | null = null;

  // Active download tracking: maps deviceSN to resolve/reject callbacks
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

  /**
   * Initialize the EufySecurity client and attempt to connect.
   * Call this once at startup.
   */
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

    // Restore persistent session data if available
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
      // If connect() didn't trigger tfa/captcha events, we're connected
      if (this._status === "connecting") {
        this._status = "connected";
        this.savePersistentData();
        logger.info("Connected to Eufy Security");
      }
    } catch (err) {
      // 2FA or captcha may have been triggered via events
      if (
        this._status !== "tfa_required" &&
        this._status !== "captcha_required"
      ) {
        this._status = "error";
        this._errorMessage =
          err instanceof Error ? err.message : "Unknown connection error";
        logger.error({ err }, "Failed to connect to Eufy Security");
      }
    }
  }

  /**
   * Submit a 2FA verification code (from email/SMS).
   */
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

  /**
   * Submit a captcha solution.
   */
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

  /**
   * Get all camera devices from the account.
   */
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

  /**
   * Get all stations (base stations / hubs).
   */
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
   * Uses the HTTP API to query the Eufy cloud for event records.
   */
  async getEvents(
    deviceSerialNumber: string,
    from: Date,
    to: Date
  ): Promise<EventRecord[]> {
    this.ensureConnected();

    const events = await this.client!.getApi().getVideoEvents(from, to, {
      deviceSN: deviceSerialNumber,
    });

    return events.map((e) => ({
      id: `${e.device_sn}_${e.start_time}`,
      deviceSerialNumber: e.device_sn,
      deviceName: e.device_name,
      stationSerialNumber: e.station_sn,
      storagePath: e.storage_path,
      hevcStoragePath: e.hevc_storage_path,
      cipherId: e.cipher_id,
      startTime: e.start_time,
      endTime: e.end_time,
      thumbPath: e.thumb_path,
      hasHuman: e.has_human === 1,
      videoType: e.video_type,
    }));
  }

  /**
   * Download a single event video and save it as an MP4 file.
   *
   * The eufy-security-client provides raw H.264/H.265 video and raw AAC audio
   * as Node.js Readable streams via the "station download start" event.
   * We save these to temp files, then use FFmpeg to mux them into a proper MP4.
   *
   * The download is initiated via P2P connection to the station.
   */
  async downloadEvent(event: EventRecord, outputPath: string): Promise<void> {
    this.ensureConnected();

    // Ensure output directory exists
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
      // Register this download so event handlers can find it
      this.activeDownloads.set(event.deviceSerialNumber, {
        resolve,
        reject,
        ffmpeg: null,
        videoTempPath,
        audioTempPath,
        outputPath,
      });

      // Initiate the P2P download
      // The "station download start" event handler will receive the streams
      this.client!.startStationDownload(
        event.deviceSerialNumber,
        event.storagePath,
        event.cipherId
      ).catch((err) => {
        this.activeDownloads.delete(event.deviceSerialNumber);
        this.cleanupTempFiles(videoTempPath, audioTempPath);
        reject(err);
      });

      // Timeout after 5 minutes
      setTimeout(() => {
        if (this.activeDownloads.has(event.deviceSerialNumber)) {
          this.activeDownloads.delete(event.deviceSerialNumber);
          this.cleanupTempFiles(videoTempPath, audioTempPath);
          reject(new Error("Download timed out after 5 minutes"));
        }
      }, 5 * 60 * 1000);
    });
  }

  /**
   * Gracefully close the Eufy client connection.
   */
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

    // 2FA requested
    this.client.on("tfa request", () => {
      this._status = "tfa_required";
      logger.info("2FA verification code required - check your email/SMS");
    });

    // Captcha requested
    this.client.on(
      "captcha request",
      (captchaId: string, captchaImageBase64: string) => {
        this._status = "captcha_required";
        this._captchaInfo = { id: captchaId, imageBase64: captchaImageBase64 };
        logger.info("Captcha verification required");
      }
    );

    // Connection established
    this.client.on("connect", () => {
      this._status = "connected";
      this.savePersistentData();
      logger.info("Eufy client connected");
    });

    // Connection closed
    this.client.on("close", () => {
      if (this._status === "connected") {
        this._status = "disconnected";
        logger.info("Eufy client disconnected");
      }
    });

    // Connection error
    this.client.on("connection error", (error: Error) => {
      this._status = "error";
      this._errorMessage = error.message;
      logger.error({ error }, "Eufy connection error");
    });

    /**
     * Download started - receives raw video and audio streams.
     * The video stream is raw H.264 (or H.265) and audio is raw AAC.
     * We save them to temp files, then mux with FFmpeg when download finishes.
     */
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

        // Write raw streams to temp files
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

    /**
     * Download finished - mux the raw video/audio into MP4 using FFmpeg.
     */
    this.client.on(
      "station download finish",
      (_station: Station, device: Device) => {
        const deviceSN = device.getSerial();
        const download = this.activeDownloads.get(deviceSN);
        if (!download) return;

        logger.info({ deviceSN }, "Download stream finished, muxing with FFmpeg");

        // Small delay to ensure file streams are fully flushed
        setTimeout(() => {
          this.muxWithFfmpeg(download);
        }, 500);
      }
    );
  }

  /**
   * Use FFmpeg to combine raw H.264 video and AAC audio into an MP4 container.
   */
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

    // Video input
    args.push("-f", "h264", "-i", download.videoTempPath);

    // Audio input (if available)
    if (audioExists) {
      args.push("-f", "aac", "-i", download.audioTempPath);
      args.push("-map", "0:v", "-map", "1:a");
    }

    // Copy codecs (no re-encoding), optimize for streaming
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
