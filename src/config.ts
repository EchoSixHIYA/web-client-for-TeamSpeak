import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface AppConfig {
  /** HTTP server port */
  port: number;
  /** TeamSpeak server host */
  tsHost: string;
  /** TeamSpeak voice/UDP port */
  tsPort: number;
  /** TeamSpeak query port (10011 for TS3, 10080 for TS6) */
  tsQueryPort: number;
  /** TS server password (empty if none) */
  tsServerPassword: string;
  /** Force protocol: "ts3" | "ts6" | undefined for auto-detect */
  tsServerProtocol?: "ts3" | "ts6";
  /** Pre-shared token for /ws/voice authentication */
  voiceToken: string;
  /** Max concurrent web clients */
  maxClients: number;
  /** Trust X-Forwarded-* headers (for reverse proxy) */
  trustProxy: boolean;
}

export function getDefaultConfig(): AppConfig {
  return {
    port: 3030,
    tsHost: "127.0.0.1",
    tsPort: 9987,
    tsQueryPort: 10011,
    tsServerPassword: "",
    tsServerProtocol: undefined,
    voiceToken: "change-me",
    maxClients: 20,
    trustProxy: false,
  };
}

export function loadConfig(path: string): AppConfig {
  const defaults = getDefaultConfig();
  try {
    const raw = readFileSync(path, "utf-8");
    return { ...defaults, ...JSON.parse(raw) };
  } catch {
    return defaults;
  }
}

export function saveConfig(path: string, config: AppConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
}
