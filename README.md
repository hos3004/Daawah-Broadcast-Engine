# Daawah Broadcast Engine

نظام بث تلفزيوني 24/7 يعمل بالكامل على Cloud VPS — بدون OBS وبدون الاعتماد على كمبيوتر محلي.

---

## الميزات الرئيسية

- **بث مستمر 24/7** عبر FFmpeg → HLS / RTMP
- **مكتبة وسائط ذكية** مع فحص ffprobe وتصنيف الحالة
- **خريطة تشغيل 3 أشهر** بصيغ JSON / CSV / XLSX
- **Overlays مسبقة** — تيكر يومي، اسم البرنامج، اللوجو (WebM مع alpha)
- **دعم اللغة العربية RTL** عبر node-canvas بدون FFmpeg drawtext
- **Fallback طارئ** — النظام لا يُظهر شاشة سوداء أبداً
- **لوحة تحكم ويب** (React) مؤمّنة بـ JWT + RBAC
- **WebSocket** لتحديثات لحظية
- **قاعدة بيانات SQLite** (WAL mode) قابلة للترقية إلى PostgreSQL

---

## المتطلبات

```
Node.js >= 20 LTS
FFmpeg >= 6.0 + ffprobe
Ubuntu 22.04 / 24.04 LTS
```

---

## التثبيت السريع (تطوير)

```bash
# 1. نسخ المشروع
git clone https://github.com/hos3004/Daawah-Broadcast-Engine.git
cd Daawah-Broadcast-Engine

# 2. نسخ ملف الإعداد
cp .env.example .env
# عدّل .env حسب بيئتك

# 3. تثبيت الاعتماديات
npm install

# 4. تشغيل وضع التطوير
npm run dev
```

ستجد الـ API على `http://localhost:3000` والـ dashboard على `http://localhost:5173/admin`

---

## النشر على VPS (Ubuntu 22.04/24.04)

### 1. تحضير السيرفر

```bash
# تحديث النظام
sudo apt update && sudo apt upgrade -y

# تثبيت Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# تثبيت FFmpeg
sudo apt install -y ffmpeg

# تثبيت Nginx
sudo apt install -y nginx

# إنشاء المستخدم
sudo useradd -m -s /bin/bash daawah
sudo usermod -aG www-data daawah
```

### 2. إنشاء المجلدات

```bash
sudo mkdir -p /opt/daawah-broadcast
sudo mkdir -p /media/library/{programs,fillers,emergency,promos,quran}
sudo mkdir -p /media/emergency
sudo mkdir -p /var/www/html/hls
sudo mkdir -p /var/log/daawah-broadcast
sudo mkdir -p /etc/daawah-broadcast

sudo chown -R daawah:daawah /opt/daawah-broadcast
sudo chown -R daawah:daawah /media
sudo chown -R daawah:www-data /var/www/html/hls
sudo chown -R daawah:daawah /var/log/daawah-broadcast
```

### 3. نشر التطبيق

```bash
cd /opt/daawah-broadcast
git clone https://github.com/hos3004/Daawah-Broadcast-Engine.git .

npm install
npm run build

# ملف الإعداد
sudo cp .env.example /etc/daawah-broadcast/.env
sudo nano /etc/daawah-broadcast/.env  # عدّل الإعدادات

sudo chown daawah:daawah /etc/daawah-broadcast/.env
sudo chmod 600 /etc/daawah-broadcast/.env
```

### 4. Systemd Services

```bash
sudo cp deploy/systemd/daawah-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now daawah-api
sudo systemctl status daawah-api
```

### 5. Nginx

```bash
# HLS (public stream)
sudo cp deploy/nginx/hls.conf /etc/nginx/sites-available/daawah-hls
sudo ln -s /etc/nginx/sites-available/daawah-hls /etc/nginx/sites-enabled/

# Admin dashboard (protected)
sudo cp deploy/nginx/admin.conf /etc/nginx/sites-available/daawah-admin
sudo ln -s /etc/nginx/sites-available/daawah-admin /etc/nginx/sites-enabled/

sudo nginx -t && sudo systemctl reload nginx
```

