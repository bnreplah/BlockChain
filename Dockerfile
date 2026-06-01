# DARM-ANN node image — runs the Express server (memory network + dashboard).
FROM node:20-slim

WORKDIR /app

# Install production dependencies first (better layer caching).
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# App source.
COPY . .

# Defaults (override via compose / -e). PORT is the listen port; NODE_URL is the
# self URL passed to app.js; DARM_SNAPSHOT persists state across restarts.
ENV PORT=3001 \
    NODE_URL=http://localhost:3001 \
    DARM_SNAPSHOT=/data/node.json \
    DARM_SNAPSHOT_MS=60000 \
    DARM_MIN_AGE_MS=60000

# Persistent state volume (shared LTM snapshot + WAL survive restarts).
RUN mkdir -p /data
EXPOSE 3001
VOLUME ["/data"]

# Liveness/readiness probe (no curl in slim image — use Node).
HEALTHCHECK --interval=15s --timeout=4s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3001)+'/darm/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# app.js takes <port> <selfUrl> as argv.
CMD ["sh", "-c", "node app.js ${PORT} ${NODE_URL}"]
