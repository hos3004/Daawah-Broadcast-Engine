# Deployment Guide — Ubuntu 22.04 / 24.04

## Prerequisites

| Package | Version |
|---------|---------|
| Node.js | >= 20 LTS |
| FFmpeg  | >= 6.0 |
| Nginx   | >= 1.18 |
| OS      | Ubuntu 22.04 / 24.04 LTS |

---

## Step 1 — Prepare the Server

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Verify
node -v  # should print v20.x.x

# FFmpeg
sudo apt install -y ffmpeg
ffmpeg -version  # should print version ≥ 6.0

# Nginx
sudo apt install -y nginx

# Create app user
sudo useradd -m -s /bin/bash daawah
sudo usermod -aG www-data daawah
```

---

## Step 2 — Directory Layout

```bash
sudo mkdir -p /opt/daawah-broadcast
sudo mkdir -p /srv/daawah/media/{source,bumpers,normalized-ar,emergency,original-ar}
sudo mkdir -p /var/www/html/hls
sudo mkdir -p /var/log/daawah-broadcast
sudo mkdir -p /etc/daawah-broadcast
sudo mkdir -p /opt/daawah-broadcast/data
sudo mkdir -p /opt/daawah-broadcast/assets/{fonts,overlays/{logo,tickers,now-playing},logo-source}

# Permissions
sudo chown -R daawah:daawah /opt/daawah-broadcast
sudo chown -R daawah:daawah /srv/daawah
sudo chown -R daawah:www-data /var/www/html/hls
sudo chmod 2775 /var/www/html/hls
sudo chown -R daawah:daawah /var/log/daawah-broadcast
sudo chown root:daawah /etc/daawah-broadcast
sudo chmod 750 /etc/daawah-broadcast
```

---

## Step 3 — Arabic Font

The overlay generator requires a font that supports Arabic script.

```bash
# Option A: Download Noto Sans Arabic
sudo -u daawah wget -O /opt/daawah-broadcast/assets/fonts/NotoSansArabic-Regular.ttf \
  "https://github.com/notofonts/arabic/raw/main/fonts/NotoSansArabic/unhinted/ttf/NotoSansArabic-Regular.ttf"

# Option B: Install via apt (Ubuntu 22.04+)
sudo apt install -y fonts-noto-core fonts-noto-extra
# Then set OVERLAY_FONT_PATH=/usr/share/fonts/truetype/noto/NotoSansArabic-Regular.ttf
```

---

## Step 4 — Clone and Build

```bash
sudo -u daawah git clone https://github.com/hos3004/Daawah-Broadcast-Engine.git /opt/daawah-broadcast
cd /opt/daawah-broadcast

sudo -u daawah npm install
sudo -u daawah npm run build
```

---

## Step 5 — Environment Configuration

```bash
sudo cp /opt/daawah-broadcast/.env.example /etc/daawah-broadcast/.env
sudo nano /etc/daawah-broadcast/.env
```

**Minimum required changes in `.env`:**

```env
NODE_ENV=production
PORT=3001
HOST=127.0.0.1
JWT_SECRET=<generate: openssl rand -hex 64>
COOKIE_SECRET=<generate: openssl rand -hex 32>
COOKIE_SECURE=true
ADMIN_EMAIL=admin@your-domain.com
ADMIN_PASSWORD=<strong password>
CORS_ORIGIN=https://admin.your-domain.com
DB_PATH=/opt/daawah-broadcast/data/daawah.db
MEDIA_LIBRARY_PATH=/srv/daawah/media/source
MEDIA_EMERGENCY_PATH=/srv/daawah/media/emergency
MEDIA_BROWSER_BASE_PATH=/srv/daawah/media
MEDIA_BROWSER_ALLOWED_ROOTS=original-ar,source,bumpers,normalized-ar,emergency
NORMALIZED_MEDIA_PATH=/srv/daawah/media/normalized-ar
HLS_OUTPUT_PATH=/var/www/html/hls
LOG_PATH=/var/log/daawah-broadcast
OVERLAY_FONT_PATH=/opt/daawah-broadcast/assets/fonts/NotoSansArabic-Regular.ttf
```

```bash
sudo chown daawah:daawah /etc/daawah-broadcast/.env
sudo chmod 600 /etc/daawah-broadcast/.env
```

---

## Step 6 — Systemd Service

```bash
sudo cp /opt/daawah-broadcast/deploy/systemd/daawah-control-backend.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable daawah-control-backend
sudo systemctl start daawah-control-backend

