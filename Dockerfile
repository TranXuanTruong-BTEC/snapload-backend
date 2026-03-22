# ── Base: Node 20 on Debian ────────────────────────────────────
FROM node:20-slim

# Install ffmpeg + yt-dlp dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg python3 python3-pip curl wget \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

# Verify
RUN yt-dlp --version && ffmpeg -version | head -1

# App setup
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY server.js ./

# Directories
RUN mkdir -p /app/tmp /app/logs

# Port
ENV PORT=4000
EXPOSE 4000

# Docker healthcheck — use curl (already installed above)
HEALTHCHECK --interval=15s --timeout=10s --start-period=20s --retries=5 \
  CMD curl -sf http://localhost:${PORT:-4000}/api/health > /dev/null || exit 1

CMD ["node", "server.js"]
