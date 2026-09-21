import * as fs from "fs";
import * as path from "path";
import pino from "pino";

const logger = pino({ name: "event-store" });

export interface StoredEvent {
  id: string;
  deviceSN: string;
  deviceName: string;
  stationSN: string;
  filePath: string;
  cipher: number;
  eventTime: number;
  eventType: number;
  eventSession: string;
  content: string;
  storageType: number;
  channel: number;
}

export interface PushMessage {
  name?: string;
  event_time?: number;
  type?: number;
  station_sn?: string;
  device_sn?: string;
  push_time?: number;
  content?: string;
  channel?: number;
  cipher?: number;
  event_session?: string;
  event_type?: number;
  file_path?: string;
  storage_type?: number;
  msg_type?: number;
  [key: string]: unknown;
}

export class EventStore {
  private events: Map<string, StoredEvent> = new Map();
  private storePath: string;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(persistentDir: string) {
    this.storePath = path.join(persistentDir, "events.json");
    this.load();
  }

  addFromPush(msg: PushMessage): StoredEvent | null {
    if (!msg.file_path || !msg.device_sn || !msg.station_sn) {
      return null;
    }

    const id = `push_${msg.device_sn}_${msg.event_time || Date.now()}`;

    if (this.events.has(id)) {
      return null;
    }

    const event: StoredEvent = {
      id,
      deviceSN: msg.device_sn,
      deviceName: msg.name || msg.device_sn,
      stationSN: msg.station_sn,
      filePath: msg.file_path,
      cipher: msg.cipher ?? 0,
      eventTime: msg.event_time ?? Date.now(),
      eventType: msg.event_type ?? 0,
      eventSession: msg.event_session ?? "",
      content: msg.content ?? "",
      storageType: msg.storage_type ?? 1,
      channel: msg.channel ?? 0,
    };

    this.events.set(id, event);
    this.scheduleSave();
    logger.info(
      { id, device: event.deviceName, content: event.content },
      "Event captured from push notification"
    );
    return event;
  }

  getEvents(deviceSN: string, from: Date, to: Date): StoredEvent[] {
    const fromMs = from.getTime();
    const toMs = to.getTime();

    return Array.from(this.events.values())
      .filter(
        (e) =>
          e.deviceSN === deviceSN &&
          e.eventTime >= fromMs &&
          e.eventTime <= toMs
      )
      .sort((a, b) => b.eventTime - a.eventTime);
  }

  getAllEvents(deviceSN?: string): StoredEvent[] {
    const all = Array.from(this.events.values());
    if (deviceSN) {
      return all.filter((e) => e.deviceSN === deviceSN);
    }
    return all;
  }

  getStats(): { total: number; byDevice: Record<string, number> } {
    const byDevice: Record<string, number> = {};
    for (const e of this.events.values()) {
      const key = e.deviceName || e.deviceSN;
      byDevice[key] = (byDevice[key] || 0) + 1;
    }
    return { total: this.events.size, byDevice };
  }

  private load(): void {
    try {
      if (fs.existsSync(this.storePath)) {
        const raw = fs.readFileSync(this.storePath, "utf-8");
        const arr: StoredEvent[] = JSON.parse(raw);
        for (const e of arr) {
          this.events.set(e.id, e);
        }
        logger.info({ count: this.events.size }, "Loaded events from disk");
      }
    } catch (err) {
      logger.warn({ err }, "Failed to load event store, starting fresh");
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveToDisk();
    }, 2000);
  }

  private saveToDisk(): void {
    try {
      const dir = path.dirname(this.storePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const arr = Array.from(this.events.values());
      fs.writeFileSync(this.storePath, JSON.stringify(arr, null, 2));
    } catch (err) {
      logger.warn({ err }, "Failed to save event store");
    }
  }

  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.saveToDisk();
  }
}
