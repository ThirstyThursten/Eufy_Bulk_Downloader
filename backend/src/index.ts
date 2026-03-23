import * as dotenv from "dotenv";
import * as path from "path";
import pino from "pino";
import { EufyService } from "./eufyClient";
import { JobManager } from "./downloader";
import { createApp } from "./server";

// Load .env file from the backend directory
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const logger = pino({
  name: "main",
  transport: {
    target: "pino-pretty",
    options: { colorize: true },
  },
});

async function main(): Promise<void> {
  const port = parseInt(process.env.PORT || "3001", 10);
  const downloadDir = path.resolve(
    process.env.DOWNLOAD_DIR || path.join(__dirname, "..", "downloads")
  );

  logger.info({ downloadDir }, "Download directory");

  // Initialize the Eufy client
  const eufyService = new EufyService();
  logger.info("Initializing Eufy Security client...");
  await eufyService.initialize();

  if (eufyService.status === "connected") {
    logger.info("Eufy Security client is connected and ready");
  } else {
    logger.warn(
      { status: eufyService.status },
      "Eufy client initialized but not fully connected - check /api/status for 2FA/captcha"
    );
  }

  // Create the job manager
  const jobManager = new JobManager(eufyService, downloadDir);

  // Create and start the Express server
  const app = createApp(eufyService, jobManager);

  app.listen(port, () => {
    logger.info(`Server listening on http://localhost:${port}`);
    logger.info(`API available at http://localhost:${port}/api/status`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down...");
    await eufyService.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  logger.error({ err }, "Fatal error during startup");
  process.exit(1);
});
