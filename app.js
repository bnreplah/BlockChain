//establish api


console.log("[--------------Configuring the server--------------]");

require('dotenv').config();//require the .env file for use
const express = require('express');//express for api server
const app = express(); //initialize the express object
const jwt = require('jsonwebtoken');//get the json web token models
app.use(express.json());//use json to parse the requests

// RBAC token auth for the DARM-ANN API. Off by default (back-compat). Tokens
// carry a scope; routes require a minimum scope:
//   read     → GET endpoints (state, query, tasks, validators, mempool, …)
//   operator → mutating endpoints (teach, observe, tx, replay, validators add/del…)
// Configure via either:
//   DARM_AUTH_TOKEN=<tok>                  (single operator-scope token; legacy)
//   DARM_TOKENS="tokA:operator,tokB:read"  (multiple scoped tokens)
// Health + metrics stay open for probes/scraping. Alertmanager webhook is open
// so Alertmanager (no bearer support by default) can deliver alerts.
const rbac = require('./darm-ann/rbac');
const RateLimiter = require('./darm-ann/rateLimiter');
const AuditLog = require('./darm-ann/auditLog');
const darmTokenScopes = rbac.buildTokenScopes({ authToken: process.env.DARM_AUTH_TOKEN || '', tokensSpec: process.env.DARM_TOKENS || '' });
// Inter-node cluster token is accepted as operator scope (gossip/state-sync).
if (process.env.DARM_CLUSTER_TOKEN) darmTokenScopes.set(process.env.DARM_CLUSTER_TOKEN, 'operator');
// Open paths: probes, scrape, alerts webhook, and the static UI pages (the
// pages themselves load data via authenticated XHR, so serving the HTML is safe).
const DARM_OPEN_PATHS = new Set(['/darm/health', '/darm/ready', '/darm/version', '/darm/metrics', '/darm/alerts', '/darm/monitor', '/darm/dashboard', '/darm/docs', '/darm/openapi.yaml']);
// Per-token (or per-IP when anonymous) token-bucket rate limiter.
const DARM_RL_CAP = Number(process.env.DARM_RATE_CAPACITY || 120);
const DARM_RL_RPS = Number(process.env.DARM_RATE_PER_SEC || 60);
const darmRateLimiter = new RateLimiter({ capacity: DARM_RL_CAP, refillPerSec: DARM_RL_RPS });
// Audit trail of operator actions (mutations). DARM_AUDIT_FILE persists it.
const darmAudit = new AuditLog({ file: process.env.DARM_AUDIT_FILE || null, max: 2000 });
function tokenOf(req){ const h = req.headers['authorization'] || ''; return h.startsWith('Bearer ') ? h.slice(7) : (req.headers['x-darm-token'] || ''); }
app.use((req, res, next)=>{
    if (!req.path.startsWith('/darm/') && !req.path.startsWith('/agents/') && !req.path.startsWith('/fabric/')) return next(); // guard DARM + agent + fabric APIs
    if (DARM_OPEN_PATHS.has(req.path)) return next();  // probes/scrape/alerts exempt
    const token = tokenOf(req);
    // Auth (RBAC) — skipped entirely when no tokens configured.
    if (darmTokenScopes.size > 0) {
        const result = rbac.authorize(darmTokenScopes, req.method, token);
        if (!result.ok) {
            if (req.method !== 'GET') darmAudit.record({ actor: token ? 'token:'+token.slice(0,4)+'…' : (req.ip||'anon'), action: 'auth-denied', method: req.method, path: req.path, status: result.status });
            return res.status(result.status).json({ error: result.error, need: result.need, have: result.have, hint: 'Authorization: Bearer <token>' });
        }
        req.darmScope = result.scope;
    }
    // Rate limit, keyed by token if present else client IP.
    const key = token || req.ip || 'anon';
    const rl = darmRateLimiter.allow(key);
    res.set('X-RateLimit-Remaining', String(rl.remaining));
    if (!rl.ok) {
        res.set('Retry-After', String(Math.ceil(rl.retryAfterMs / 1000)));
        return res.status(429).json({ error: 'rate_limited', retryAfterMs: rl.retryAfterMs });
    }
    // Audit mutating actions (record outcome once the response finishes).
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.on('finish', ()=>{
            darmAudit.record({ actor: token ? 'token:'+token.slice(0,4)+'…' : (req.ip||'anon'), scope: req.darmScope || null, action: req.path.replace('/darm/',''), method: req.method, path: req.path, status: res.statusCode });
        });
    }
    next();
});

const authRoute = require('./routes/auth');//require the middle ware for user use /api/user
const { SHA256 } = require('crypto-js');//used for hashing and crypto algorithms
const uuid = require('crypto-random-string');//creates a unique id of mathematically random bits ( not really uuid package but similar )
process.env.REFRESH_TOKEN = uuid(64).toString();//sets the refresh token at the start of the application
const port = process.argv[2];//gets the port from the second argument of the start command
const currentNodeUrl = process.argv[3];//gets the currentNodeUrl as the third argument of the start command
const rp = require('request-promise');//allows for promises ( compatible with wix )
//establish Chain
const Chain = require('./structures/Chain');//a link list data structure alternative to using an array for the block chain

console.log("[--------------[DEBUGGING]--------------]")
//[DEBUG]:
console.log("PROCESS ARGUMENTS => ");
console.log(...process.argv);//debugging prints out to the screen the arguments

//establish User and User authentication
const User = require('./account_classes/Users');
let refreshTokens = [];

//establish BlockChain
const Blockchain = require('./structures/Blockchain');

//establish node
const doC = Date.now();

//Node address of current node
const n0deAddress =  SHA256(uuid(64) + ":|:" + doC.toString()).toString();
console.log("save this [NODE UUID]: ", n0deAddress);