# Check status
sudo systemctl status daawah-control-backend
sudo journalctl -u daawah-control-backend -f
```

---

## Step 7 — Nginx Configuration

```bash
# Remove default site
sudo rm -f /etc/nginx/sites-enabled/default

# HLS stream (public)
sudo cp /opt/daawah-broadcast/deploy/nginx/hls.conf /etc/nginx/sites-available/daawah-hls
sudo sed -i 's/stream.your-domain.com/stream.YOURDOMAIN.com/g' /etc/nginx/sites-available/daawah-hls
sudo ln -s /etc/nginx/sites-available/daawah-hls /etc/nginx/sites-enabled/

# Admin dashboard (protected)
sudo cp /opt/daawah-broadcast/deploy/nginx/admin.conf /etc/nginx/sites-available/daawah-admin
sudo sed -i 's/admin.your-domain.com/admin.YOURDOMAIN.com/g' /etc/nginx/sites-available/daawah-admin
sudo ln -s /etc/nginx/sites-available/daawah-admin /etc/nginx/sites-enabled/

# Test config
sudo nginx -t

# Reload
sudo systemctl reload nginx
```

---

## Step 8 — SSL (Let's Encrypt)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx \
  -d stream.YOURDOMAIN.com \
  -d admin.YOURDOMAIN.com \
  --email admin@YOURDOMAIN.com \
  --agree-tos \
  --non-interactive

# Auto-renewal
sudo systemctl enable --now certbot.timer
```

---

## Step 9 — Place Emergency Media

**This step is mandatory before starting the broadcast.**

```bash
# Copy emergency content (Quran, Islamic fillers, etc.)
sudo -u daawah cp /path/to/emergency/*.mp4 /media/emergency/

# Verify
ls -la /media/emergency/
```

---

## Step 10 — First Launch

1. Open `https://admin.YOURDOMAIN.com` in a browser
2. Log in with the admin email/password from `.env`
3. Go to **Media Library** → click **فحص المكتبة** (Scan)
4. Wait for scan to complete
5. Go to **الجدول** (Schedule) → import a JSON/CSV schedule
6. Validate and publish the schedule
7. Go to **التحكم بالبث** → click **بناء القائمة** for today
8. Go to **الطبقات** (Overlays) → generate today's ticker
9. Go to **التحكم بالبث** → click **تشغيل**
10. HLS stream available at: `https://stream.YOURDOMAIN.com/hls/stream.m3u8`

---

## Updates

```bash
cd /opt/daawah-broadcast
sudo -u daawah git pull origin master
sudo -u daawah npm install
sudo -u daawah npm run build
sudo systemctl restart daawah-control-backend
```

---

## Logs

```bash
# App logs
sudo journalctl -u daawah-control-backend -f --since "1 hour ago"

# FFmpeg logs
sudo -u daawah tail -f /var/log/daawah-broadcast/ffmpeg-$(date +%Y-%m-%d).log

# Access logs from API dashboard: /admin → السجلات
```

---

## Ports

| Port | Service | Access |
|------|---------|--------|
| 3001 | Node.js API | localhost only (127.0.0.1) |
| 80 / 443 | Nginx | Public |
| 1935 | RTMP (optional) | Public (if enabled) |

**The Node.js API must never be directly accessible from the internet.**
