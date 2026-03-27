# Self-Hosting Guide

How to run splitflap.org on your own server. Covers local development, production deployment with HTTPS, reverse proxy, and process management.

---

## Requirements

- **Node.js** 18+ (LTS recommended)
- **npm** (comes with Node.js)
- A server with a public IP (for remote access) or local network access (for LAN-only use)

## Local Development

```bash
# Clone
git clone https://github.com/MohdYahyaMahmodi/splitflap.org.git
cd splitflap.org

# Install dependencies
npm install

# Start
node server.js
```

Output:

```
  splitflap.org server on http://localhost:3000

  Board:     http://localhost:3000/board.html
  Companion: http://localhost:3000/companion.html
```

Open `board.html` on whatever screen you want to use as the display. Open `companion.html` on your phone. Both devices must be on the same network.

### Finding Your Local IP

Your phone needs to reach the server. Use your machine's local IP instead of `localhost`:

```bash
# macOS
ipconfig getifaddr en0

# Linux
hostname -I | awk '{print $1}'

# Windows
ipconfig | findstr "IPv4"
```

Then open `http://192.168.x.x:3000/board.html` on the TV and `http://192.168.x.x:3000/companion.html` on the phone.

### Optional: Audio File

Place a `click.wav` file in the `public/` directory for authentic mechanical flap sound. The file should be a short recording (under 100ms) of a split-flap click. If no file is present, the board falls back to a synthesized click generated via the Web Audio API.

## Production Deployment

### 1. Server Setup

SSH into your server and install Node.js:

```bash
# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verify
node --version  # v20.x.x
npm --version   # 10.x.x
```

Clone and install:

```bash
cd /opt
sudo git clone https://github.com/MohdYahyaMahmodi/splitflap.org.git
cd splitflap.org
sudo npm install --production
```

### 2. Environment Configuration

The server reads one environment variable:

| Variable | Default | Description         |
| -------- | ------- | ------------------- |
| `PORT`   | `3000`  | HTTP/WebSocket port |

For production behind a reverse proxy, keep the default port 3000. The proxy handles external traffic on 80/443.

### 3. Process Manager (systemd)

Create a systemd service so the server starts on boot and restarts on crash:

```bash
sudo nano /etc/systemd/system/splitflap.service
```

```ini
[Unit]
Description=splitflap.org server
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/splitflap.org
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
Environment=PORT=3000
Environment=NODE_ENV=production

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/splitflap.org

# Resource limits
LimitNOFILE=65536
MemoryMax=512M

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable splitflap
sudo systemctl start splitflap

# Check status
sudo systemctl status splitflap

# View logs
sudo journalctl -u splitflap -f
```

### 4. Reverse Proxy (Nginx)

Nginx handles HTTPS termination and proxies both HTTP and WebSocket traffic to the Node.js server.

Install Nginx:

```bash
sudo apt install nginx
```

Create the site config:

```bash
sudo nano /etc/nginx/sites-available/splitflap
```

```nginx
server {
    listen 80;
    server_name yourdomain.com;

    # Redirect HTTP to HTTPS
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

    # TLS hardening
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;

    # Proxy HTTP requests
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Proxy WebSocket connections
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket timeout (keep connections alive)
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

**Important**: The WebSocket `proxy_read_timeout` must be set high (86400s = 24 hours). The default 60s will kill idle WebSocket connections, causing constant reconnects.

Enable the site:

```bash
sudo ln -s /etc/nginx/sites-available/splitflap /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 5. HTTPS with Let's Encrypt

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com
```

Certbot modifies the Nginx config automatically. Certificates auto-renew via a systemd timer.

Verify:

```bash
sudo certbot renew --dry-run
```

### 6. Firewall

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

Port 3000 does not need to be exposed — Nginx proxies all traffic.

## Alternative: Docker

Create a `Dockerfile`:

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 3000
USER node
CMD ["node", "server.js"]
```

Build and run:

```bash
docker build -t splitflap .
docker run -d -p 3000:3000 --name splitflap --restart unless-stopped splitflap
```

With Docker Compose:

```yaml
version: "3.8"
services:
  splitflap:
    build: .
    ports:
      - "3000:3000"
    restart: unless-stopped
    environment:
      - NODE_ENV=production
```

```bash
docker compose up -d
```

## Alternative: Cloudflare Tunnel (No Port Forwarding)

If you're running on a home server and don't want to open ports:

