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

# Docker healthcheck — tells Railway the app is ready
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+process.env.PORT+'/api/health', r => { process.exit(r.statusCode === 200 ? 0 : 1) })" || exit 1

CMD ["node", "server.js"]
