FROM node:20-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      fonts-liberation \
      fonts-noto-color-emoji \
      fonts-noto \
      ca-certificates \
      dumb-init \
      python3 \
      make \
      g++ \
      wget \
      xdg-utils \
      libnss3 \
      libatk-bridge2.0-0 \
      libdrm2 \
      libxkbcommon0 \
      libxcomposite1 \
      libxdamage1 \
      libxrandr2 \
      libgbm1 \
      libasound2 \
      libpango-1.0-0 \
      libcairo2 \
      libcups2 \
      libxshmfence1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY app/package.json app/package-lock.json* ./app/
RUN cd app && npm ci --include=dev

COPY app ./app
COPY package.json ./

RUN cd app && npm run build

RUN mkdir -p /app/data

EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]
CMD ["npm", "start"]
