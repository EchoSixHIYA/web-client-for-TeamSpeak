import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createWebServer } from "./server/server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(ROOT_DIR, "config.json");
const DATA_DIR = path.join(ROOT_DIR, "data");
const LOG_DIR = path.join(DATA_DIR, "logs");
const STATIC_DIR = path.join(ROOT_DIR, "web", "dist");

async function main() {
  const config = loadConfig(CONFIG_PATH);
  saveConfig(CONFIG_PATH, config);

  const logger = createLogger(LOG_DIR);

  logger.info({ config: { ...config, voiceToken: "***" } }, "Starting WebSpeak server");

  const webServer = createWebServer({
    port: config.port,
    trustProxy: config.trustProxy,
    staticDir: STATIC_DIR,
    voiceBridgeOptions: {
      tsHost: config.tsHost,
      tsPort: config.tsPort,
      tsQueryPort: config.tsQueryPort,
      tsServerPassword: config.tsServerPassword,
      tsServerProtocol: config.tsServerProtocol,
      voiceToken: config.voiceToken,
      maxClients: config.maxClients,
    },
    logger,
  });

  await webServer.start();

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down");
    await webServer.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
