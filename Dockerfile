FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV NODE_ENV=production
ENV NODE_NO_WARNINGS=1
ENV WA_DATA_DIR=/app/data
ENV WA_API_HOST=0.0.0.0
ENV WA_API_PORT=8788

EXPOSE 8788

CMD ["node", "src/server.mjs"]