//Initialize the chain
let Bcoin = new Blockchain();

//get the genesis signature as the chainId
const chainID = Bcoin.getGenesisSig();
console.log(chainID);

// ****************************************************************************
// DARM-ANN v6.0 — Distributed Agentic Recursive Memory Network
// The existing PoW blockchain (Bcoin) is bridged in as the Long-Term Memory
// (LTM) tier. DARM-ANN layers the rest of the five-tier hierarchy
// (WM -> EB -> STM -> LTM -> RRC) plus CDCP consensus consolidation and the
// RCE replay engine on top of it. Fully self-contained: no Redis, no external
// LLM, no external consensus service. See darm-ann/README.md for the full
// mapping to the v6.0 white paper.
// ****************************************************************************
const fs = require('fs');
const DarmAnn = require('./darm-ann');
const { repoChainAdapter } = require('./darm-ann/network/chainAdapter');
// Persistence: set DARM_SNAPSHOT to a file path to restore on boot + save on exit.
const DARM_SNAPSHOT = process.env.DARM_SNAPSHOT || '';
// Env-tunable consensus config (production knobs, no code edits required).
const darmConfig = { cdcp: {} };
if (process.env.DARM_MIN_AGE_MS != null) darmConfig.cdcp.tMinAgeMs = Number(process.env.DARM_MIN_AGE_MS);
if (process.env.DARM_TAU_C != null) darmConfig.cdcp.tauC = Number(process.env.DARM_TAU_C);
let darm;
if (DARM_SNAPSHOT && fs.existsSync(DARM_SNAPSHOT)) {
    darm = DarmAnn.load(DARM_SNAPSHOT, { adapter: repoChainAdapter(Bcoin), config: darmConfig });
    console.log("[DARM-ANN] restored from snapshot", DARM_SNAPSHOT);
} else {
    darm = new DarmAnn({ nodeId: n0deAddress, adapter: repoChainAdapter(Bcoin), config: darmConfig });
}
darm.autorun(); // background RCE replay + STM triage + self-correction
console.log("[DARM-ANN] memory network online ->", JSON.stringify(darm.state().tiers));

// Task manager: tracks long-running operations so they can be monitored live.
const TaskManager = require('./darm-ann/taskManager');
const darmTasks = new TaskManager({ max: 200 });
// Record autorun background cycles as tasks so the monitor shows ongoing work.
darm._taskHook = (type, result) => { const t = darmTasks.create(type, { label: type + ' (auto)' }); darmTasks.start(t.id); darmTasks.finish(t.id, result); };

// ── Agentic layer: registry (linked list) + tier-aware router ──────────────
const AgentRegistry = require('./darm-ann/agents/registry');
const AgentRouter = require('./darm-ann/agents/router');
const darmAgents = new AgentRegistry({ heartbeatTimeoutMs: Number(process.env.AGENT_HEARTBEAT_TIMEOUT_MS || 60000) });
const darmAgentRouter = new AgentRouter(darmAgents);
// Reap stale agents periodically so the registry reflects who is actually online.
const darmAgentReaper = setInterval(() => darmAgents.reapStale(), 30000);
if (darmAgentReaper.unref) darmAgentReaper.unref();

// ── DARM-ANN v7.2 Distributed AI Lens: this node IS an Autonomous Cognitive
// System (ACS). The Fabric layer advertises capabilities, routes jobs between
// subnets via DIRP-1 (trust-pruned Dijkstra), and runs the CCIL/SAL/privacy
// planes. ACS identity is deterministic from the node's cluster identity so a
// restart keeps the same ACSN.
const Fabric = require('./darm-ann/fabric');
const ValidatorKey = require('./darm-ann/consensus/validatorKey');
const fabricSeed = require('crypto').createHash('sha256').update('darm-acs|' + (process.env.NODE_URL || currentNodeUrl || n0deAddress)).digest();
const fabric = new Fabric({ key: ValidatorKey.fromSeed(fabricSeed), name: process.env.ACS_NAME || ('acs-' + n0deAddress.slice(0, 8)),
    ccil: { stake: Number(process.env.ACS_STAKE || 500), uptime: 1, bvas: 0.9 } });
// Advertise this node's own memory/inference capability so peers can route to it.
fabric.advertise({
    model_classes: ['tinylm', 'slm'], memory_domains: ['ltm', 'rrc'], gpu_tiers: ['edge'],
    latency_class: Number(process.env.ACS_LATENCY || 5), trust_score: 0.9,
    price_curve: Number(process.env.ACS_PRICE || 1), sync_classes: ['async', 'block'], conf_classes: ['redact', 'attested'],
});
fabric.ccil.reconcile(fabric.acsn); // elevate to the role its stake/uptime/bvas earns
console.log("[DARM-ANN] ACS online ->", fabric.acsn, "role", fabric.ccil.role(fabric.acsn));

// Periodic durable snapshot to the persistent volume (production deploy). The
// interval (ms) is DARM_SNAPSHOT_MS; 0 disables. Default 60s when a path is set.
const DARM_SNAPSHOT_MS = process.env.DARM_SNAPSHOT_MS != null ? Number(process.env.DARM_SNAPSHOT_MS) : (DARM_SNAPSHOT ? 60000 : 0);
let darmSnapshotTimer = null;
function persistSnapshot() {
    if (!DARM_SNAPSHOT) return null;
    darm.save(DARM_SNAPSHOT);
    return DARM_SNAPSHOT;
}
if (DARM_SNAPSHOT && DARM_SNAPSHOT_MS > 0) {
    darmSnapshotTimer = setInterval(() => { try { persistSnapshot(); } catch (e) { console.error("[DARM-ANN] periodic snapshot failed", e.message); } }, DARM_SNAPSHOT_MS);
    if (darmSnapshotTimer.unref) darmSnapshotTimer.unref();
}

