FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      fonts-noto-color-emoji \
      fonts-noto \
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libxcomposite1 libxrandr2 \
      libxdamage1 libgbm1 libasound2 \
      ca-certificates \
      && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_ENV=production

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
COPY config/ ./config/
COPY web/ ./web/

RUN npm run build

RUN npm prune --omit=dev

EXPOSE 3000
VOLUME ["/data"]
ENV DATA_DIR=/data

CMD ["node", "dist/index.js"]
