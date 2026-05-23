# WebSpeak — TeamSpeak Browser Gateway

Server-side browser gateway for TeamSpeak. Deploy on your server — users join voice channels from any browser, no TeamSpeak client needed.

> [:cn: 中文版本](#chinese-version)

**Features**
- Full Opus audio pipeline, low latency
- Voice-activated (VOX) + push-to-talk (Space key)
- Channel list with click-to-switch
- One-click share link
- Each user gets an independent TS3 virtual client identity

**Browser Requirements**
- Chrome 94+ or Edge 94+ (WebCodecs API)
- HTTPS (secure context required by WebCodecs)

---

## Architecture

```
Browser                       Node.js Server                     TeamSpeak Server
┌─────────────────┐          ┌──────────────────────────┐       ┌──────────┐
│ Mic → PCM       │──binary─▶│ /ws/voice                │       │          │
│ ScriptProcessor │          │  ├─ PCM→Opus encode      │◀════▶│ TS Server│
│                 │◀─Opus───│  │  └─ TS voice relay     │       │          │
│ AudioDecoder    │          │                          │       │          │
│ WebClient.vue   │◀─JSON───│ Channel/member list       │       │          │
└─────────────────┘          └──────────────────────────┘       └──────────┘
```

## Installation

### Prerequisites

- Node.js 22+
- TeamSpeak server (TS3 or TS6)
- (Optional) TS6 WebQuery API key — for channel list

### Linux

```bash
git clone https://github.com/EchoSixHIYA/WebClient4TeamSpeak.git
cd WebClient4TeamSpeak

# Install server dependencies
npm install

# Build frontend
cd web
npm install
npx vite build
cd ..

# Compile TypeScript
npx tsc

# Generate self-signed SSL certificate (required for WebCodecs)
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -keyout certs/key.pem -out certs/cert.pem -days 365 -nodes -subj "/CN=your-server-ip"
```

### Windows

```powershell
git clone https://github.com/EchoSixHIYA/WebClient4TeamSpeak.git
cd WebClient4TeamSpeak

# Install server dependencies
npm install

# Build frontend
cd web
npm install
npx vite build
cd ..

# Compile TypeScript
npx tsc

# Generate self-signed SSL certificate (requires OpenSSL)
# Download from https://slproweb.com/products/Win32OpenSSL.html if needed
mkdir certs
openssl req -x509 -newkey rsa:2048 -keyout certs\key.pem -out certs\cert.pem -days 365 -nodes -subj "/CN=localhost"
```

## Configuration

On first run, `config.json` is auto-generated. Edit it:

```json
{
  "port": 3040,
  "tsHost": "127.0.0.1",
  "tsPort": 9987,
  "tsQueryPort": 10080,
  "tsServerPassword": "",
  "tsServerProtocol": "ts6",
  "tsApiKey": "",
  "voiceToken": "your-secret-token-here",
  "maxClients": 10,
  "trustProxy": false
}
```

### Options

| Field | Description | Default |
|-------|-------------|---------|
| `port` | WebSpeak HTTP server port | `3040` |
| `tsHost` | TeamSpeak server address | `127.0.0.1` |
| `tsPort` | TeamSpeak voice port (UDP) | `9987` |
| `tsQueryPort` | WebQuery HTTP port (TS3: 10011, TS6: 10080) | `10080` |
| `tsServerPassword` | TS server password (empty if none) | `""` |
| `tsServerProtocol` | Force `"ts3"` or `"ts6"`, blank for auto-detect | — |
| `tsApiKey` | TS6 WebQuery API key. **Channel list won't work without it** | `""` |
| `voiceToken` | Auth token for web clients (carried in share link) | — |
| `maxClients` | Max concurrent web users | `10` |
| `trustProxy` | Enable when behind nginx/Caddy | `false` |

### Getting a TS6 WebQuery API Key

Required for the channel list feature:

1. SSH to TeamSpeak ServerQuery (port 10022)
2. Login as `serveradmin`
3. Run `apikeyadd scope=manage lifetime=0`
4. Copy the returned key into `tsApiKey`

Voice chat works fine without it — only the channel list will be empty.

## Running

### Development

```bash
# Server (auto-reload)
npx tsx src/index.ts

# Frontend dev server (separate terminal)
cd web
npx vite --host
```

### Production

```bash
node dist/index.js
```

#### systemd (recommended)

```bash
sudo tee /etc/systemd/system/webspeak.service << 'EOF'
[Unit]
Description=WebSpeak - TeamSpeak Web Client
After=network.target

[Service]
Type=simple
User=teamspeak
WorkingDirectory=/home/teamspeak/webspeak-webclient
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now webspeak
```

## Usage

1. Open `https://your-server:3040/?token=your-voice-token`
2. Enter a nickname and optional channel name
3. Click "连接"
4. Default VOX mode (speak to transmit); switch to push-to-talk (hold Space)
5. Click "分享" to copy a share link

> TS server address, port, and auth token are all configured server-side in `config.json`.

### URL Parameters

| Param | Description |
|-------|-------------|
| `?token=xxx` | Auth token (required) |
| `?channel=Lobby` | Pre-fill channel name |

## Reverse Proxy (HTTPS)

Instead of self-signed certs, use nginx:

```nginx
server {
    listen 443 ssl;
    server_name ts.example.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:3040;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

Set `"trustProxy": true` in `config.json`.

## Tech Stack

- **Server**: Node.js + Express + ws + @honeybbq/teamspeak-client + @discordjs/opus
- **Frontend**: Vue 3 + Vite + WebCodecs API (AudioEncoder/AudioDecoder)
- **Audio**: Browser PCM capture → server-side Opus encode → TeamSpeak

## Star This Project

If this project helps you, a **star** greatly increases its visibility and helps more people discover it. Just click ⭐ at the top right — it costs nothing but means a lot.

## Donate / 打赏

If you'd like to support the development, feel free to scan the WeChat QR code below. Any amount is appreciated!

<img src="donate.png" width="260" alt="WeChat Pay QR Code">

> Maintainer: [EchoSixHIYA](https://github.com/EchoSixHIYA)

## License

MIT

---

<h1 id="chinese-version">WebSpeak — TeamSpeak 浏览器网关（中文）</h1>

> [:us: English Version](#webspeak--teamspeak-browser-gateway)

部署在服务器上的 TeamSpeak 浏览器网关。用户无需安装 TS 客户端，浏览器即加入语音频道。

**特性**
- 全链路 Opus 音频，低延迟
- 自由麦（VOX 语音检测）+ 按键说话（空格键）
- 频道列表 + 点击切换频道
- 一键分享链接，对方打开即用
- 每个用户独立 TS3 虚拟客户端身份

**浏览器要求**
- Chrome 94+ 或 Edge 94+（需要 WebCodecs API）
- HTTPS 连接（WebCodecs 安全上下文要求）

## 架构

```
浏览器                          Node.js 服务端                       TeamSpeak 服务器
┌─────────────────┐            ┌──────────────────────────┐         ┌──────────┐
│ 麦克风 → PCM    │──PCM二进制▶│ /ws/voice                │         │          │
│ ScriptProcessor │            │  ├─ PCM→Opus编码         │◀══════▶│ TS Server│
│                 │◀─Opus帧───│  │  └─ 透传TS语音         │         │          │
│ AudioDecoder    │            │                          │         │          │
│ WebClient.vue   │◀─JSON─────│ 成员/频道列表             │         │          │
└─────────────────┘            └──────────────────────────┘         └──────────┘
```

## 安装

### 前提条件

- Node.js 22+
- TeamSpeak 服务器（TS3 或 TS6）
- （可选）TS6 WebQuery API Key —— 用于获取频道列表

### Linux

```bash
git clone https://github.com/EchoSixHIYA/WebClient4TeamSpeak.git
cd WebClient4TeamSpeak

# 安装服务端依赖
npm install

# 安装并构建前端
cd web
npm install
npx vite build
cd ..

# 编译 TypeScript
npx tsc

# 生成自签名 SSL 证书（WebCodecs 需要 HTTPS）
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -keyout certs/key.pem -out certs/cert.pem -days 365 -nodes -subj "/CN=你的服务器IP"
```

### Windows

```powershell
git clone https://github.com/EchoSixHIYA/WebClient4TeamSpeak.git
cd WebClient4TeamSpeak

# 安装服务端依赖
npm install

# 安装并构建前端
cd web
npm install
npx vite build
cd ..

# 编译 TypeScript
npx tsc

# 生成自签名 SSL 证书（需要 OpenSSL）
# 如果没有 OpenSSL，可以从 https://slproweb.com/products/Win32OpenSSL.html 安装
mkdir certs
openssl req -x509 -newkey rsa:2048 -keyout certs\key.pem -out certs\cert.pem -days 365 -nodes -subj "/CN=localhost"
```

## 配置

首次运行时自动生成 `config.json`，编辑它进行配置：

```json
{
  "port": 3040,
  "tsHost": "127.0.0.1",
  "tsPort": 9987,
  "tsQueryPort": 10080,
  "tsServerPassword": "",
  "tsServerProtocol": "ts6",
  "tsApiKey": "",
  "voiceToken": "your-secret-token-here",
  "maxClients": 10,
  "trustProxy": false
}
```

### 配置项说明

| 字段 | 说明 | 默认值 |
|------|------|--------|
| `port` | WebSpeak 服务端口 | `3040` |
| `tsHost` | TeamSpeak 服务器地址 | `127.0.0.1` |
| `tsPort` | TeamSpeak 语音端口（UDP） | `9987` |
| `tsQueryPort` | WebQuery HTTP 端口（TS3: 10011, TS6: 10080） | `10080` |
| `tsServerPassword` | TS 服务器密码（无密码则留空） | `""` |
| `tsServerProtocol` | 强制协议类型 `"ts3"` / `"ts6"`，留空自动检测 | — |
| `tsApiKey` | TS6 WebQuery API Key。**不填则无法显示频道列表** | `""` |
| `voiceToken` | 网页客户端连接密钥（分享链接中携带） | — |
| `maxClients` | 最大并发网页用户数 | `10` |
| `trustProxy` | 反向代理模式（nginx/Caddy 后启用） | `false` |

### 获取 TS6 WebQuery API Key

频道列表功能需要 TS6 的 WebQuery API Key。获取方式：

1. SSH 连接到 TeamSpeak ServerQuery（端口 10022）
2. 使用 `serveradmin` 登录
3. 执行 `apikeyadd scope=manage lifetime=0`
4. 将返回的 key 填入 `tsApiKey`

如果不填 `tsApiKey`，频道列表将为空，但不影响语音通话。

## 启动

### 开发模式

```bash
# 服务端（自动重启）
npx tsx src/index.ts

# 前端开发服务器（另开终端）
cd web
npx vite --host
```

### 生产模式

```bash
# 直接启动
node dist/index.js

# systemd 服务（推荐）
sudo tee /etc/systemd/system/webspeak.service << 'EOF'
[Unit]
Description=WebSpeak - TeamSpeak Web Client
After=network.target

[Service]
Type=simple
User=teamspeak
WorkingDirectory=/home/teamspeak/webspeak-webclient
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now webspeak
```

## 使用

1. 浏览器打开 `https://你的服务器IP:3040/?token=你的voiceToken`
2. 输入昵称和频道名（可选）
3. 点击 "连接"
4. 默认自由麦模式，说话即传；可切换为按键说话（空格键）
5. 点击 "分享" 按钮复制带参数链接，发给朋友即可加入

> TS 服务器地址、端口、连接密钥均由服务端 `config.json` 配置，用户无需填写。

### URL 参数

| 参数 | 说明 |
|------|------|
| `?token=xxx` | 连接密钥（必填） |
| `?channel=大厅` | 预填频道名 |

## 反向代理（HTTPS）

如果不用自签名证书，可通过 nginx 反代：

```nginx
server {
    listen 443 ssl;
    server_name ts.example.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:3040;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

并在 `config.json` 中设置 `"trustProxy": true`。

## 求个 Star

如果这个项目对你有帮助，请点击右上角的 ⭐ Star，让更多人看到它。不花钱，但是对我们意义重大。

## 打赏

如果你想支持开发，扫描下方微信收款码即可，金额随意！

<img src="donate.png" width="260" alt="微信收款码">

> 维护者: [EchoSixHIYA](https://github.com/EchoSixHIYA)

## 技术栈

- **服务端**: Node.js + Express + ws + @honeybbq/teamspeak-client + @discordjs/opus
- **前端**: Vue 3 + Vite + WebCodecs API（AudioEncoder/AudioDecoder）
- **音频**: 浏览器 PCM 采集 → 服务端 Opus 编码 → TeamSpeak

## License

MIT