// Graceful shutdown: persist the snapshot and stop background timers.
let darmShuttingDown = false;
function darmShutdown() {
    if (darmShuttingDown) return; darmShuttingDown = true;
    try { if (persistSnapshot()) console.log("[DARM-ANN] snapshot saved to", DARM_SNAPSHOT); } catch (e) { console.error("[DARM-ANN] snapshot save failed", e.message); }
    if (darmSnapshotTimer) clearInterval(darmSnapshotTimer);
    darm.stop();
    process.exit(0);
}
process.on('SIGINT', darmShutdown);
process.on('SIGTERM', darmShutdown);

// Gossip mempool: any node can submit a transaction; it is admitted locally and
// gossiped to registered network peers (HTTP), which re-gossip on first sight.
// A submitted 'memory' tx is observed into this node's memory pipeline.
const Mempool = require('./darm-ann/consensus/mempool');
const darmMempool = new Mempool({ nodeId: n0deAddress, fanout: 4, ttl: 4, onTx: (tx) => {
    if (tx.type === 'memory' && tx.payload && tx.payload.claim) {
        darm.observe({ claim: tx.payload.claim, reward: tx.payload.reward != null ? tx.payload.reward : 1, epistemic: tx.payload.epistemic });
    }
}});
// HTTP gossip: forward a tx to each registered network node's /darm/tx endpoint.
// Inter-node traffic carries the cluster token so peers can authenticate it when
// auth is enabled (DARM_CLUSTER_TOKEN; falls back to the legacy auth token).
const DARM_CLUSTER_TOKEN = process.env.DARM_CLUSTER_TOKEN || process.env.DARM_AUTH_TOKEN || '';
function gossipTxToPeers(tx, ttl) {
    if (ttl <= 0) return;
    const headers = DARM_CLUSTER_TOKEN ? { Authorization: 'Bearer ' + DARM_CLUSTER_TOKEN } : {};
    (Bcoin.networkNode || []).forEach((peerUrl) => {
        rp({ uri: peerUrl + '/darm/tx', method: 'POST', headers, body: { tx, ttl: ttl - 1 }, json: true }).catch(() => {});
    });
}

// ****************************************************************************
// ROUTES:
// ****************************************************************************



//needed for establishing the secure channel
//JWT 


//JWT entry point
// grants access to the given page showing the post authenticated for that user
// [Not tested yet]
app.get('/access', authenticateToken, (req, res)=>{
    res.json(posts.filter(post=> post.username === req.user.username))
});


//the authentication end point
// grants a newAuthentication tokena and new refresh token, needs some sort of authentication
// [Not Tested yet]
app.post('/login' ,function (req, res){
    //authenticate user
    const pssKey = req.body.signedPss;
    //some sort of authentication checking that the pss is signed by the users private key.
    //
    const loggedInUser = User(req.body.id, req.body.name, req.body.username, req.body.email)
    const accessToken = generateAuthenticationToken(loggedInUser);
    const refreshToken = generateRefreshToken(loggedInUser);
    refreshTokens.push(refreshToken);
    res.json({accessToken : accessToken,
              refreshToken: refreshToken});
});


//the token refresh endpoint
// grants the user a new authentication token if their refresh token is valid and not expired
//  [Not Tested Yet]
app.post('/token', (req, res)=>{
    const refreshToken = req.body.token;
    if(refreshToken == null)return res.sendStatus(401);
    if(refreshTokens.includes(refreshToken)) return res.sendStatus(403);
    jwt.verify(refreshToken, process.env.REFRESH_TOKEN, (err, user) =>{
        if(err) return res.sendStatus(403);
        const accessToken = generateAuthenticationToken(user);
        res.json({accessToken: accessToken, refreshToken: refreshToken});
    });
});

//ends the session and revokes the refresh token
// need to add revoking the authentication token too
// [Not Tested Yet]
app.post('/logout', (req, res)=>{
    refreshTokens = refreshTokens.filter(token => token !== req.body.token);
    res.sendStatus(204);
});

//  ************************************************************************
//  End JWT End points
//  ************************************************************************

//  ************************************************************************
//  User Endpoint Route
//  ************************************************************************



//register end point  
app.post("/register",function (req, res){
    const user = new User({
        name: req.body.name,
        email: req.body.email,
        password: req.body.password,
        uuid: "u=" + uuid(32).toString(),
        node: n0deAddress,
        timestamp: Date.now(),
        wallet : [],
    });
    //check if user already exists
    //if already exists prompt to login
    //else register user and create new transaction between the node and the user.
    
});


//Route middlewares
app.use('/api/user', authRoute);//everything in the offroute will have this prefix
//when we do to post request to register we need to go to /api/user/register


//  ************************************************************************
//  Node Endpoint Route
//  ************************************************************************


//Routes for blockchain
//presents the working blockchain held on this node
app.get("/blockchain", (req, res)=>{
    res.send(Bcoin);
});


//  ************************************************************************
//  DARM-ANN Memory Network Endpoints
//  ************************************************************************

// observe: ingest a completed inference/claim (WM -> EB -> STM)
app.post("/darm/observe", (req, res)=>{
    const result = darm.observe({
        claim: req.body.claim,
        claims: req.body.claims,
        reward: req.body.reward,
        epistemic: req.body.epistemic,
        agentId: req.body.agentId,
    });
    res.json({note: "Observation ingested into DARM-ANN", result});
});

// query: retrieve via the memory hierarchy (RRC -> STM -> LTM -> MISS)
app.get("/darm/query", (req, res)=>{
    res.json(darm.query(req.query.q || ""));
});

