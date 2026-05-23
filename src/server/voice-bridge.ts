import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Server } from "node:http";
import { createRequire } from "node:module";
import { TSClient, type TSVoiceData } from "./ts-client.js";
import type { Logger } from "../logger.js";

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
}

export class VoiceBridge {
  private clients = new Map<string, WebClientEntry>();
  private wss: WebSocketServer | null = null;
  private logger: Logger;

  constructor(
    private options: VoiceBridgeOptions,
    logger: Logger,
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
          ws.on("message", (data: Buffer) => {
            // JSON commands start with '{'
            if (data.length > 0 && data[0] === 0x7b) {
              try { handleCommand(entry, JSON.parse(data.toString("utf-8"))); } catch { /* */ }
              return;
            }
            // PCM binary
            entry.pcmAccumulator = Buffer.concat([entry.pcmAccumulator, data]);
            while (entry.pcmAccumulator.length >= 1920) {
              const pcm = entry.pcmAccumulator.subarray(0, 1920);
              entry.pcmAccumulator = entry.pcmAccumulator.subarray(1920);
              try {
                const opus = entry.opusEncoder.encode(pcm);
                tsClient.sendVoice(opus, 4);
              } catch { /* */ }
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

async function handleCommand(entry: WebClientEntry, cmd: { type: string; [k: string]: unknown }) {
  switch (cmd.type) {
    case "listChannels": {
      try {
        const channels = await entry.tsClient.listChannels();
        if (entry.ws.readyState === WebSocket.OPEN) {
          entry.ws.send(JSON.stringify({ type: "channelList", channels }));
        }
      } catch {
        if (entry.ws.readyState === WebSocket.OPEN) {
          entry.ws.send(JSON.stringify({ type: "channelList", channels: [] }));
        }
      }
      break;
    }
    case "switchChannel": {
      try {
        await entry.tsClient.switchChannel(BigInt(cmd.channelId as string));
        if (entry.ws.readyState === WebSocket.OPEN) {
          entry.ws.send(JSON.stringify({ type: "channelSwitched", channelId: cmd.channelId }));
        }
      } catch (e: any) {
        if (entry.ws.readyState === WebSocket.OPEN) {
          entry.ws.send(JSON.stringify({ type: "error", message: "切换失败: " + e.message }));
        }
      }
      break;
    }
  }
}
