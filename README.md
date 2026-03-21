# SnapLoad Backend

Server Express xử lý download và convert video.

## Cài đặt

### 1. Cài yt-dlp và ffmpeg (bắt buộc)

```powershell
# Cài yt-dlp
winget install yt-dlp

# Cài ffmpeg
winget install ffmpeg

# Kiểm tra đã cài chưa
yt-dlp --version
ffmpeg -version
```

### 2. Cài dependencies và chạy

```powershell
cd snapload-backend
npm install
npm start
```

Server chạy tại: http://localhost:4000

---

## API Endpoints

### `POST /api/info`
Lấy thông tin video (title, thumbnail, danh sách formats)

```json
Body: { "url": "https://youtube.com/...", "format": "mp3", "quality": "320" }
Response: { "title": "...", "platform": "YouTube", "thumbnail": "...", "formats": [...] }
```

### `GET /api/download?url=...&format=mp3&quality=320`
Download trực tiếp file về máy.

- `format`: `mp3` hoặc `mp4`
- `quality`: `320/256/192/128` (mp3) hoặc `2160/1080/720/480` (mp4)

### `POST /api/convert` (multipart/form-data)
Convert file MP4 local sang MP3.

```
file: <mp4 file>
quality: 320
```

---

## Cấu trúc thư mục

```
snapload-backend/
├── server.js     ← server chính
├── tmp/          ← file tạm (tự xoá sau 30 phút)
└── package.json
```

---

## Kết nối với website

Trong file `media-desktop-web/.env` (tạo nếu chưa có):

```
VITE_API_URL=http://localhost:4000
```

Hoặc nếu deploy backend lên server riêng:
```
VITE_API_URL=https://api.snapload.app
```