### 6. SSL (Let's Encrypt)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d stream.your-domain.com -d admin.your-domain.com
```

---

## هيكل المشروع

```
daawah-broadcast-engine/
├── server/                 ← Node.js + TypeScript Backend
│   └── src/
│       ├── config/         ← App configuration
│       ├── db/             ← SQLite schema & migrations
│       ├── auth/           ← JWT auth + RBAC
│       ├── media/          ← ffprobe + media scanner
│       ├── schedule/       ← Schedule import + validation
│       ├── playlist/       ← Daily playlist builder
│       ├── overlay/        ← Ticker, now-playing, logo generators
│       ├── broadcast/      ← FFmpeg process manager
│       ├── api/routes/     ← REST API endpoints
│       └── ws/             ← WebSocket server
├── web/                    ← React Admin Dashboard
│   └── src/
│       ├── pages/          ← Dashboard, Media, Schedule, Overlays, Broadcast, Logs
│       └── components/     ← Layout, shared UI
├── docs/                   ← Architecture, deployment, security docs
├── samples/schedules/      ← Sample JSON + CSV schedules
└── deploy/                 ← Nginx + Systemd config files
```

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/login` | تسجيل الدخول |
| GET | `/api/auth/me` | المستخدم الحالي |
| POST | `/api/media/scan` | فحص مكتبة الوسائط |
| GET | `/api/media/files` | قائمة الملفات |
| POST | `/api/schedules/import` | استيراد جدول |
| POST | `/api/schedules/validate/:id` | التحقق من الجدول |
| POST | `/api/schedules/publish/:id` | نشر الجدول |
| POST | `/api/schedules/playlist/build/:date` | بناء قائمة اليوم |
| GET | `/api/broadcast/status` | حالة البث |
| POST | `/api/broadcast/start` | تشغيل البث |
| POST | `/api/broadcast/stop` | إيقاف البث |
| POST | `/api/broadcast/emergency` | تفعيل البث الطارئ |
| GET | `/api/now` | ما يُعرض الآن |
| POST | `/api/overlays/ticker/generate/:date` | توليد تيكر اليوم |
| POST | `/api/overlays/logo/convert` | تحويل اللوجو |
| GET | `/health` | فحص صحة النظام |

---

## الأدوار والصلاحيات

| الدور | الوصف |
|-------|-------|
| `admin` | صلاحيات كاملة |
| `editor` | إدارة الجداول والوسائط |
| `operator` | تشغيل/إيقاف البث |
| `viewer` | عرض فقط |

---

## الأمان

- API يستمع على `127.0.0.1` فقط — Nginx يوجّه الطلبات
- كلمات المرور مشفّرة بـ bcrypt
- JWT في cookies HTTP-only
- Rate limiting على login endpoint
- رفع الملفات مؤمّن ضد path traversal
- لا توجد أسرار في الـ repository

---

## للمزيد

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — الرؤية المعمارية الكاملة
- [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) — خطة التنفيذ والمراحل
- [docs/SCHEDULE_FORMAT.md](docs/SCHEDULE_FORMAT.md) — صيغة ملف الجدول
- [.env.example](.env.example) — جميع إعدادات البيئة

---

## المتطلبات قبل البث

1. ✅ وضع ملفات الطوارئ في `/media/emergency/`
2. ✅ فحص المكتبة من لوحة التحكم
3. ✅ استيراد جدول التشغيل والتحقق منه ونشره
4. ✅ بناء قائمة التشغيل لليوم
5. ✅ توليد التيكر اليومي
6. ✅ تحويل اللوجو إلى WebM (مرة واحدة)
7. ✅ الضغط على "تشغيل" من صفحة التحكم بالبث
