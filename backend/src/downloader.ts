import { v4 as uuidv4 } from "uuid";
import * as path from "path";
import pino from "pino";
import { EufyService, EventRecord } from "./eufyClient";

const logger = pino({ name: "downloader" });

export type EventDownloadStatus = "pending" | "downloading" | "done" | "failed";
export type JobStatus = "running" | "completed" | "failed" | "cancelled";

export interface EventDownloadInfo {
  eventId: string;
  startTime: number;
  endTime: number;
  status: EventDownloadStatus;
  error?: string;
  outputPath?: string;
}

export interface DownloadJob {
  id: string;
  deviceSerialNumber: string;
  deviceName: string;
  from: number;
  to: number;
  events: EventDownloadInfo[];
  status: JobStatus;
  maxConcurrent: number;
  createdAt: number;
  completedAt?: number;
}

/**
 * Sanitize a string for use as a filesystem directory/file name.
 */
function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\-. ]/g, "_").trim();
}

/**
 * Generate a deterministic file path for a downloaded event.
 * Format: <downloadDir>/<DeviceName>/<YYYY-MM-DD>/<YYYYMMDD_HHmmss>_<eventId>.mp4
 */
function buildOutputPath(
  downloadDir: string,
  deviceName: string,
  event: EventRecord
): string {
  const date = new Date(event.startTime * 1000);
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");

  const dateDir = `${yyyy}-${mm}-${dd}`;
  const fileName = `${yyyy}${mm}${dd}_${hh}${min}${ss}_${event.startTime}.mp4`;

  return path.join(downloadDir, sanitizeFilename(deviceName), dateDir, fileName);
}

/**
 * In-memory job manager for tracking bulk download jobs.
 */
export class JobManager {
  private jobs = new Map<string, DownloadJob>();
  private eufyService: EufyService;
  private downloadDir: string;

  constructor(eufyService: EufyService, downloadDir: string) {
    this.eufyService = eufyService;
    this.downloadDir = downloadDir;
  }

  /**
   * Create a new download job from a list of events.
   */
  createJob(
    deviceSerialNumber: string,
    deviceName: string,
    from: number,
    to: number,
    events: EventRecord[],
    maxConcurrent: number = 2
  ): DownloadJob {
    const job: DownloadJob = {
      id: uuidv4(),
      deviceSerialNumber,
      deviceName,
      from,
      to,
      events: events.map((e) => ({
        eventId: e.id,
        startTime: e.startTime,
        endTime: e.endTime,
        status: "pending" as EventDownloadStatus,
        outputPath: buildOutputPath(this.downloadDir, deviceName, e),
      })),
      status: "running",
      maxConcurrent,
      createdAt: Date.now(),
    };

    this.jobs.set(job.id, job);
    logger.info(
      { jobId: job.id, eventCount: events.length },
      "Download job created"
    );

    return job;
  }

  /**
   * Start processing a job: download events with controlled concurrency.
   * This runs asynchronously and updates job status as it progresses.
   */
  async startJob(
    jobId: string,
    events: EventRecord[]
  ): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);

    // Build a lookup map of event records by their ID
    const eventMap = new Map<string, EventRecord>();
    for (const e of events) {
      eventMap.set(e.id, e);
    }

    const pending = [...job.events];
    const active: Promise<void>[] = [];

    const processNext = async (): Promise<void> => {
      while (pending.length > 0 && job.status === "running") {
        const eventInfo = pending.shift()!;
        const eventRecord = eventMap.get(eventInfo.eventId);

        if (!eventRecord) {
          eventInfo.status = "failed";
          eventInfo.error = "Event record not found";
          continue;
        }

        eventInfo.status = "downloading";
        logger.info(
          {
            jobId,
            eventId: eventInfo.eventId,
            outputPath: eventInfo.outputPath,
          },
          "Downloading event"
        );

        try {
          await this.eufyService.downloadEvent(
            eventRecord,
            eventInfo.outputPath!
          );
          eventInfo.status = "done";
          logger.info(
            { jobId, eventId: eventInfo.eventId },
            "Event downloaded"
          );
        } catch (err) {
          eventInfo.status = "failed";
          eventInfo.error =
            err instanceof Error ? err.message : "Download failed";
          logger.error(
            { jobId, eventId: eventInfo.eventId, err },
            "Event download failed"
          );
        }
      }
    };

    // Start up to maxConcurrent workers
    for (let i = 0; i < job.maxConcurrent; i++) {
      active.push(processNext());
    }

    await Promise.all(active);

    // Determine final job status
    const allDone = job.events.every((e) => e.status === "done");
    const anyFailed = job.events.some((e) => e.status === "failed");

    if (job.status === "cancelled") {
      // Keep cancelled status
    } else if (allDone) {
      job.status = "completed";
    } else if (anyFailed) {
      job.status = "failed";
    } else {
      job.status = "completed";
    }

    job.completedAt = Date.now();
    logger.info({ jobId, status: job.status }, "Job finished");
  }

  /**
   * Cancel a running job (pending events won't be downloaded).
   */
  cancelJob(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (job && job.status === "running") {
      job.status = "cancelled";
      job.completedAt = Date.now();
      logger.info({ jobId }, "Job cancelled");
    }
  }

  /**
   * Get all jobs and their statuses.
   */
  getJobs(): DownloadJob[] {
    return Array.from(this.jobs.values()).sort(
      (a, b) => b.createdAt - a.createdAt
    );
  }

  /**
   * Get a single job by ID.
   */
  getJob(jobId: string): DownloadJob | undefined {
    return this.jobs.get(jobId);
  }
}
