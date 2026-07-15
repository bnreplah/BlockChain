#!/bin/sh
# DARM-ANN agent entrypoint: bring up the VPN backend (if Tailscale), then run
# the agent runner which joins the VPN via the adapter, registers its tier +
# capabilities to the model, and heartbeats until terminated.
set -e

if [ "$VPN_BACKEND" = "tailscale" ]; then
  echo "[agent] starting tailscaled (userspace networking)…"
  # Userspace mode needs no NET_ADMIN/tun; SOCKS/HTTP proxy exposed for the app.
  tailscaled --tun=userspace-networking --socks5-server=localhost:1055 --outbound-http-proxy-listen=localhost:1055 &
  # Give tailscaled a moment to create its socket.
  sleep 2
  # The runner calls `tailscale up` via the VPN adapter using $TS_AUTHKEY.
  export ALL_PROXY=socks5://localhost:1055/
  export HTTP_PROXY=http://localhost:1055/
fi

echo "[agent] launching runner: tier=$AGENT_TIER caps=$AGENT_CAPS model=$DARM_MODEL_URL vpn=$VPN_BACKEND"
exec node deploy/agent/runner.js
