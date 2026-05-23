import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Server } from "node:http";
import { get } from "node:http";
import { createRequire } from "node:module";
import { TSClient, type TSVoiceData } from "./ts-client.js";
import type { Logger as LoggerType } from "../logger.js";

const require = createRequire(import.meta.url);
const { OpusEncoder } = require("@discordjs/opus") as {
  OpusEncoder: new (sr: number, ch: number) => { encode(pcm: Buffer): Buffer };
};

export interface VoiceBridgeOptions {
  tsHost: string;
  tsPort: number;
  tsQueryPort: number;
  tsServerPassword: string;
  tsServerProtocol?: "ts3" | "ts6";
  tsApiKey: string;
  voiceToken: string;
  maxClients: number;
}

interface ChannelMember {
  id: number;
  nickname: string;
}

interface WebClientEntry {
  id: string;
  tsClient: TSClient;
  ws: WebSocket;
  nickname: string;
  members: Map<number, ChannelMember>;
  opusEncoder: { encode(pcm: Buffer): Buffer };
  pcmAccumulator: Buffer;
  logger: LoggerType;
}

export class VoiceBridge {
  private clients = new Map<string, WebClientEntry>();
  private wss: WebSocketServer | null = null;
  private logger: LoggerType;

  constructor(
    private options: VoiceBridgeOptions,
    logger: LoggerType,
  ) {
    this.logger = logger.child({ component: "voice-bridge" });
  }