// teach / refute: seed the cluster knowledge graph (G_K) used by CDCP votes
app.post("/darm/teach", (req, res)=>{
    darm.teach(req.body.claim);
    res.json({note: "Fact grounded across cluster voters"});
});
app.post("/darm/refute", (req, res)=>{
    darm.refute(req.body.claim);
    res.json({note: "Claim marked refuted across cluster voters"});
});

// replay: run one RCE consolidation cycle (nominates STM survivors to LTM)
app.post("/darm/replay", async (req, res)=>{
    const task = await darmTasks.run('replay', { label: 'RCE replay cycle' }, async (ctl)=>{
        ctl.step('starting replay');
        const r = darm.replay();
        ctl.step(`replayed ${r.replayed}, promoted ${r.promoted}`, 1);
        return r;
    });
    res.json({ task: task.id, ...task.result });
});

// triage: run STM lifecycle management
app.post("/darm/triage", async (req, res)=>{
    const task = await darmTasks.run('triage', { label: 'STM triage' }, async (ctl)=>{
        const r = darm.triage();
        ctl.step(`expired ${r.expired||0}, promoted ${r.promotedArchived||0}`, 1);
        return r;
    });
    res.json({ task: task.id, ...task.result });
});

// state: Sigma(t) snapshot of tier occupancies and the associative graph
app.get("/darm/state", (req, res)=>{
    res.json(darm.state());
});

// ************************************************************************
// Agentic registration + tool-capability discovery (linked-list registry)
// ************************************************************************

