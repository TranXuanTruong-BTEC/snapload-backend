# Deploy SnapLoad Backend lên Railway (Free)

## Tổng quan

```
Cloudflare Pages (website)  →  Railway (backend API)
mysite.pages.dev            →  snapload-backend.up.railway.app
```

Website chạy 24/7 trên Cloudflare, backend chạy 24/7 trên Railway.
Không cần mở máy tính nữa.

---

## Bước 1 — Push backend lên GitHub

```powershell
# Tạo repo mới trên GitHub tên: snapload-backend
# Sau đó:
cd C:\project\snapload-backend
git init
git add .
git commit -m "Initial backend"
git remote add origin https://github.com/TranXuanTruong-BTEC/snapload-backend.git
git push -u origin main
```

---

## Bước 2 — Deploy lên Railway

1. Vào **https://railway.app** → Sign up bằng GitHub
2. Bấm **"New Project"** → **"Deploy from GitHub repo"**
3. Chọn repo `snapload-backend`
4. Railway tự phát hiện `Dockerfile` và build
5. Đợi ~3 phút để build xong (cài yt-dlp + ffmpeg trong Docker)
6. Vào **Settings → Networking → Generate Domain**
   → Sẽ có domain dạng: `snapload-backend-production.up.railway.app`

---

## Bước 3 — Thêm biến môi trường trên Railway

Vào **Variables** trong Railway project, thêm:

```
FRONTEND_URL=https://mytools-9ns.pages.dev
```

*(Thay bằng domain Cloudflare Pages thật của bạn)*

---

## Bước 4 — Cập nhật website dùng backend mới

Tạo file `.env` trong `media-desktop-web`:

```
VITE_API_URL=https://snapload-backend-production.up.railway.app
```

Build và deploy lại website:

```powershell
cd C:\project\media-desktop-web
npm run build
# Push lên GitHub → Cloudflare tự deploy
```

---

## Kết quả

| | Trước | Sau |
|---|---|---|
| Backend | localhost:4000 (cần mở máy) | Railway (24/7) |
| Website | Cloudflare Pages | Cloudflare Pages |
| Khi tắt máy | ❌ Không tải được | ✅ Vẫn hoạt động |
| Chi phí | Miễn phí | Miễn phí (Railway free tier: $5/tháng credit) |

---

## Railway Free Tier

- **$5 credit miễn phí/tháng** ≈ đủ chạy ~500 giờ
- Nếu hết credit: upgrade $5/tháng hoặc dùng Render.com (free nhưng chậm hơn)

## Render.com (thay thế Railway)

1. Vào **https://render.com** → New → Web Service
2. Connect GitHub repo `snapload-backend`
3. Runtime: **Docker**
4. Tự động dùng `render.yaml`
5. Free tier: ngủ sau 15 phút không dùng (cold start ~30s)
