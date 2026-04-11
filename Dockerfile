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
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src

RUN useradd -m -u 1000 soundboardbot \
    && mkdir -p /app/sounds /app/data /app/logs \
    && chown -R soundboardbot:soundboardbot /app

USER soundboardbot

ENV NODE_ENV=production

CMD ["node", "src/index.js"]
