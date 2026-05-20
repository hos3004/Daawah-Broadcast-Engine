# Security Guide

## Authentication

### JWT Tokens
- Stored in **HTTP-only cookies** (inaccessible to JavaScript)
- Expiry: 24 hours
- Algorithm: HS256
- Secret: minimum 64 random hex characters

```bash
# Generate JWT secret
openssl rand -hex 64
```

### Password Storage
- Algorithm: **bcrypt** with cost factor 12
- Never stored in plaintext
- No password recovery by email in MVP (admin must reset via DB)

### Rate Limiting
- Login endpoint: 10 requests per 15 minutes per IP
- Configurable via `AUTH_RATE_LIMIT_WINDOW_MS` and `AUTH_RATE_LIMIT_MAX`

---

## Role-Based Access Control (RBAC)

| Role | Permissions |
|------|------------|
| `admin` | Full access: user management, schedule publish, broadcast control, system settings |
| `editor` | Import/validate/publish schedules, scan media, generate overlays |
| `operator` | Start/stop/restart broadcast, build playlists, generate overlays |
| `viewer` | Read-only access to all pages |

---

## Network Security

### API Binding
The Node.js API **must** listen on `127.0.0.1` only:
```env
HOST=127.0.0.1
PORT=3000
```

Nginx reverse-proxies `/api/` and `/admin/` from the public interface. The raw Node.js port must never be exposed.

### Firewall (UFW)
```bash
sudo ufw default deny incoming
sudo ufw allow ssh
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
# If using RTMP:
sudo ufw allow 1935/tcp
sudo ufw enable
```

### Cloudflare Access (Recommended for Admin)
Place the admin subdomain behind Cloudflare Zero Trust Access for an additional authentication layer before the login page.

---

## Upload Security

All file uploads validate:
1. **File extension** — allowed: `.json`, `.csv`, `.xlsx`, `.png`, `.jpg`, `.webm`, `.mp4`
2. **MIME type** — validated against a strict allowlist
3. **Path traversal prevention** — filenames are sanitized with `path.basename()`, uploads stored in controlled directories
4. **Size limits** — schedule files: 50 MB, logo frames: 100 MB

**Never trust uploaded filenames.** The server always sanitizes and controls the final path.

---

## Read-Only Media Browser

The Media Browser only exposes configured roots under `MEDIA_BROWSER_BASE_PATH`
and uses `rootId + relative path` requests instead of trusting raw absolute
paths from the client.

Guards:
- Reject absolute paths, null bytes, and `..` traversal segments.
- Resolve the real filesystem path before serving a listing.
- Reject symlink escapes outside the selected allowed root.
- Keep delete, rename, move, and upload out of scope for the read-only page.
- Scan selected folder is allowed for `admin`, `editor`, and `operator` roles
  because it updates DB scan state only; it does not mutate files on disk.

---

## CORS

```env
CORS_ORIGIN=https://admin.your-domain.com
```

Only the configured origin is allowed to send credentialed requests. Wildcard `*` must never be used in production.

---

## Secrets Management

- All secrets in `.env` file
- `.env` is in `.gitignore` — never committed to git
- Production `.env` stored at `/etc/daawah-broadcast/.env` with mode `600` (owner-readable only)
- No secrets hardcoded in source code

---

## Audit Logging

Every state-changing action is recorded in the `audit_logs` table:
- User ID and email
- Action name
- Entity type and ID
- IP address
- Timestamp

Access audit logs from: Admin Dashboard → السجلات → سجل المراجعة

---

## Security Headers (Helmet)

Applied via `helmet` middleware:
- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `Strict-Transport-Security` (via Nginx)
- `X-XSS-Protection`

---

## Nginx Security Headers

Add to your Nginx config:
```nginx
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
add_header X-Frame-Options "DENY" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
```

---

## Checklist Before Production

- [ ] `JWT_SECRET` is a random 64-char hex string (not the default)
- [ ] `COOKIE_SECRET` is a random 32-char hex string
- [ ] `ADMIN_PASSWORD` is a strong unique password
- [ ] API port 3000 is NOT accessible from the internet (firewall + HOST=127.0.0.1)
- [ ] HTTPS enabled on all public endpoints
- [ ] `.env` file has mode `600`
- [ ] Emergency media exists in `/media/emergency/`
- [ ] Rate limiting is active (default: 10 req/15min)
- [ ] Audit logs enabled and visible in dashboard
