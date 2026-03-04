import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { z } from "zod";
import pino from "pino";
import { EufyService } from "./eufyClient";
import { JobManager } from "./downloader";

const logger = pino({ name: "server" });

/**
 * Create and configure the Express application with all API routes.
 */
export function createApp(
  eufyService: EufyService,
  jobManager: JobManager
): express.Application {
  const app = express();

  app.use(cors());
  app.use(express.json());

  // --- Health / Status ---

  /**
   * GET /api/status
   * Returns the current connection status to Eufy Security.
   * Used by the frontend to show connection state and handle 2FA/captcha.
   */
  app.get("/api/status", (_req: Request, res: Response) => {
    res.json({
      status: eufyService.status,
      captcha: eufyService.captchaInfo,
      error: eufyService.errorMessage,
    });
  });

  // --- 2FA / Captcha ---

  const tfaSchema = z.object({ code: z.string().length(6) });

  /**
   * POST /api/auth/tfa
   * Submit a 2FA verification code (6 digits from email/SMS).
   */
  app.post("/api/auth/tfa", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { code } = tfaSchema.parse(req.body);
      await eufyService.submitTfaCode(code);
      res.json({ status: eufyService.status });
    } catch (err) {
      next(err);
    }
  });

  const captchaSchema = z.object({
    captchaId: z.string(),
    captchaCode: z.string(),
  });

  /**
   * POST /api/auth/captcha
   * Submit a captcha solution.
   */
  app.post("/api/auth/captcha", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { captchaId, captchaCode } = captchaSchema.parse(req.body);
      await eufyService.submitCaptcha(captchaId, captchaCode);
      res.json({ status: eufyService.status });
    } catch (err) {
      next(err);
    }
  });

  // --- Devices ---

  /**
   * GET /api/devices
   * Returns all camera devices associated with the Eufy account.
   */
  app.get("/api/devices", async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const devices = await eufyService.getDevices();
      const stations = await eufyService.getStations();
      res.json({ devices, stations });
    } catch (err) {
      next(err);
    }
  });

  // --- Events ---

  const eventsQuerySchema = z.object({
    deviceId: z.string().min(1),
    from: z.string().datetime(),
    to: z.string().datetime(),
  });

  /**
   * GET /api/events?deviceId=...&from=...&to=...
   * Returns video event clips for a given camera and time range.
   * from/to should be ISO 8601 date strings.
   */
  app.get("/api/events", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = eventsQuerySchema.parse(req.query);
      const from = new Date(query.from);
      const to = new Date(query.to);

      if (from >= to) {
        res.status(400).json({ error: "'from' must be before 'to'" });
        return;
      }

      const events = await eufyService.getEvents(query.deviceId, from, to);
      res.json({ events });
    } catch (err) {
      next(err);
    }
  });

  // --- Download ---

  const downloadSchema = z.object({
    deviceId: z.string().min(1),
    from: z.string().datetime(),
    to: z.string().datetime(),
    eventIds: z.array(z.string()).optional(),
    maxConcurrent: z.number().int().min(1).max(5).optional(),
  });

  /**
   * POST /api/download
   * Start a bulk download job for the given device and time range.
   * Optionally filter to specific event IDs.
   * Returns the job ID immediately; the download runs in the background.
   */
  app.post("/api/download", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = downloadSchema.parse(req.body);
      const from = new Date(body.from);
      const to = new Date(body.to);

      if (from >= to) {
        res.status(400).json({ error: "'from' must be before 'to'" });
        return;
      }

      // Fetch events for the device and time range
      let events = await eufyService.getEvents(body.deviceId, from, to);

      // Filter to selected event IDs if provided
      if (body.eventIds && body.eventIds.length > 0) {
        const idSet = new Set(body.eventIds);
        events = events.filter((e) => idSet.has(e.id));
      }

      if (events.length === 0) {
        res.status(404).json({ error: "No events found for the given criteria" });
        return;
      }

      // Get device name for folder naming
      const devices = await eufyService.getDevices();
      const device = devices.find((d) => d.serialNumber === body.deviceId);
      const deviceName = device?.name || body.deviceId;

      const maxConcurrent =
        body.maxConcurrent ||
        parseInt(process.env.MAX_CONCURRENT_DOWNLOADS || "2", 10);

      // Create the job
      const job = jobManager.createJob(
        body.deviceId,
        deviceName,
        from.getTime(),
        to.getTime(),
        events,
        maxConcurrent
      );

      // Start the job asynchronously (don't await)
      jobManager.startJob(job.id, events).catch((err) => {
        logger.error({ jobId: job.id, err }, "Job execution error");
      });

      res.status(201).json({ jobId: job.id });
    } catch (err) {
      next(err);
    }
  });

  // --- Jobs ---

  /**
   * GET /api/jobs
   * Returns all download jobs and their statuses.
   */
  app.get("/api/jobs", (_req: Request, res: Response) => {
    const jobs = jobManager.getJobs();
    res.json({ jobs });
  });

  /**
   * POST /api/jobs/:jobId/cancel
   * Cancel a running download job.
   */
  app.post("/api/jobs/:jobId/cancel", (req: Request, res: Response) => {
    const job = jobManager.getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    jobManager.cancelJob(req.params.jobId);
    res.json({ status: "cancelled" });
  });

  // --- Error handler ---

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    // Zod validation errors
    if (err?.name === "ZodError") {
      res.status(400).json({
        error: "Validation error",
        details: err.errors,
      });
      return;
    }

    logger.error({ err }, "Unhandled error");
    res.status(500).json({
      error: err?.message || "Internal server error",
    });
  });

  return app;
}