  attach(server: Server): void {
    this.wss = new WebSocketServer({ server, path: "/ws/voice" });

    this.wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
      const url = new URL(req.url ?? "/", `https://${req.headers.host ?? "localhost"}`);
      const token = url.searchParams.get("token");
      const channelName = url.searchParams.get("channel") ?? undefined;
      const nickname = url.searchParams.get("nickname") ?? "WebUser";
      const tsHost = url.searchParams.get("tsHost") ?? this.options.tsHost;
      const tsPort = parseInt(url.searchParams.get("tsPort") ?? String(this.options.tsPort), 10);

      if (token !== this.options.voiceToken) {
        this.logger.warn({ nickname }, "Invalid voice token");
        ws.close(4001, "Invalid token");
        return;
      }

      if (this.clients.size >= this.options.maxClients) {
        this.logger.warn({ max: this.options.maxClients }, "Max clients reached");
        ws.close(4004, "Server full");
        return;
      }

      const entryId = `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      this.logger.info({ entryId, nickname, channel: channelName }, "WebClient connecting");

      const tsClient = new TSClient({
        host: tsHost,
        port: tsPort,
        nickname,
        serverPassword: this.options.tsServerPassword,
        serverProtocol: this.options.tsServerProtocol,
        defaultChannel: channelName,
      }, this.logger);

      const entry: WebClientEntry = {
        id: entryId,
        tsClient,
        ws,
        nickname,
        members: new Map(),
        opusEncoder: new OpusEncoder(48000, 1),
        pcmAccumulator: Buffer.alloc(0),
        logger: this.logger,
      };

      tsClient.connect()
        .then(() => {
          this.clients.set(entryId, entry);

          // Track channel members
          const selfId = tsClient.getClientId();

          tsClient.on("clientEnter", (info) => {
            entry.members.set(info.id, { id: info.id, nickname: info.nickname });
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: "memberEnter",
                id: info.id,
                nickname: info.nickname,
                isSelf: info.id === selfId,
              }));
            }
          });

          tsClient.on("clientLeave", (info) => {
            entry.members.delete(info.id);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "memberLeave", id: info.id }));
            }
          });

          // Delay then send full member list (clientEnter events arrive during connect)
          setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: "connected",
                tsClientId: selfId,
                members: Array.from(entry.members.values()),
              }));
            }
          }, 500);

          // TS → Browser: forward voice data
          tsClient.on("voiceData", (data: TSVoiceData) => {
            if (ws.readyState === WebSocket.OPEN && data.clientId !== selfId) {
              const header = Buffer.alloc(3);
              header.writeUInt8(data.codec, 0);
              header.writeUInt16BE(data.clientId, 1);
              const packet = Buffer.concat([header, data.data]);
              ws.send(packet);
            }
          });

          // TS → Browser: forward text messages
          tsClient.on("textMessage", (msg) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: "chatMessage",
                invokerName: msg.invokerName,
                invokerId: msg.invokerId,
                message: msg.message,
              }));
            }
          });

          // TS disconnect → cleanup
          tsClient.on("disconnected", () => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "disconnected" }));
            }
            this.cleanup(entryId);
          });

          // Browser → TS: PCM → Opus encoding
          ws.on("message", (data: Buffer | string) => {
            // Try to parse as JSON first (either text frame or binary starting with '{')
            if (typeof data === "string" || (data.length > 0 && data[0] === 0x7b)) {
              try {
                const cmd = JSON.parse(typeof data === "string" ? data : data.toString("utf-8"));
                if (cmd && cmd.type) {
                  this.logger.info({ entryId, cmd: cmd.type }, "WS command");
                  handleCommand(entry, this.options, cmd).catch((e) => {
                    this.logger.error({ err: e.message || String(e) }, "Command failed");
                  });
                  return;
                }
              } catch { /* not JSON, fall through to PCM */ }
            }
            // Binary frames = PCM audio
            if (Buffer.isBuffer(data)) {
              entry.pcmAccumulator = Buffer.concat([entry.pcmAccumulator, data]);
              while (entry.pcmAccumulator.length >= 1920) {
                const pcm = entry.pcmAccumulator.subarray(0, 1920);
                entry.pcmAccumulator = entry.pcmAccumulator.subarray(1920);
                try { tsClient.sendVoice(entry.opusEncoder.encode(pcm), 4); } catch { /* */ }
              }
            }
          });

          // WebSocket close → cleanup
          ws.on("close", () => {
            this.logger.info({ entryId }, "WebSocket closed");
            this.cleanup(entryId);
          });

          ws.on("error", (err) => {
            this.logger.error({ err, entryId }, "WebSocket error");
            this.cleanup(entryId);
          });
        })
        .catch((err: Error) => {
          this.logger.error({ err, entryId }, "TS connect failed");
          ws.close(4003, `Connection failed: ${err.message}`);
        });
    });

    this.logger.info("Voice WebSocket endpoint ready at /ws/voice");
  }

  private cleanup(entryId: string): void {
    const entry = this.clients.get(entryId);
    if (!entry) return;
    entry.tsClient.disconnect().catch(() => {});
    this.clients.delete(entryId);
    this.logger.info({ entryId }, "Client cleaned up");
  }

  getActiveCount(): number {
    return this.clients.size;
  }

  shutdown(): void {
    for (const [id, entry] of this.clients) {
      entry.tsClient.disconnect().catch(() => {});
      this.clients.delete(id);
    }
    this.wss?.close();
  }
}

async function handleCommand(entry: WebClientEntry, opts: VoiceBridgeOptions, cmd: { type: string; [k: string]: unknown }) {
  switch (cmd.type) {
    case "listChannels": {
      const result = await fetchChannelTree(opts);
      if (entry.ws.readyState === WebSocket.OPEN) {
        entry.ws.send(JSON.stringify({ type: "channelList", channels: result }));
      }
      break;
    }
    case "switchChannel": {
      try {
        await entry.tsClient.switchChannel(BigInt(cmd.channelId as string));
      } catch (e: any) {
        // "already member" is harmless (double-click) — not an error
        if (!e.message?.includes("already member")) {
          if (entry.ws.readyState === WebSocket.OPEN) {
            entry.ws.send(JSON.stringify({ type: "error", message: "切换失败: " + e.message }));
          }
          break;
        }
      }
      // Refresh channel list on success (or "already member")
      const tree = await fetchChannelTree(opts);
      if (entry.ws.readyState === WebSocket.OPEN) {
        entry.ws.send(JSON.stringify({ type: "channelList", channels: tree }));
      }
      break;
    }
  }
}

function httpGetJSON(url: string, apiKey: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: { "x-api-key": apiKey },
      timeout: 5000,
    };
    get(options, (res) => {
      let data = "";
      res.on("data", (chunk: string) => { data += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on("error", reject).on("timeout", function(this: any) { this.destroy(); reject(new Error("timeout")); });
  });
}

async function fetchChannelTree(opts: VoiceBridgeOptions): Promise<unknown[]> {
  if (!opts.tsApiKey) return [];
  try {
    const base = `http://${opts.tsHost}:${opts.tsQueryPort}`;
    const [chJson, clJson] = await Promise.all([
      httpGetJSON(`${base}/1/channellist?-topic&-flags&-voice&-limits&-icon`, opts.tsApiKey),
      httpGetJSON(`${base}/1/clientlist?-uid&-away&-voice&-times&-groups&-info`, opts.tsApiKey),
    ]);
    const channels: any[] = chJson.body || [];
    const clients: any[] = clJson.body || [];
    return channels.map((ch: any) => ({
      id: String(ch.cid),
      parentID: String(ch.pid || 0),
      name: ch.channel_name || "?",
      members: clients
        .filter((c: any) => String(c.cid) === String(ch.cid))
        .map((c: any) => ({ id: c.clid, nickname: c.client_nickname || "?" })),
    }));
  } catch {
    return [];
  }
}
