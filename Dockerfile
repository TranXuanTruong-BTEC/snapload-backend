FROM node:20-slim

RUN apt-get update && apt-get install -y \
    ffmpeg python3 python3-pip curl wget zip \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

RUN yt-dlp --version && ffmpeg -version | head -1

WORKDIR /app

# Cache bust — increment when you need a fresh build
ARG CACHE_BUST=2
COPY package.json ./
RUN npm install --production
COPY server.js ./

RUN mkdir -p /app/tmp /app/logs

ENV PORT=4000
EXPOSE 4000

CMD ["node", "server.js"]
