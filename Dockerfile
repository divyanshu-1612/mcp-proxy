FROM node:22-slim

# Docker CLI only (not the daemon) — used to launch sibling containers via host socket
RUN apt-get update \
    && apt-get install -y --no-install-recommends docker.io curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --production

COPY . .

EXPOSE 9800

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s \
    CMD curl -sf http://127.0.0.1:9800/health || exit 1

CMD ["node", "daemon.js"]