```bash
# Install cloudflared
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared
chmod +x /usr/local/bin/cloudflared

# Login and create tunnel
cloudflared tunnel login
cloudflared tunnel create splitflap
cloudflared tunnel route dns splitflap yourdomain.com

# Run
cloudflared tunnel --url http://localhost:3000 run splitflap
```

Cloudflare Tunnels support WebSocket natively with no additional configuration.

## Alternative: Railway / Render / Fly.io

The project works on any platform that supports Node.js and WebSockets.

**Railway:**

```bash
# Install Railway CLI
npm install -g @railway/cli
railway login
railway init
railway up
```

**Render:**

1. Connect your GitHub repo
2. Set build command: `npm install`
3. Set start command: `node server.js`
4. Deploy

**Fly.io:**

```bash
fly launch
fly deploy
```

All three platforms support WebSockets out of the box.

## LAN-Only Setup (No Internet)

For use on a local network without internet access (e.g., office displays, events):

1. Run `node server.js` on any machine on the network
2. Open `http://LOCAL_IP:3000/board.html` on the display
3. Open `http://LOCAL_IP:3000/companion.html` on the phone (must be on same WiFi)

No DNS, no HTTPS, no external dependencies. The QR code on the board encodes the local URL, so scanning it on the phone opens the companion automatically.

**Note**: The QR code library (`qrcode-generator`) is loaded from a CDN in `board.html`. For fully offline operation, download the library and serve it locally:

```bash
curl -o public/qrcode.min.js https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js
```

Then update the `<script>` tag in `board.html` from the CDN URL to `qrcode.min.js`.

## Security Considerations

### What the server stores in memory

Board records are stored in a JavaScript `Map`. Nothing is written to disk. When the server restarts, all boards and connections are lost. Clients reconnect and re-register automatically.

Each board record contains:

- WebSocket references (not serializable, garbage collected on disconnect)
- 6-character board code (alphanumeric, no ambiguous characters I/O/0/1)
- 32-character hex secret (generated via `crypto.randomBytes`)
- Last settings/messages (for reconnect sync, capped at 10KB)
- Timestamps (creation, last activity)

### Rate limiting

| Layer                | Limit                       | Window      |
| -------------------- | --------------------------- | ----------- |
| HTTP API (`/api/*`)  | 100 requests                | 15 minutes  |
| WebSocket messages   | 120 messages per connection | 60 seconds  |
| Message payload      | 64KB max                    | Per message |
| Message text storage | 10,000 characters max       | Per board   |

### Security headers

The server uses `helmet` which sets:

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Strict-Transport-Security` (when behind HTTPS proxy)
- `X-XSS-Protection`
- CSP is disabled (required for inline scripts and CDN resources)

### Board cleanup

Boards inactive for 24 hours are automatically deleted. The cleanup runs every 5 minutes.

### WebSocket heartbeat

Server sends `ping` every 30 seconds. Connections that don't respond with `pong` are terminated. This prevents ghost connections from consuming resources.

## Monitoring

### Health check endpoint

```bash
curl http://localhost:3000/api/health
# {"ok":true,"boards":3}
```

Returns the number of active boards. Useful for uptime monitoring.

### Logs

The server logs to stdout:

```
Board created: ABC123
Companion paired: ABC123 (locked)
Board reconnected: ABC123
Board kicked, new code: XYZ789
```

Use `journalctl -u splitflap -f` with systemd or `docker logs -f splitflap` with Docker.

## Updating

```bash
cd /opt/splitflap.org
sudo git pull
sudo npm install --production
sudo systemctl restart splitflap
```

No database migrations. No config files to update. The server is stateless.

## Troubleshooting

**Board shows QR code but phone can't connect**  
Phone and TV must be on the same network. Corporate/guest WiFi networks often isolate clients. Try a personal hotspot or home WiFi.

**WebSocket connections drop every 60 seconds**  
Your reverse proxy has a low `proxy_read_timeout`. Set it to `86400s` in the Nginx config.

**QR code doesn't scan**  
The QR encodes a full URL including the secret. If the URL is very long, try increasing the QR error correction level in `board.html` (change `'M'` to `'L'` in the `qrcode()` call for more data capacity).

**No sound on the TV**  
Browsers require a user interaction before playing audio. Click anywhere on the board page to unlock the AudioContext. The companion join event also triggers this.

**Board flashes when changing columns/rows**  
This is the fade-out/fade-in transition (250ms). The board DOM must be fully rebuilt when the grid structure changes because the number of cells changes. The fade makes this smooth rather than an instant flash.

---

**[Back to README](README.md)**
