# DARM-ANN Agentic Layer

A fleet of agents that **come online → join a VPN → register their tier and tool
capabilities** to the model, which records them in a linked-list registry the
router walks to dispatch work. Built dependency-free, alongside the memory +
consensus core.

## Agent tiers

| Tier | Rank | Role | Holds memory? | Routes? |
|------|------|------|---------------|---------|
| `knowledgeable` | 4 | Broad-knowledge; teaches, consolidates, answers across domains | yes | yes |
| `generalist` | 3 | Generally specialized across a domain family | yes | yes |
| `narrow` | 2 | One tight capability — e.g. a **"dumb router"** that only classifies/forwards | no | yes |
| `worker` | 1 | Worker node / operating plane (runner-like); executes tasks & tools | no | no |

The router prefers the **lowest-capable tier** that advertises a needed
capability (don't burn a knowledgeable agent on a worker's job), escalating
upward only when required.

## Linked-list registry

`agents/registry.js` is a singly-linked list of agent records (mirroring the
repo's `structures/Chain.js` motif) — the source of truth for *who is online and
what they can do*. Each link:

```
{ id, name, tier, rank, capabilities[], endpoint, vpnIp, publicKey,
  status, registeredAt, lastSeen, order, meta }
```

The model also `observe()`s each registration into its memory, so it *learns*
which tools exist and consolidates that over time.

## Come-online lifecycle (`agents/agent.js`)

1. **VPN up** — `agents/vpn.js` adapter (`tailscale` | `generic`/WireGuard |
   `local`) joins the private network and returns the agent's address.
2. **Register** — `POST /agents/register` with tier + capabilities → agent id.
3. **Heartbeat** — periodic `POST /agents/heartbeat` keeps it `online`
   (stale agents are reaped to `offline`).
4. **Offline** — on shutdown, `POST /agents/deregister` + VPN down.

```js
const Agent = require('./darm-ann/agents/agent');
const a = new Agent({ name: 'runner-1', tier: 'worker', capabilities: ['execute'],
                      modelUrl: 'https://model', token: 'op-token', vpn: 'tailscale' });
await a.online();           // VPN up + register + heartbeat
const where = await a.discover('teach');   // ask the router who can 'teach'
// ... on shutdown:
await a.offline();
```

## HTTP API

`POST /agents/register` · `POST /agents/heartbeat` · `POST /agents/deregister` ·
`GET /agents` (list + stats + capabilities) ·
`GET /agents/route?capability=…[&minTier&preferTier]` (tier-aware dispatch) ·
`GET /agents/escalation?capability=…` (ordered fallback chain).

Prometheus: `darm_agents{tier=…}` and `darm_agents_online`.

## Deploying a tier of agents

A ready-to-use **agent image** joins Tailscale on start, then runs the agent
runner:

```bash
docker build -f deploy/agent/Dockerfile -t darm-agent:latest .
docker run -e VPN_BACKEND=tailscale -e TS_AUTHKEY=tskey-... \
           -e DARM_MODEL_URL=https://model.example -e DARM_TOKEN=op-token \
           -e AGENT_TIER=worker -e AGENT_CAPS=execute,run-tool darm-agent:latest
```

The **`darm-agents` Helm chart** deploys a whole fleet — one Deployment per tier
entry (default: 1 knowledgeable, 2 generalist, 2 narrow "dumb routers", 3
workers):

```bash
helm install agents deploy/helm/darm-agents \
  --set model.url=http://darm-ann.darm-ann.svc.cluster.local:3001 \
  --set tailscale.authKey=tskey-... \
  --set auth.token=op-token
```

Tune the fleet via `values.yaml` `agents:` (name, tier, replicas, capabilities).
