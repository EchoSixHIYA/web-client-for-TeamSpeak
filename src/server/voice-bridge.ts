import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Server } from "node:http";
import { TSClient, type TSVoiceData } from "./ts-client.js";
import type { Logger } from "../logger.js";

export interface VoiceBridgeOptions {
  tsHost: string;
  tsPort: number;
  tsQueryPort: number;
  tsServerPassword: string;
  tsServerProtocol?: "ts3" | "ts6";
  voiceToken: string;
  maxClients: number;
}

interface WebClientEntry {
  id: string;
  tsClient: TSClient;
  ws: WebSocket;
  nickname: string;
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
      // Parse auth params
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const token = url.searchParams.get("token");
      const channelName = url.searchParams.get("channel") ?? undefined;
      const nickname = url.searchParams.get("nickname") ?? "WebUser";

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
        host: this.options.tsHost,
        port: this.options.tsPort,
        nickname: nickname,
        serverPassword: this.options.tsServerPassword,
        serverProtocol: this.options.tsServerProtocol,
        defaultChannel: channelName,
      }, this.logger);

      const entry: WebClientEntry = {
        id: entryId,
        tsClient,
        ws,
        nickname,
      };

      tsClient.connect()
        .then(() => {
          this.clients.set(entryId, entry);

          // Tell browser we're connected
          ws.send(JSON.stringify({
            type: "connected",
            tsClientId: tsClient.getClientId(),
          }));

          // TS → Browser: forward voice data
          tsClient.on("voiceData", (data: TSVoiceData) => {
            if (ws.readyState === WebSocket.OPEN) {
              // Binary frame: [1B codec][2B clientId BE][Opus data]
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

          // TS → Browser: client enter/leave notifications
          tsClient.on("clientEnter", (info) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: "clientEnter",
                id: info.id,
                nickname: info.nickname,
              }));
            }
          });

          tsClient.on("clientLeave", (info) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: "clientLeave",
                id: info.id,
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

          // Browser → TS: incoming voice
          ws.on("message", (data: Buffer) => {
            // Browser sends raw Opus frames (codec 4 = voice)
            tsClient.sendVoice(data, 4);
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
