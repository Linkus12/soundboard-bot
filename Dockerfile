# --- Build stage: compile native deps (better-sqlite3, @discordjs/opus) -----
FROM node:20-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

# --- Runtime stage: ffmpeg + node_modules only ------------------------------
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
       -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src

RUN mkdir -p /app/sounds /app/data /app/logs \
    && chown -R node:node /app

USER node

ENV NODE_ENV=production

CMD ["node", "src/index.js"]