// register: an agent comes online and registers its tier + capabilities
// (operator scope). Returns the assigned agent id.
app.post("/agents/register", (req, res)=>{
    try {
        const rec = darmAgents.register({
            id: req.body.id, name: req.body.name, tier: req.body.tier,
            capabilities: req.body.capabilities || [], endpoint: req.body.endpoint || null,
            vpnIp: req.body.vpnIp || null, publicKey: req.body.publicKey || null, meta: req.body.meta || {},
        });
        // Record the agent's capabilities into the model's memory so the model
        // "knows" what tools exist (observed; consolidates over time).
        try { darm.observe({ claim: `agent ${rec.name} (${rec.tier}) provides capabilities: ${rec.capabilities.join(', ')}`, reward: 0.6, epistemic: { conf_cal: 0.75, u_ep: 0.2 } }); } catch (_e) {}
        res.json({ note: "agent registered", id: rec.id, tier: rec.tier, capabilities: rec.capabilities });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// heartbeat: keep an agent marked online (operator scope)
app.post("/agents/heartbeat", (req, res)=>{
    const rec = darmAgents.heartbeat(req.body.id);
    if (!rec) return res.status(404).json({ error: "unknown agent" });
    res.json({ ok: true, lastSeen: rec.lastSeen });
});

// deregister: graceful agent shutdown (operator scope)
app.post("/agents/deregister", (req, res)=>{
    res.json({ ok: darmAgents.deregister(req.body.id) });
});

// list: all registered agents (read scope), filterable by tier/capability
app.get("/agents", (req, res)=>{
    res.json({
        stats: darmAgents.stats(),
        capabilities: darmAgents.capabilities(),
        agents: darmAgents.list({ tier: req.query.tier || null, capability: req.query.capability || null, onlineOnly: req.query.online === '1' }),
    });
});

// route: dispatch a capability to the best agent (read scope) — tier-aware
app.get("/agents/route", (req, res)=>{
    const cap = req.query.capability;
    if (!cap) return res.status(400).json({ error: "capability query param required" });
    res.json(darmAgentRouter.route(cap, { minTier: req.query.minTier || null, preferTier: req.query.preferTier || null }));
});

// escalation: ordered fallback chain for a capability (read scope)
app.get("/agents/escalation", (req, res)=>{
    const cap = req.query.capability;
    if (!cap) return res.status(400).json({ error: "capability query param required" });
    res.json({ capability: cap, chain: darmAgentRouter.escalationChain(cap) });
});

// ************************************************************************
// DIRP-1 fabric: Autonomous Cognitive System (ACS) inter-network routing
// (DARM-ANN v7.2 Distributed AI Lens — Parts II-IV)
// ************************************************************************

// state: this ACS's fabric state (identity, role, RIB/CCIL/SAL stats) [read]
app.get("/fabric/state", (req, res)=>{ res.json(fabric.state()); });

// advertise: sign + publish a capability advertisement (operator)
app.post("/fabric/advertise", (req, res)=>{
    try { res.json(fabric.advertise(req.body.capability || req.body, { ttlMs: req.body.ttlMs })); }
    catch (e) { res.status(400).json({ error: e.message }); }
});

// gossip: ingest a peer's signed ADVERTISE/WITHDRAW into the RIB (operator)
app.post("/fabric/gossip", (req, res)=>{
    const rec = req.body.record || req.body;
    res.json(fabric.gossipIn(rec, { peerAcsn: req.body.peerAcsn || null }));
});

// peer: add a bidirectional peering edge to another ACSN (operator)
app.post("/fabric/peer", (req, res)=>{
    if (!req.body.acsn) return res.status(400).json({ error: "acsn required" });
    fabric.peerWith(req.body.acsn);
    res.json({ ok: true, peers: fabric.rib.neighbours(fabric.acsn).length });
});

// route: DIRP-1 path selection for a capability match (read). Body: { match, privacy_mode, sync_class, conf_class }
app.post("/fabric/route", (req, res)=>{
    const b = req.body || {};
    const match = b.model_class ? (c)=> Array.isArray(c.model_classes) && c.model_classes.includes(b.model_class) : ()=>true;
    res.json(fabric.route({ match, privacy_mode: b.privacy_mode, sync_class: b.sync_class, conf_class: b.conf_class, beta: b.beta, trustFloor: b.trustFloor }));
});

// job: run a job end-to-end ROUTE->execute->ATTEST->SETTLE (operator)
app.post("/fabric/job", async (req, res)=>{
    const b = req.body || {};
    const match = b.model_class ? (c)=> Array.isArray(c.model_classes) && c.model_classes.includes(b.model_class) : ()=>true;
    const out = await fabric.runJob({ payload: b.payload, budget: b.budget || 0 }, { match, privacy_mode: b.privacy_mode, sync_class: b.sync_class, conf_class: b.conf_class });
    res.status(out.ok ? 200 : 400).json(out);
});

// rails: register a settlement Rail Profile (operator) / list (read)
app.post("/fabric/rails", (req, res)=>{ res.json(fabric.sal.registerRail(req.body || {})); });
app.get("/fabric/rails", (req, res)=>{ res.json({ rails: fabric.sal.rails(), settlementLive: fabric.sal.settlementLive() }); });

// adapters: register a SAL Adapter ACS (operator) — any external backend
app.post("/fabric/adapters", (req, res)=>{
    try {
        const a = new Fabric.SAL.AdapterACS(req.body || {});
        res.json(fabric.sal.registerAdapter(a));
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// navigate: model-directed traversal of the Markov chain-graph (TinyLM-steered)
app.get("/darm/navigate", (req, res)=>{
    res.json(darm.navigate(req.query.q || "", Number(req.query.steps) || 8));
});

// self-correct: validate/repair chains, prune TTL, supersede contradictions
app.post("/darm/selfcorrect", async (req, res)=>{
    const task = await darmTasks.run('selfcorrect', { label: 'self-correction pass' }, async (ctl)=>{
        const r = darm.selfCorrect();
        ctl.step(`repaired STM ${r.stmRepaired}, LTM ${r.ltmRepaired}, superseded ${r.superseded}`, 1);
        return r;
    });
    res.json({ task: task.id, ...task.result });
});

// snapshot: persist durable state to disk (DARM_SNAPSHOT or body.path)
app.post("/darm/snapshot", async (req, res)=>{
    const path = (req.body && req.body.path) || DARM_SNAPSHOT;
    if(!path) return res.status(400).json({error: "no snapshot path; set DARM_SNAPSHOT or body.path"});
    const task = await darmTasks.run('snapshot', { label: 'persist snapshot' }, async (ctl)=>{
        darm.save(path); ctl.step('saved to ' + path, 1); return { path };
    });
    res.json({note: "snapshot saved", path, task: task.id});
});

// tasks: list tracked operations (task manager) + summary
app.get("/darm/tasks", (req, res)=>{
    res.json({ summary: darmTasks.summary(), tasks: darmTasks.list({ status: req.query.status || null, limit: Number(req.query.limit) || 50 }) });
});
// tasks/stream: Server-Sent Events feed of live task updates for the monitor.
// Registered BEFORE /darm/tasks/:id so "stream" is not captured as an id.
app.get("/darm/tasks/stream", (req, res)=>{
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.flushHeaders && res.flushHeaders();
    res.write(`event: snapshot\ndata: ${JSON.stringify(darmTasks.list({ limit: 50 }))}\n\n`);
    const onUpdate = (task)=>{ res.write(`event: task\ndata: ${JSON.stringify(task)}\n\n`); };
    darmTasks.on('update', onUpdate);
    const keepalive = setInterval(()=>res.write(': keepalive\n\n'), 15000);
    if (keepalive.unref) keepalive.unref();
    req.on('close', ()=>{ clearInterval(keepalive); darmTasks.removeListener('update', onUpdate); });
});
app.get("/darm/tasks/:id", (req, res)=>{
    const t = darmTasks.get(req.params.id);
    if(!t) return res.status(404).json({error: "task not found"});
    res.json(t);
});

// monitor: task manager / monitor view (operator can watch progress live)
app.get(["/darm/monitor"], (req, res)=>{
    res.sendFile("./darm-ann/monitor.html", {root: __dirname});
});

// audit: operator action trail (requires read scope when auth is on)
app.get("/darm/audit", (req, res)=>{
    res.json({ size: darmAudit.size(), entries: darmAudit.list({ limit: Number(req.query.limit) || 100, action: req.query.action || null }) });
});

// backup: snapshot the node's durable state to a portable, checksummed archive
// (operator scope). Persists current state first so the backup is fresh.
const darmBackup = require('./darm-ann/backup');
app.post("/darm/backup", async (req, res)=>{
    if (!DARM_SNAPSHOT) return res.status(400).json({ error: "DARM_SNAPSHOT not configured" });
    const dataDir = require('path').dirname(DARM_SNAPSHOT);
    const task = await darmTasks.run('backup', { label: 'backup data dir' }, async (ctl)=>{
        persistSnapshot();                       // fresh snapshot first
        if (process.env.DARM_AUDIT_FILE) { try { require('fs').appendFileSync(process.env.DARM_AUDIT_FILE, ''); } catch(_e){} }
        const manifest = darmBackup.createArchive(dataDir, darmBackup.allFiles());
        ctl.step(`archived ${manifest.files.length} file(s)`, 1);
        return { files: manifest.files, digest: manifest.digest, archive: manifest };
    });
    const out = { note: "backup created", files: task.result.files, digest: task.result.digest, task: task.id };
    if (req.query.download === '1') out.archive = task.result.archive; // inline archive
    res.json(out);
});

// restore: rebuild the running node from a backup archive (operator scope).
// Body: { archive: <manifest> }  OR  { path: "/data/backup.json" }.
// Verifies the archive (incl. LTM chain integrity), writes files to the data
// dir, then hot-swaps the live node from the restored snapshot.
app.post("/darm/restore", async (req, res)=>{
    if (!DARM_SNAPSHOT) return res.status(400).json({ error: "DARM_SNAPSHOT not configured" });
    const dataDir = require('path').dirname(DARM_SNAPSHOT);
    let manifest = req.body && req.body.archive;
    try {
        if (!manifest && req.body && req.body.path) manifest = JSON.parse(require('fs').readFileSync(req.body.path, 'utf8'));
    } catch (e) { return res.status(400).json({ error: "cannot read archive: " + e.message }); }
    if (!manifest) return res.status(400).json({ error: "provide body.archive or body.path" });
    const check = darmBackup.verifyArchive(manifest);
    if (!check.ok) return res.status(400).json({ error: "archive invalid", reason: check.reason });
    try {
        const task = await darmTasks.run('restore', { label: 'restore from backup' }, async (ctl)=>{
            const written = darmBackup.restoreArchive(manifest, dataDir);
            ctl.step(`restored ${written.length} file(s); hot-swapping node`);
            const old = darm;
            darm = DarmAnn.load(DARM_SNAPSHOT, { adapter: repoChainAdapter(Bcoin), config: darmConfig });
            darm._taskHook = old._taskHook;
            darm.autorun();
            old.stop();
            ctl.step(`node restored: LTM=${darm.ltm.size}, valid=${darm.ltm.validate().valid}`, 1);
            return { files: written, ltm: darm.ltm.size, ltmValid: darm.ltm.validate().valid };
        });
        res.json({ note: "restored", ...task.result, task: task.id });
    } catch (e) {
        res.status(500).json({ error: "restore failed: " + e.message });
    }
});

// health: liveness/readiness probe for deployment
app.get("/darm/health", (req, res)=>{
    const st = darm.state();
    const healthy = st.chains.stmValid && st.chains.ltmValid;
    res.status(healthy ? 200 : 503).json({status: healthy ? "ok" : "degraded", chains: st.chains, tiers: st.tiers, version: darmVersion.info().version});
});

// version: build/version info (open — useful for deploy verification)
const darmVersion = require('./darm-ann/version');
app.get("/darm/version", (req, res)=>{ res.json(darmVersion.info()); });

// openapi: serve the API specification (open)
app.get("/darm/openapi.yaml", (req, res)=>{
    res.set('Content-Type', 'application/yaml');
    res.sendFile("./darm-ann/openapi.yaml", {root: __dirname});
});
// docs: Swagger UI rendering the spec (open)
app.get("/darm/docs", (req, res)=>{
    res.set('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"/><title>DARM-ANN API</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css"></head>
<body><div id="swagger-ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>window.onload=()=>{SwaggerUIBundle({url:'/darm/openapi.yaml',dom_id:'#swagger-ui'});};</script>
</body></html>`);
});

// ready: readiness probe — node has booted and its chains are valid
app.get("/darm/ready", (req, res)=>{
    const st = darm.state();
    const ready = !!darm && st.chains.stmValid && st.chains.ltmValid;
    res.status(ready ? 200 : 503).json({ready});
});

// tx: submit a new transaction (origin) OR receive a gossiped one (peers).
// Origin submit:  body = { type, payload }      → admit locally + gossip
// Gossip relay:   body = { tx, ttl }            → verify, dedup, re-gossip
app.post("/darm/tx", (req, res)=>{
    if (req.body && req.body.tx) {
        // Inbound gossip from a peer.
        const before = darmMempool.seen.has(req.body.tx.id);
        darmMempool.handle({ type: 'TX_GOSSIP', ttl: req.body.ttl || 0, tx: req.body.tx });
        const admitted = !before && darmMempool.seen.has(req.body.tx.id);
        if (admitted) gossipTxToPeers(req.body.tx, req.body.ttl || 0);
        return res.json({ note: admitted ? "tx admitted + relayed" : "duplicate/ignored" });
    }
    // Origin submission.
    const tx = darmMempool.submit(req.body.type || 'memory', req.body.payload || {});
    gossipTxToPeers(tx, darmMempool.ttl);
    res.json({ note: "tx submitted and gossiped", tx: { id: tx.id, type: tx.type } });
});

// mempool: inspect pending transactions
app.get("/darm/mempool", (req, res)=>{
    res.json({ size: darmMempool.size(), pending: darmMempool.take(50).map(t => ({ id: t.id, type: t.type, origin: t.origin })) });
});

// alerts: Alertmanager webhook receiver. Records recent alerts and, when
// auto-remediation is enabled (DARM_AUTOREMEDIATE!=0), runs a remediation task
// in response to actionable firing alerts (e.g. a chain-invalid alert triggers
// a self-correction pass). Each remediation is tracked on the monitor.
const DARM_AUTOREMEDIATE = process.env.DARM_AUTOREMEDIATE !== '0';
const darmAlerts = [];
function remediate(alertName){
    // Map an alert to a remediation action; return a task or null.
    if (alertName === 'DarmLTMChainInvalid' || alertName === 'DarmSTMChainInvalid') {
        return darmTasks.run('remediate', { label: `auto-remediate ${alertName}`, meta: { alert: alertName } }, async (ctl)=>{
            ctl.step('running self-correction in response to ' + alertName);
            const r = darm.selfCorrect();
            ctl.step(`repaired STM ${r.stmRepaired}, LTM ${r.ltmRepaired}`, 1);
            return r;
        });
    }
    return null;
}
app.post("/darm/alerts", (req, res)=>{
    const incoming = (req.body && req.body.alerts) || [];
    const remediations = [];
    for (const a of incoming) {
        const name = a.labels && a.labels.alertname;
        darmAlerts.unshift({ status: a.status, name, severity: a.labels && a.labels.severity, instance: a.labels && a.labels.instance, at: Date.now() });
        if (DARM_AUTOREMEDIATE && a.status === 'firing') {
            const task = remediate(name);
            if (task) remediations.push(name);
        }
    }
    while (darmAlerts.length > 50) darmAlerts.pop();
    console.log(`[DARM-ANN] received ${incoming.length} alert(s); remediated ${remediations.length}`);
    res.json({ note: "alerts received", count: incoming.length, remediated: remediations });
});
app.get("/darm/alerts", (req, res)=>{ res.json({ recent: darmAlerts.slice(0, 20), autoRemediate: DARM_AUTOREMEDIATE }); });

// metrics: Prometheus exposition format for scraping (Grafana dashboards)
const darmMetrics = require('./darm-ann/metrics');
const darmStartTime = Date.now();
app.get("/darm/metrics", (req, res)=>{
    const text = darmMetrics.render(darm, {
        mempoolSize: darmMempool.size(),
        uptimeSeconds: (Date.now() - darmStartTime) / 1000,
        networkNodes: (Bcoin.networkNode || []).length,
        tasks: darmTasks.summary(),
        buildInfo: darmVersion.info(),
        agents: darmAgents.stats(),
        fabric: fabric.state(),
    });
    res.set('Content-Type', 'text/plain; version=0.0.4');
    res.send(text);
});

// validators: dynamic validator-set membership
app.get("/darm/validators", (req, res)=>{
    res.json({ validators: darm.validators(), membershipVersion: darm.state().cluster.membershipVersion });
});
app.post("/darm/validators", (req, res)=>{
    res.json(darm.addValidator(req.body || {}));
});
app.delete("/darm/validators/:id", (req, res)=>{
    res.json(darm.removeValidator(req.params.id));
});

// dashboard: a small operator UI over the endpoints
app.get(["/darm", "/darm/dashboard"], (req, res)=>{
    res.sendFile("./darm-ann/dashboard.html", {root: __dirname});
});


//transaction end point
// adds the transaction that was broadcasted from one of the nodes to the pending transactions upon consensus
app.post("/transaction",(req, res)=>{
   const newTransaction = req.body;
   const blockIndex = Bcoin.addTransactionToPendingTransactions(newTransaction);
    res.json({note: `Transaction will be added in block ${blockIndex}`});

});
    

//broadcast transaction end point
// broadcasts the transaction to the rest of the nodes
app.post("/transaction/broadcast", function(req, res){
    const newTransaction = Bcoin.createNewTransaction(req.body,type, req.body,data, req.body.sender, req.body.recipient);
    Bcoin.addTransactionToPendingTransactions(newTransaction);
    const requestPromises = [];
    Bcoin.networkNode.forEach(networkNodeUrl =>{
        const requestOptions ={
            uri: networkNodeUrl + '/transaction',
            method: 'POST',
            body: newTransaction,
            json: true
        };
        requestPromises.push(rp(requestOptions));
    });
    Promise.all(requestPromises).then(data=>{
        res.json({note: "Transaction created and broadcast succesfully"});
    })
});


//mine end point
// the mining end point that mines and sends the new transaction to the rest of the nodes
app.get("/mine", (req, res)=>{
      
      //authenticate
      const nodeAddress = n0deAddress;//sends mined coins to this node
      
      const lastBlock = Bcoin.getLastBlock();
      const previousBlockHash = lastBlock['hash'];
      const currentBlockData = {
          transactions: Bcoin.pendingTransactions,
          index: lastBlock['index'] + 1,

      };
      const reciet = Bcoin.PoW(previousBlockHash, currentBlockData);
      const nonce = reciet[0];
      const hash = Bcoin.hashBlock(previousBlockHash, currentBlockData, nonce);
      const newBlock = Bcoin.createNewBlock(nonce, previousBlockHash, hash);
      const requestPromises = [];
      Bcoin.networkNode.forEach(networkNodeUrl=>{
          const requestOptions = {
              uri: networkNodeUrl + '/receive-new-block',
              method: 'POST',
              body:{newBlock: newBlock},
              json: true
          };
          requestPromises.push(rp(requestOptions));
      });
      Promise.all(requestPromises).then(data=>{
          const requestOptions = {
              uri: Bcoin.currentNodeUrl + '/transaction/broadcast',
              method: 'POST',
              body: {
                  type: "g0ld",
                  data: 12.5,
                  sender: chainID,
                  recipient: nodeAddress,
              },
              json: true,

          };
          return rp(requestOptions);
      });
      
      res.json({
          "reciept":reciet, 
          "info":"A new block has been mined",
          "Block":newBlock,
      });
      Bcoin.createNewTransaction("g0ld", 12.5, chainID, nodeAddress );
      
});
  

// //end point to get a downloaded version of the code to run and connect to the blockchain
// app.get("/downloadCoin", function(req, res){
//     res.sendFile("initNode.txt",{root: __dirname});
// })

  

//recieve new block end point
//checks newly recieved block
app.post("/recieve-new-block",  function(req, res){
    const newBlock = req.body.newBlock;
    const lastBlock = Bcoin.getLastBlock();
    const correctHash = (lastBlock.hash === newBlock.previousBlockHash);
    const correctIndex = (lastBlock['index'] + 1 === newBlock.index);
    if(correctIndex & correctHash){
        Bcoin.chain.push(newBlock);
        res.json({
            note: "New block has been recieved and accepted",
            newBlock: newBlock,
        });
    }//end if
    else{
        res.json({
            note: "New block rejected",
            newBlock: newBlock,
            code:"AD00001",
            message: "Block is invalid"
        });
    }//end else
});


//register-and-broadcast-node end point
app.post("/register-and-broadcast-node", function(req, res){
    const newNodeUrl = req.body.newNodeUrl;//will be sending the new node that we want to add to our network.
    if(Bcoin.networkNode.indexOf(newNodeUrl) == -1){
        Bcoin.networkNode.push(newNodeUrl);
    }//end if
    const regNodesPromises = [];
    Bcoin.networkNode.forEach(networkNodeUrl => {
        //... register-node
        const requestOptions = {
            uri: networkNodeUrl + '/register-node',
            method: 'POST',
            body: {newNodeUrl: newNodeUrl},
            json: true,

        };
        regNodesPromises.push(rp(requestOptions));

    });
    Promise.all(regNodesPromises).then(data=>{
        const bulkRegisterOptions = {
            uri: newNodeUrl + '/register-nodes-bulk',
            method: 'POST',
            body: {allNetworkNodes: [...Bcoin.networkNode,Bcoin.currentNodeUrl]},
            json: true
        };
        return rp(bulkRegisterOptions).then(data =>{
            res.json({note: "New Node registered with network succesfully"});
        });
    });
});


/*** The difference between register-and-broadcast-node and register-node endpoint
* when we want to register a new node we go to register-and-broadcast
* then those nodes will register it on their node, and then submit the node to register-node
* 
*/


//register-node endpoint
app.post("/register-node", function(req, res){
    const newNodeUrl = req.body.newNodeUrl;
    const nodeNotAlreadyPresent = (Bcoin.networkNode.indexOf(newNodeUrl) == -1);
    const notCurrentNode = (Bcoin.currentNodeUrl !== newNodeUrl);
    if(nodeNotAlreadyPresent && notCurrentNode){
        Bcoin.networkNode.push(newNodeUrl);
    }//end if
    
    res.json({note: "New node registered succesfully."});
})


app.post("/register-nodes-bulk", function(req,res){
    const allNetNodes = req.body.allNetworkNodes;
    allNetNodes.forEach(networkNodeUrl =>{
        const nodeNotAlreadyPresent = (Bcoin.networkNode.indexOf(networkNodeUrl) == -1);
        const notCurrentNode = (Bcoin.currentNodeUrl !== networkNodeUrl);
        if(nodeNotAlreadyPresent && notCurrentNode){
            Bcoin.networkNode.push(networkNodeUrl);
        }//end if
    });
    res.json({note:"Bulk registration succesful"});
});


app.get("/consensus", function(req, res){
    
    const requestPromises = [];
    Bcoin.networkNode.forEach(networkNodeUrl =>{
        const requestOptions ={
            uri: networkNodeUrl + '/blockchain',
            method: 'GET',
            json: true,
        };
        requestPromises.push(rp(requestOptions));
    });
    Promise.all(requestPromises).then(blockchains =>{
        const currentChainLength = Bcoin.chain.length;
        let maxChainLength = currentChainLength;
        let newLongestChain = null;
        let newPendingTransactions = null;
        blockchains.forEach(blockchain =>{
            if(blockchain.chain.length > maxChainLength){
                maxChainLength = blockchain.chain.length;
                newLongestChain = blockchain.chain;
                newPendingTransactions = blockchain.pendingTransactions;
            };//end if
        });
        if(!newLongestChain || (newLongestChain && !Bcoin.chainIsValid(newLongestChain))){
            res.json({note: "Current chain has not been replaced",
                chain: Bcoin.chain,
            });

        }else{
            Bcoin.chain = newLongestChain;
            Bcoin.pendingTransactions = newPendingTransactions;
            res.json({
                note: "This chain has been replaced",
                chain: Bcoin.chain
            });
        }

    });
});




//  ********************************************************************************************
//  Block-Explorer Endpoints
//  ********************************************************************************************
// for searching and examining blocks



//returns matching :blockHash
app.get('/block/:blockHash', function(req, res){
    const blockHash = req.params.blockHash;
    const foundBlock = Bcoin.getBlock(blockHash);
    res.json({
        block: foundBlock,
    });
});


//returns matching :transactionId
app.get('/transaction/:transactionId', function(req, res){
    const transactionId = req.params.transactionId;
    const transactionData = Bcoin.getTransaction(transactionId);
    res.json({
        transaction: transactionData.transaction,
        block: transactionData.block,
    });

});


//returns matching :address
app.get('/address/:address', function(req, res){
    const address = req.params.address;
    const addressData = Bcoin.getAddressData(address);
    res.json({
        addressData: addressData
    });
});


//  ********************************************************************************************
//  Coin Explorer
//  ********************************************************************************************



//coin explorer
app.get("/bex",function(req, res){
    res.sendFile("./index.html", {root: __dirname});
});
  


//  ********************************************************************************************
//  JWT Token functions
//  ********************************************************************************************


function generateRefreshToken(loggedInUser){
    return jwt.sign(loggedInUser, process.env.REFRESH_TOKEN, {expiresIn: '3hr'})
}


function generateAuthenticationToken(loggedInUser){
    return jwt.sign(loggedInUser, process.env.ACCESS_TOKEN_SECRET, {expiresIn: '2hr'});
}


function authenticateToken(req, res, next){
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if(token == null){
        return res.sendStatus(403);
    }//end if
    jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, user)=>{
        if(err) {
            return sendStatus(403);
        }//end if
        req.user = user;
        next();
    });
}



//  Port determined by argsv[0]
//  Change this to something more friendly and secure, like a prompt or ""
//

//listen on port — HTTPS when DARM_TLS_CERT/DARM_TLS_KEY are provided, else HTTP.
if (process.env.DARM_TLS_CERT && process.env.DARM_TLS_KEY) {
    const https = require('https');
    const tlsOpts = { cert: fs.readFileSync(process.env.DARM_TLS_CERT), key: fs.readFileSync(process.env.DARM_TLS_KEY) };
    https.createServer(tlsOpts, app).listen(port, ()=>{
        console.log("Server is now listening on port (TLS)", port);
    });
} else {
    app.listen(port, ()=>{
        console.log("Server is now listening on port" ,port);
    });
}


// console.log('---------------------------Development envriornment node app starting----------------------');
