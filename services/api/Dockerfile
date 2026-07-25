FROM node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg tini \
    && apt-get clean

COPY services/api/package.json services/api/package-lock.json ./
RUN npm ci --omit=dev

COPY services/api/src ./src
COPY services/api/scripts ./scripts
COPY contracts /app/contracts
COPY database/migrations /app/database/migrations

RUN mkdir -p /data/media /data/processing /data/releases /data/backups \
    && chown -R node:node /app /data

USER node
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.mjs"]
