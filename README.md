# WebSpeak — TeamSpeak 网页语音客户端

浏览器即开即用的 TeamSpeak 客户端。无需安装任何软件，打开链接就能听和说。

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
2. 填入 TS 服务器 IP、昵称、频道名（可选）
3. 点击 "连接"
4. 默认自由麦模式，说话即传；可切换为按键说话（空格键）
5. 点击 "分享" 按钮复制带参数链接，发给朋友即可加入

### URL 参数

| 参数 | 说明 |
|------|------|
| `?token=xxx` | 连接密钥（必填） |
| `?ts=1.2.3.4` | 预填 TS 服务器 IP |
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

## 技术栈

- **服务端**: Node.js + Express + ws + @honeybbq/teamspeak-client + @discordjs/opus
- **前端**: Vue 3 + Vite + WebCodecs API（AudioEncoder/AudioDecoder）
- **音频**: 浏览器 PCM 采集 → 服务端 Opus 编码 → TeamSpeak

## License

MIT
