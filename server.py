#!/usr/bin/env python3
"""
SnapLoad Backend Server
Yêu cầu: pip install flask flask-cors yt-dlp
Chạy: python server.py
Port: 8787
"""

import os, re, json, tempfile, threading, time, uuid
from pathlib import Path
from flask import Flask, request, jsonify, send_file, after_this_request
from flask_cors import CORS

try:
    import yt_dlp
except ImportError:
    print("❌ yt-dlp chưa cài. Chạy: pip install yt-dlp")
    exit(1)

app = Flask(__name__)
CORS(app, origins=["http://localhost:5173", "http://localhost:5174", "http://localhost:4173"])

DOWNLOAD_DIR = Path(tempfile.gettempdir()) / "snapload_downloads"
DOWNLOAD_DIR.mkdir(exist_ok=True)

# ── Cleanup old files (> 30 phút) ─────────────────────────────
def cleanup_old_files():
    while True:
        now = time.time()
        for f in DOWNLOAD_DIR.iterdir():
            if f.is_file() and (now - f.stat().st_mtime) > 1800:
                try: f.unlink()
                except: pass
        time.sleep(300)

threading.Thread(target=cleanup_old_files, daemon=True).start()

# ── Helpers ────────────────────────────────────────────────────
def sanitize_filename(name: str) -> str:
    name = re.sub(r'[<>:"/\\|?*]', '', name)
    return name[:80].strip() or "download"

def get_format_spec(fmt: str, quality: str) -> tuple[str, str]:
    """Trả về (ydl_format_string, output_ext)"""
    if fmt == "mp3":
        return "bestaudio/best", "mp3"
    elif fmt == "mp4":
        height_map = {"2160": 2160, "1080": 1080, "720": 720, "480": 480}
        h = height_map.get(quality, 1080)
        return f"bestvideo[height<={h}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<={h}]+bestaudio/best[height<={h}]", "mp4"
    elif fmt == "webm":
        height_map = {"1080": 1080, "720": 720, "480": 480}
        h = height_map.get(quality, 720)
        return f"bestvideo[height<={h}][ext=webm]+bestaudio[ext=webm]/bestvideo[height<={h}]+bestaudio/best[height<={h}]", "webm"
    elif fmt == "convert_mp3":
        # Convert từ MP4 local file
        return "bestaudio/best", "mp3"
    return "bestaudio/best", "mp3"

# ── Route: GET /info ────────────────────────────────────────────
@app.route("/info")
def get_info():
    url = request.args.get("url", "").strip()
    if not url:
        return jsonify({"ok": False, "error": "Thiếu URL"}), 400

    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "extract_flat": False,
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)

        formats_available = []
        raw_formats = info.get("formats") or []

        # Check available video resolutions
        heights = set()
        for f in raw_formats:
            h = f.get("height")
            if h and f.get("vcodec") != "none":
                heights.add(h)

        has_audio = any(f.get("acodec") != "none" for f in raw_formats)

        if has_audio:
            formats_available.append({"format": "mp3", "label": "MP3 Audio"})
        for h in sorted(heights, reverse=True)[:4]:
            label = {2160:"4K / 2160p", 1440:"2K / 1440p", 1080:"1080p HD", 720:"720p HD", 480:"480p SD", 360:"360p"}.get(h, f"{h}p")
            formats_available.append({"format": "mp4", "quality": str(h), "label": f"MP4 {label}"})

        return jsonify({
            "ok": True,
            "title": info.get("title", "Video"),
            "thumbnail": info.get("thumbnail", ""),
            "duration": info.get("duration", 0),
            "platform": info.get("extractor_key", "Unknown"),
            "formats": formats_available,
        })

    except Exception as e:
        msg = str(e)
        if "Private video" in msg:    msg = "Video này ở chế độ riêng tư"
        elif "not available" in msg:  msg = "Video không khả dụng ở khu vực của bạn"
        elif "removed" in msg:        msg = "Video đã bị xoá"
        elif "sign in" in msg.lower(): msg = "Video yêu cầu đăng nhập"
        return jsonify({"ok": False, "error": msg}), 400

