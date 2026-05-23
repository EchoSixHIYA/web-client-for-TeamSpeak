import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VoiceBridge, type VoiceBridgeOptions } from "./voice-bridge.js";
import type { Logger } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface WebServerOptions {
  port: number;
  trustProxy: boolean;
  staticDir?: string;
  voiceBridgeOptions: VoiceBridgeOptions;
  logger: Logger;
}

export interface WebServer {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createWebServer(options: WebServerOptions): WebServer {
  const app = express();
  const server = createServer(app);
  const logger = options.logger.child({ component: "web" });

  if (options.trustProxy) {
    app.set("trust proxy", true);
  }

  app.use(express.json({ limit: "100kb" }));

  // Health check
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", version: "0.1.0" });
  });

  // Serve static frontend
  if (options.staticDir) {
    app.use(express.static(options.staticDir));
    app.get(/^(?!\/api|\/ws)/, (_req, res) => {
      res.sendFile(path.join(options.staticDir!, "index.html"));
    });
  }

  // Voice bridge WebSocket at /ws/voice
  const voiceBridge = new VoiceBridge(options.voiceBridgeOptions, logger);
  voiceBridge.attach(server);

  return {
    start(): Promise<void> {
      return new Promise((resolve) => {
        server.listen(options.port, () => {
          logger.info({ port: options.port }, "Web server started");
          resolve();
        });
      });
    },
    async stop(): Promise<void> {
      voiceBridge.shutdown();
      return new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
