# DARM-ANN Agent image — joins a VPN (Tailscale) on start, then registers its
# tier + capabilities to the model's agent registry and heartbeats.
#
# Build:  docker build -f deploy/agent/Dockerfile -t darm-agent:latest .
# Run:    docker run --cap-add=NET_ADMIN --device=/dev/net/tun \
#           -e TS_AUTHKEY=tskey-... -e VPN_BACKEND=tailscale \
#           -e DARM_MODEL_URL=https://model.example -e DARM_TOKEN=... \
#           -e AGENT_TIER=worker -e AGENT_CAPS=execute,run-tool darm-agent:latest
FROM node:20-slim

# Tailscale (userspace) — optional; only used when VPN_BACKEND=tailscale.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates iptables \
 && curl -fsSL https://tailscale.com/install.sh | sh \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .

ARG GIT_COMMIT=unknown
ENV DARM_GIT_COMMIT=${GIT_COMMIT} \
    VPN_BACKEND=local \
    TS_LOGIN_SERVER="" \
    AGENT_TIER=worker \
    AGENT_CAPS="" \
    DARM_MODEL_URL=http://localhost:3001 \
    AGENT_HEARTBEAT_MS=20000

# tailscaled state survives restarts when a volume is mounted here.
VOLUME ["/var/lib/tailscale"]

ENTRYPOINT ["sh", "deploy/agent/entrypoint.sh"]