# ── Route: GET /download ────────────────────────────────────────
@app.route("/download")
def download():
    url     = request.args.get("url", "").strip()
    fmt     = request.args.get("format", "mp3")
    quality = request.args.get("quality", "320")

    if not url:
        return jsonify({"ok": False, "error": "Thiếu URL"}), 400

    format_spec, out_ext = get_format_spec(fmt, quality)
    job_id    = uuid.uuid4().hex[:8]
    out_tmpl  = str(DOWNLOAD_DIR / f"{job_id}_%(title)s.%(ext)s")

    ydl_opts = {
        "format":   format_spec,
        "outtmpl":  out_tmpl,
        "quiet":    True,
        "no_warnings": True,
        "noplaylist": True,
    }

    # MP3: cần postprocessor để convert audio
    if fmt in ("mp3", "convert_mp3"):
        ydl_opts["postprocessors"] = [{
            "key":            "FFmpegExtractAudio",
            "preferredcodec": "mp3",
            "preferredquality": quality if fmt == "mp3" else "192",
        }]

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            title = sanitize_filename(info.get("title", "download"))

        # Find the output file
        output_file = None
        for f in DOWNLOAD_DIR.iterdir():
            if f.name.startswith(job_id) and f.is_file():
                output_file = f
                break

        if not output_file:
            return jsonify({"ok": False, "error": "File không được tạo. Kiểm tra ffmpeg đã cài chưa."}), 500

        download_name = f"{title}.{output_file.suffix.lstrip('.')}"

        @after_this_request
        def remove_file(response):
            try:
                threading.Timer(5.0, lambda: output_file.unlink(missing_ok=True)).start()
            except: pass
            return response

        return send_file(
            str(output_file),
            as_attachment=True,
            download_name=download_name,
            mimetype="audio/mpeg" if out_ext == "mp3" else "video/mp4",
        )

    except Exception as e:
        msg = str(e)
        if "ffmpeg" in msg.lower():
            msg = "ffmpeg chưa được cài. Tải tại ffmpeg.org rồi thêm vào PATH."
        elif "Private" in msg:
            msg = "Video ở chế độ riêng tư"
        return jsonify({"ok": False, "error": msg}), 400

# ── Route: POST /convert (MP4 local → MP3) ─────────────────────
@app.route("/convert", methods=["POST"])
def convert_mp4_to_mp3():
    """Nhận file MP4 từ client, convert sang MP3 bằng ffmpeg rồi trả về"""
    if "file" not in request.files:
        return jsonify({"ok": False, "error": "Không có file"}), 400

    file    = request.files["file"]
    quality = request.form.get("quality", "192")

    if not file.filename.lower().endswith((".mp4", ".webm", ".mkv", ".avi", ".mov")):
        return jsonify({"ok": False, "error": "Chỉ hỗ trợ MP4, WebM, MKV, AVI, MOV"}), 400

    job_id   = uuid.uuid4().hex[:8]
    in_path  = DOWNLOAD_DIR / f"{job_id}_input{Path(file.filename).suffix}"
    out_path = DOWNLOAD_DIR / f"{job_id}_output.mp3"

    file.save(str(in_path))

    try:
        import subprocess
        result = subprocess.run([
            "ffmpeg", "-i", str(in_path),
            "-vn", "-acodec", "libmp3lame",
            "-ab", f"{quality}k",
            str(out_path), "-y"
        ], capture_output=True, text=True, timeout=120)

        if result.returncode != 0:
            return jsonify({"ok": False, "error": f"ffmpeg lỗi: {result.stderr[-200:]}"}), 500

        stem = Path(file.filename).stem
        download_name = f"{sanitize_filename(stem)}.mp3"

        @after_this_request
        def cleanup(response):
            threading.Timer(5.0, lambda: [
                in_path.unlink(missing_ok=True),
                out_path.unlink(missing_ok=True),
            ]).start()
            return response

        return send_file(
            str(out_path),
            as_attachment=True,
            download_name=download_name,
            mimetype="audio/mpeg",
        )

    except FileNotFoundError:
        return jsonify({"ok": False, "error": "ffmpeg chưa cài. Tải tại https://ffmpeg.org"}), 500
    except subprocess.TimeoutExpired:
        return jsonify({"ok": False, "error": "File quá lớn hoặc mất quá nhiều thời gian convert"}), 500

# ── Route: GET /health ─────────────────────────────────────────
@app.route("/health")
def health():
    import shutil
    return jsonify({
        "ok": True,
        "yt_dlp": True,
        "ffmpeg": shutil.which("ffmpeg") is not None,
    })

if __name__ == "__main__":
    print("\n" + "="*50)
    print("  🚀 SnapLoad Backend running")
    print("  📡 API: http://localhost:8787")
    print("  Endpoints:")
    print("    GET  /health")
    print("    GET  /info?url=...")
    print("    GET  /download?url=...&format=mp3&quality=320")
    print("    POST /convert  (file upload MP4→MP3)")
    print("="*50 + "\n")
    app.run(host="0.0.0.0", port=8787, debug=False)
